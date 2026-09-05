import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { buildPaths, ensureDirs, jeffRoot, type JeffPaths } from './paths.js'
import { openDb, type DB } from './db/db.js'
import { agentRepo, kvRepo, chatMessageRepo, type AgentRow } from './db/repos.js'
import { SidecarManager } from './sidecar/manager.js'
import { OcClient } from './oc/client.js'
import { writeSidecarConfig, type ProviderSetting } from './oc/configWriter.js'
import { AgentRegistry, XIAOJIE_INSTRUCTIONS, agentSlug } from './agents/registry.js'
import { XIAOJIE_ID } from './ipc/contract.js'
import { ToolBridge, renderBridgePlugin } from './tools/bridge.js'
import { registerAdminTools } from './tools/adminTools.js'
import { registerProjectTools, taskCardMessage } from './tools/projectTools.js'
import { registerMemoryTools, DELEGATE_TOOL, sesMetaKey, type SessionScopeCtx } from './tools/memoryTools.js'
import { allToolDefs } from './tools/definitions.js'
import { PrivateChat } from './chat/private.js'
import { GroupChat } from './orchestrator/group.js'
import { Delegator } from './orchestrator/delegate.js'
import { MemoryStore } from './memory/store.js'
import { SessionIndex } from './memory/indexer.js'
import type { McpServerCfg } from './mcp/parse.js'
import { SyncEngine, type WebdavConfig, type SyncReport } from './sync/engine.js'

export const APP_VERSION = '1.1.0'

export type { McpServerCfg } from './mcp/parse.js'
export { buildPaths, ensureDirs, jeffRoot } from './paths.js'
export { openDb } from './db/db.js'

const NUDGE_INTERVAL = 10 // 每 N 个用户触发一次后台记忆自省
const NUDGE_REVIEW_MAX_CHARS = 6000

/** Jeff 核心实例：桌面主进程与测试脚本共用 */
export class JeffCore extends EventEmitter {
  paths: JeffPaths
  db!: DB
  sidecar!: SidecarManager
  oc!: OcClient
  registry!: AgentRegistry
  bridge = new ToolBridge()
  privateChat!: PrivateChat
  groupChat!: GroupChat
  delegator!: Delegator
  memory!: MemoryStore
  indexer!: SessionIndex
  sync!: SyncEngine
  bus = new EventEmitter()
  private started = false
  private registryDirty = false
  lastSyncReport: SyncReport | null = null
  private autoSyncTimer: NodeJS.Timeout | null = null

  constructor(home?: string) {
    super()
    this.paths = buildPaths(jeffRoot(home))
  }

