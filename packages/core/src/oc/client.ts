import { EventEmitter } from 'node:events'
import { sleep } from '../sidecar/manager.js'

/**
 * opencode server 薄客户端（基于其 OpenAPI HTTP 面，1.18.x 验证）。
 * 刻意不依赖 @opencode-ai/sdk：接口面窄而稳定，避免 SDK 版本耦合。
 */
export class OcClient extends EventEmitter {
  constructor(public port: number) {
    super()
  }

  private base(): string {
    return `http://127.0.0.1:${this.port}`
  }

  private async req<T>(method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
    const res = await fetch(`${this.base()}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`opencode ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
    }
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('json')) return undefined as T
    return (await res.json()) as T
  }

  // ---------- 会话 ----------
  async createSession(input: { title?: string; agent?: string; model?: { providerID: string; id: string } }): Promise<SessionInfo> {
    return this.req('POST', '/session', input)
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    return this.req('GET', `/session/${sessionId}`)
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.req('GET', '/session')
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.req('DELETE', `/session/${sessionId}`)
  }

  /** 获取会话消息（含 user/assistant 与 parts） */
  async getMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.req('GET', `/session/${sessionId}/message`)
  }

  /**
   * 发送一条用户消息并等待 assistant 回复完成。
   * @returns 完成的 assistant 消息 info
   */
  async sendMessage(input: {
    sessionId: string
    text: string
    agent?: string
    model?: { providerID: string; modelID: string }
    system?: string
    noReply?: boolean
    timeoutMs?: number
  }): Promise<AssistantInfo> {
    const returned = await this.req<{ info?: AssistantInfo; id?: string }>(
      'POST',
      `/session/${input.sessionId}/message`,
      {
        parts: [{ type: 'text', text: input.text }],
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.noReply ? { noReply: true } : {}),
      },
      60000,
    )
    const assistantId = returned?.info?.id ?? returned?.id
    if (!assistantId) throw new Error('发送消息未返回 assistant 消息 id')
    const deadline = Date.now() + (input.timeoutMs ?? 180000)
    for (;;) {
      const msgs = await this.getMessages(input.sessionId)
      const found = msgs.find((m) => m.info?.id === assistantId)?.info as AssistantInfo | undefined
      if (found) {
        if (found.error) throw new Error(`assistant 消息出错: ${JSON.stringify(found.error).slice(0, 300)}`)
        if (found.time?.completed) return found
      } else if (Date.now() > deadline) {
        throw new Error('assistant 消息未创建（超时）')
      }
      if (Date.now() > deadline) throw new Error('等待 assistant 回复超时')
      await sleep(400)
    }
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.req('POST', `/session/${sessionId}/abort`).catch(() => {})
  }

  // ---------- agent / provider ----------
  async listAgents(): Promise<OpencodeAgent[]> {
    return this.req('GET', '/agent')
  }

  /** 配置后的 provider + 模型目录 */
  async listProviders(): Promise<ProviderInfo[]> {
    const data = await this.req<{ providers?: ProviderInfo[] } | ProviderInfo[]>('GET', '/config/providers')
    if (Array.isArray(data)) return data
    return data.providers ?? []
  }

  // ---------- SSE ----------
  /** 连接全局事件流；事件转发为 'event' 事件 {type, properties}；自动重连 */
  private sseAbort: AbortController | null = null
  startEventStream(): void {
    if (this.sseAbort) return
    const ctrl = new AbortController()
    this.sseAbort = ctrl
    void this.runSse(ctrl)
  }

  stopEventStream(): void {
    this.sseAbort?.abort()
    this.sseAbort = null
  }

  private async runSse(ctrl: AbortController): Promise<void> {
    for (;;) {
      try {
        const res = await fetch(`${this.base()}/event`, { signal: ctrl.signal })
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim()
            buf = buf.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              this.emit('event', JSON.parse(payload))
            } catch {
              /* 非 JSON 行忽略 */
            }
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) return
        this.emit('sse-error', err)
      }
      if (ctrl.signal.aborted) return
      await sleep(1500)
    }
  }
}

// ---------- 类型 ----------
export interface SessionInfo {
  id: string
  title?: string
  agent?: string
  directory?: string
  [k: string]: unknown
}

export interface UserMessageInfo {
  id: string
  role: 'user'
  time?: { created: number }
  parts?: Part[]
  [k: string]: unknown
}

export interface AssistantInfo {
  id: string
  role: 'assistant'
  agent?: string
  modelID?: string
  providerID?: string
  time?: { created: number; completed?: number }
  error?: unknown
  parts?: Part[]
  tokens?: { total?: number; input?: number; output?: number }
  [k: string]: unknown
}

export type Part =
  | { id: string; type: 'text'; text: string; synthetic?: boolean }
  | { id: string; type: 'reasoning'; text?: string }
  | { id: string; type: 'tool'; tool: string; state?: { status?: string; output?: string; input?: unknown; error?: string } }
  | { id: string; type: string; [k: string]: unknown }

export interface SessionMessage {
  info: UserMessageInfo | AssistantInfo | { id: string; role?: string; [k: string]: unknown }
  parts?: Part[]
}

export interface OpencodeAgent {
  name: string
  mode?: string
  model?: { providerID: string; modelID: string }
  description?: string
  [k: string]: unknown
}

export interface ProviderInfo {
  id: string
  name?: string
  models?: Record<string, unknown>
  [k: string]: unknown
}
