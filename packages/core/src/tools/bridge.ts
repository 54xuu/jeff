import http from 'node:http'
import { EventEmitter } from 'node:events'
import { randomToken } from '../util/id.js'

/**
 * 工具桥：本地 HTTP API，opencode 插件工具通过它调用 Jeff 核心能力。
 * 安全：只监听 127.0.0.1 + Bearer token（每次启动随机生成）。
 */
export class ToolBridge extends EventEmitter {
  private server: http.Server | null = null
  private handlers = new Map<string, (args: unknown) => Promise<unknown>>()
  token = randomToken()
  port = 0

  register<TIn, TOut>(name: string, handler: (args: TIn) => Promise<TOut>): void {
    this.handlers.set(name, handler as (args: unknown) => Promise<unknown>)
  }

  url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      const done = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/health') {
        done(200, { ok: true })
        return
      }
      const auth = req.headers.authorization || ''
      if (auth !== `Bearer ${this.token}`) {
        done(401, { ok: false, error: 'unauthorized' })
        return
      }
      const match = /^\/tools\/([a-z0-9_.-]+)$/i.exec(url.pathname)
      if (req.method !== 'POST' || !match) {
        done(404, { ok: false, error: 'not found' })
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const name = match[1]
        const handler = this.handlers.get(name)
        if (!handler) {
          done(404, { ok: false, error: `未知工具: ${name}` })
          return
        }
        let args: unknown = {}
        try {
          args = body ? JSON.parse(body) : {}
        } catch {
          done(400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        Promise.resolve()
          .then(() => handler(args))
          .then((data) => {
            this.emit('tool-call', name)
            done(200, { ok: true, data })
          })
          .catch((err) => done(200, { ok: false, error: String((err as Error)?.message || err) }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    this.port = (server.address() as { port: number }).port
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }
}

/** 生成 opencode 插件文件内容（工具定义 → bridge 调用） */
export function renderBridgePlugin(bridgeUrl: string, token: string, tools: Array<{ name: string; description: string; args: Record<string, { type: string; description?: string; items?: unknown; enum?: string[] }> }>): string {
  const toolDefs = tools
    .map((t) => {
      const args = JSON.stringify(
        Object.fromEntries(
          Object.entries(t.args).map(([k, v]) => [
            k,
            { type: v.type, description: v.description, ...(v.items ? { items: v.items } : {}), ...(v.enum ? { enum: v.enum } : {}) },
          ]),
        ),
      )
      return `    '${t.name}': {\n      description: ${JSON.stringify(t.description)},\n      args: ${args},\n      async execute(args, ctx) {\n        return await call('${t.name}', args, ctx)\n      },\n    },`
    })
    .join('\n')
  return `// 由 Jeff 自动生成 — 工具桥接插件（勿手工编辑）
export const JeffBridge = async () => {
  const BASE = ${JSON.stringify(bridgeUrl)}
  const TOKEN = ${JSON.stringify(token)}
  async function call(name, args, ctx) {
    const payload = { ...(args ?? {}), __ctx: { sessionID: ctx?.sessionID, agent: ctx?.agent, messageID: ctx?.messageID } }
    const res = await fetch(BASE + '/tools/' + name, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || '工具调用失败')
    return data.data == null ? 'ok' : (typeof data.data === 'string' ? data.data : JSON.stringify(data.data))
  }
  return {
    tool: {
${toolDefs}
    },
    // 自定义 Responses（@ai-sdk/openai 且不是官方 openai）会带上官方才认的字段，
    // 硅基流动 / 中转网关常以 400 拒绝整次请求。这里在发出前拿掉。
    'chat.params': async (input, output) => {
      const npm = input && input.model && input.model.api && input.model.api.npm
      const providerID = (input && input.model && input.model.providerID) || (input && input.provider && input.provider.id) || ''
      if (npm !== '@ai-sdk/openai' || providerID === 'openai') return
      const o = output && output.options
      if (!o || typeof o !== 'object') return
      delete o.include
      delete o.reasoningSummary
      delete o.textVerbosity
      delete o.promptCacheKey
    },
    // Zen Go 的 /responses 缺 x-opencode-session 会直接 400。provider id 不以 opencode 开头时引擎不会自动加。
    'chat.headers': async (input, output) => {
      const base = String((input && input.provider && input.provider.options && input.provider.options.baseURL) || '')
      if (!/opencode\\.ai/i.test(base)) return
      const headers = output && output.headers
      if (!headers || !input || !input.sessionID) return
      headers['x-opencode-session'] = input.sessionID
      headers['x-opencode-request'] = (input.message && input.message.id) || input.sessionID
    },
  }
}
`
}