  async init(opts: { resourceBinDir?: string; binaryPath?: string } = {}): Promise<void> {
    if (this.started) return
    ensureDirs(this.paths)
    this.db = openDb(this.paths)
    this.seedXiaojie()
    this.registry = new AgentRegistry(this.db, this.paths)
    this.memory = new MemoryStore(this.paths)
    this.indexer = new SessionIndex(this.db)
    this.groupChat = new GroupChat(this.db, () => this.oc, this.chatHooks())
    this.privateChat = new PrivateChat(this.db, () => this.oc, this.chatHooks())
    this.delegator = new Delegator(this.db, () => this.oc, this.groupChat, (projectId) => {
      this.bus.emit('group-updated', { projectId })
    })
    this.sync = new SyncEngine(this.db, this.paths, this.memory, () => this.kv().getJSON<WebdavConfig | null>('settings:webdav', null), (r) => {
      this.lastSyncReport = r
      this.bus.emit('sync-report', r)
    })
    // 自动同步：数据变化后防抖 30s
    this.bus.on('data-changed', () => this.scheduleAutoSync())

    // 工具桥（先注册工具，再启动，再渲染插件文件）
    registerAdminTools(this.bridge, {
      db: this.db,
      onChanged: () => {
        this.syncRegistry()
        this.markRegistryDirty()
        this.bus.emit('data-changed', 'agents')
      },
    })
    registerProjectTools(this.bridge, {
      db: this.db,
      onProjectChanged: () => {
        this.bus.emit('data-changed', 'projects')
      },
      onTaskChanged: (projectId, taskId) => {
        if (taskId) {
          const card = taskCardMessage(this.db, projectId, taskId)
          if (card.content) this.groupChat.addSystemMessage(projectId, card.content, card.meta)
        }
        this.bus.emit('data-changed', 'tasks')
        this.bus.emit('group-updated', { projectId })
      },
    })
    registerMemoryTools(this.bridge, {
      db: this.db,
      store: this.memory,
      indexer: this.indexer,
      resolveSession: (sessionId) => this.resolveSession(sessionId),
    })
    this.bridge.register(DELEGATE_TOOL, async (raw: Record<string, unknown>) => {
      const { __ctx, member_agent_id, instruction } = raw as {
        __ctx?: { sessionID?: string; agent?: string; messageID?: string }
        member_agent_id?: string
        instruction?: string
      }
      const resolved = __ctx?.sessionID ? this.resolveSession(__ctx.sessionID) : null
      if (!resolved || resolved.kind !== 'group') {
        return { ok: false, error: 'jeff_delegate 只能在项目群里使用（且你必须是群主）' }
      }
      if (!member_agent_id || !instruction) return { ok: false, error: 'member_agent_id 与 instruction 必填' }
      const r = await this.delegator.delegate(
        { projectId: resolved.projectId, leaderAgentId: resolved.agentId },
        member_agent_id,
        instruction,
        __ctx?.messageID,
      )
      return r.ok ? { member: r.memberName, result: r.result } : { ok: false, error: r.error }
    })
    await this.bridge.start()
    this.writeBridgePlugin()

    // sidecar 配置（provider/auth）+ agent 定义文件（必须在 sidecar 启动前就位）
    this.writeSidecarConfig()
    this.syncRegistry()

    // sidecar 启动
    this.sidecar = new SidecarManager({ paths: this.paths, resourceBinDir: opts.resourceBinDir, binaryPath: opts.binaryPath })
    this.sidecar.on('status', (status: string, error?: string) => {
      this.bus.emit('sidecar-status', { status, error })
      this.emit('sidecar-status', { status, error })
    })
    this.sidecar.on('log', (line: string) => this.emit('sidecar-log', line))
    await this.sidecar.start()
    this.oc = new OcClient(this.sidecar.port)
    this.oc.startEventStream()
    this.oc.on('event', (evt: { type?: string; properties?: Record<string, unknown> }) => this.handleOcEvent(evt))

    this.writeUsageSkill()
    this.backfillIndex()
    this.started = true
    if (this.kv().getJSON<WebdavConfig | null>('settings:webdav', null)?.autoSync) {
      setTimeout(() => void this.syncNow().catch(() => {}), 5000)
    }
  }

  /** 数据变化后防抖自动同步 */
  scheduleAutoSync(): void {
    const cfg = this.kv().getJSON<WebdavConfig | null>('settings:webdav', null)
    if (!cfg?.autoSync || !this.started) return
    if (this.autoSyncTimer) clearTimeout(this.autoSyncTimer)
    this.autoSyncTimer = setTimeout(() => {
      this.autoSyncTimer = null
      void this.syncNow().catch(() => {})
    }, 30000)
    this.autoSyncTimer.unref?.()
  }

  /** 手动同步 */
  async syncNow(): Promise<SyncReport> {
    return this.sync.sync()
  }

  /** 配置 WebDAV（密码存本地 kv） */
  async configureSync(cfg: WebdavConfig): Promise<void> {
    this.kv().setJSON('settings:webdav', cfg)
    this.sync.resetClient()
    if (cfg.autoSync) void this.syncNow().catch(() => {})
  }

  syncConfig(): Omit<WebdavConfig, 'password'> | null {
    const cfg = this.kv().getJSON<WebdavConfig | null>('settings:webdav', null)
    if (!cfg?.url) return null
    const { password: _password, ...rest } = cfg
    return rest
  }

  private chatHooks() {
    return {
      beforeEnsure: () => this.restartIfRegistryDirty(),
      onSessionCreated: (sessionId: string, meta: { kind: 'private' | 'group' | 'review'; agentId: string; projectId?: string }) => {
        this.kv().setJSON(sesMetaKey(sessionId), meta)
      },
      buildSystem: (agentId: string, projectId?: string) => this.buildMemorySystem(agentId, projectId),
      afterReply: (scope: { kind: 'private'; agentId: string } | { kind: 'group'; projectId: string; agentId: string }) => {
        this.onReplyDone(scope)
      },
    }
  }

