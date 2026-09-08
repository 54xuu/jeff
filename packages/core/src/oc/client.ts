import { EventEmitter } from 'node:events'
import { sleep } from '../sidecar/manager.js'
import type { DebugLogFn } from '../logger.js'

/**
 * opencode server 薄客户端（基于其 OpenAPI HTTP 面，1.18.x 验证）。
 * 刻意不依赖 @opencode-ai/sdk：接口面窄而稳定，避免 SDK 版本耦合。
 */
export class OcClient extends EventEmitter {
  constructor(
    public port: number,
    /** 调试日志回调（可选）：assistant 错误的完整 JSON 只有这里能拿到（上层会被截断） */
    private log?: DebugLogFn,
  ) {
    super()
  }

  /** sidecar 状态探针（由 JeffCore 注入）：连接失败时日志能对上 sidecar 当时状态/端口 */
  statusProvider?: () => { status: string; port: number } | null

  private base(): string {
    return `http://127.0.0.1:${this.port}`
  }

  private async req<T>(method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
    const started = Date.now()
    try {
      const res = await fetch(`${this.base()}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // HTTP 业务错误：sidecar 可达，不按连接失败包装
        const httpErr = new Error(`opencode ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`) as Error & { httpStatus?: number }
        httpErr.httpStatus = res.status
        throw httpErr
      }
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('json')) return undefined as T
      return (await res.json()) as T
    } catch (err) {
      const e = err as Error & { name?: string; cause?: unknown; httpStatus?: number }
      // HTTP 业务错误 / 超时 / 用户中止：原样抛出（上层依赖 abort 字样判定「已停止生成」）
      if (e?.httpStatus || e?.name === 'TimeoutError' || e?.name === 'AbortError') throw err
      // 连接层失败（端口不可达/连接重置等）：留全量现场 + 包装成可读错误，保留原始 cause
      const cause = e?.cause instanceof Error ? { name: e.cause.name, message: e.cause.message } : e?.cause
      this.log?.('oc-req-fail', {
        method,
        path,
        port: this.port,
        elapsedMs: Date.now() - started,
        sidecar: this.statusProvider?.() ?? null,
        name: e?.name,
        message: e?.message,
        cause,
      })
      const wrapped = new Error(`引擎服务连接失败（127.0.0.1:${this.port} ${method} ${path}）：${e?.message || err}`)
      ;(wrapped as Error & { cause?: unknown }).cause = err
      throw wrapped
    }
  }

  // ---------- 会话 ----------
  async createSession(input: { title?: string; agent?: string; model?: { providerID: string; id: string }; directory?: string }): Promise<SessionInfo> {
    // directory：把会话锚定到指定工作空间目录（opencode WorkspaceRoutingQuery，文件操作以该目录为根）
    const qs = input.directory ? `?directory=${encodeURIComponent(input.directory)}` : ''
    return this.req('POST', `/session${qs}`, input)
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    return this.req('GET', `/session/${sessionId}`)
  }

  async listSessions(directory?: string): Promise<SessionInfo[]> {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    return this.req('GET', `/session${qs}`)
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.req('DELETE', `/session/${sessionId}`)
  }

  /** 更新会话标题等元数据 */
  async updateSession(sessionId: string, patch: { title?: string }): Promise<SessionInfo> {
    return this.req('PATCH', `/session/${sessionId}`, patch)
  }

  /** 获取会话消息（含 user/assistant 与 parts） */
  async getMessages(sessionId: string, timeoutMs = 30000): Promise<SessionMessage[]> {
    return this.req('GET', `/session/${sessionId}/message`, undefined, timeoutMs)
  }

  /**
   * 发送一条用户消息并等待 assistant 回复完成。
   * @returns 完成的 assistant 消息 info
   */
  async sendMessage(input: {
    sessionId: string
    text: string
    /** 随文本发送的图片（dataURL 内联），映射为 opencode file part */
    images?: Array<{ mime: string; dataUrl: string }>
    agent?: string
    model?: { providerID: string; modelID: string }
    /** 思考档位（模型 variants 的 key；opencode PromptInput.variant 原生支持） */
    variant?: string
    system?: string
    noReply?: boolean
    timeoutMs?: number
  }): Promise<AssistantInfo> {
    // 调试现场：只记元信息（不含消息内容），用于对齐后续 assistant-error / stop 日志
    this.log?.('send-start', {
      sessionId: input.sessionId,
      agent: input.agent,
      model: input.model,
      variant: input.variant,
      textLen: input.text.length,
      images: input.images?.length ?? 0,
      timeoutMs: input.timeoutMs ?? 600000,
    })
    const waitMs = input.timeoutMs ?? 600000
    // 总预算从进入时计：POST 与后续轮询共用剩余时间（旧逻辑 POST 结束后才起 deadline，总时长可能翻倍）
    const deadline = Date.now() + waitMs
    const remaining = () => Math.max(1000, deadline - Date.now())
    const returned = await this.req<{ info?: AssistantInfo; id?: string }>(
      'POST',
      `/session/${input.sessionId}/message`,
      {
        parts: [
          ...(input.text ? [{ type: 'text', text: input.text }] : []),
          ...(input.images || []).map((img) => ({ type: 'file', mime: img.mime, url: img.dataUrl })),
        ],
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.noReply ? { noReply: true } : {}),
      },
      // POST 会阻塞到整个 run 结束（LLM 慢思考/慢网络时可达数分钟），超时必须覆盖全程；
      // 之前固定 60s 会在 LLM 生成超过 60s 时先炸（TimeoutError 误判为已停止）
      remaining(),
    )
    const assistantId = returned?.info?.id ?? returned?.id
    if (!assistantId) throw new Error('发送消息未返回 assistant 消息 id')
    for (;;) {
      if (Date.now() > deadline) throw new Error('等待 assistant 回复超时')
      const msgs = await this.getMessages(input.sessionId, remaining())
      const entry = msgs.find((m) => m.info?.id === assistantId)
      const found = entry?.info as AssistantInfo | undefined
      if (found) {
        // 列表条目的 parts 在顶层（info 里没有）——合并回去，调用方才能提取回复文本
        if (entry?.parts?.length && !found.parts) found.parts = entry.parts
        if (found.error) {
          const raw = JSON.stringify(found.error)
          // 完整错误只在调试日志里留存（上层提示会被层层截断）
          this.log?.('assistant-error', { sessionId: input.sessionId, assistantId, error: found.error })
          const hint = /certificate/i.test(raw) ? '（如为企业网络证书拦截，可在 设置→引擎服务 开启「跳过 LLM 证书校验」）' : ''
          throw new Error(`assistant 消息出错: ${raw.slice(0, 300)}${hint}`)
        }
        if (found.time?.completed) return found
      }
      if (Date.now() > deadline) throw new Error('等待 assistant 回复超时')
      await sleep(400)
    }
  }

  /** 用户主动停止过的会话 → 时间戳（区分「已停止生成」与 provider 真实失败） */
  private aborts = new Map<string, number>()

  async abortSession(sessionId: string): Promise<void> {
    this.aborts.set(sessionId, Date.now())
    await this.req('POST', `/session/${sessionId}/abort`).catch((err) => {
      // /abort 失败不再完全静默：留诊断现场（会话可能已结束或 sidecar 不可达）
      this.log?.('abort-fail', { sessionId, error: String((err as Error)?.message || err) })
    })
  }

  /** 最近 windowMs 内是否对该会话发起过用户停止 */
  isAbortRequested(sessionId: string, windowMs = 120000): boolean {
    const t = this.aborts.get(sessionId)
    if (!t) return false
    if (Date.now() - t > windowMs) {
      this.aborts.delete(sessionId)
      return false
    }
    return true
  }

  /**
   * 手动触发会话压缩（opencode 1.18：POST /session/{id}/summarize）。
   * 等待 compaction assistant 完成（summary + completed）后返回。
   */
  async summarize(input: {
    sessionId: string
    providerID: string
    modelID: string
    auto?: boolean
    timeoutMs?: number
  }): Promise<AssistantInfo> {
    const before = await this.getMessages(input.sessionId)
    const beforeIds = new Set(before.map((m) => m.info?.id).filter(Boolean) as string[])
    const compactMs = input.timeoutMs ?? 300000
    // 与 sendMessage 同理：POST 阻塞到压缩完成，超时须覆盖全程
    await this.req(
      'POST',
      `/session/${input.sessionId}/summarize`,
      {
        providerID: input.providerID,
        modelID: input.modelID,
        auto: input.auto ?? false,
      },
      compactMs,
    )
    const deadline = Date.now() + compactMs
    for (;;) {
      const msgs = await this.getMessages(input.sessionId)
      for (const entry of msgs) {
        const info = entry.info as AssistantInfo
        if (!info?.id || beforeIds.has(info.id)) continue
        if (info.role !== 'assistant') continue
        if (!(info.summary === true || info.mode === 'compaction')) continue
        if (entry.parts?.length && !info.parts) info.parts = entry.parts
        if (info.error) {
          this.log?.('compact-error', { sessionId: input.sessionId, error: info.error })
          throw new Error(`压缩失败: ${JSON.stringify(info.error).slice(0, 300)}`)
        }
        if (info.time?.completed || (info as { finish?: string }).finish) return info
      }
      if (Date.now() > deadline) throw new Error('等待压缩完成超时')
      await sleep(400)
    }
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
        // 必须用全局事件流：裸 /event 不带 ?directory= 时只推 server.connected/heartbeat，
        // 会话的 message.part.delta 挂在 global 总线（opencode 1.18 实测）
        const res = await fetch(`${this.base()}/global/event`, { signal: ctrl.signal })
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`)
        this.emit('sse-open', { port: this.port, endpoint: '/global/event' })
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
              const parsed = JSON.parse(payload) as { payload?: { type?: string; properties?: Record<string, unknown> }; type?: string; properties?: Record<string, unknown> }
              // /event 直接给 {type,properties}；/global/event 包一层 {directory,project,payload} —— 统一解包
              this.emit('event', parsed.payload ?? parsed)
            } catch {
              /* 非 JSON 行忽略 */
            }
          }
        }
        // 服务端正常关流（sidecar 退出/重启）：与错误断开区分，便于对账
        this.log?.('sse-eof', { port: this.port })
      } catch (err) {
        if (ctrl.signal.aborted) return
        const e = err as Error & { cause?: unknown }
        this.emit('sse-error', { port: this.port, name: e?.name, message: e?.message })
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
  tokens?: { total?: number; input?: number; output?: number; cache?: { read?: number; write?: number } }
  /** opencode compaction 摘要消息标记 */
  summary?: boolean
  mode?: string
  finish?: string
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
