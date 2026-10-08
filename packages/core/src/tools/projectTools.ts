import type { ToolBridge } from './bridge.js'
import type { DB } from '../db/db.js'
import { PROJECT_STATUSES, TASK_PRIORITIES, TASK_STATUSES, agentRepo, projectAgentRepo, projectRepo, taskRepo } from '../db/repos.js'
import { parseProjectWorkspaceState, serializeProjectWorkspaceState, validateProjectWorkspaceJson } from '../project/workspace.js'

export interface ProjectToolDeps {
  db: DB
  /** 任务/项目变化后回调：写群系统消息（任务卡片）+ 通知 UI */
  onTaskChanged: (projectId: string, taskId?: string) => void
  onProjectChanged: () => void
}

/**
 * 「没打算改的字段」的识别：模型改一处时会把自己没打算改的字段补成空串（v1.8.2 插件、v1.8.3 定时任务
 * 都实测过），而空串 !== undefined，于是 `title:''` 会把群名/任务标题清空。统一按「空串 = 未提供」处理。
 */
function nonBlank(v: unknown): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}

function onlyProvided(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v
  return out
}

/** 注册项目群与任务工具；群内委派由真实成员身份校验。 */
export function registerProjectTools(reg: ToolBridge, deps: ProjectToolDeps): void {
  const projects = projectRepo(deps.db)
  const members = projectAgentRepo(deps.db)
  const agents = agentRepo(deps.db)
  const tasks = taskRepo(deps.db)

  reg.register('jeff_project_create', async (args: {
    title?: string
    icon?: string
    description?: string
    system_prompt?: string
    leader_agent_id?: string
    workspace_dir?: string
    members?: Array<string | { agentId?: string; agent_id?: string; role?: string }>
  }) => {
    const title = (args.title || '').trim()
    if (!title) throw new Error('title（群名）不能为空')
    const leaderId = args.leader_agent_id
    if (!leaderId) throw new Error('必须指定群主 leader_agent_id（一个 agent）')
    if (!agents.get(leaderId)) throw new Error(`群主智能体不存在: ${leaderId}`)
    const p = projects.create({
      title,
      icon: args.icon || '👥',
      description: args.description || '',
      system_prompt: args.system_prompt || '',
      leader_agent_id: leaderId,
      workspace_dir: (args.workspace_dir || '').trim(),
    })
    members.add(p.id, leaderId, 'leader', 0)
    for (const m of args.members || []) {
      const id = typeof m === 'string' ? m : m.agentId || m.agent_id
      if (!id || id === leaderId) continue
      if (!agents.get(id)) throw new Error(`成员智能体不存在: ${id}`)
      members.add(p.id, id, 'worker')
    }
    deps.onProjectChanged()
    return { id: p.id, title: p.title, leader_agent_id: p.leader_agent_id, workspace_dir: p.workspace_dir || '' }
  })

  reg.register('jeff_project_update', async (args: { id?: string; title?: string; description?: string; system_prompt?: string; clear_system_prompt?: boolean; icon?: string; status?: string; leader_agent_id?: string; workspace_dir?: string; workspace_state?: string }) => {
    if (!args.id) throw new Error('id 不能为空')
    const patch = onlyProvided({
      title: nonBlank(args.title),
      description: nonBlank(args.description),
      ...(args.clear_system_prompt ? { system_prompt: '' } : { system_prompt: nonBlank(args.system_prompt) }),
      icon: nonBlank(args.icon),
      status: nonBlank(args.status),
      leader_agent_id: nonBlank(args.leader_agent_id),
      ...(args.workspace_state !== undefined ? {
        workspace_state: serializeProjectWorkspaceState({
          ...parseProjectWorkspaceState(validateProjectWorkspaceJson(args.workspace_state)),
          // 自治 agent 可以维护项目事实，但不能伪造用户的选题确认、制作关联或成品验收。
          campaigns: parseProjectWorkspaceState(projects.get(args.id)?.workspace_state).campaigns,
          assets: parseProjectWorkspaceState(projects.get(args.id)?.workspace_state).assets,
          reportTemplates: parseProjectWorkspaceState(projects.get(args.id)?.workspace_state).reportTemplates,
          reportSources: parseProjectWorkspaceState(projects.get(args.id)?.workspace_state).reportSources,
        }),
      } : {}),
      // 例外：工作空间目录明确支持「传空串 = 清除为默认工作区」（工具说明里写明了）
      ...(args.workspace_dir !== undefined ? { workspace_dir: String(args.workspace_dir).trim() } : {}),
    })
    if (Object.keys(patch).length === 0) throw new Error('没有要修改的字段（title / description / system_prompt / icon / status / leader_agent_id / workspace_dir / workspace_state 至少要传一个有值的）')
    if (patch.status && !(PROJECT_STATUSES as readonly string[]).includes(String(patch.status))) {
      throw new Error(`status 非法：${String(patch.status)}（可用：${PROJECT_STATUSES.join('/')}）`)
    }
    const row = projects.update(args.id, patch)
    if (!row) throw new Error(`项目不存在或更新失败: ${args.id}`)
    if (patch.leader_agent_id) members.add(args.id, String(patch.leader_agent_id), 'leader')
    deps.onProjectChanged()
    return { id: row.id, title: row.title, workspace_dir: row.workspace_dir || '', changed: Object.keys(patch) }
  })

  reg.register('jeff_project_list', async () => {
    return projects.list().map((p) => ({
      id: p.id,
      title: p.title,
      icon: p.icon,
      status: p.status,
      description: p.description,
      system_prompt: p.system_prompt,
      leader_agent_id: p.leader_agent_id,
      workspace_dir: p.workspace_dir || '',
      members: members.listByProject(p.id).map((m) => {
        const agent = agents.get(m.agent_id)
        return {
          agent_id: m.agent_id,
          name: agent?.name || m.agent_id,
          role: m.role,
          duties: m.duties || '',
          model_override: m.model_override,
          thinking_override: m.thinking_override,
          execution_engine: agent?.execution_engine || 'opencode',
          engine_model: agent?.engine_model || '',
          model_provider: agent?.model_provider || '',
          model_id: agent?.model_id || '',
          thinking: agent?.thinking || '',
        }
      }),
    }))
  })

  reg.register('jeff_project_add_member', async (args: { project_id?: string; agent_id?: string; role?: string }) => {
    if (!args.project_id || !args.agent_id) throw new Error('project_id 与 agent_id 必填')
    if (!projects.get(args.project_id)) throw new Error(`项目不存在: ${args.project_id}`)
    if (!agents.get(args.agent_id)) throw new Error(`智能体不存在: ${args.agent_id}`)
    // 成员职责通过群内配置定义；群主身份由项目资料维护。
    members.add(args.project_id, args.agent_id, 'worker')
    deps.onProjectChanged()
    return { added: true }
  })

  reg.register('jeff_project_member_config', async (args: {
    project_id?: string; agent_id?: string; duties?: string; model_override?: string; thinking_override?: string
    reset_model?: boolean; reset_thinking?: boolean; clear_duties?: boolean
  }) => {
    const projectId = nonBlank(args.project_id)
    const agentId = nonBlank(args.agent_id)
    if (!projectId || !agentId) throw new Error('project_id 与 agent_id 必填')
    if (!projects.get(projectId)) throw new Error(`项目不存在: ${projectId}`)
    if (!members.getRole(projectId, agentId)) throw new Error('该 Agent 不属于本项目群，请先添加成员')
    const patch: { duties?: string; model_override?: string | null; thinking_override?: string | null } = {}
    if (args.clear_duties) patch.duties = ''
    else if (nonBlank(args.duties) !== undefined) {
      if (args.duties!.length > 12000) throw new Error('成员职责不能超过 12000 个字符')
      patch.duties = args.duties
    }
    if (args.reset_model) patch.model_override = null
    else if (nonBlank(args.model_override) !== undefined) {
      if (args.model_override!.trim().length > 500) throw new Error('模型覆盖不能超过 500 个字符')
      patch.model_override = args.model_override!.trim()
    }
    if (args.reset_thinking) patch.thinking_override = null
    else if (nonBlank(args.thinking_override) !== undefined) {
      const thinking = args.thinking_override!.trim()
      if (!['none', 'low', 'medium', 'high', 'max'].includes(thinking)) throw new Error('不支持的思考程度')
      patch.thinking_override = thinking
    }
    if (!Object.keys(patch).length) throw new Error('请提供要修改的字段；恢复个人默认时使用 reset_model / reset_thinking')
    members.updateConfig(projectId, agentId, patch)
    deps.onProjectChanged()
    return { updated: true, project_id: projectId, agent_id: agentId, changed: Object.keys(patch) }
  })

  reg.register('jeff_project_remove_member', async (args: { project_id?: string; agent_id?: string }) => {
    if (!args.project_id || !args.agent_id) throw new Error('project_id 与 agent_id 必填')
    const p = projects.get(args.project_id)
    if (!p) throw new Error(`项目不存在: ${args.project_id}`)
    if (p.leader_agent_id === args.agent_id) throw new Error('不能移除群主（leader）；请先改群主')
    members.remove(args.project_id, args.agent_id)
    deps.onProjectChanged()
    return { removed: true }
  })

  reg.register('jeff_project_delete', async (args: { id?: string }) => {
    if (!args.id) throw new Error('id 不能为空')
    if (!projects.get(args.id)) throw new Error(`项目不存在: ${args.id}`)
    const ok = projects.softDelete(args.id)
    if (!ok) throw new Error(`解散失败: ${args.id}`)
    deps.onProjectChanged()
    return { deleted: true, id: args.id }
  })

  reg.register('jeff_task_create', async (args: {
    project_id?: string
    title?: string
    description?: string
    priority?: string
    assignee_agent_id?: string
    parent_task_id?: string
    due_at?: number
    depends_on?: string[]
    acceptance_criteria?: string
  }) => {
    if (!args.project_id) throw new Error('project_id 必填')
    const title = (args.title || '').trim()
    if (!title) throw new Error('title 必填')
    if (!projects.get(args.project_id)) throw new Error(`项目不存在: ${args.project_id}`)
    const assigneeType = args.assignee_agent_id ? 'agent' : 'none'
    if (args.assignee_agent_id && !agents.get(args.assignee_agent_id)) throw new Error(`指派的智能体不存在: ${args.assignee_agent_id}`)
    const t = tasks.create({
      project_id: args.project_id,
      title,
      description: args.description || '',
      priority: args.priority,
      assignee_type: assigneeType,
      assignee_id: args.assignee_agent_id || '',
      parent_task_id: args.parent_task_id || null,
      due_at: args.due_at,
      depends_on: args.depends_on,
      acceptance_criteria: args.acceptance_criteria || '',
    })
    deps.onTaskChanged(args.project_id, t.id)
    return { id: t.id, key: `JEF-${t.number}`, title: t.title, status: t.status }
  })

  reg.register('jeff_task_update', async (args: {
    id?: string
    title?: string
    description?: string
    status?: string
    priority?: string
    assignee_agent_id?: string
    due_at?: number
    depends_on?: string[]
    acceptance_criteria?: string
  }) => {
    if (!args.id) throw new Error('id 必填')
    const cur = tasks.get(args.id)
    if (!cur) throw new Error(`任务不存在: ${args.id}`)
    if (args.assignee_agent_id !== undefined && args.assignee_agent_id !== '' && !agents.get(args.assignee_agent_id)) {
      throw new Error(`指派的智能体不存在: ${args.assignee_agent_id}`)
    }
    const patch = onlyProvided({
      title: nonBlank(args.title),
      description: nonBlank(args.description),
      status: nonBlank(args.status),
      priority: nonBlank(args.priority),
      ...(args.due_at !== undefined && Number.isFinite(args.due_at) ? { due_at: args.due_at } : {}),
      ...(args.depends_on !== undefined ? { depends_on: JSON.stringify(args.depends_on) } : {}),
      acceptance_criteria: nonBlank(args.acceptance_criteria),
      // 例外：指派明确支持「传空串 = 取消指派」（工具说明里写明了）
      ...(args.assignee_agent_id !== undefined
        ? { assignee_type: args.assignee_agent_id ? 'agent' : 'none', assignee_id: args.assignee_agent_id }
        : {}),
    })
    if (Object.keys(patch).length === 0) throw new Error('没有要修改的字段（title / description / status / priority / assignee_agent_id / due_at / depends_on / acceptance_criteria 至少要传一个有值的）')
    // 非法枚举值必须在调用 repo 前拦住：repo 对非法值返回 undefined，直接读 row.id 会抛
    // 「Cannot read properties of undefined」这种内部错误，模型看不懂也不知道该怎么改
    if (patch.status && !(TASK_STATUSES as readonly string[]).includes(String(patch.status))) {
      throw new Error(`status 非法：${String(patch.status)}（可用：${TASK_STATUSES.join('/')}）`)
    }
    if (patch.priority && !(TASK_PRIORITIES as readonly string[]).includes(String(patch.priority))) {
      throw new Error(`priority 非法：${String(patch.priority)}（可用：${TASK_PRIORITIES.join('/')}）`)
    }
    const row = tasks.update(args.id, patch)
    if (!row) throw new Error(`任务更新失败（不存在或状态/优先级非法）: ${args.id}`)
    deps.onTaskChanged(cur.project_id, args.id)
    return { id: row!.id, key: `JEF-${row!.number}`, status: row!.status, changed: Object.keys(patch) }
  })

  reg.register('jeff_task_list', async (args: { project_id?: string; status?: string }) => {
    if (!args.project_id) throw new Error('project_id 必填')
    let list = tasks.listByProject(args.project_id)
    if (args.status) list = list.filter((t) => t.status === args.status)
    return list.map((t) => ({
      id: t.id,
      key: `JEF-${t.number}`,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee_agent_id: t.assignee_id || null,
      assignee_name: t.assignee_id ? agents.get(t.assignee_id)?.name || null : null,
    }))
  })

  reg.register('jeff_task_delete', async (args: { id?: string }) => {
    if (!args.id) throw new Error('id 必填')
    const cur = tasks.get(args.id)
    if (!cur) throw new Error(`任务不存在: ${args.id}`)
    tasks.softDelete(args.id)
    deps.onTaskChanged(cur.project_id, args.id)
    return { deleted: true }
  })
}