  /** 记忆注入：agent 记忆 + 项目记忆（群聊）+ 全局用户画像 */
  buildMemorySystem(agentId: string, projectId?: string): string | undefined {
    const blocks: string[] = []
    const agentBlock = this.memory.renderBlock({ kind: 'agent', agentId })
    if (agentBlock) blocks.push(agentBlock)
    if (projectId) {
      const projectBlock = this.memory.renderBlock({ kind: 'project', projectId })
      if (projectBlock) blocks.push(projectBlock)
    }
    const userBlock = this.memory.renderBlock({ kind: 'user' })
    if (userBlock) blocks.push(userBlock)
    if (blocks.length === 0) return undefined
    return [
      '【长期记忆（Jeff）】以下是关于用户与项目的持久记忆，供你参考；如与当前对话冲突，以对话为准，并可用 jeff_memory 工具更新你的记忆。',
      ...blocks,
    ].join('\n')
  }

  /** 回复完成：索引本轮内容 + 计数 nudge */
  private onReplyDone(scope: { kind: 'private'; agentId: string } | { kind: 'group'; projectId: string; agentId: string }): void {
    try {
      if (scope.kind === 'private') {
        const sessionId = this.privateChat.getSessionId(scope.agentId)
        if (sessionId) void this.indexSession(sessionId, `private:${scope.agentId}`)
      } else {
        const scopeKey = `group:${scope.projectId}`
        const msgs = chatMessageRepo(this.db).listByScope(scopeKey, 4)
        const agents = agentRepo(this.db)
        for (const m of msgs) {
          if (this.indexer.has(`chat:${m.id}`)) continue
          const sender = m.sender_type === 'user' ? 'user' : m.sender_type === 'agent' ? agents.get(m.sender_id)?.name || 'agent' : 'system'
          this.indexer.index({ id: `chat:${m.id}`, scope: scopeKey, sender, ts: m.created_at, text: m.content, sessionId: '' })
        }
      }
    } catch {
      /* 索引失败不影响聊天 */
    }
    void this.maybeNudge(scope)
  }

