import type { DB } from '../db/db.js'
import { agentRepo, kvRepo } from '../db/repos.js'
import { agentSlug } from '../agents/registry.js'
import type { OcClient, AssistantInfo } from '../oc/client.js'
import { agentPromptOpts } from '../util/modelKey.js'
import { composeAutoTitle, placeholderTitle } from '../util/title.js'

/** UI 侧聊天消息（私聊与群聊共用形状） */
export interface ChatMsg {
  id: string
  role: 'user' | 'assistant' | 'system'
  agentId?: string
  text: string
  time: number
  /** 思考过程（reasoning parts，按顺序拼接的段落） */
  reasoning?: string[]
  tools?: Array<{ tool: string; status?: string; output?: string; error?: string }>
  /** 消息携带的图片（用户发送或历史回放） */
  images?: Array<{ mime: string; dataUrl: string }>
  meta?: Record<string, unknown>
}

const SESSION_KEY = (agentId: string) => `session:private:${agentId}`
/**
 * 自动命名标记，值为会话创建时刻（毫秒）。
 * 存在 = 还没补任务名；首条消息补完后删除，手动改名也会删除（手动命名优先）。
 */
export const autoTitleKey = (sessionId: string) => `sesauto:${sessionId}`

export interface PrivateChatHooks {
  /** 每次确保会话前调用（用于惰性重启 sidecar 等） */
  beforeEnsure?: () => Promise<void>
  /** 新会话创建后记录元数据（session → jeff 语义映射） */
  onSessionCreated?: (sessionId: string, meta: { kind: 'private' | 'group' | 'review'; agentId: string; projectId?: string }) => void
  /** 每条消息的 system 注入（长期记忆块） */
  buildSystem?: (agentId: string, projectId?: string) => string | undefined
  /** 回复完成后（索引 + nudge） */
  afterReply?: (scope: { kind: 'private'; agentId: string } | { kind: 'group'; projectId: string; agentId: string }) => void
  /** 智能体未绑定模型时的会话兜底 */
  defaultModel?: () => { providerID: string; modelID: string } | null
  /** 调试日志（消息处理失败等现场） */
  onDebugLog?: (tag: string, detail: unknown) => void
}

/** 用户主动停止生成的可辨识错误（IPC 层映射为 stopped 结果，不与 provider 失败混同） */
export class PrivateChatStoppedError extends Error {
  /**
   * true = 本轮在建会话期间就被取消，请求从未发给引擎（引擎历史里没有这条用户消息）。
   * 界面据此保留本地记录，否则重拉历史会把用户刚敲的内容整段冲掉。
   */
  cancelled: boolean
  constructor(sessionId: string, cancelled = false) {
    super('已停止生成')
    this.name = 'PrivateChatStoppedError'
    this.sessionId = sessionId
    this.cancelled = cancelled
  }
  sessionId: string
}

/** 私聊（agent = 微信好友）：每个 agent 一条持续会话 */
export class PrivateChat {
  /** 并发 ensureSession 去重：同 agent 只建一个会话（防 send/新会话竞态下 KV 指针互相覆盖） */
  private ensureInflight = new Map<string, Promise<string>>()
  /** 在途发送（agentId）：首条消息时会话尚未建好，停止请求必须能落在「发送真正开始」之前 */
  private inFlight = new Set<string>()
  /** 会话建成前收到的停止意图（agentId）：建成后立即按「已停止」结束，不再真跑这一轮 */
  private pendingStop = new Set<string>()

  constructor(
    private db: DB,
    private getOc: () => OcClient,
    private hooks?: PrivateChatHooks,
  ) {}

  /**
   * 停止该 agent 的在途生成。
   * 关键：界面上的「发送中」是同步置位的，停止按钮在 ensureSession 建会话（首条消息冷启动可达数秒）
   * 期间就可点；此时 KV 里还没有 sessionId，旧实现 `if (sessionId)` 会把停止静默丢掉，
   * 用户点了停止界面却继续生成。这里改为「记下意图，会话建好立刻中断」。
   */
  async stop(agentId: string): Promise<{ sessionId: string | null; deferred: boolean }> {
    const sessionId = this.getSessionId(agentId)
    if (sessionId) {
      await this.getOc().abortSession(sessionId)
      return { sessionId, deferred: false }
    }
    const deferred = this.inFlight.has(agentId)
    if (deferred) this.pendingStop.add(agentId)
    return { sessionId: null, deferred }
  }

