import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { buildPaths, ensureDirs, jeffRoot, type JeffPaths } from './paths.js'
import { openDb, type DB } from './db/db.js'
import { agentRepo, kvRepo, chatMessageRepo, projectRepo, projectAgentRepo, type AgentRow } from './db/repos.js'
import { SidecarManager } from './sidecar/manager.js'
import { OcClient } from './oc/client.js'
import { writeSidecarConfig, migrateProviders, firstEnabledModel, configuredModelOptions, type ProviderSetting } from './oc/configWriter.js'
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
import { probeMcpAll } from './mcp/probe.js'
import type { SkillsBackupReport, SkillsRestoreStage, SkillsRestoreApply, ContextPreviewInfo } from './ipc/contract.js'
import { SyncEngine, type WebdavConfig, type SyncReport, normalizeWebdavBasePath } from './sync/engine.js'
import { compactionThreshold, splitContextMessages } from './chat/context.js'

export const APP_VERSION = '1.3.0'

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
      onChanged: () => this.bus.emit('data-changed', 'memory'),
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
    const e2e = process.env.JEFF_E2E === '1'
    this.sidecar = new SidecarManager({
      paths: this.paths,
      resourceBinDir: opts.resourceBinDir,
      binaryPath: opts.binaryPath,
      // E2E 避开本机日常 Jeff 占用的 14096+ 端口段
      ...(e2e ? { minPort: 16096, maxPort: 17096 } : {}),
    })
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
    const report = await this.sync.sync()
    if (report.ok) {
      this.syncRegistry()
      this.writeSidecarConfig()
      this.markRegistryDirty()
      this.bus.emit('data-changed', 'agents')
      this.bus.emit('data-changed', 'projects')
      this.bus.emit('data-changed', 'settings')
    }
    return report
  }

  /** 配置 WebDAV（密码存本地 kv；password 空串则保留已存密码）。不自动 sync——由 UI「保存并同步」/「立即同步」或防抖触发，避免与紧随其后的 syncNow 撞重入锁。 */
  async configureSync(cfg: WebdavConfig): Promise<void> {
    const prev = this.kv().getJSON<WebdavConfig | null>('settings:webdav', null)
    const next: WebdavConfig = {
      url: cfg.url,
      username: cfg.username,
      password: cfg.password || prev?.password || '',
      basePath: normalizeWebdavBasePath(cfg.basePath || prev?.basePath),
      autoSync: !!cfg.autoSync,
      timeoutMs: cfg.timeoutMs ?? prev?.timeoutMs ?? 60_000,
      tlsVerify: cfg.tlsVerify !== false,
    }
    this.kv().setJSON('settings:webdav', next)
    this.sync.resetClient()
  }

  syncConfig(): Omit<WebdavConfig, 'password'> | null {
    const cfg = this.kv().getJSON<WebdavConfig | null>('settings:webdav', null)
    if (!cfg?.url) return null
    const { password: _password, ...rest } = cfg
    return {
      ...rest,
      timeoutMs: rest.timeoutMs ?? 60_000,
      tlsVerify: rest.tlsVerify !== false,
    }
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

  /** 记忆注入：agent 记忆 + 项目记忆（群聊）+ 全局用户画像 + AGENTS.md（用户级/项目级） */
  buildMemorySystem(agentId: string, projectId?: string): string | undefined {
    const blocks: string[] = []
    for (const md of this.agentsMdBlocks(projectId)) blocks.push(md)
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
      '【长期记忆与规则（Jeff）】以下是关于用户/项目的持久记忆与 AGENTS.md 规则，供你参考；如与当前对话冲突，以对话为准，记忆可用 jeff_memory 工具更新。',
      ...blocks,
    ].join('\n')
  }

  // ---------- 历史会话（聊天记录抽屉） ----------
  /** 某智能体的全部会话（opencode 会话列表按 agent slug/标题过滤 + 当前会话标记） */
  async listAgentSessions(agentId: string): Promise<Array<{ id: string; title: string; updatedAt: number; active: boolean; agentId: string; agentName: string }>> {
    const agent = agentRepo(this.db).get(agentId)
    if (!agent) throw new Error('智能体不存在')
    const slug = agentSlug(agentId)
    const current = this.privateChat.getSessionId(agentId)
    const all = await this.oc.listSessions()
    const prefix = `与 ${agent.name} 的聊天`
    return all
      .filter((s) => {
        if (s.id === current) return true
        const info = s as { agent?: string; title?: string; time?: { updated?: number } }
        return info.agent === slug || (typeof info.title === 'string' && info.title.startsWith(prefix))
      })
      .map((s) => ({
        id: s.id,
        title: s.title || '（未命名会话）',
        updatedAt: (s as { time?: { updated?: number } }).time?.updated || 0,
        active: s.id === current,
        agentId,
        agentName: agent.name,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 项目群话题列表（扁平聊天记录） */
  listGroupThreads(projectId: string): Array<{ id: string; title: string; updatedAt: number; createdAt: number; active: boolean; messageCount: number }> {
    if (!projectRepo(this.db).get(projectId)) throw new Error('项目不存在')
    const active = this.groupChat.threads.ensureActiveThread(projectId)
    return this.groupChat.threads.listThreads(projectId).map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      createdAt: t.createdAt,
      active: t.id === active,
      messageCount: this.groupChat.history(projectId, t.id).length,
    }))
  }

  /** 预览某段群话题的消息 */
  previewGroupThread(projectId: string, threadId: string) {
    return this.groupChat.history(projectId, threadId)
  }

  newGroupThread(projectId: string, title?: string): { threadId: string; title: string } {
    if (!projectRepo(this.db).get(projectId)) throw new Error('项目不存在')
    const t = this.groupChat.threads.createThread(projectId, title)
    return { threadId: t.id, title: t.title }
  }

  activateGroupThread(projectId: string, threadId: string): void {
    this.groupChat.threads.setActive(projectId, threadId)
  }

  renameGroupThread(projectId: string, threadId: string, title: string): { id: string; title: string } {
    const t = this.groupChat.threads.rename(projectId, threadId, title)
    return { id: t.id, title: t.title }
  }

  async deleteGroupThread(projectId: string, threadId: string): Promise<{ ok: boolean }> {
    const { ocSessionIds } = this.groupChat.threads.deleteThread(projectId, threadId)
    for (const sid of ocSessionIds) {
      await this.oc.deleteSession(sid).catch(() => {})
    }
    return { ok: true }
  }

  /** @deprecated 保留给旧 IPC；群侧请用 listGroupThreads */
  async listGroupSessions(projectId: string): Promise<Array<{ id: string; title: string; updatedAt: number; active: boolean; agentId: string; agentName: string }>> {
    const threads = this.listGroupThreads(projectId)
    return threads.map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      active: t.active,
      agentId: '',
      agentName: '群',
    }))
  }

  /** 预览任意会话完整历史 */
  async previewSession(sessionId: string) {
    return this.privateChat.mapSessionMessages(sessionId)
  }

  /** 切换当前会话（私聊） */
  activateSession(scope: 'private' | 'group', agentId: string, sessionId: string, projectId?: string): void {
    const kv = this.kv()
    if (scope === 'group' && projectId) {
      // 群侧请用 activateGroupThread；此处兼容：若 sessionId 是 threadId
      try {
        this.groupChat.threads.setActive(projectId, sessionId)
      } catch {
        const tid = this.groupChat.threads.ensureActiveThread(projectId)
        kv.set(`session:group:${projectId}:${tid}:${agentId}`, sessionId)
      }
    } else {
      kv.set(`session:private:${agentId}`, sessionId)
    }
  }

  /** 删除会话；若是某处的当前会话则清掉指针（避免悬空） */
  async deleteSession(sessionId: string): Promise<void> {
    await this.oc.deleteSession(sessionId)
    const kv = this.kv()
    const rows = kv.prefixScan('session:')
    for (const [key, value] of rows) {
      if (value === sessionId) kv.delete(key)
    }
  }

  /** 重命名会话标题（私聊 opencode session） */
  async renameSession(sessionId: string, title: string): Promise<{ id: string; title: string }> {
    const t = title.trim()
    if (!t) throw new Error('标题不能为空')
    const s = await this.oc.updateSession(sessionId, { title: t })
    return { id: s.id, title: s.title || t }
  }

  /** 已配置模型选项（只含启用提供商的模型；composer/智能体表单共用） */
  configuredModels() {
    return configuredModelOptions(this.listProviders())
  }

  /** 解析当前会话使用的模型（覆盖 → agent 绑定 → 全局默认） */
  resolveModel(agentId: string, override?: { providerID: string; modelID: string } | null): { providerID: string; modelID: string } | null {
    if (override?.providerID && override?.modelID) return override
    const agent = agentRepo(this.db).get(agentId)
    if (agent?.model_provider && agent?.model_id) return { providerID: agent.model_provider, modelID: agent.model_id }
    return this.defaultModel()
  }

  private modelLimits(model: { providerID: string; modelID: string } | null): { contextLimit: number | null; outputLimit: number | null } {
    if (!model) return { contextLimit: null, outputLimit: null }
    const opt = this.configuredModels().find((m) => m.providerID === model.providerID && m.modelID === model.modelID)
    return {
      contextLimit: opt?.contextLimit ?? null,
      outputLimit: opt?.outputLimit ?? null,
    }
  }

  /** 对话上下文预览（占用、system、compact 摘要、活跃消息） */
  async contextPreview(input: { agentId: string; projectId?: string; model?: { providerID: string; modelID: string } }): Promise<ContextPreviewInfo> {
    const { agentId, projectId } = input
    if (!agentRepo(this.db).get(agentId)) throw new Error('智能体不存在')
    const sessionId = projectId
      ? this.groupChat.getSessionId(projectId, agentId)
      : this.privateChat.getSessionId(agentId)
    const model = this.resolveModel(agentId, input.model)
    const { contextLimit, outputLimit } = this.modelLimits(model)
    const threshold = compactionThreshold(contextLimit ?? undefined, outputLimit ?? undefined)
    const system = this.buildMemorySystem(agentId, projectId) || null

    if (!sessionId) {
      return {
        sessionId: null,
        agentId,
        ...(projectId ? { projectId } : {}),
        usedTokens: 0,
        contextLimit,
        outputLimit,
        threshold,
        autoEnabled: !!contextLimit && contextLimit > 0,
        system,
        summary: null,
        activeMessages: [],
        compactedCount: 0,
      }
    }

    const msgs = await this.oc.getMessages(sessionId)
    const parts = splitContextMessages(msgs)
    return {
      sessionId,
      agentId,
      ...(projectId ? { projectId } : {}),
      usedTokens: parts.usedTokens,
      contextLimit,
      outputLimit,
      threshold,
      autoEnabled: !!contextLimit && contextLimit > 0,
      system,
      summary: parts.summary,
      activeMessages: parts.activeMessages,
      compactedCount: parts.compactedCount,
    }
  }

  /** 手动压缩当前会话（调用 opencode summarize） */
  async contextCompress(input: {
    agentId: string
    projectId?: string
    model?: { providerID: string; modelID: string }
  }): Promise<ContextPreviewInfo> {
    const { agentId, projectId } = input
    if (!agentRepo(this.db).get(agentId)) throw new Error('智能体不存在')
    const sessionId = projectId
      ? this.groupChat.getSessionId(projectId, agentId)
      : this.privateChat.getSessionId(agentId)
    if (!sessionId) throw new Error('当前没有可压缩的会话')
    const model = this.resolveModel(agentId, input.model)
    if (!model) throw new Error('未配置模型，无法压缩')
    await this.oc.summarize({ sessionId, providerID: model.providerID, modelID: model.modelID, auto: false })
    return this.contextPreview(input)
  }

  /** 群聊最近一次回复的 agent（用于上下文默认成员） */
  lastGroupAgentId(projectId: string): string | null {
    const sessionId = this.groupChat.threads.getLastOcSession(projectId)
    if (!sessionId) return null
    const threadId = this.groupChat.threads.getActiveThreadId(projectId)
    const members = projectAgentRepo(this.db).listByProject(projectId)
    for (const m of members) {
      if (this.groupChat.getSessionId(projectId, m.agent_id, threadId || undefined) === sessionId) return m.agent_id
    }
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE key LIKE ?").all(`session:group:${projectId}:%`) as Array<{ key: string; value: string }>
    for (const r of rows) {
      if (r.value === sessionId) {
        // session:group:projectId:threadId:agentId
        const m = /session:group:[^:]+:[^:]+:(.+)/.exec(r.key)
        if (m) return m[1]
        const legacy = /session:group:[^:]+:(.+)/.exec(r.key)
        if (legacy && !legacy[1].includes(':')) return legacy[1]
      }
    }
    return null
  }

  /** 停止群聊当前生成（abort 最近路由的会话） */
  async abortGroup(projectId: string): Promise<void> {
    const sessionId = this.groupChat.threads.getLastOcSession(projectId)
    if (sessionId) await this.oc.abortSession(sessionId)
  }

  /** AGENTS.md 注入块：用户级权威副本 + 项目级权威副本；工作空间旧文件仅作本机额外注入 */
  agentsMdBlocks(projectId?: string): string[] {
    const out: string[] = []
    try {
      const userFile = this.paths.agentsMdUser
      if (fs.existsSync(userFile)) {
        const text = fs.readFileSync(userFile, 'utf8').trim()
        if (text) out.push(`【AGENTS.md · 用户级】（${userFile}）\n${text}`)
      }
      if (projectId) {
        const auth = path.join(this.paths.agentsMdDir, `${projectId}.md`)
        if (fs.existsSync(auth)) {
          const text = fs.readFileSync(auth, 'utf8').trim()
          if (text) out.push(`【AGENTS.md · 项目级】（${auth}）\n${text}`)
        }
        const project = projectRepo(this.db).get(projectId)
        const dir = project?.workspace_dir || this.paths.workspaceDir
        const legacy = path.join(dir, 'AGENTS.md')
        if (fs.existsSync(legacy) && path.resolve(legacy) !== path.resolve(auth)) {
          const text = fs.readFileSync(legacy, 'utf8').trim()
          if (text) out.push(`【AGENTS.md · 工作空间】（${legacy}）\n${text}`)
        }
      }
    } catch {
      /* 读取失败不注入 */
    }
    return out
  }

  /** AGENTS.md 文件清单（设置页编辑用；项目级指向权威副本） */
  agentsMdList(): Array<{ kind: 'user' | 'project'; id: string; label: string; file: string; exists: boolean }> {
    const out: Array<{ kind: 'user' | 'project'; id: string; label: string; file: string; exists: boolean }> = []
    const userFile = this.paths.agentsMdUser
    out.push({ kind: 'user', id: 'user', label: '用户级 AGENTS.md（全局）', file: userFile, exists: fs.existsSync(userFile) })
    for (const p of projectRepo(this.db).list()) {
      const file = path.join(this.paths.agentsMdDir, `${p.id}.md`)
      const legacy = path.join(p.workspace_dir || this.paths.workspaceDir, 'AGENTS.md')
      out.push({
        kind: 'project',
        id: p.id,
        label: `${p.icon} ${p.title}`,
        file,
        exists: fs.existsSync(file) || fs.existsSync(legacy),
      })
    }
    return out
  }

  agentsMdGet(kind: 'user' | 'project', id: string): { content: string; file: string } {
    const list = this.agentsMdList()
    const hit = list.find((x) => x.kind === kind && x.id === id)
    if (!hit) throw new Error('AGENTS.md 条目不存在')
    let content = ''
    if (fs.existsSync(hit.file)) content = fs.readFileSync(hit.file, 'utf8')
    else if (kind === 'project') {
      const p = projectRepo(this.db).get(id)
      const legacy = path.join(p?.workspace_dir || this.paths.workspaceDir, 'AGENTS.md')
      if (fs.existsSync(legacy)) content = fs.readFileSync(legacy, 'utf8')
    }
    return { content, file: hit.file }
  }

  agentsMdSave(kind: 'user' | 'project', id: string, content: string): void {
    const list = this.agentsMdList()
    const hit = list.find((x) => x.kind === kind && x.id === id)
    if (!hit) throw new Error('AGENTS.md 条目不存在')
    fs.mkdirSync(path.dirname(hit.file), { recursive: true })
    fs.writeFileSync(hit.file, content, 'utf8')
    this.bus.emit('data-changed', 'agentsmd')
  }

  // ---------- skills 备份/恢复（委托 SyncEngine；安全模型见 engine.ts） ----------
  async skillsBackupNow(): Promise<SkillsBackupReport> {
    return this.sync.backupSkills()
  }

  lastSkillsBackup(): (SkillsBackupReport & { fileCount?: number }) | null {
    return this.sync.lastSkillsBackup()
  }

  async skillsRestoreStage(): Promise<SkillsRestoreStage> {
    return this.sync.restoreSkillsStage()
  }

  async skillsRestoreApply(): Promise<SkillsRestoreApply> {
    return this.sync.restoreSkillsApply()
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
        // session:group:projectId:threadId:agentId
        const withThread = /session:group:([^:]+):([^:]+):(.+)/.exec(r.key)
        if (withThread) return { kind: 'group', projectId: withThread[1], agentId: withThread[3] }
        const legacy = /session:group:([^:]+):(.+)/.exec(r.key)
        if (legacy) return { kind: 'group', projectId: legacy[1], agentId: legacy[2] }
      }
    }
    return null
  }

  /** SSE 事件 → bus（UI 刷新信号 + 流式增量） */
  private streamParts = new Map<string, { text: string; reasoning: string }>() // key: sessionId:messageId:partId
  private streamTools = new Map<string, Map<string, { tool: string; status?: string }>>() // key: sessionId:messageId → partId → tool
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

    // 流式：text / reasoning part 增量（field==='text' 正文，'reasoning' 思考）
    if (evt.type === 'message.part.delta') {
      const { messageID, partID, field, delta } = props as { messageID?: string; partID?: string; field?: string; delta?: string }
      if (!messageID || !partID || !delta) return
      if (field !== 'text' && field !== 'reasoning') return
      if (this.msgRoles.get(messageID) && this.msgRoles.get(messageID) !== 'assistant') return
      const key = `${sessionId}:${messageID}:${partID}`
      const cur = this.streamParts.get(key) || { text: '', reasoning: '' }
      if (field === 'text') cur.text += delta
      else cur.reasoning += delta
      this.streamParts.set(key, cur)
      this.emitStream(sessionId, messageID)
      return
    }

    // 流式纠偏：part.updated 带全量文本，比增量拼接长则以它为准；tool part 更新运行状态
    if (evt.type === 'message.part.updated') {
      const part = props.part as { id?: string; messageID?: string; type?: string; text?: string; tool?: string; state?: { status?: string } } | undefined
      if (!part?.id || !part.messageID) return
      if (this.msgRoles.get(part.messageID) && this.msgRoles.get(part.messageID) !== 'assistant') return
      if (part.type === 'text' && typeof part.text === 'string') {
        const key = `${sessionId}:${part.messageID}:${part.id}`
        const cur = this.streamParts.get(key)
        if (cur && part.text.length >= cur.text.length) cur.text = part.text
        else if (!cur && part.text) this.streamParts.set(key, { text: part.text, reasoning: '' })
        this.emitStream(sessionId, part.messageID)
        return
      }
      if (part.type === 'reasoning' && typeof part.text === 'string') {
        const key = `${sessionId}:${part.messageID}:${part.id}`
        const cur = this.streamParts.get(key)
        if (cur && part.text.length >= cur.reasoning.length) cur.reasoning = part.text
        else if (!cur && part.text) this.streamParts.set(key, { text: '', reasoning: part.text })
        this.emitStream(sessionId, part.messageID)
        return
      }
      if (part.type === 'tool' && part.tool) {
        const tools = this.streamTools.get(`${sessionId}:${part.messageID}`) || new Map()
        tools.set(part.id, { tool: part.tool, status: part.state?.status })
        this.streamTools.set(`${sessionId}:${part.messageID}`, tools)
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
      for (const key of Array.from(this.streamTools.keys())) {
        if (key.startsWith(`${sessionId}:`)) this.streamTools.delete(key)
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
    const texts: string[] = []
    const reasonings: string[] = []
    for (const [key, v] of this.streamParts) {
      if (!key.startsWith(`${sessionId}:${messageId}:`)) continue
      if (v.text) texts.push(v.text)
      if (v.reasoning) reasonings.push(v.reasoning)
    }
    const text = texts.join('\n')
    const reasoning = reasonings.join('\n')
    const tools = this.streamTools.get(`${sessionId}:${messageId}`)
    const toolList = tools ? Array.from(tools.values()) : undefined
    if (resolved.kind === 'group') {
      this.bus.emit('chat-stream', { kind: 'group', projectId: resolved.projectId, agentId: resolved.agentId, messageId, text, reasoning: reasoning || undefined, tools: toolList, done: false })
    } else {
      this.bus.emit('chat-stream', { kind: 'private', agentId: resolved.agentId, messageId, text, reasoning: reasoning || undefined, tools: toolList, done: false })
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

  /** 内置小杰：不存在则创建；存在则仅在指令漂移时对齐（避免每次启动顶 updated_at） */
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
    const cur = agents.get(XIAOJIE_ID)
    if (cur && cur.instructions !== XIAOJIE_INSTRUCTIONS) {
      agents.update(XIAOJIE_ID, { instructions: XIAOJIE_INSTRUCTIONS })
    }
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
- 一个项目就是一个群；群里有你 + 一个群主（leader）+ 若干工作者（worker）。工作者是统一角色，不做开发/UI/测试/产品等细分类。
- **只有一个群主（leader）**，所有工作由它统筹：群消息默认给 leader，@成员名 直达该成员。
- leader 用 jeff_delegate 工具把活儿委派给 worker，worker 独立执行后结果自动回群，leader 再汇总。
- 群资料面板：成员管理 + 任务看板（拖拽改状态）。

## 3. 任务 = JEF-n
- 任务归属项目群，编号 JEF-n，状态：待办/进行中/待审/完成/已取消；优先级四级。
- 创建途径：群里对话让 leader/小杰建（自动出现任务卡片）、或群资料看板手动建。

## 其他能力
- **记忆**：每个智能体有自己的长期记忆；项目群有共享记忆；全局用户画像由小杰维护（用 jeff_memory 工具读写，用户说「记住/忘记/整理记忆」即可）。设置页可人工查看、删除单条；每个范围有字符预算防止 token 浪费。
- **AGENTS.md**：用户级（数据目录 AGENTS.md）与项目级（工作空间目录 AGENTS.md）规则文件，每轮对话自动注入；设置 → 记忆页可编辑。
- **会话搜索**：所有历史对话全文可搜（jeff_session_search）。
- **模型提供商**：设置页配置自定义提供商（Chat / Responses / Anthropic 三种 API 格式），每个模型可配上下文/最大输出/图片输入/思考档位（none/low/high/max）；聊天输入框可切换模型与思考程度。新会话默认用第一个启用提供商的第一个模型。
- **MCP**：设置页粘贴 JSON 导入（支持 mcpServers 包裹格式），可查看每个服务的连接状态与工具清单（请到设置配置，小杰无 MCP 工具）。
- **图片消息**：聊天输入框支持上传/粘贴/拖拽图片（需模型支持图片输入），智能体能看图回答。
- **项目群工作空间**：发起群聊可选工作空间目录，群内产出的文件默认保存到该目录。
- **WebDAV 同步**：设置页配置；同步智能体/项目群/任务/设置（含 MCP）/记忆/AGENTS.md + 备份 ~/.agents/skills（单向备份，本地永不自动改写）；项目工作空间路径按设备保留；实体级双向合并。同步或恢复 skills 后可用菜单「重启 Jeff」整应用重开。
- **亮/深夜模式**：左侧导航底部切换，或跟随系统。
- **小杰能代操**：智能体 CRUD、项目群建改/解散、任务、记忆与会话搜索。须去设置的：模型供应商、MCP、WebDAV/skills、主题与引擎。
`
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8')
  }

  writeSidecarConfig(): void {
    const kv = kvRepo(this.db)
    const providers = this.listProviders()
    writeSidecarConfig(this.paths, providers, { mcp: this.listMcp() })
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

  /** 探测全部 MCP：连接 + tools/list（设置页展示状态与工具清单；与 sidecar 无关） */
  async probeMcp(): Promise<Awaited<ReturnType<typeof probeMcpAll>>> {
    return probeMcpAll(this.listMcp())
  }

  /** 便捷访问器 */
  get agents() {
    return agentRepo(this.db)
  }

  kv() {
    return kvRepo(this.db)
  }

  listProviders(): ProviderSetting[] {
    // migrateProviders 兼容旧 kv：丢弃 builtin、补齐新字段
    return migrateProviders(this.kv().getJSON<unknown>('settings:providers', []))
  }

  /** 会话兜底模型（动态）：第一个启用提供商的第一个模型 */
  defaultModel(): { providerID: string; modelID: string } | null {
    return firstEnabledModel(this.listProviders())
  }

  async saveProviders(providers: ProviderSetting[]): Promise<void> {
    this.kv().setJSON('settings:providers', providers)
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
export { compactionThreshold, splitContextMessages, tokenUsage, COMPACTION_BUFFER, type ContextPreview } from './chat/context.js'
export { XIAOJIE_SLUG, agentSlug } from './agents/registry.js'
export { XIAOJIE_ID } from './ipc/contract.js'
export { SidecarManager } from './sidecar/manager.js'
export { ToolBridge } from './tools/bridge.js'
export { GroupChat } from './orchestrator/group.js'
export { Delegator } from './orchestrator/delegate.js'
export { registerProjectTools, taskCardMessage } from './tools/projectTools.js'
export { MemoryStore, parseEntries, matchUnique, type MemoryScope, type MemoryOp, type MemoryResult } from './memory/store.js'
export { SyncEngine, type WebdavConfig, type SyncReport, normalizeWebdavBasePath, formatWebdavError } from './sync/engine.js'
export { probeMcpServer, probeMcpAll, type McpProbe } from './mcp/probe.js'
export { migrateProviders, firstEnabledModel, configuredModelOptions, thinkingVariant, API_FORMAT_NPM, ANTHROPIC_BUDGET, type ConfiguredModelOption } from './oc/configWriter.js'

export { SessionIndex, cjkSplit, buildMatchQuery } from './memory/indexer.js'
export { parseMcpServerJson } from './mcp/parse.js'
export { MEMORY_TOOL, SEARCH_TOOL, DELEGATE_TOOL, type SessionScopeCtx, type ToolCtx } from './tools/memoryTools.js'
export { formatModelKey, parseModelKey, modelDisplayLabel } from './util/modelKey.js'
export { normalizeProjectRole, projectRoleLabel, PROJECT_ROLES, type ProjectRole } from './util/projectRole.js'
