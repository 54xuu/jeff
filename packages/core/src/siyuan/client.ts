export interface SiYuanStoredConfig { baseUrl: string; token: string }
export interface SiYuanNotebook { id: string; name: string; closed: boolean }
export interface SiYuanSearchResult { docId: string; notebookId: string; title: string; path: string; snippet: string }
export interface SiYuanDocument { docId: string; notebookId: string; path: string; markdown: string }

interface KernelResponse<T> { code: number; msg?: string; data?: T }

const DOC_ID = /^\d{14}-[0-9a-z]{7}$/
const NOTEBOOK_ID = /^\d{14}-[0-9a-z]{7}$/
const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`

export function normalizeSiYuanBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请输入有效的思源服务地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('思源地址只支持不含账号、查询参数和片段的 HTTP(S) 地址')
  }
  return url.toString().replace(/\/+$/, '')
}

export class SiYuanClient {
  constructor(private readonly readConfig: () => SiYuanStoredConfig) {}

  async listNotebooks(): Promise<SiYuanNotebook[]> {
    const data = await this.request<{ notebooks?: Array<{ id?: string; name?: string; closed?: boolean }> }>('/api/notebook/lsNotebooks', {})
    return (data?.notebooks || []).filter((item) => typeof item.id === 'string' && typeof item.name === 'string')
      .map((item) => ({ id: item.id!, name: item.name!, closed: Boolean(item.closed) }))
  }

  async listDocuments(notebookId: string): Promise<SiYuanSearchResult[]> {
    if (!NOTEBOOK_ID.test(notebookId)) throw new Error('思源笔记本 ID 格式无效')
    await this.request('/api/sqlite/flushTransaction', {})
    const rows = await this.request<Array<{ docId: string; notebookId: string; title: string; path: string }>>('/api/query/sql', {
      stmt: `SELECT id AS docId, box AS notebookId, content AS title, hpath AS path
        FROM blocks WHERE type='d' AND box=${sqlText(notebookId)} ORDER BY hpath LIMIT 200`,
    })
    return (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row.docId === 'string' && DOC_ID.test(row.docId))
      .map((row) => ({ docId: row.docId, notebookId: row.notebookId, title: String(row.title || '').trim(), path: String(row.path || ''), snippet: '' }))
  }

  async search(keyword: string, options: { notebookId?: string; parentDocId?: string; limit?: number } = {}): Promise<SiYuanSearchResult[]> {
    const text = keyword.trim()
    if (text.length < 2) throw new Error('请输入至少 2 个字符的搜索词')
    if (text.length > 100) throw new Error('搜索词不能超过 100 个字符')
    await this.request('/api/sqlite/flushTransaction', {})
    const escaped = text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_').replaceAll("'", "''")
    if (options.notebookId && !NOTEBOOK_ID.test(options.notebookId)) throw new Error('思源笔记本 ID 格式无效')
    const boxFilter = options.notebookId ? `AND d.box = ${sqlText(options.notebookId)}` : ''
    let pathFilter = ''
    if (options.parentDocId) {
      const parent = await this.documentMeta(options.parentDocId)
      if (options.notebookId && parent.notebookId !== options.notebookId) throw new Error('搜索目录与笔记本不一致')
      const hPath = parent.hPath.replace(/\/+$/, '')
      pathFilter = `AND (d.id = ${sqlText(options.parentDocId)} OR substr(d.hpath, 1, length(${sqlText(`${hPath}/`)})) = ${sqlText(`${hPath}/`)})`
    }
    const stmt = `SELECT d.id AS docId, d.box AS notebookId, d.content AS title, d.path AS path,
      (SELECT substr(match.content, 1, 180) FROM blocks match
       WHERE match.root_id = d.id AND match.content LIKE '%${escaped}%' ESCAPE '\\'
       ORDER BY match.updated DESC LIMIT 1) AS snippet, MAX(b.updated) AS updated
      FROM blocks b JOIN blocks d ON d.id = b.root_id
      WHERE b.content LIKE '%${escaped}%' ESCAPE '\\' ${boxFilter} ${pathFilter}
      GROUP BY d.id ORDER BY updated DESC LIMIT ${Math.max(1, Math.min(100, Math.trunc(options.limit || 50)))}`
    const rows = await this.request<SiYuanSearchResult[]>('/api/query/sql', { stmt })
    return (Array.isArray(rows) ? rows : []).filter((row) => row && DOC_ID.test(row.docId) && typeof row.title === 'string')
      .map((row) => ({
        docId: row.docId,
        notebookId: String(row.notebookId || ''),
        title: row.title.trim(),
        path: String(row.path || '').trim(),
        snippet: String(row.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 180),
      }))
  }

  async read(docId: string): Promise<SiYuanDocument> {
    if (!DOC_ID.test(docId)) throw new Error('思源文档 ID 格式无效')
    const data = await this.request<{ hPath?: string; content?: string }>('/api/export/exportMdContent', { id: docId })
    if (typeof data?.content !== 'string') throw new Error('思源未返回文档正文')
    if (data.content.length > 100_000) throw new Error('文档过大（超过 100,000 字符）')
    const meta = await this.documentMeta(docId)
    return { docId, notebookId: meta.notebookId, path: String(data.hPath || ''), markdown: data.content }
  }

  async create(input: { notebookId: string; parentDocId?: string; path: string; markdown: string }): Promise<{ docId: string; path: string }> {
    const notebookId = input.notebookId.trim()
    if (!NOTEBOOK_ID.test(notebookId)) throw new Error('创建文档需要指定有效的思源笔记本 ID')
    const titlePath = input.path.trim().replace(/^\/+|\/+$/g, '')
    if (!titlePath || titlePath.split('/').some((part) => !part.trim() || part === '.' || part === '..')) throw new Error('请输入有效的文档路径')
    if (!input.markdown.trim()) throw new Error('文档内容不能为空')
    if (input.markdown.length > 100_000) throw new Error('文档内容不能超过 100,000 字符')

    let fullPath = `/${titlePath}`
    if (input.parentDocId?.trim()) {
      if (!DOC_ID.test(input.parentDocId)) throw new Error('思源父文档 ID 格式无效')
      const parent = await this.documentMeta(input.parentDocId)
      if (parent.notebookId !== notebookId) throw new Error('父文档与目标笔记本不一致')
      fullPath = `${parent.hPath.replace(/\/+$/, '')}/${titlePath}`
    }
    await this.request('/api/sqlite/flushTransaction', {})
    const existing = await this.request<Array<{ id: string }>>('/api/query/sql', {
      stmt: `SELECT id FROM blocks WHERE type='d' AND box=${sqlText(notebookId)} AND hpath=${sqlText(fullPath)} LIMIT 1`,
    })
    if (existing?.[0]?.id) throw new Error(`目标路径已存在文档（${existing[0].id}）；请搜索并追加到原文档，或选择其他标题`)
    const id = await this.request<string>('/api/filetree/createDocWithMd', {
      notebook: notebookId, path: fullPath, markdown: input.markdown,
    })
    if (!id || !DOC_ID.test(id)) throw new Error('思源没有返回新文档 ID，请检查文档是否已创建后再重试')
    return { docId: id, path: fullPath }
  }

  async append(input: { parentDocId: string; markdown: string }): Promise<{ blockId: string }> {
    const parentDocId = input.parentDocId.trim()
    if (!DOC_ID.test(parentDocId)) throw new Error('思源目标文档 ID 格式无效')
    if (!input.markdown.trim()) throw new Error('追加内容不能为空')
    if (input.markdown.length > 100_000) throw new Error('追加内容不能超过 100,000 字符')
    const data = await this.request<Array<{ doOperations?: Array<{ id?: string }> }>>('/api/block/appendBlock', {
      data: input.markdown, dataType: 'markdown', parentID: parentDocId,
    })
    return { blockId: String(data?.[0]?.doOperations?.[0]?.id || '') }
  }

  async documentMeta(docId: string): Promise<{ notebookId: string; hPath: string }> {
    if (!DOC_ID.test(docId)) throw new Error('思源文档 ID 格式无效')
    await this.request('/api/sqlite/flushTransaction', {})
    const rows = await this.request<Array<{ notebookId?: string; hPath?: string }>>('/api/query/sql', {
      stmt: `SELECT box AS notebookId, hpath AS hPath FROM blocks WHERE id='${docId}' LIMIT 1`,
    })
    const row = rows?.[0]
    if (!row?.notebookId || !row.hPath) throw new Error('思源文档不存在或已删除')
    return { notebookId: row.notebookId, hPath: row.hPath }
  }

  private async request<T = unknown>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const config = this.readConfig()
    if (!config.baseUrl || !config.token) throw new Error('请先在「设置 → 思源知识库」配置服务地址与 API Token')
    let response: Response
    try {
      response = await fetch(`${config.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Token ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      const message = String((error as Error)?.message || '网络连接失败').replaceAll(config.token, '[已隐藏]')
      throw new Error(`无法连接思源：${message}`)
    }
    if (!response.ok) throw new Error(`思源请求失败：HTTP ${response.status} ${response.statusText}`)
    let payload: KernelResponse<T>
    try { payload = await response.json() as KernelResponse<T> } catch { throw new Error('思源返回了无效 JSON') }
    if (payload.code !== 0) {
      const message = String(payload.msg || '未知错误').replaceAll(config.token, '[已隐藏]').slice(0, 300)
      throw new Error(`思源 API 错误（${payload.code}）：${message}`)
    }
    return payload.data as T
  }
}

export function isSiYuanDocumentId(value: string): boolean { return DOC_ID.test(value) }