  /** 取该 agent 的活跃会话（不存在则创建并记录） */
  async ensureSession(agentId: string, agentName: string): Promise<string> {
    const inflight = this.ensureInflight.get(agentId)
    if (inflight) return inflight
    const p = this.doEnsureSession(agentId, agentName).finally(() => this.ensureInflight.delete(agentId))
    this.ensureInflight.set(agentId, p)
    return p
  }

  private async doEnsureSession(agentId: string, agentName: string): Promise<string> {
    await this.hooks?.beforeEnsure?.()
    const kv = kvRepo(this.db)
    const existing = kv.get(SESSION_KEY(agentId))
    if (existing) {
      try {
        await this.getOc().getSession(existing)
        return existing
      } catch {
        kv.delete(SESSION_KEY(agentId))
      }
    }
    const now = Date.now()
    const s = await this.getOc().createSession({ title: placeholderTitle(now), agent: agentSlug(agentId) })
    kv.set(SESSION_KEY(agentId), s.id)
    kv.set(autoTitleKey(s.id), String(now))
    this.hooks?.onSessionCreated?.(s.id, { kind: 'private', agentId })
    return s.id
  }

  /**
   * 首条用户消息发出前补会话名：`{创建时间戳}-{任务中文名称}`。
   * 标记位（值为创建时刻）保证只补一次，且手动改名后不再补。
   * 改名失败只记日志并保留标记（下一条消息重试），绝不打断用户发送。
   */
  private async maybeAutoTitle(sessionId: string, text: string): Promise<void> {
    const kv = kvRepo(this.db)
    const key = autoTitleKey(sessionId)
    const createdAt = Number(kv.get(key))
    if (!createdAt) return
    try {
      await this.getOc().updateSession(sessionId, { title: composeAutoTitle(createdAt, text) })
      kv.delete(key)
    } catch (err) {
      this.hooks?.onDebugLog?.('private-autotitle-fail', {
        sessionId,
        error: String((err as Error)?.message || err),
      })
    }
  }

  /** 开启全新会话（旧会话保留在 opencode 历史中） */
  async newSession(agentId: string, agentName: string): Promise<string> {
    await this.hooks?.beforeEnsure?.()
    kvRepo(this.db).delete(SESSION_KEY(agentId))
    return this.ensureSession(agentId, agentName)
  }

  getSessionId(agentId: string): string | null {
    return kvRepo(this.db).get(SESSION_KEY(agentId))
  }

  /**
   * 发送消息并等待回复完成。
   * 模型/思考以智能体资料为准；入参 model/variant 忽略（兼容旧调用方）。
   */
  async send(
    agentId: string,
    agentName: string,
    text: string,
    _model?: { providerID: string; modelID: string },
    images?: Array<{ mime: string; dataUrl: string }>,
    _variant?: string,
  ): Promise<AssistantInfo> {
    this.inFlight.add(agentId)
    try {
      return await this.doSend(agentId, agentName, text, images)
    } finally {
      this.inFlight.delete(agentId)
      this.pendingStop.delete(agentId)
    }
  }

