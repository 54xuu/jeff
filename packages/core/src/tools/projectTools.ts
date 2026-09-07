import type { ToolBridge } from './bridge.js'
import type { DB } from '../db/db.js'
import { agentRepo, projectAgentRepo, projectRepo, taskRepo } from '../db/repos.js'

export interface ProjectToolDeps {
  db: DB
  /** 任务/项目变化后回调：写群系统消息（任务卡片）+ 通知 UI */
  onTaskChanged: (projectId: string, taskId?: string) => void
  onProjectChanged: () => void
}

/** 注册项目群与任务工具（小杰与 leader 可用） */
export function registerProjectTools(reg: ToolBridge, deps: ProjectToolDeps): void {
  const projects = projectRepo(deps.db)
  const members = projectAgentRepo(deps.db)
  const agents = agentRepo(deps.db)
  const tasks = taskRepo(deps.db)

  reg.register('jeff_project_create', async (args: {
    title?: string
    icon?: string
    description?: string
    leader_agent_id?: string
    members?: Array<{ agentId?: string; agent_id?: string; role?: string }>
  }) => {
    const title = (args.title || '').trim()
    if (!title) throw new Error('title（群名）不能为空')
    const leaderId = args.leader_agent_id
    if (!leaderId) throw new Error('必须指定群主 leader_agent_id（一个 agent）')
    if (!agents.get(leaderId)) throw new Error(`群主智能体不存在: ${leaderId}`)
    const p = projects.create({ title, icon: args.icon || '👥', description: args.description || '', leader_agent_id: leaderId })
    members.add(p.id, leaderId, 'leader', 0)
    for (const m of args.members || []) {
      const id = m.agentId || m.agent_id
      if (!id || id === leaderId) continue
      if (!agents.get(id)) throw new Error(`成员智能体不存在: ${id}`)
      members.add(p.id, id, 'worker')
    }
    deps.onProjectChanged()
    return { id: p.id, title: p.title, leader_agent_id: p.leader_agent_id }
  })

  reg.register('jeff_project_update', async (args: { id?: string; title?: string; description?: string; icon?: string; status?: string; leader_agent_id?: string }) => {
    if (!args.id) throw new Error('id 不能为空')
    const row = projects.update(args.id, {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.icon !== undefined ? { icon: args.icon } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.leader_agent_id !== undefined ? { leader_agent_id: args.leader_agent_id } : {}),
    })
    if (!row) throw new Error(`项目不存在: ${args.id}`)
    if (args.leader_agent_id) members.add(args.id, args.leader_agent_id, 'leader')
    deps.onProjectChanged()
    return { id: row.id, title: row.title }
  })

  reg.register('jeff_project_list', async () => {
    return projects.list().map((p) => ({
      id: p.id,
      title: p.title,
      icon: p.icon,
      status: p.status,
      description: p.description,
      leader_agent_id: p.leader_agent_id,
      members: members.listByProject(p.id).map((m) => ({ agentId: m.agent_id, role: m.role })),
    }))
  })

  reg.register('jeff_project_add_member', async (args: { project_id?: string; agent_id?: string; role?: string }) => {
    if (!args.project_id || !args.agent_id) throw new Error('project_id 与 agent_id 必填')
    if (!projects.get(args.project_id)) throw new Error(`项目不存在: ${args.project_id}`)
    if (!agents.get(args.agent_id)) throw new Error(`智能体不存在: ${args.agent_id}`)
    // 加员一律 worker；群主只能通过 create/update 的 leader_agent_id 指定
    members.add(args.project_id, args.agent_id, 'worker')
    deps.onProjectChanged()
    return { added: true }
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

  reg.register('jeff_task_create', async (args: {
    project_id?: string
    title?: string
    description?: string
    priority?: string
    assignee_agent_id?: string
    parent_task_id?: string
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
  }) => {
    if (!args.id) throw new Error('id 必填')
    const cur = tasks.get(args.id)
    if (!cur) throw new Error(`任务不存在: ${args.id}`)
    if (args.assignee_agent_id !== undefined && args.assignee_agent_id !== '' && !agents.get(args.assignee_agent_id)) {
      throw new Error(`指派的智能体不存在: ${args.assignee_agent_id}`)
    }
    const row = tasks.update(args.id, {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.assignee_agent_id !== undefined
        ? { assignee_type: args.assignee_agent_id ? 'agent' : 'none', assignee_id: args.assignee_agent_id }
        : {}),
    })
    deps.onTaskChanged(cur.project_id, args.id)
    return { id: row!.id, key: `JEF-${row!.number}`, status: row!.status }
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
export const PROJECT_TOOL_HINT = `项目群工具（jeff_project_*）用于建群、配成员与群主；任务工具（jeff_task_*）用于创建/流转任务，任务会以卡片形式出现在对应项目群里。创建项目群时必须先想好：群名、谁当群主（leader，统筹一切的智能体）、有哪些工作者（worker，统一角色，不做开发/产品等细分类）。`
