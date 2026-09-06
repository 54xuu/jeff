import type { DB } from '../db/db.js'
import { kvRepo } from '../db/repos.js'
import { agentSlug } from '../agents/registry.js'
import type { OcClient, AssistantInfo } from '../oc/client.js'

/** UI 侧聊天消息（私聊与群聊共用形状） */
export interface ChatMsg {
  id: string
  role: 'user' | 'assistant' | 'system'
  agentId?: string
  text: string
  time: number
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
}

/** 私聊（agent = 微信好友）：每个 agent 一条持续会话 */
export class PrivateChat {
  constructor(
    private db: DB,
    private getOc: () => OcClient,
    private hooks?: PrivateChatHooks,
  ) {}

  /** 取该 agent 的活跃会话（不存在则创建并记录） */
  async ensureSession(agentId: string, agentName: string): Promise<string> {
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

  /** 发送消息并等待回复完成 */
  async send(
    agentId: string,
    agentName: string,
    text: string,
    model?: { providerID: string; modelID: string },
    images?: Array<{ mime: string; dataUrl: string }>,
    variant?: string,
  ): Promise<AssistantInfo> {
    const sessionId = await this.ensureSession(agentId, agentName)
    const reply = await this.getOc().sendMessage({
      sessionId,
      text,
      ...(images && images.length ? { images } : {}),
      agent: agentSlug(agentId),
      system: this.hooks?.buildSystem?.(agentId),
      ...(model && model.providerID && model.modelID ? { model } : {}),
      ...(variant ? { variant } : {}),
    })
    this.hooks?.afterReply?.({ kind: 'private', agentId })
    return reply
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
      const tools: NonNullable<ChatMsg['tools']> = []
      const images: NonNullable<ChatMsg['images']> = []
      for (const p of parts as Array<Record<string, unknown>>) {
        if (p.type === 'text' && !p.synthetic && typeof p.text === 'string' && p.text.trim()) {
          text += (text ? '\n' : '') + p.text
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
        ...(tools.length ? { tools } : {}),
        ...(images.length ? { images } : {}),
      })
    }
    return out
  }
}
