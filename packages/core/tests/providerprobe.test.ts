import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { probeProviderModel } from '../src/providers/probe.js'
import type { ProviderSetting } from '../src/oc/configWriter.js'

/** 本地假 provider 端点：记录最近一次请求，按模型 id / 路径返回不同结果 */
let server: Server
let port = 0
let last: { url?: string; headers?: Record<string, unknown>; body?: Record<string, unknown> } = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      last = { url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
      if (req.url === '/chat/completions') {
        if (last.body?.model === 'bad-model') {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'model not found' } }))
          return
        }
        if (last.body?.model === 'slow-model') {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{"choices":[]}')
          }, 2000)
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"choices":[]}')
        return
      }
      if (req.url === '/responses' || req.url === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as { port: number }).port
})

afterAll(() => {
  server.close()
})

const provider = (patch: Partial<ProviderSetting> = {}): ProviderSetting => ({
  id: 'test-pv',
  name: '测试供应商',
  apiFormat: 'chat',
  baseURL: `http://127.0.0.1:${port}`,
  enabled: true,
  models: [],
  ...patch,
})

describe('probeProviderModel（模型连通直连探测）', () => {
  it('chat 格式：200 → ok + 耗时；请求体带 model 与 max_tokens=1', async () => {
    const r = await probeProviderModel(provider(), 'good-model')
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(last.url).toBe('/chat/completions')
    expect(last.body?.model).toBe('good-model')
    expect(last.body?.max_tokens).toBe(1)
    expect(last.headers?.authorization).toBeUndefined() // 无 apiKey 时不带鉴权头
  }, 10000)

  it('chat 格式：404 + error.message → ok:false 且错误可读', async () => {
    const r = await probeProviderModel(provider(), 'bad-model')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('HTTP 404')
    expect(r.error).toContain('model not found')
  }, 10000)

  it('apiKey 走 Bearer 头（chat）', async () => {
    await probeProviderModel(provider({ apiKey: 'sk-test' }), 'good-model')
    expect(last.headers?.authorization).toBe('Bearer sk-test')
  }, 10000)

  it('responses 格式：POST /responses，max_output_tokens=1', async () => {
    const r = await probeProviderModel(provider({ apiFormat: 'responses' }), 'good-model')
    expect(r.ok).toBe(true)
    expect(last.url).toBe('/responses')
    expect(last.body?.max_output_tokens).toBe(1)
  }, 10000)

  it('anthropic 格式：POST /v1/messages，x-api-key + anthropic-version 头', async () => {
    const r = await probeProviderModel(provider({ apiFormat: 'anthropic' }), 'good-model')
    expect(r.ok).toBe(true)
    expect(last.url).toBe('/v1/messages')
    expect(last.headers?.['x-api-key']).toBeUndefined() // 未配置 apiKey
    expect(last.headers?.['anthropic-version']).toBe('2023-06-01')

    await probeProviderModel(provider({ apiFormat: 'anthropic', apiKey: 'sk-anthropic' }), 'good-model')
    expect(last.headers?.['x-api-key']).toBe('sk-anthropic')
  }, 10000)

  it('缺 baseURL（非 anthropic）→ 直接报「未配置 baseURL」', async () => {
    const r = await probeProviderModel(provider({ baseURL: '' }), 'good-model')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('baseURL')
  }, 10000)

  it('超时 → ok:false + 可读的超时错误', async () => {
    const r = await probeProviderModel(provider(), 'slow-model', 200)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('超时')
  }, 10000)

  it('模型 id 为空 → 直接报错不发请求', async () => {
    const r = await probeProviderModel(provider(), '  ')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('模型 id')
  }, 10000)
})