  private async doSend(
    agentId: string,
    agentName: string,
    text: string,
    images?: Array<{ mime: string; dataUrl: string }>,
  ): Promise<AssistantInfo> {
    const sessionId = await this.ensureSession(agentId, agentName)
    // 建会话期间用户已点停止：这一轮直接按「已停止」收尾（否则停止被丢弃，界面一直转圈到超时）
    if (this.pendingStop.delete(agentId)) {
      this.hooks?.onDebugLog?.('private-send-stop', { agentId, sessionId, reason: 'stopped-before-session-ready' })
      throw new PrivateChatStoppedError(sessionId, true)
    }
    await this.maybeAutoTitle(sessionId, text)
    const agent = agentRepo(this.db).get(agentId)
    const opts = agentPromptOpts(agent, this.hooks?.defaultModel?.() ?? null)
    try {
      const reply = await this.getOc().sendMessage({
        sessionId,
        text,
        ...(images && images.length ? { images } : {}),
        agent: agentSlug(agentId),
        system: this.hooks?.buildSystem?.(agentId),
        ...opts,
      })
      this.hooks?.afterReply?.({ kind: 'private', agentId })
      return reply
    } catch (err) {
      const msg = String((err as Error)?.message || err)
      // 只有最近确实点过停止才算「已停止」；provider 超时/中断等也含 abort 字样，须落日志留现场
      const stopped = /abort/i.test(msg) && this.getOc().isAbortRequested(sessionId)
      this.hooks?.onDebugLog?.(stopped ? 'private-send-stop' : 'private-send-fail', {
        agentId,
        sessionId,
        error: msg,
        stack: (err as Error)?.stack,
      })
      // 停止是用户预期行为：抛专用错误，由 IPC 层转成 stopped 结果，UI 不显示「发送失败」
      if (stopped) throw new PrivateChatStoppedError(sessionId)
      throw err
    }
  }

  /** 读取历史消息（映射为 UI 形状） */
  async history(agentId: string): Promise<ChatMsg[]> {
    const sessionId = this.getSessionId(agentId)
    if (!sessionId) return []
    return this.mapSessionMessages(sessionId)
  }

  async mapSessionMessages(sessionId: string): Promise<ChatMsg[]> {
    const msgs = await this.getOc().getMessages(sessionId)
    // 末尾 assistant 消息 = 本轮最终答复；只有它之前的「工具步」正文才算推导/前言。
    let lastAssistantIdx = -1
    msgs.forEach((m, i) => {
      if ((m.info as { role?: string })?.role === 'assistant') lastAssistantIdx = i
    })
    const out: ChatMsg[] = []
    for (let mi = 0; mi < msgs.length; mi++) {
      const m = msgs[mi]
      const info = m.info as { id: string; role?: string; time?: { created?: number; completed?: number }; agent?: string; error?: unknown }
      const role = info.role === 'user' ? 'user' : info.role === 'assistant' ? 'assistant' : 'system'
      const parts = (m.parts || (info as { parts?: unknown[] }).parts || []) as Array<Record<string, unknown>>
      let text = ''
      const reasoning: string[] = []
      const tools: NonNullable<ChatMsg['tools']> = []
      const images: NonNullable<ChatMsg['images']> = []
      // 中间步（带工具调用、且后面还有最终答复）：它的正文是「工具调用前的推导/前言」，
      // 流式期间由思考区展示，历史回放同样收进思考区，避免同一内容在流式/历史两处位置不一致。
      const toolStep = mi < lastAssistantIdx && parts.some((p) => p.type === 'tool')
      for (const p of parts) {
        if (p.type === 'text' && !p.synthetic && typeof p.text === 'string' && p.text.trim()) {
          if (toolStep) reasoning.push(p.text)
          else text += (text ? '\n' : '') + p.text
        } else if (p.type === 'reasoning' && typeof p.text === 'string' && p.text.trim()) {
          reasoning.push(p.text)
        } else if (p.type === 'file' && typeof p.url === 'string' && p.url.startsWith('data:')) {
          images.push({ mime: String(p.mime || 'image/png'), dataUrl: p.url })
        } else if (p.type === 'tool') {
          const st = (p.state || {}) as { status?: string; output?: string; error?: string }
          tools.push({ tool: String(p.tool || ''), status: st.status, output: (st.output || '').slice(0, 2000), error: st.error })
        }
      }
      if (role === 'assistant' && !text.trim() && tools.length === 0) continue
      out.push({
        id: info.id,
        role,
        agentId: info.agent,
        text,
        // 界面时间要能用来量「这一轮花了多久」：智能体消息取完成时刻（与群聊落库 created_at 同理），
        // 用户消息取发送时刻。若用创建的 created，思考 + 工具的耗时会全部漏掉。
        time: (role === 'assistant' ? info.time?.completed ?? info.time?.created : info.time?.created) || 0,
        ...(reasoning.length ? { reasoning } : {}),
        ...(tools.length ? { tools } : {}),
        ...(images.length ? { images } : {}),
      })
    }
    return out
  }
}
