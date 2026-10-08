import { MemoryRouter, type MemoryPrivacy } from '../memory/routing.js'
import type { ToolBridge } from './bridge.js'
import type { MemoryStore, MemoryScope, MemoryOp } from '../memory/store.js'
import type { SessionIndex } from '../memory/indexer.js'
import type { DB } from '../db/db.js'
import { agentRepo, projectAgentRepo, projectRepo } from '../db/repos.js'

/** 工具调用者上下文（由插件透传） */
export interface ToolCtx {
  sessionID?: string
  agent?: string
  messageID?: string
}

export type SessionScopeCtx =
  | { kind: 'private'; agentId: string; isSubtask?: boolean }
  | { kind: 'group'; projectId: string; agentId: string; threadId?: string; isSubtask?: boolean }
  | { kind: 'review'; agentId: string; projectId?: string }

export interface MemoryToolDeps {
  db: DB
  store: MemoryStore
  indexer: SessionIndex
  /** opencode session → Jeff 会话语义 */
  resolveSession(sessionId: string): SessionScopeCtx | null
  /** 记忆写入后回调（触发自动同步等） */
  onChanged?: () => void
  rulesContent?: (scope: MemoryScope) => string
}

/** 内部工具名（bridge handler 名 = opencode 工具名） */
export const MEMORY_TOOL = 'jeff_memory'
export const SEARCH_TOOL = 'jeff_session_search'
export const DELEGATE_TOOL = 'jeff_delegate'

/** 注册记忆与会话搜索工具（所有 agent 可用） */
export function registerMemoryTools(reg: ToolBridge, deps: MemoryToolDeps): void {
  const agents = agentRepo(deps.db)
  const router = new MemoryRouter(deps.store, deps.rulesContent)

  reg.register(MEMORY_TOOL, async (raw: Record<string, unknown>) => {
    const { __ctx, action, text, old_text, new_text, operations, scope, privacy } = raw as {
      __ctx?: ToolCtx
      action?: string
      text?: string
      old_text?: string
      new_text?: string
      operations?: MemoryOpLike[]
      scope?: string
      privacy?: MemoryPrivacy
    }
    const ctx = __ctx || {}
    const resolved = ctx.sessionID ? deps.resolveSession(ctx.sessionID) : null
    const agentId = resolved?.agentId || (ctx.agent ? agents.list().find((a) => a.name === ctx.agent)?.id : undefined)
    if (!agentId) return { ok: false, error: '无法识别调用者身份（无会话上下文）' }

    const target = resolveMemoryScope(deps.db, { agentId, resolved, explicit: scope })
    if ('error' in target) return { ok: false, error: target.error }
    const memScope = target.scope
    if (privacy && !['auto', 'private', 'public'].includes(privacy)) return { ok: false, error: '未知 privacy' }

    if (action === 'list') {
      const entries = router.list(memScope)
      return { ok: true, entries, totalChars: entries.join('\n').length, budget: deps.store.budget(memScope), scope: deps.store.label(memScope) }
    }
    if (action === 'batch' && Array.isArray(operations)) {
      const r = router.batch(memScope, operations as MemoryOp[], privacy)
      if (r.ok) deps.onChanged?.()
      return r
    }
    if (action === 'add') {
      const r = router.batch(memScope, [{ action: 'add', text: String(text || '') }], privacy)
      if (r.ok) deps.onChanged?.()
      return r
    }
    if (action === 'replace') {
      const r = router.batch(memScope, [{ action: 'replace', old_text: String(old_text || ''), new_text: String(new_text ?? '') }], privacy)
      if (r.ok) deps.onChanged?.()
      return r
    }
    if (action === 'remove') {
      const r = router.batch(memScope, [{ action: 'remove', old_text: String(old_text || '') }], privacy)
      if (r.ok) deps.onChanged?.()
      return r
    }
    return { ok: false, error: 'action 必须是 list/add/replace/remove/batch' }
  })

  reg.register(SEARCH_TOOL, async (raw: Record<string, unknown>) => {
    const { __ctx, query, limit, scope } = raw as { __ctx?: ToolCtx; query?: string; limit?: number; scope?: string }
    if (!query?.trim()) return { ok: false, error: 'query 必填' }
    const ctx = __ctx || {}
    const resolved = ctx.sessionID ? deps.resolveSession(ctx.sessionID) : null
    let scopeFilter: string | undefined
    if (scope && scope !== 'all') scopeFilter = scope
    else if (!scope && resolved) {
      scopeFilter = resolved.kind === 'group' ? `group:${resolved.projectId}` : `private:${resolved.agentId}`
    }
    const hits = deps.indexer.search(query, { limit, scope: scopeFilter })
    return {
      ok: true,
      count: hits.length,
      hits: hits.map((h) => ({ scope: h.scope, sender: h.sender, snippet: h.snippet, sessionId: h.sessionId, time: new Date(h.ts).toISOString() })),
    }
  })
}

interface MemoryOpLike {
  action?: string
  text?: string
  old_text?: string
  new_text?: string
}

type ScopeResolveResult = { scope: MemoryScope } | { error: string }

/** 记忆写入域解析：默认 agent 自身；group 会话默认项目共享记忆；共享项目记忆仍校验成员关系 */
export function resolveMemoryScope(
  db: DB,
  input: { agentId: string; resolved: SessionScopeCtx | null; explicit?: string },
): ScopeResolveResult {
  const agents = agentRepo(db)
  if (input.explicit) {
    if (input.explicit === 'self') return { scope: { kind: 'agent', agentId: input.agentId } }
    if (input.explicit === 'user') {
      return { scope: { kind: 'user' } }
    }
    if (input.explicit.startsWith('project:')) {
      const projectId = input.explicit.slice(8)
      if (!projectRepo(db).get(projectId)) return { error: '项目不存在' }
      const inProject = projectAgentRepo(db).getRole(projectId, input.agentId)
      if (!inProject) return { error: `你不属于项目 ${projectId}，不能写它的共享记忆` }
      return { scope: { kind: 'project', projectId } }
    }
    return { error: `未知 scope: ${input.explicit}` }
  }
  if (input.resolved?.kind === 'review' && input.resolved.projectId) return { scope: { kind: 'project', projectId: input.resolved.projectId } }
  if (input.resolved?.kind === 'group') return { scope: { kind: 'project', projectId: input.resolved.projectId } }
  return { scope: { kind: 'agent', agentId: input.agentId } }
}

/** 会话语义元数据（opencode session ↔ jeff 映射），存 kv */
export const sesMetaKey = (sessionId: string) => `sesmeta:${sessionId}`
