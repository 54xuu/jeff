import type { DB } from '../db/db.js'
import { agentRepo } from '../db/repos.js'
import { XIAOJIE_ID } from '../ipc/contract.js'
import type { ToolBridge } from './bridge.js'

/** 管理工具名（小杰独占；其他 agent 的 opencode 定义里显式禁用） */
export const ADMIN_TOOL_NAMES = [
  'jeff_agent_create',
  'jeff_agent_update',
  'jeff_agent_delete',
  'jeff_agent_list',
  'jeff_agent_get',
] as const

export type AdminDeps = {
  db: DB
  /** 变更后回调（同步 md + 通知 UI） */
  onChanged: () => void
}

/**
 * 「没打算改的字段」的识别：模型改一处时会把自己没打算改的字段补成空串（v1.8.2 在插件、v1.8.3 在定时任务
 * 上都实测过），而空串 !== undefined，于是 `name:''` 会把智能体名字清空。统一按「空串 = 未提供」处理。
 */
function nonBlank(v: unknown): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}

/** 取「明确传了值」的字段（空串视为没传）；patch 里只放真的要改的键 */
function onlyProvided(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v
  return out
}

/** 在工具桥上注册 admin 工具实现（bridge 名 = opencode 工具名） */
export function registerAdminTools(reg: ToolBridge, deps: AdminDeps): void {
  const agents = agentRepo(deps.db)
  const [T_CREATE, T_UPDATE, T_DELETE, T_LIST, T_GET] = ADMIN_TOOL_NAMES

  reg.register(T_CREATE, async (args: { name?: string; description?: string; instructions?: string; avatar?: string; model_provider?: string; model_id?: string; thinking?: string; category?: string }) => {
    const name = (args.name || '').trim()
    if (!name) throw new Error('name 不能为空')
    const thinking = normalizeThinking(args.thinking)
    const row = agents.create({
      name,
      avatar: args.avatar || '🤖',
      description: args.description || '',
      instructions: args.instructions || '',
      model_provider: args.model_provider || '',
      model_id: args.model_id || '',
      thinking,
      category: args.category || '',
    })
    deps.onChanged()
    return { id: row.id, name: row.name, category: row.category }
  })

  reg.register(T_UPDATE, async (args: { id?: string; name?: string; description?: string; instructions?: string; avatar?: string; model_provider?: string; model_id?: string; thinking?: string; category?: string; archived?: boolean }) => {
    if (!args.id) throw new Error('id 不能为空')
    if (args.id === XIAOJIE_ID) throw new Error('小杰是内置管家，不可编辑')
    const patch = onlyProvided({
      name: nonBlank(args.name),
      description: nonBlank(args.description),
      instructions: nonBlank(args.instructions),
      avatar: nonBlank(args.avatar),
      model_provider: nonBlank(args.model_provider),
      model_id: nonBlank(args.model_id),
      category: nonBlank(args.category),
      ...(nonBlank(args.thinking) !== undefined ? { thinking: normalizeThinking(args.thinking) } : {}),
      ...(args.archived !== undefined ? { archived: args.archived ? 1 : 0 } : {}),
    })
    if (Object.keys(patch).length === 0) throw new Error('没有要修改的字段（name / avatar / description / instructions / model_* / thinking / category / archived 至少要传一个有值的）')
    const row = agents.update(args.id, patch)
    if (!row) throw new Error(`智能体不存在: ${args.id}`)
    deps.onChanged()
    return { id: row.id, name: row.name, changed: Object.keys(patch) }
  })

  reg.register(T_DELETE, async (args: { id?: string }) => {
    if (!args.id) throw new Error('id 不能为空')
    if (args.id === XIAOJIE_ID) throw new Error('小杰是内置管家，不可删除')
    const ok = agents.softDelete(args.id)
    if (!ok) throw new Error(`删除失败（不存在或不可删除）: ${args.id}`)
    deps.onChanged()
    return { deleted: true }
  })

  reg.register(T_LIST, async () => {
    return agents.list().map((a) => ({ id: a.id, name: a.name, avatar: a.avatar, description: a.description, builtin: !!a.builtin, archived: !!a.archived }))
  })

  reg.register(T_GET, async (args: { id?: string }) => {
    if (!args.id) throw new Error('id 不能为空')
    const a = agents.get(args.id)
    if (!a) throw new Error(`智能体不存在: ${args.id}`)
    return { id: a.id, name: a.name, avatar: a.avatar, description: a.description, instructions: a.instructions, model_provider: a.model_provider, model_id: a.model_id, thinking: a.thinking || '', builtin: !!a.builtin }
  })
}

const THINKING_OK = new Set(['', 'none', 'low', 'high', 'max'])

function normalizeThinking(v: string | undefined): string {
  if (v === undefined || v === null) return ''
  const t = String(v).trim()
  if (!THINKING_OK.has(t)) throw new Error(`thinking 必须是空串 / none / low / high / max，收到: ${t}`)
  return t
}
