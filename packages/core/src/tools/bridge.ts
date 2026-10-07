import http from 'node:http'
import { EventEmitter } from 'node:events'
import { randomToken } from '../util/id.js'
import { allToolDefs } from './definitions.js'

/**
 * 工具桥：本地 HTTP API，opencode 插件工具通过它调用 Jeff 核心能力。
 * 安全：只监听 127.0.0.1 + Bearer token（每次启动随机生成）。
 */
export class ToolBridge extends EventEmitter {
  private server: http.Server | null = null
  private handlers = new Map<string, (args: unknown) => Promise<unknown>>()
  token = randomToken()
  port = 0
  private sessions = new Map<string, { sessionID: string; agent: string; denied: Set<string> }>()

  /** A random, run-scoped capability binds identity outside model-controlled arguments. */
  openMcpSession(sessionID: string, agent: string, denied: Set<string>): { url: string; close: () => void } {
    const capability = randomToken()
    this.sessions.set(capability, { sessionID, agent, denied })
    return { url: `${this.url()}/mcp/${capability}`, close: () => { this.sessions.delete(capability) } }
  }

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
      if (url.pathname.startsWith('/mcp/')) {
        const scope = this.sessions.get(url.pathname.slice(5))
        if (!scope) { done(403, { error: '会话工具访问已失效' }); return }
        if (req.method !== 'POST') { done(405, { error: '仅支持 POST' }); return }
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
          if (body.length > 2 * 1024 * 1024) req.destroy()
        })
        req.on('end', async () => {
          let rpc: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
          try { rpc = JSON.parse(body) } catch { done(400, { error: '无效 MCP 请求' }); return }
          if (rpc.id === undefined) { res.writeHead(202); res.end(); return }
          const reply = (result: unknown) => done(200, { jsonrpc: '2.0', id: rpc.id, result })
          if (rpc.method === 'initialize') {
            reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'jeff', version: '1.0.0' } })
          } else if (rpc.method === 'ping') reply({})
          else if (rpc.method === 'tools/list') {
            reply({ tools: allToolDefs().filter((def) => !scope.denied.has(def.name)).map((def) => ({
              name: def.name, description: def.description,
              inputSchema: { type: 'object', properties: def.args, additionalProperties: false },
            })) })
          } else if (rpc.method === 'tools/call') {
            const name = rpc.params?.name || ''
            const handler = this.handlers.get(name)
            if (!handler || scope.denied.has(name) || !allToolDefs().some((def) => def.name === name)) {
              reply({ isError: true, content: [{ type: 'text', text: '该会话无权调用此工具' }] }); return
            }
            const args = { ...rpc.params?.arguments }
            if ('__ctx' in args) {
              reply({ isError: true, content: [{ type: 'text', text: '禁止提供调用者身份' }] }); return
            }
            try {
              const data = await handler({ ...args, __ctx: { sessionID: scope.sessionID, agent: scope.agent } })
              reply({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data ?? 'ok') }] })
            } catch (err) { reply({ isError: true, content: [{ type: 'text', text: String((err as Error).message) }] }) }
          } else done(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: '不支持的 MCP 方法' } })
        })
        return
      }
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
    // 请求头：Zen Go 补 session；Anthropic 兼容网关同时认 x-api-key 与 Bearer。
    'chat.headers': async (input, output) => {
      const headers = output && output.headers
      if (!headers) return
      const base = String((input && input.provider && input.provider.options && input.provider.options.baseURL) || '')
      if (/opencode\\.ai/i.test(base) && input && input.sessionID) {
        // Zen Go 的 /responses 缺 x-opencode-session 会直接 400。provider id 不以 opencode 开头时引擎不会自动加。
        headers['x-opencode-session'] = input.sessionID
        headers['x-opencode-request'] = (input.message && input.message.id) || input.sessionID
      }
      const npm = input && input.model && input.model.api && input.model.api.npm
      if (npm !== '@ai-sdk/anthropic') return
      const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
      if (hasAuth) return
      const key = (input && input.provider && (input.provider.key || (input.provider.options && input.provider.options.apiKey))) || ''
      if (!key) return
      headers['authorization'] = 'Bearer ' + key
    },
  }
}
`
}
