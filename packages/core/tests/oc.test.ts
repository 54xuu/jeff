import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { Agent } from 'undici'
import { OcClient, friendlyAssistantError } from '../src/oc/client.js'

type LogEntry = [string, unknown]

const makeClient = (port: number, logs: LogEntry[], dispatcher?: Agent) =>
  new OcClient(port, (tag, detail) => logs.push([tag, detail]), dispatcher)

/** 起一个本地 http mock：handlers 按 (method, url) 前缀匹配 */
const startServer = (handlers: Array<{ match: (method: string, url: string) => boolean; reply: (req: http.IncomingMessage, res: http.ServerResponse) => void }>): Promise<number> =>
  new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = req.url || ''
      const method = (req.method || 'GET').toUpperCase()
      const h = handlers.find((x) => x.match(method, url))
      if (h) h.reply(req, res)
      else {
        res.writeHead(404)
        res.end()
      }
    })
    srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port))
    ;(srv as http.Server & { __close?: () => void }).__close = () => new Promise<void>((r) => srv.close(() => r()))
    servers.push(srv)
  })

const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  )
})

const json = (res: http.ServerResponse, body: unknown): void => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

describe('OcClient 网络诊断与超时', () => {
  it('端口不可达：包装为可读错误并保留 cause，诊断日志含 method/path/port', async () => {
    // 拿一个确定没有监听的端口
    const dead = net.createServer()
    const port = await new Promise<number>((resolve) => {
      dead.listen(0, '127.0.0.1', () => resolve((dead.address() as net.AddressInfo).port))
    })
    await new Promise<void>((r) => dead.close(() => r()))
    const logs: LogEntry[] = []
    const client = makeClient(port, logs)
    let err: Error | null = null
    try {
      await client.getSession('ses_x')
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeTruthy()
    expect(err!.message).toContain('引擎服务连接失败')
    expect(err!.message).toContain(`127.0.0.1:${port}`)
    expect(err!.message).toContain('GET /session/ses_x')
    expect((err as Error & { cause?: unknown }).cause).toBeTruthy()
    const failLog = logs.find(([tag]) => tag === 'oc-req-fail')?.[1] as Record<string, unknown>
    expect(failLog.method).toBe('GET')
    expect(failLog.path).toBe('/session/ses_x')
    expect(failLog.port).toBe(port)
    expect(typeof failLog.elapsedMs).toBe('number')
  })

  it('HTTP 非 2xx：不误报为连接失败，保持 opencode 原始错误', async () => {
    const port = await startServer([
      { match: (m, u) => m === 'GET' && u.startsWith('/session/'), reply: (_req, res) => { res.writeHead(500); res.end('boom') } },
    ])
    const logs: LogEntry[] = []
    const client = makeClient(port, logs)
    let msg = ''
    try {
      await client.getSession('ses_x')
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('-> 500')
    expect(msg).not.toContain('引擎服务连接失败')
  })

  it('sendMessage：总 deadline 覆盖 POST + 轮询，超时给出明确错误', async () => {
    const port = await startServer([
      { match: (m, u) => m === 'POST' && u.includes('/message'), reply: (_req, res) => json(res, { info: { id: 'msg_1', role: 'assistant' } }) },
      {
        match: (m, u) => m === 'GET' && u.includes('/message'),
        reply: (_req, res) => {
          // assistant 永不完成
          setTimeout(() => json(res, [{ info: { id: 'msg_1', role: 'assistant' } }]), 500)
        },
      },
    ])
    const client = makeClient(port, [])
    const t0 = Date.now()
    let msg = ''
    try {
      await client.sendMessage({ sessionId: 'ses_t', text: 'hi', timeoutMs: 2000 })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toBe('等待 assistant 回复超时')
    // 总预算生效：约 2s 内失败（旧实现 POST 后才起 deadline，轮询 30s 超时会拖更久）
    expect(Date.now() - t0).toBeLessThan(8000)
  })

  it('sendMessage：assistant 完成即返回（happy path 不受 deadline 影响）', async () => {
    const port = await startServer([
      { match: (m, u) => m === 'POST' && u.includes('/message'), reply: (_req, res) => json(res, { info: { id: 'msg_ok', role: 'assistant' } }) },
      {
        match: (m, u) => m === 'GET' && u.includes('/message'),
        reply: (_req, res) => json(res, [{ info: { id: 'msg_ok', role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: 'done' }] }]),
      },
    ])
    const client = makeClient(port, [])
    const reply = await client.sendMessage({ sessionId: 'ses_ok', text: 'hi', timeoutMs: 5000 })
    expect(reply.id).toBe('msg_ok')
    expect(reply.parts?.length).toBe(1)
  })

  it('abortSession：/abort 失败写入 abort-fail 诊断日志且不抛出', async () => {
    const port = await startServer([
      { match: (m, u) => m === 'POST' && u.includes('/abort'), reply: (_req, res) => { res.writeHead(503); res.end() } },
    ])
    const logs: LogEntry[] = []
    const client = makeClient(port, logs)
    await expect(client.abortSession('ses_a')).resolves.toBeUndefined()
    expect(logs.some(([tag]) => tag === 'abort-fail')).toBe(true)
  })

  it('HeadersTimeout：注入小超时 dispatcher，超时被分类为「响应超时」而非连接失败，日志含 isHeadersTimeout 与 causeChain', async () => {
    const port = await startServer([
      {
        match: (m, u) => m === 'GET' && u.startsWith('/session/'),
        reply: (_req, res) => {
          // 1s 后才回响应头：超过注入的 headersTimeout(300ms)，触发 Undici HeadersTimeoutError
          setTimeout(() => json(res, { id: 'ses_x' }), 1000)
        },
      },
    ])
    const logs: LogEntry[] = []
    const client = makeClient(port, logs, new Agent({ headersTimeout: 300, bodyTimeout: 300 }))
    let err: Error | null = null
    try {
      await client.getSession('ses_x')
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeTruthy()
    expect(err!.message).toContain('引擎服务响应超时')
    expect(err!.message).not.toContain('引擎服务连接失败')
    // 上层依赖 abort 字样判定「已停止生成」，超时措辞不得误触
    expect(err!.message).not.toContain('abort')
    const failLog = logs.find(([tag]) => tag === 'oc-req-fail')?.[1] as Record<string, unknown>
    expect(failLog.isHeadersTimeout).toBe(true)
    expect(typeof failLog.timeoutMs).toBe('number')
    const chain = failLog.causeChain as Array<{ name?: string }>
    expect(chain.some((c) => c.name === 'HeadersTimeoutError')).toBe(true)
  })

  it('POST 挂起（永不回响应头）：默认 dispatcher 下由应用总预算终止，且全程只发一次 POST 不重放', async () => {
    let postCount = 0
    const port = await startServer([
      {
        match: (m, u) => m === 'POST' && u.includes('/message'),
        reply: (_req, res) => {
          postCount += 1
          // 故意不回响应头，模拟 sidecar run 卡住
          void res
        },
      },
    ])
    const client = makeClient(port, [])
    const t0 = Date.now()
    let err: Error | null = null
    try {
      await client.sendMessage({ sessionId: 'ses_hang', text: 'hi', timeoutMs: 2000 })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeTruthy()
    // 2000ms 应用预算先于 Undici 默认 300s headersTimeout 生效
    expect(Date.now() - t0).toBeLessThan(8000)
    expect(err!.name).toBe('TimeoutError')
    // 有副作用的 POST 绝不重放
    expect(postCount).toBe(1)
  })
})

describe('friendlyAssistantError：上游 APIError 映射为可读中文提示', () => {
  it('完整链路：assistant 带回 Zen 400 APIError 时抛出友好提示而非原始 JSON', async () => {
    const zenError = {
      name: 'APIError',
      data: {
        message: 'Bad Request: {"object":"error","model":"deepseek-v4-flash"}',
        statusCode: 400,
        isRetryable: false,
        responseBody: '{"object":"error","model":"deepseek-v4-flash"}',
        metadata: { url: 'https://opencode.ai/zen/go/v1/chat/completions' },
      },
    }
    const port = await startServer([
      { match: (m, u) => m === 'POST' && u.includes('/message'), reply: (_req, res) => json(res, { info: { id: 'msg_err', role: 'assistant' } }) },
      {
        match: (m, u) => m === 'GET' && u.includes('/message'),
        reply: (_req, res) =>
          json(res, [{ info: { id: 'msg_err', role: 'assistant', time: { completed: 1 }, error: zenError }, parts: [] }]),
      },
    ])
    const logs: LogEntry[] = []
    const client = makeClient(port, logs)
    let msg = ''
    try {
      await client.sendMessage({ sessionId: 'ses_zen', text: 'hi', timeoutMs: 5000 })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('模型服务拒绝了本次请求（400）')
    expect(msg).toContain('（模型 deepseek-v4-flash）')
    expect(msg).toContain('新建话题')
    expect(msg).not.toContain('assistant 消息出错')
    // 提示文案不得含 abort（上层以 abort 判定「已停止生成」）
    expect(msg).not.toContain('abort')
    // 完整原始错误仍在调试日志
    const errLog = logs.find(([tag]) => tag === 'assistant-error')?.[1] as { error?: unknown }
    expect(errLog.error).toEqual(zenError)
  })

  it('按状态码给出对应处置提示，无法识别时返回 null', () => {
    const mk = (statusCode: number, responseBody = '{"object":"error","model":"m1"}') => ({
      name: 'APIError',
      data: { statusCode, responseBody },
    })
    expect(friendlyAssistantError(mk(400))).toContain('上下文超长')
    expect(friendlyAssistantError(mk(401))).toContain('API Key')
    expect(friendlyAssistantError(mk(403))).toContain('API Key')
    expect(friendlyAssistantError(mk(404))).toContain('模型不存在')
    expect(friendlyAssistantError(mk(429))).toContain('限流')
    expect(friendlyAssistantError(mk(503))).toContain('暂时故障')
    // 无模型信息时不出现空标签
    expect(friendlyAssistantError({ name: 'APIError', data: { statusCode: 400 } })).toBe('模型服务拒绝了本次请求（400）：常见原因是会话上下文超长、模型暂不可用或请求参数不被支持。可新建话题（清空上下文）后重试，或在 设置→模型供应商 更换模型。')
    // 非 APIError / 无状态码：回退原始展示
    expect(friendlyAssistantError({ name: 'OtherError' })).toBeNull()
    expect(friendlyAssistantError({ name: 'APIError', data: {} })).toBeNull()
    expect(friendlyAssistantError(null)).toBeNull()
  })
})
