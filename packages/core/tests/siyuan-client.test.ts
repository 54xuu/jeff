import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JeffCore } from '../src/index.js'
import { exportSiYuanMarkdown, getSiYuanConfig, saveSiYuanConfig, searchSiYuan } from '../../../apps/desktop/src/main/siyuan.js'

function testCore(): { core: JeffCore; values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  const kv = {
    getJSON: <T>(key: string, fallback: T): T => values.has(key) ? values.get(key) as T : fallback,
    setJSON: (key: string, value: unknown) => values.set(key, value),
  }
  return { core: { kv: () => kv } as unknown as JeffCore, values }
}

function jsonResponse(data: unknown, code = 0, msg = ''): Response {
  return new Response(JSON.stringify({ code, msg, data }), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('SiYuan client', () => {
  it('stores the API token locally, preserves it when the input is blank, and never returns it', () => {
    const { core, values } = testCore()
    expect(getSiYuanConfig(core)).toEqual({ baseUrl: '', tokenConfigured: false })
    expect(() => saveSiYuanConfig(core, { baseUrl: 'http://127.0.0.1:6806' })).toThrow('Token')
    expect(saveSiYuanConfig(core, { baseUrl: 'http://127.0.0.1:6806/', token: 'local-secret' })).toEqual({ baseUrl: 'http://127.0.0.1:6806', tokenConfigured: true })
    expect(saveSiYuanConfig(core, { baseUrl: 'http://127.0.0.1:6806' })).toEqual({ baseUrl: 'http://127.0.0.1:6806', tokenConfigured: true })
    expect(JSON.stringify(getSiYuanConfig(core))).not.toContain('local-secret')
    expect(values.get('integration:siyuan')).toEqual({ baseUrl: 'http://127.0.0.1:6806', token: 'local-secret' })
    expect(() => saveSiYuanConfig(core, { baseUrl: 'https://user:pass@example.com', token: 'secret' })).toThrow('不含账号')
  })

  it('searches document roots, escapes SQL quotes, and normalizes candidate fields', async () => {
    const { core } = testCore()
    saveSiYuanConfig(core, { baseUrl: 'http://127.0.0.1:6806', token: 'secret' })
    const calls: Array<{ url: string; body: any; authorization: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const url = String(input)
      calls.push({ url, body, authorization: new Headers(init?.headers).get('Authorization') })
      return url.endsWith('/api/query/sql') ? jsonResponse([
        { docId: '20261005123456-abc1234', title: '日报', path: '/日记/10月', snippet: '  腕表\n呼叫  ' },
        { docId: 'invalid', title: '段落，不是文档', path: '/', snippet: 'skip' },
      ]) : jsonResponse(null)
    }))
    await expect(searchSiYuan(core, "O'Reilly")).resolves.toEqual([{ docId: '20261005123456-abc1234', title: '日报', path: '/日记/10月', snippet: '腕表 呼叫' }])
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.authorization === 'Token secret')).toBe(true)
    expect(calls[1]?.body.stmt).toContain("%O''Reilly%")
    expect(calls[1]?.body.stmt).toContain('d.id = b.root_id')
    await expect(searchSiYuan(core, 'x')).rejects.toThrow('至少 2 个字符')
  })

  it('exports only validated SiYuan document IDs and caps each source size', async () => {
    const { core } = testCore()
    saveSiYuanConfig(core, { baseUrl: 'http://127.0.0.1:6806', token: 'secret' })
    const fetchMock = vi.fn(async () => jsonResponse({ hPath: '/日报/10月', content: '# 日报\n完成接口联调' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(exportSiYuanMarkdown(core, 'not-an-id')).rejects.toThrow('ID 格式无效')
    await expect(exportSiYuanMarkdown(core, '20261005123456-abc1234')).resolves.toEqual({ docId: '20261005123456-abc1234', path: '/日报/10月', markdown: '# 日报\n完成接口联调' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: 'x'.repeat(100_001) })))
    await expect(exportSiYuanMarkdown(core, '20261005123456-abc1234')).rejects.toThrow('超过 100,000 字符')
  })
})
