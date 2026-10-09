import type { DB } from '../db/db.js'
import { projectRepo } from '../db/repos.js'
import type { SessionScopeCtx } from '../tools/memoryTools.js'
import type { ToolBridge } from '../tools/bridge.js'
import type { SiYuanClient } from './client.js'

export interface SiYuanToolDeps {
  db: DB
  client: SiYuanClient
  resolveSession: (sessionId: string) => SessionScopeCtx | null
  getDefaultTarget: () => { notebookId?: string; parentDocId?: string }
  onChanged: () => void
}

/** Register model-facing SiYuan tools. Session identity and project binding come from Jeff, never tool arguments. */
export function registerSiYuanTools(bridge: ToolBridge, deps: SiYuanToolDeps): void {
  const { client } = deps
  bridge.register('jeff_siyuan_list_notebooks', async () => client.listNotebooks())
  bridge.register('jeff_siyuan_search', async (raw: Record<string, unknown>) => {
    const ctx = raw.__ctx as { sessionID?: string } | undefined
    const scope = ctx?.sessionID ? deps.resolveSession(ctx.sessionID) : null
    if (!scope || scope.kind === 'review') throw new Error('无法识别当前会话作用域，不能搜索思源')
    const keyword = typeof raw.keyword === 'string' ? raw.keyword : ''
    const requestedNotebook = typeof raw.notebook_id === 'string' ? raw.notebook_id.trim() : ''
    const requestedScope = raw.scope === 'all' ? 'all' : raw.scope === 'project' ? 'project' : ''
    const project = scope.kind === 'group' ? projectRepo(deps.db).get(scope.projectId) : undefined
    const boundNotebook = project?.siyuan_notebook_id || ''
    const boundParent = project?.siyuan_parent_doc_id || ''
    if (scope.kind === 'group' && !boundNotebook && !requestedNotebook && requestedScope !== 'all') {
      throw new Error('当前项目群尚未绑定思源目录；请先在群资料设置位置，或在用户明确要求全库搜索时传 scope="all"')
    }
    if (scope.kind === 'group' && requestedScope === 'project' && !boundNotebook && !requestedNotebook) {
      throw new Error('当前项目群尚未绑定思源目录；请先在群资料设置归档位置，或改为全库搜索')
    }
    // Private chats have no project binding. If the model labels a named-project question as
    // "project" scope, honor the private-chat default (whole library) instead of rejecting it.
    const all = !requestedNotebook && (requestedScope === 'all' || scope.kind === 'private')
    if (requestedNotebook && !(await client.listNotebooks()).some((item) => item.id === requestedNotebook)) {
      throw new Error('笔记本 ID 不可用；请先调用 jeff_siyuan_list_notebooks 选择有效笔记本')
    }
    if (scope.kind === 'group' && requestedNotebook && requestedNotebook !== boundNotebook && requestedScope !== 'all') {
      throw new Error('搜索其他笔记本需要明确传 scope="all"，确保这是用户要求的全库搜索')
    }
    const notebookId = requestedNotebook || (!all && scope.kind === 'group' ? boundNotebook : '')
    const parentDocId = requestedNotebook && requestedNotebook !== boundNotebook ? '' : (!all && notebookId ? boundParent : '')
    const results = await client.search(keyword, { ...(notebookId ? { notebookId } : {}), ...(parentDocId ? { parentDocId } : {}) })
    const location = notebookId
      ? requestedNotebook && requestedNotebook !== boundNotebook ? '指定笔记本' : `当前项目目录${parentDocId ? '及其子文档' : ''}`
      : '全库'
    return {
      scope: all ? '全库' : location,
      results,
      next: !all && scope.kind === 'group' ? '若结果不足，请再次调用 jeff_siyuan_search 并传 scope="all" 扩展到全库。' : '',
    }
  })

  bridge.register('jeff_siyuan_read', async (raw: Record<string, unknown>) => {
    const ctx = raw.__ctx as { sessionID?: string } | undefined
    const scope = ctx?.sessionID ? deps.resolveSession(ctx.sessionID) : null
    if (!scope || scope.kind === 'review') throw new Error('无法识别当前会话作用域，不能读取思源')
    const docId = typeof raw.doc_id === 'string' ? raw.doc_id.trim() : ''
    if (!docId) throw new Error('doc_id 不能为空')
    const project = scope.kind === 'group' ? projectRepo(deps.db).get(scope.projectId) : undefined
    if (scope.kind === 'group' && raw.scope !== 'all') {
      const notebookId = project?.siyuan_notebook_id || ''
      if (!notebookId) throw new Error('当前项目群尚未绑定思源目录；只有用户明确要求全库资料时才能传 scope="all" 读取')
      const doc = await client.documentMeta(docId)
      if (doc.notebookId !== notebookId) throw new Error('目标文档不在当前项目群绑定的笔记本内；如用户要求读取全库结果，请传 scope="all"')
      const parentDocId = project?.siyuan_parent_doc_id || ''
      if (parentDocId) {
        const parent = await client.documentMeta(parentDocId)
        const parentPath = parent.hPath.replace(/\/+$/, '')
        if (doc.hPath !== parentPath && !doc.hPath.startsWith(`${parentPath}/`)) {
          throw new Error('目标文档不在当前项目群绑定目录内；如用户要求读取全库结果，请传 scope="all"')
        }
      }
    }
    return client.read(docId)
  })

  const resolveTarget = async (scope: SessionScopeCtx, raw: Record<string, unknown>) => {
    const project = scope.kind === 'group' ? projectRepo(deps.db).get(scope.projectId) : undefined
    const global = deps.getDefaultTarget()
    // Models may inspect notebook options while preparing a write. Those IDs are not
    // user intent by themselves: only the explicit flag may override Jeff's target.
    const hasExplicitTarget = raw.explicit_target === true
    let notebookId = hasExplicitTarget && typeof raw.notebook_id === 'string' ? raw.notebook_id.trim() : ''
    let parentDocId = hasExplicitTarget && typeof raw.parent_doc_id === 'string' ? raw.parent_doc_id.trim() : ''
    if (parentDocId && !notebookId) notebookId = (await client.documentMeta(parentDocId)).notebookId
    if (!hasExplicitTarget) {
      notebookId = project?.siyuan_notebook_id || global.notebookId || ''
      parentDocId = project?.siyuan_notebook_id ? project.siyuan_parent_doc_id : (global.parentDocId || '')
    }
    if (!notebookId) throw new Error('没有明确的思源写入位置；请让用户指定笔记本或先配置项目群/全局归档目标')
    if (!(await client.listNotebooks()).some((item) => item.id === notebookId)) throw new Error('目标笔记本不存在或当前不可用，请重新选择思源写入位置')
    if (parentDocId && (await client.documentMeta(parentDocId)).notebookId !== notebookId) throw new Error('目标父文档不属于选定笔记本')
    return { notebookId, parentDocId }
  }

  bridge.register('jeff_siyuan_create', async (raw: Record<string, unknown>) => {
    const ctx = raw.__ctx as { sessionID?: string } | undefined
    const scope = ctx?.sessionID ? deps.resolveSession(ctx.sessionID) : null
    if (!scope || scope.kind === 'review') throw new Error('无法识别当前会话作用域，不能写入思源')
    const titlePath = typeof raw.title_path === 'string' ? raw.title_path.trim() : ''
    const markdown = typeof raw.markdown === 'string' ? raw.markdown : ''
    if (!titlePath || !markdown.trim()) throw new Error('title_path 与 markdown 必填')
    const target = await resolveTarget(scope, raw)
    const created = await client.create({ notebookId: target.notebookId, ...(target.parentDocId ? { parentDocId: target.parentDocId } : {}), path: titlePath, markdown })
    deps.onChanged()
    return { ...created, notebookId: target.notebookId, message: '思源文档已创建；原有文档未被覆盖。' }
  })

  bridge.register('jeff_siyuan_append', async (raw: Record<string, unknown>) => {
    const ctx = raw.__ctx as { sessionID?: string } | undefined
    const scope = ctx?.sessionID ? deps.resolveSession(ctx.sessionID) : null
    if (!scope || scope.kind === 'review') throw new Error('无法识别当前会话作用域，不能写入思源')
    const docId = typeof raw.doc_id === 'string' ? raw.doc_id.trim() : ''
    const markdown = typeof raw.markdown === 'string' ? raw.markdown : ''
    if (!docId || !markdown.trim()) throw new Error('doc_id 与 markdown 必填')
    const doc = await client.documentMeta(docId)
    const project = scope.kind === 'group' ? projectRepo(deps.db).get(scope.projectId) : undefined
    if (scope.kind === 'group' && raw.scope !== 'all') {
      const notebookId = project?.siyuan_notebook_id || ''
      if (!notebookId) throw new Error('当前项目群尚未绑定思源目录；只有用户明确要求全库追加时才能传 scope="all"')
      if (doc.notebookId !== notebookId) throw new Error('目标文档不在当前项目群绑定的笔记本内；如用户要求全库追加，请传 scope="all"')
      const parentDocId = project?.siyuan_parent_doc_id || ''
      if (parentDocId) {
        const parent = await client.documentMeta(parentDocId)
        const parentPath = parent.hPath.replace(/\/+$/, '')
        if (doc.hPath !== parentPath && !doc.hPath.startsWith(`${parentPath}/`)) {
          throw new Error('目标文档不在当前项目群绑定目录内；如用户要求全库追加，请传 scope="all"')
        }
      }
    }
    const appended = await client.append({ parentDocId: docId, markdown })
    deps.onChanged()
    return { ...appended, docId, notebookId: doc.notebookId, path: doc.hPath, message: '内容已追加到文档末尾。' }
  })
}
