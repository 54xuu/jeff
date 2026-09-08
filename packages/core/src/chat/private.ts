import type { DB } from '../db/db.js'
import { agentRepo, kvRepo } from '../db/repos.js'
import { agentSlug } from '../agents/registry.js'
import type { OcClient, AssistantInfo } from '../oc/client.js'
import { agentPromptOpts } from '../util/modelKey.js'

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
  constructor(sessionId: string) {
    super('已停止生成')
    this.name = 'PrivateChatStoppedError'
    this.sessionId = sessionId
  }
  sessionId: string
}

/** 私聊（agent = 微信好友）：每个 agent 一条持续会话 */
export class PrivateChat {
  /** 并发 ensureSession 去重：同 agent 只建一个会话（防 send/新会话竞态下 KV 指针互相覆盖） */
  private ensureInflight = new Map<string, Promise<string>>()

  constructor(
    private db: DB,
    private getOc: () => OcClient,
    private hooks?: PrivateChatHooks,
  ) {}

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
    const s = await this.getOc().createSession({ title: `与 ${agentName} 的聊天`, agent: agentSlug(agentId) })
    kv.set(SESSION_KEY(agentId), s.id)
    this.hooks?.onSessionCreated?.(s.id, { kind: 'private', agentId })
    return s.id
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
    const sessionId = await this.ensureSession(agentId, agentName)
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
    const out: ChatMsg[] = []
    for (const m of msgs) {
      const info = m.info as { id: string; role?: string; time?: { created?: number }; agent?: string; error?: unknown }
      const role = info.role === 'user' ? 'user' : info.role === 'assistant' ? 'assistant' : 'system'
      const parts = m.parts || (info as { parts?: unknown[] }).parts || []
      let text = ''
      const reasoning: string[] = []
      const tools: NonNullable<ChatMsg['tools']> = []
      const images: NonNullable<ChatMsg['images']> = []
      for (const p of parts as Array<Record<string, unknown>>) {
        if (p.type === 'text' && !p.synthetic && typeof p.text === 'string' && p.text.trim()) {
          text += (text ? '\n' : '') + p.text
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
        time: info.time?.created || 0,
        ...(reasoning.length ? { reasoning } : {}),
        ...(tools.length ? { tools } : {}),
        ...(images.length ? { images } : {}),
      })
    }
    return out
  }
}
