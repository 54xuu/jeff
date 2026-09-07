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

/** 在工具桥上注册 admin 工具实现（bridge 名 = opencode 工具名） */
export function registerAdminTools(reg: ToolBridge, deps: AdminDeps): void {
  const agents = agentRepo(deps.db)
  const [T_CREATE, T_UPDATE, T_DELETE, T_LIST, T_GET] = ADMIN_TOOL_NAMES

  reg.register(T_CREATE, async (args: { name?: string; description?: string; instructions?: string; avatar?: string; model_provider?: string; model_id?: string; thinking?: string }) => {
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
    })
    deps.onChanged()
    return { id: row.id, name: row.name }
  })

  reg.register(T_UPDATE, async (args: { id?: string; name?: string; description?: string; instructions?: string; avatar?: string; model_provider?: string; model_id?: string; thinking?: string; archived?: boolean }) => {
    if (!args.id) throw new Error('id 不能为空')
    if (args.id === XIAOJIE_ID) throw new Error('小杰是内置管家，不可编辑')
    const row = agents.update(args.id, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
      ...(args.avatar !== undefined ? { avatar: args.avatar } : {}),
      ...(args.model_provider !== undefined ? { model_provider: args.model_provider } : {}),
      ...(args.model_id !== undefined ? { model_id: args.model_id } : {}),
      ...(args.thinking !== undefined ? { thinking: normalizeThinking(args.thinking) } : {}),
      ...(args.archived !== undefined ? { archived: args.archived ? 1 : 0 } : {}),
    })
    if (!row) throw new Error(`智能体不存在: ${args.id}`)
    deps.onChanged()
    return { id: row.id, name: row.name }
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
