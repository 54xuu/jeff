import type { JeffCore } from '@jeff/core'
import type { SiYuanConfigInfo, SiYuanSearchResult } from '@jeff/core'

interface StoredSiYuanConfig { baseUrl: string; token: string }
interface KernelResponse<T> { code: number; msg?: string; data?: T }

function readConfig(core: JeffCore): StoredSiYuanConfig {
  const value = core.kv().getJSON<StoredSiYuanConfig | null>('integration:siyuan', null)
  return value && typeof value.baseUrl === 'string' && typeof value.token === 'string' ? value : { baseUrl: '', token: '' }
}

export function getSiYuanConfig(core: JeffCore): SiYuanConfigInfo {
  const config = readConfig(core)
  return { baseUrl: config.baseUrl, tokenConfigured: Boolean(config.token) }
}

export function saveSiYuanConfig(core: JeffCore, input: { baseUrl: string; token?: string }): SiYuanConfigInfo {
  let url: URL
  try { url = new URL(input.baseUrl.trim()) } catch { throw new Error('请输入有效的思源服务地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('思源地址只支持不含账号、查询参数和片段的 HTTP(S) 地址')
  const baseUrl = url.toString().replace(/\/+$/, '')
  const previous = readConfig(core)
  const token = input.token?.trim() || previous.token
  if (!token) throw new Error('请填写思源 Kernel API Token')
  core.kv().setJSON('integration:siyuan', { baseUrl, token })
  return { baseUrl, tokenConfigured: true }
}

export async function searchSiYuan(core: JeffCore, keyword: string): Promise<SiYuanSearchResult[]> {
  const text = keyword.trim()
  if (text.length < 2) throw new Error('请输入至少 2 个字符的搜索词')
  if (text.length > 100) throw new Error('搜索词不能超过 100 个字符')
  await request(core, '/api/sqlite/flushTransaction', {})
  const escaped = text.replaceAll("'", "''")
  // Match any block but return its root document ID and title so selection always stores a document, not a paragraph.
  const stmt = `SELECT d.id AS docId, d.content AS title, d.path AS path, substr(b.content, 1, 180) AS snippet, MAX(b.updated) AS updated
FROM blocks b JOIN blocks d ON d.id = b.root_id
WHERE b.content LIKE '%${escaped}%'
GROUP BY d.id
ORDER BY updated DESC
LIMIT 50`
  const rows = await request<SiYuanSearchResult[]>(core, '/api/query/sql', { stmt })
  return (Array.isArray(rows) ? rows : []).filter((row) => row && /^\d{14}-[0-9a-z]{7}$/.test(row.docId) && typeof row.title === 'string')
    .map((row) => ({ docId: row.docId, title: row.title.trim(), path: String(row.path || '').trim(), snippet: String(row.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 180) }))
}

export async function exportSiYuanMarkdown(core: JeffCore, docId: string): Promise<{ docId: string; path: string; markdown: string }> {
  if (!/^\d{14}-[0-9a-z]{7}$/.test(docId)) throw new Error('思源文档 ID 格式无效')
  const data = await request<{ hPath?: string; content?: string }>(core, '/api/export/exportMdContent', { id: docId })
  if (typeof data?.content !== 'string') throw new Error(`思源未返回文档正文：${docId}`)
  if (data.content.length > 100_000) throw new Error(`文档过大（超过 100,000 字符）：${docId}`)
  return { docId, path: String(data.hPath || ''), markdown: data.content }
}

async function request<T = unknown>(core: JeffCore, endpoint: string, body: Record<string, unknown>): Promise<T> {
  const config = readConfig(core)
  if (!config.baseUrl || !config.token) throw new Error('请先在「设置 → 思源知识库」配置服务地址与 API Token')
  const response = await fetch(`${config.baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Token ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`思源请求失败：HTTP ${response.status} ${response.statusText}`)
  let payload: KernelResponse<T>
  try { payload = await response.json() as KernelResponse<T> } catch { throw new Error('思源返回了无效 JSON') }
  if (payload.code !== 0) throw new Error(`思源 API 错误（${payload.code}）：${payload.msg || '未知错误'}`)
  return payload.data as T
}
