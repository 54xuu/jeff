import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { OcClient } from '../src/oc/client.js'

type LogEntry = [string, unknown]

const makeClient = (port: number, logs: LogEntry[]) =>
  new OcClient(port, (tag, detail) => logs.push([tag, detail]))

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
})