  /** opencode 会话内容 → 索引（幂等，按消息 id 去重） */
  async indexSession(sessionId: string, scope: string): Promise<number> {
    const msgs = await this.oc.getMessages(sessionId)
    let n = 0
    for (const m of msgs) {
      const info = m.info as { id?: string; role?: string; time?: { created?: number } }
      if (!info?.id) continue
      if (this.indexer.has(`oc:${info.id}`)) continue
      const parts = m.parts || []
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text?: string }).text || '')
        .join('\n')
      if (!text.trim()) continue
      this.indexer.index({ id: `oc:${info.id}`, scope, sessionId, sender: info.role || '', ts: info.time?.created || 0, text })
      n += 1
    }
    return n
  }

  /** 启动时回填索引（群消息 + 既有会话） */
  private backfillIndex(): void {
    try {
      const all = this.db.prepare('SELECT id, scope, sender_type, sender_id, content, created_at FROM chat_message ORDER BY created_at ASC').all() as unknown as Array<{
        id: string
        scope: string
        sender_type: string
        sender_id: string
        content: string
        created_at: number
      }>
      const agents = agentRepo(this.db)
      for (const m of all) {
        if (this.indexer.has(`chat:${m.id}`)) continue
        const sender = m.sender_type === 'user' ? 'user' : m.sender_type === 'agent' ? agents.get(m.sender_id)?.name || 'agent' : 'system'
        this.indexer.index({ id: `chat:${m.id}`, scope: m.scope, sender, ts: m.created_at, text: m.content })
      }
      for (const a of agents.list()) {
        const sessionId = this.kv().get(`session:private:${a.id}`)
        if (sessionId) void this.indexSession(sessionId, `private:${a.id}`).catch(() => {})
      }
    } catch {
      /* 回填失败不阻塞启动 */
    }
  }

  /** hermes 式 nudge：每 N 轮触发后台记忆自省 */
  private async maybeNudge(scope: { kind: 'private'; agentId: string } | { kind: 'group'; projectId: string; agentId: string }): Promise<void> {
    const key = scope.kind === 'private' ? `private:${scope.agentId}` : `group:${scope.projectId}`
    const kv = this.kv()
    const count = (kv.getJSON<number>(`nudge:${key}`, 0) || 0) + 1
    kv.setJSON(`nudge:${key}`, count)
    if (count % NUDGE_INTERVAL !== 0) return
    const guardKey = `nudge:running:${key}`
    if (kv.get(guardKey)) return
    kv.set(guardKey, String(Date.now()))
    void this.runNudgeReview(scope, key, guardKey).catch(() => {
      kv.delete(guardKey)
    })
  }

  /** 后台自省：fork 一个临时会话，重放最近对话，让 agent 自己决定存什么 */
  private async runNudgeReview(
    scope: { kind: 'private'; agentId: string } | { kind: 'group'; projectId: string; agentId: string },
    key: string,
    guardKey: string,
  ): Promise<void> {
    try {
      this.emit('sidecar-log', `[nudge] 触发记忆自省 ${key}`)
      let transcript = ''
      if (scope.kind === 'private') {
        const sessionId = this.privateChat.getSessionId(scope.agentId)
        if (!sessionId) return
        const msgs = await this.privateChat.mapSessionMessages(sessionId)
        transcript = msgs
          .slice(-30)
          .map((m) => `${m.role === 'user' ? '用户' : 'assistant'}: ${m.text.slice(0, 300)}`)
          .join('\n')
      } else {
        const history = this.groupChat.history(scope.projectId)
        transcript = history
          .slice(-30)
          .map((m) => `${m.sender_name}: ${m.text.slice(0, 300)}`)
          .join('\n')
      }
      if (!transcript.trim()) return
      transcript = transcript.slice(0, NUDGE_REVIEW_MAX_CHARS)

      const agent = agentRepo(this.db).get(scope.agentId)
      if (!agent) return
      const s = await this.oc.createSession({ title: `记忆自省 ${key}`, agent: agentSlug(scope.agentId) })
      this.kv().setJSON(sesMetaKey(s.id), { kind: 'review', agentId: scope.agentId, projectId: scope.kind === 'group' ? scope.projectId : undefined })
      try {
        await this.oc.sendMessage({
          sessionId: s.id,
          agent: agentSlug(scope.agentId),
          timeoutMs: 120000,
          text: [
            '【后台记忆自省】回顾以下最近对话（你只能用 jeff_memory 工具，不要回复用户任何文字）。',
            '把值得长期记住的信息写进你的记忆：用户偏好、环境事实、被纠正的错误、长期惯例。',
            '不要记录：琐碎寒暄、可随时重查的信息、本次会话临时内容。已有条目不必重复添加。若没有值得记的，直接结束（不用调用工具）。',
            '',
            '--- 对话记录 ---',
            transcript,
          ].join('\n'),
        })
      } finally {
        await this.oc.deleteSession(s.id).catch(() => {})
        this.kv().delete(sesMetaKey(s.id))
      }
    } finally {
      this.kv().delete(guardKey)
    }
  }

  /** opencode session → Jeff 会话语义（元数据优先，kv 扫描回退） */
  resolveSession(sessionId: string): SessionScopeCtx | null {
    const meta = this.kv().getJSON<{ kind: 'private' | 'group' | 'review'; agentId: string; projectId?: string } | null>(sesMetaKey(sessionId), null)
    if (meta?.agentId) {
      if (meta.kind === 'group' && meta.projectId) return { kind: 'group', projectId: meta.projectId, agentId: meta.agentId }
      if (meta.kind === 'review') return { kind: 'review', agentId: meta.agentId, projectId: meta.projectId }
      return { kind: 'private', agentId: meta.agentId }
    }
    for (const agent of agentRepo(this.db).list()) {
      if (this.kv().get(`session:private:${agent.id}`) === sessionId) return { kind: 'private', agentId: agent.id }
    }
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'session:group:%'").all() as unknown as Array<{ key: string; value: string }>
    for (const r of rows) {
      if (r.value === sessionId) {
        const m = /session:group:([^:]+):(.+)/.exec(r.key)
        if (m) return { kind: 'group', projectId: m[1], agentId: m[2] }
      }
    }
    return null
  }

  /** SSE 事件 → bus（UI 刷新信号 + 流式增量） */
  private streamParts = new Map<string, { text: string }>() // key: sessionId:messageId:partId
  private msgRoles = new Map<string, string>() // messageId → role（过滤用户消息的 part 回显）

  private handleOcEvent(evt: { type?: string; properties?: Record<string, unknown> }): void {
    if (!evt?.type) return
    const props = (evt.properties || {}) as Record<string, unknown>
    const sessionId = props.sessionID as string | undefined
    if (!sessionId) return

    // 记录消息角色（流式只推 assistant 的 part，避免用户消息回显被当成流式气泡）
    if (evt.type === 'message.updated') {
      const info = props.info as { id?: string; role?: string } | undefined
      if (info?.id && info.role) {
        this.msgRoles.set(info.id, info.role)
        if (this.msgRoles.size > 500) {
          const first = this.msgRoles.keys().next().value
          if (first) this.msgRoles.delete(first)
        }
      }
    }

    // 流式：text part 增量（field==='text' 才是正文）
    if (evt.type === 'message.part.delta') {
      const { messageID, partID, field, delta } = props as { messageID?: string; partID?: string; field?: string; delta?: string }
      if (!messageID || !partID || field !== 'text' || !delta) return
      if (this.msgRoles.get(messageID) && this.msgRoles.get(messageID) !== 'assistant') return
      const key = `${sessionId}:${messageID}:${partID}`
      const cur = this.streamParts.get(key) || { text: '' }
      cur.text += delta
      this.streamParts.set(key, cur)
      this.emitStream(sessionId, messageID)
      return
    }

    // 流式纠偏：part.updated 带全量文本，比增量拼接长则以它为准
    if (evt.type === 'message.part.updated') {
      const part = props.part as { id?: string; messageID?: string; type?: string; text?: string } | undefined
      if (part?.type === 'text' && part.id && part.messageID && typeof part.text === 'string') {
        if (this.msgRoles.get(part.messageID) && this.msgRoles.get(part.messageID) !== 'assistant') return
        const key = `${sessionId}:${part.messageID}:${part.id}`
        const cur = this.streamParts.get(key)
        if (cur && part.text.length >= cur.text.length) cur.text = part.text
        else if (!cur && part.text) this.streamParts.set(key, { text: part.text })
        this.emitStream(sessionId, part.messageID)
      }
      return
    }

    // 完成信号：assistant 消息 completed 或会话转 idle → 通知渲染层拉全量 + 清流式缓冲
    if (evt.type === 'message.updated' || evt.type === 'session.idle') {
      const info = props.info as { id?: string; role?: string; time?: { completed?: number } } | undefined
      const completed = evt.type === 'session.idle' || (info?.role === 'assistant' && !!info?.time?.completed)
      if (!completed) return
      const resolved = this.resolveSession(sessionId)
      for (const key of Array.from(this.streamParts.keys())) {
        if (key.startsWith(`${sessionId}:`)) this.streamParts.delete(key)
      }
      if (!resolved) return
      if (resolved.kind === 'group') {
        this.bus.emit('chat-stream', { kind: 'group', projectId: resolved.projectId, agentId: resolved.agentId, messageId: info?.id || '', text: '', done: true })
        this.bus.emit('group-updated', { projectId: resolved.projectId })
      } else if (resolved.kind === 'private') {
        this.bus.emit('chat-stream', { kind: 'private', agentId: resolved.agentId, messageId: info?.id || '', text: '', done: true })
        this.bus.emit('chat-updated', { agentId: resolved.agentId, sessionId })
      }
    }
  }

  /** 把某会话某消息的流式增量发给渲染层（review/未知会话跳过） */
  private emitStream(sessionId: string, messageId: string): void {
    const resolved = this.resolveSession(sessionId)
    if (!resolved || resolved.kind === 'review') {
      // 无法归属：清掉对应缓冲防泄漏
      for (const key of Array.from(this.streamParts.keys())) {
        if (key.startsWith(`${sessionId}:`)) this.streamParts.delete(key)
      }
      return
    }
    let text = ''
    for (const [key, v] of this.streamParts) {
      if (key.startsWith(`${sessionId}:${messageId}:`)) text += (text ? '\n' : '') + v.text
    }
    if (resolved.kind === 'group') {
      this.bus.emit('chat-stream', { kind: 'group', projectId: resolved.projectId, agentId: resolved.agentId, messageId, text, done: false })
    } else {
      this.bus.emit('chat-stream', { kind: 'private', agentId: resolved.agentId, messageId, text, done: false })
    }
  }

  async dispose(): Promise<void> {
    if (!this.started) return
    this.oc?.stopEventStream()
    await this.sidecar?.stop().catch(() => {})
    await this.bridge?.stop().catch(() => {})
    this.db?.close()
    this.started = false
  }

  get isStarted(): boolean {
    return this.started
  }

  /** agent md 同步（带全局默认模型兜底） */
  syncRegistry(): void {
    this.registry.syncAll(this.defaultModel() ?? undefined)
  }

  /** agent 定义有变化：md 已同步，下次会话前需重启 sidecar（opencode 不热加载 agent） */
  markRegistryDirty(): void {
    this.registryDirty = true
  }

  private async restartIfRegistryDirty(): Promise<void> {
    if (!this.registryDirty || !this.sidecar) return
    this.registryDirty = false
    await this.restartSidecar()
  }

  /** 重启 sidecar 并重建客户端/会话对象 */
  async restartSidecar(): Promise<void> {
    const old = this.oc
    await this.sidecar.stop()
    await this.sidecar.start()
    old?.stopEventStream()
    this.oc = new OcClient(this.sidecar.port)
    this.oc.startEventStream()
    this.oc.on('event', (evt: { type?: string; properties?: Record<string, unknown> }) => this.handleOcEvent(evt))
    this.groupChat = new GroupChat(this.db, () => this.oc, this.chatHooks())
    this.privateChat = new PrivateChat(this.db, () => this.oc, this.chatHooks())
  }

  /** 内置小杰：不存在则创建；存在则强制对齐指令（保持与代码同步，不可被改） */
  private seedXiaojie(): void {
    const agents = agentRepo(this.db)
    const existing = agents.get(XIAOJIE_ID)
    if (!existing) {
      agents.create({
        id: XIAOJIE_ID,
        name: '小杰',
        avatar: '🧑‍💻',
        description: 'Jeff 内置管家：问答、创建与管理一切',
        builtin: 1,
      })
    }
    agents.update(XIAOJIE_ID, { instructions: XIAOJIE_INSTRUCTIONS })
  }

  /** 把工具桥插件写进 sidecar 插件目录 */
  writeBridgePlugin(): void {
    fs.mkdirSync(this.paths.ocPluginsDir, { recursive: true })
    const defs = allToolDefs().map((d) => ({ name: d.name, description: d.description, args: d.args }))
    const plugin = renderBridgePlugin(this.bridge.url(), this.bridge.token, defs)
    fs.writeFileSync(path.join(this.paths.ocPluginsDir, 'jeff-bridge.js'), plugin, 'utf8')
  }

  /** 内置使用说明 skill（所有 agent 可调用 /jeff-usage 或被自动加载） */
  writeUsageSkill(): void {
    const dir = path.join(this.paths.ocSkillsDir, 'jeff-usage')
    fs.mkdirSync(dir, { recursive: true })
    const content = `---
name: jeff-usage
description: Jeff 桌面应用的完整使用说明：智能体、项目群（leader 统筹）、任务看板、记忆、WebDAV 同步。当用户问「Jeff 怎么用 / 能做什么」时加载。
---

# Jeff 使用说明

Jeff 把「开发 + 项目管理」组织成三个概念（微信心智模型）：

## 1. 智能体 = 聊天好友
- 每个智能体是会话列表里的一个联系人，有自己的身份指令、默认模型、长期记忆。
- 私聊 = 和这个智能体一对一协作（它带编码/MCP/技能工具，可以直接干活）。
- 创建途径：\u2460 找小杰说「帮我创建一个智能体」；\u2461 「智能体」页手动新建。

## 2. 项目群 = 微信群
- 一个项目就是一个群；群里有你 + 若干智能体成员（开发/UI/测试/产品…）。
- **只有一个群主（leader）**，所有工作由它统筹：群消息默认给 leader，@成员名 直达该成员。
- leader 用 jeff_delegate 工具把活儿委派给成员，成员独立执行后结果自动回群，leader 再汇总。
- 群资料面板：成员管理 + 任务看板（拖拽改状态）。

## 3. 任务 = JEF-n
- 任务归属项目群，编号 JEF-n，状态：待办/进行中/待审/完成/已取消；优先级四级。
- 创建途径：群里对话让 leader/小杰建（自动出现任务卡片）、或群资料看板手动建。

## 其他能力
- **记忆**：每个智能体有自己的长期记忆；项目群有共享记忆；全局用户画像由小杰维护（用 jeff_memory 工具读写）。设置页可人工查看/编辑。
- **会话搜索**：所有历史对话全文可搜（jeff_session_search）。
- **模型提供商**：设置页配置（Anthropic/OpenAI/DeepSeek/Kimi/智谱/硅基流动/OpenRouter/自定义 OpenAI 兼容端点）；聊天输入框可临时切换模型。
- **图片消息**：聊天输入框支持上传/粘贴/拖拽图片（需模型支持多模态，如 Qwen3.5、Qwen-VL、GPT-4o），智能体能看图回答。
- **WebDAV 同步**：设置页配置；同步智能体/项目/任务/设置/记忆（不含会话数据）；实体级双向合并，多台机器交替使用不丢数据。
- **亮/深夜模式**：左侧导航底部切换，或跟随系统。
`
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8')
  }

  writeSidecarConfig(): void {
    const kv = kvRepo(this.db)
    const providers = kv.getJSON<ProviderSetting[]>('settings:providers', [])
    const defaultModel = kv.getJSON<{ providerID: string; modelID: string } | null>('settings:defaultModel', null)
    writeSidecarConfig(this.paths, providers, { defaultModel: defaultModel ?? undefined, mcp: this.listMcp() })
  }

  /** MCP 连接器配置（存 kv，写入 sidecar opencode.json 的 mcp 字段） */
  listMcp(): Record<string, McpServerCfg> {
    return this.kv().getJSON<Record<string, McpServerCfg>>('settings:mcp', {})
  }

  async saveMcp(cfg: Record<string, McpServerCfg>): Promise<void> {
    this.kv().setJSON('settings:mcp', cfg)
    this.writeSidecarConfig()
    await this.restartSidecar()
  }

  /** 便捷访问器 */
  get agents() {
    return agentRepo(this.db)
  }

  kv() {
    return kvRepo(this.db)
  }

  listProviders(): ProviderSetting[] {
    return this.kv().getJSON<ProviderSetting[]>('settings:providers', [])
  }

  defaultModel(): { providerID: string; modelID: string } | null {
    return this.kv().getJSON<{ providerID: string; modelID: string } | null>('settings:defaultModel', null)
  }

  async saveProviders(providers: ProviderSetting[], defaultModel?: { providerID: string; modelID: string } | null): Promise<void> {
    this.kv().setJSON('settings:providers', providers)
    if (defaultModel !== undefined) this.kv().setJSON('settings:defaultModel', defaultModel ?? null)
    this.writeSidecarConfig()
    await this.restartSidecar()
  }

  /** 小杰默认模型兜底 */
  xiaojieAgentRow(): AgentRow {
    return agentRepo(this.db).get(XIAOJIE_ID)!
  }
}

export { sesMetaKey } from './tools/memoryTools.js'
export * from './ipc/contract.js'
export * from './db/repos.js'
export * from './oc/client.js'
export * from './oc/configWriter.js'
export * from './chat/private.js'
export { XIAOJIE_SLUG, agentSlug } from './agents/registry.js'
export { XIAOJIE_ID, BUILTIN_PROVIDER_PRESETS } from './ipc/contract.js'
export { SidecarManager } from './sidecar/manager.js'
export { ToolBridge } from './tools/bridge.js'
export { GroupChat } from './orchestrator/group.js'
export { Delegator } from './orchestrator/delegate.js'
export { registerProjectTools, taskCardMessage } from './tools/projectTools.js'
export { MemoryStore, parseEntries, matchUnique, type MemoryScope, type MemoryOp, type MemoryResult } from './memory/store.js'
export { SyncEngine, type WebdavConfig, type SyncReport } from './sync/engine.js'

export { SessionIndex, cjkSplit, buildMatchQuery } from './memory/indexer.js'
export { parseMcpServerJson } from './mcp/parse.js'
export { MEMORY_TOOL, SEARCH_TOOL, DELEGATE_TOOL, type SessionScopeCtx, type ToolCtx } from './tools/memoryTools.js'
