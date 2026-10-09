import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, type DB } from '../src/db/db.js'
import { projectRepo } from '../src/db/repos.js'
import { buildPaths } from '../src/paths.js'
import { ToolBridge } from '../src/tools/bridge.js'
import { registerSiYuanTools } from '../src/siyuan/tools.js'
import type { SiYuanClient } from '../src/siyuan/client.js'

const NOTEBOOK = '20261005111111-nb12345'
const OTHER_NOTEBOOK = '20261005111111-othernb1'
const PARENT = '20261005123456-abc1234'
const DOC = '20261005123456-newdoc1'

let root: string
let db: DB
let client: SiYuanClient
let defaultTarget: { notebookId: string; parentDocId: string }
let activeScope: { kind: 'private'; agentId: string } | { kind: 'group'; projectId: string; agentId: string } | null
let call: <T = unknown>(name: string, args?: Record<string, unknown>) => Promise<T>
let search: ReturnType<typeof vi.fn>
let listNotebooks: ReturnType<typeof vi.fn>
let documentMeta: ReturnType<typeof vi.fn>
let read: ReturnType<typeof vi.fn>
let create: ReturnType<typeof vi.fn>
let append: ReturnType<typeof vi.fn>
let changed: ReturnType<typeof vi.fn>

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-siyuan-tools-'))
  db = openDb(buildPaths(root))
  defaultTarget = { notebookId: '', parentDocId: '' }
  activeScope = { kind: 'private', agentId: 'agent-1' }
  search = vi.fn(async () => [{ docId: DOC, notebookId: NOTEBOOK, title: '项目背景', path: '/项目/背景', snippet: '正文' }])
  listNotebooks = vi.fn(async () => [
    { id: NOTEBOOK, name: '项目知识', closed: false },
    { id: OTHER_NOTEBOOK, name: '其他项目', closed: false },
  ])
  documentMeta = vi.fn(async (docId: string) => ({ notebookId: NOTEBOOK, hPath: docId === PARENT ? '/项目/资料' : '/项目/资料/日报' }))
  read = vi.fn(async (docId: string) => ({ docId, notebookId: NOTEBOOK, path: '/项目/资料/日报', markdown: '# 日报' }))
  create = vi.fn(async () => ({ docId: DOC, path: '/项目/资料/新文档' }))
  append = vi.fn(async () => ({ blockId: '20261005123456-blockid' }))
  changed = vi.fn()
  client = { search, listNotebooks, documentMeta, create, append, read } as unknown as SiYuanClient
  const bridge = new ToolBridge()
  registerSiYuanTools(bridge, {
    db,
    client,
    resolveSession: () => activeScope,
    getDefaultTarget: () => defaultTarget,
    onChanged: changed,
  })
  call = async <T = unknown>(name: string, args: Record<string, unknown> = {}) => {
    const handler = (bridge as unknown as { handlers: Map<string, (input: unknown) => Promise<unknown>> }).handlers.get(name)
    if (!handler) throw new Error(`missing handler: ${name}`)
    return handler({ ...args, __ctx: { sessionID: 'session-1' } }) as Promise<T>
  }
})

afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Jeff 内置思源工具', () => {
  it('项目群先在绑定笔记本和父文档内搜索，按要求可扩展全库', async () => {
    const project = projectRepo(db).create({ title: '康立季度', siyuan_notebook_id: NOTEBOOK, siyuan_parent_doc_id: PARENT })
    activeScope = { kind: 'group', projectId: project.id, agentId: 'agent-1' }
    const first = await call<{ scope: string; results: unknown[] }>('jeff_siyuan_search', { keyword: '项目背景' })
    expect(first.scope).toBe('当前项目目录及其子文档')
    expect(search).toHaveBeenNthCalledWith(1, '项目背景', { notebookId: NOTEBOOK, parentDocId: PARENT })
    const expanded = await call<{ scope: string }>('jeff_siyuan_search', { keyword: '项目背景', scope: 'all' })
    expect(expanded.scope).toBe('全库')
    expect(search).toHaveBeenNthCalledWith(2, '项目背景', {})
    await expect(call('jeff_siyuan_search', { keyword: '项目背景', notebook_id: OTHER_NOTEBOOK })).rejects.toThrow(/需要明确传 scope="all"/)
    await call('jeff_siyuan_search', { keyword: '项目背景', notebook_id: OTHER_NOTEBOOK, scope: 'all' })
    expect(search).toHaveBeenLastCalledWith('项目背景', { notebookId: OTHER_NOTEBOOK })
  })

  it('群没有绑定位置时拒绝静默全库搜索；私聊则默认全库搜索', async () => {
    const project = projectRepo(db).create({ title: '未绑定项目' })
    activeScope = { kind: 'group', projectId: project.id, agentId: 'agent-1' }
    await expect(call('jeff_siyuan_search', { keyword: '日报' })).rejects.toThrow(/尚未绑定/)
    expect(search).not.toHaveBeenCalled()
    activeScope = { kind: 'private', agentId: 'agent-1' }
    await call('jeff_siyuan_search', { keyword: '日报' })
    expect(search).toHaveBeenCalledWith('日报', {})
    search.mockClear()
    const mislabeledProjectScope = await call<{ scope: string }>('jeff_siyuan_search', { keyword: '康立日报', scope: 'project' })
    expect(mislabeledProjectScope.scope).toBe('全库')
    expect(search).toHaveBeenCalledWith('康立日报', {})
  })

  it('写入位置按项目绑定、全局默认解析；显式位置优先，缺省时要求用户配置', async () => {
    const project = projectRepo(db).create({ title: '当前项目', siyuan_notebook_id: NOTEBOOK, siyuan_parent_doc_id: PARENT })
    activeScope = { kind: 'group', projectId: project.id, agentId: 'agent-1' }
    await call('jeff_siyuan_create', { title_path: '会议纪要', markdown: '# 会议纪要' })
    expect(create).toHaveBeenCalledWith({ notebookId: NOTEBOOK, parentDocId: PARENT, path: '会议纪要', markdown: '# 会议纪要' })
    expect(changed).toHaveBeenCalledTimes(1)
    create.mockClear()
    await call('jeff_siyuan_create', { title_path: '单独归档', markdown: '# 归档', notebook_id: NOTEBOOK })
    expect(create).toHaveBeenCalledWith({ notebookId: NOTEBOOK, path: '单独归档', markdown: '# 归档' })
    create.mockClear()
    await call('jeff_siyuan_create', { title_path: '用户指定父文档', markdown: '# 归档', parent_doc_id: DOC })
    expect(create).toHaveBeenCalledWith({ notebookId: NOTEBOOK, parentDocId: DOC, path: '用户指定父文档', markdown: '# 归档' })

    projectRepo(db).update(project.id, { siyuan_notebook_id: '', siyuan_parent_doc_id: '' })
    defaultTarget = { notebookId: NOTEBOOK, parentDocId: PARENT }
    create.mockClear()
    await call('jeff_siyuan_create', { title_path: '全局默认', markdown: '# 默认' })
    expect(create).toHaveBeenCalledWith({ notebookId: NOTEBOOK, parentDocId: PARENT, path: '全局默认', markdown: '# 默认' })
    defaultTarget = { notebookId: '', parentDocId: '' }
    await expect(call('jeff_siyuan_create', { title_path: '未配置', markdown: '# 内容' })).rejects.toThrow(/没有明确的思源写入位置/)
  })

  it('追加校验项目群目录，调用末尾追加接口，并要求真实会话身份', async () => {
    const result = await call<{ docId: string; path: string }>('jeff_siyuan_append', { doc_id: DOC, markdown: '## 新增内容' })
    expect(documentMeta).toHaveBeenCalledWith(DOC)
    expect(append).toHaveBeenCalledWith({ parentDocId: DOC, markdown: '## 新增内容' })
    expect(result).toMatchObject({ docId: DOC, notebookId: NOTEBOOK, path: '/项目/资料/日报' })
    expect(changed).toHaveBeenCalledTimes(1)

    const project = projectRepo(db).create({ title: '当前项目', siyuan_notebook_id: NOTEBOOK, siyuan_parent_doc_id: PARENT })
    activeScope = { kind: 'group', projectId: project.id, agentId: 'agent-1' }
    await expect(call('jeff_siyuan_append', { doc_id: DOC, markdown: '## 项目日报' })).resolves.toMatchObject({ docId: DOC })
    documentMeta.mockResolvedValueOnce({ notebookId: OTHER_NOTEBOOK, hPath: '/其他项目/日报' })
    await expect(call('jeff_siyuan_append', { doc_id: DOC, markdown: '## 越界' })).rejects.toThrow(/不在当前项目群绑定的笔记本内/)
    await expect(call('jeff_siyuan_append', { doc_id: DOC, markdown: '## 明确全库', scope: 'all' })).resolves.toMatchObject({ docId: DOC })

    const unbound = projectRepo(db).create({ title: '未绑定项目' })
    activeScope = { kind: 'group', projectId: unbound.id, agentId: 'agent-1' }
    await expect(call('jeff_siyuan_append', { doc_id: DOC, markdown: '## 越界' })).rejects.toThrow(/尚未绑定/)
    await expect(call('jeff_siyuan_append', { doc_id: DOC, markdown: '## 明确全库', scope: 'all' })).resolves.toMatchObject({ docId: DOC })

    activeScope = null
    await expect(call('jeff_siyuan_read', { doc_id: DOC })).rejects.toThrow(/无法识别当前会话作用域/)
  })

  it('项目群读取受绑定目录约束，扩展到全库后要求显式 scope=all', async () => {
    const project = projectRepo(db).create({ title: '当前项目', siyuan_notebook_id: NOTEBOOK, siyuan_parent_doc_id: PARENT })
    activeScope = { kind: 'group', projectId: project.id, agentId: 'agent-1' }
    await expect(call('jeff_siyuan_read', { doc_id: DOC })).resolves.toMatchObject({ docId: DOC, markdown: '# 日报' })
    expect(documentMeta).toHaveBeenCalledWith(DOC)
    expect(documentMeta).toHaveBeenCalledWith(PARENT)

    documentMeta.mockResolvedValueOnce({ notebookId: '20261005111111-othernb1', hPath: '/其他项目/资料' })
    await expect(call('jeff_siyuan_read', { doc_id: DOC })).rejects.toThrow(/不在当前项目群绑定的笔记本内/)
    expect(read).toHaveBeenCalledTimes(1)

    await expect(call('jeff_siyuan_read', { doc_id: DOC, scope: 'all' })).resolves.toMatchObject({ docId: DOC })
    expect(read).toHaveBeenCalledTimes(2)
  })
})