/** 任务变更 → 群系统消息（任务卡片）。onTaskChanged 的默认实现由 JeffCore 提供。 */
export function taskCardMessage(db: DB, projectId: string, taskId: string): { content: string; meta: Record<string, unknown> } {
  const t = taskRepo(db).get(taskId)
  if (!t) return { content: '', meta: {} }
  const assignee = t.assignee_id ? agentRepo(db).get(t.assignee_id)?.name : undefined
  const meta = { type: 'task', taskId: t.id, projectId }
  const who = assignee ? ` → ${assignee}` : ''
  return { content: `📋 任务 ${`JEF-${t.number}`}：${t.title}（${statusLabel(t.status)}${who}）`, meta }
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = { todo: '待办', in_progress: '进行中', in_review: '待审', done: '完成', cancelled: '已取消' }
  return map[status] || status
}

/** 供小杰指令参考：项目群/任务工具提示文本 */
export const PROJECT_TOOL_HINT = `项目群工具（jeff_project_*）用于建群、维护群规则（system_prompt）、群主、成员职责和逐成员模型/思考覆盖。Agent 个人 Prompt 只写跨场景稳定的人设与能力；leader/协调者/执行职责只存在于具体群的群规则和成员配置。所有 Agent 可以使用 Jeff 工具；项目群资源仍按真实成员身份校验。任务工具（jeff_task_*）用于创建和流转任务。`
