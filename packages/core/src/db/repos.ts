import type { DB } from './db.js'
import { now } from './db.js'
import { genId } from '../util/id.js'

// ---------- 类型 ----------
export interface AgentRow {
  id: string
  name: string
  avatar: string
  description: string
  instructions: string
  model_provider: string
  model_id: string
  /** 默认思考档位：'' /none/low/high/max（''=跟随模型配置） */
  thinking: string
  builtin: number
  archived: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface ProjectRow {
  id: string
  title: string
  description: string
  icon: string
  status: string
  leader_agent_id: string | null
  /** 工作空间目录（空 = 全局 workspace） */
  workspace_dir: string
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface ProjectAgentRow {
  project_id: string
  agent_id: string
  role: string
  position: number
  created_at: number
}

export interface TaskRow {
  id: string
  project_id: string
  number: number
  title: string
  description: string
  status: string
  priority: string
  assignee_type: string
  assignee_id: string
  parent_task_id: string | null
  position: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface ChatMessageRow {
  id: string
  scope: string
  sender_type: 'user' | 'agent' | 'system'
  sender_id: string
  content: string
  meta: string
  created_at: number
}

export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const
export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
export const PROJECT_STATUSES = ['planned', 'in_progress', 'paused', 'completed', 'cancelled'] as const

// ---------- kv ----------
export const kvRepo = (db: DB) => ({
  get(key: string): string | null {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return row ? row.value : null
  },
  getJSON<T>(key: string, fallback: T): T {
    const v = this.get(key)
    if (v == null) return fallback
    try {
      return JSON.parse(v) as T
    } catch {
      return fallback
    }
  },
  set(key: string, value: string): void {
    db.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(key, value, now())
  },
  setJSON(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value))
  },
  delete(key: string): void {
    db.prepare('DELETE FROM kv WHERE key = ?').run(key)
  },
})

// ---------- agent ----------
export const agentRepo = (db: DB) => ({
  list(includeDeleted = false): AgentRow[] {
    const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL'
    return db.prepare(`SELECT * FROM agent ${where} ORDER BY builtin DESC, archived ASC, name ASC`).all() as unknown as AgentRow[]
  },
  get(id: string): AgentRow | undefined {
    return db.prepare('SELECT * FROM agent WHERE id = ?').get(id) as unknown as AgentRow | undefined
  },
  create(data: { name: string; avatar?: string; description?: string; instructions?: string; model_provider?: string; model_id?: string; thinking?: string; builtin?: number; id?: string }): AgentRow {
    const id = data.id ?? genId('agt')
    const row: AgentRow = {
      id,
      name: data.name,
      avatar: data.avatar || '🤖',
      description: data.description || '',
      instructions: data.instructions || '',
      model_provider: data.model_provider || '',
      model_id: data.model_id || '',
      thinking: data.thinking || '',
      builtin: data.builtin || 0,
      archived: 0,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
    }
    db.prepare(
      `INSERT INTO agent (id, name, avatar, description, instructions, model_provider, model_id, thinking, builtin, archived, created_at, updated_at, deleted_at)
       VALUES (@id, @name, @avatar, @description, @instructions, @model_provider, @model_id, @thinking, @builtin, @archived, @created_at, @updated_at, @deleted_at)`,
    ).run(row as unknown as Record<string, never>)
    return row
  },
  update(id: string, patch: Partial<Pick<AgentRow, 'name' | 'avatar' | 'description' | 'instructions' | 'model_provider' | 'model_id' | 'thinking' | 'archived'>>): AgentRow | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updated_at: now() }
    db.prepare(
      `UPDATE agent SET name=@name, avatar=@avatar, description=@description, instructions=@instructions,
       model_provider=@model_provider, model_id=@model_id, thinking=@thinking, archived=@archived, updated_at=@updated_at WHERE id=@id`,
    ).run({
      name: next.name,
      avatar: next.avatar,
      description: next.description,
      instructions: next.instructions,
      model_provider: next.model_provider,
      model_id: next.model_id,
      thinking: next.thinking,
      archived: next.archived,
      updated_at: next.updated_at,
      id: next.id,
    })
    return this.get(id)
  },
  softDelete(id: string): boolean {
    const cur = this.get(id)
    if (!cur || cur.builtin) return false
    db.prepare('UPDATE agent SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
    return true
  },
})

// ---------- project ----------
export const projectRepo = (db: DB) => ({
  list(includeDeleted = false): ProjectRow[] {
    const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL'
    return db.prepare(`SELECT * FROM project ${where} ORDER BY updated_at DESC`).all() as unknown as ProjectRow[]
  },
  get(id: string): ProjectRow | undefined {
    return db.prepare('SELECT * FROM project WHERE id = ?').get(id) as unknown as ProjectRow | undefined
  },
  create(data: { title: string; description?: string; icon?: string; leader_agent_id?: string | null; status?: string; workspace_dir?: string }): ProjectRow {
    const row: ProjectRow = {
      id: genId('prj'),
      title: data.title,
      description: data.description || '',
      icon: data.icon || '👥',
      status: data.status || 'in_progress',
      leader_agent_id: data.leader_agent_id ?? null,
      workspace_dir: data.workspace_dir || '',
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
    }
    db.prepare(
      `INSERT INTO project (id, title, description, icon, status, leader_agent_id, workspace_dir, created_at, updated_at, deleted_at)
       VALUES (@id, @title, @description, @icon, @status, @leader_agent_id, @workspace_dir, @created_at, @updated_at, @deleted_at)`,
    ).run(row as unknown as Record<string, never>)
    return row
  },
  update(id: string, patch: Partial<Pick<ProjectRow, 'title' | 'description' | 'icon' | 'status' | 'leader_agent_id' | 'workspace_dir'>>): ProjectRow | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updated_at: now() }
    db.prepare(
      `UPDATE project SET title=@title, description=@description, icon=@icon, status=@status, leader_agent_id=@leader_agent_id, workspace_dir=@workspace_dir, updated_at=@updated_at WHERE id=@id`,
    ).run({
      title: next.title,
      description: next.description,
      icon: next.icon,
      status: next.status,
      leader_agent_id: next.leader_agent_id,
      workspace_dir: next.workspace_dir,
      updated_at: next.updated_at,
      id: next.id,
    })
    return this.get(id)
  },
  softDelete(id: string): boolean {
    const cur = this.get(id)
    if (!cur) return false
    db.prepare('UPDATE project SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
    return true
  },
})

// ---------- project_agent ----------
export const projectAgentRepo = (db: DB) => ({
  listByProject(projectId: string): ProjectAgentRow[] {
    return db.prepare('SELECT * FROM project_agent WHERE project_id = ? ORDER BY position, created_at').all(projectId) as unknown as ProjectAgentRow[]
  },
  add(projectId: string, agentId: string, role = 'member', position = 0): void {
    db.prepare(
      `INSERT INTO project_agent (project_id, agent_id, role, position, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, agent_id) DO UPDATE SET role = excluded.role, position = excluded.position`,
    ).run(projectId, agentId, role, position, now())
  },
  remove(projectId: string, agentId: string): void {
    db.prepare('DELETE FROM project_agent WHERE project_id = ? AND agent_id = ?').run(projectId, agentId)
  },
  getRole(projectId: string, agentId: string): string | undefined {
    const row = db.prepare('SELECT role FROM project_agent WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as { role: string } | undefined
    return row?.role
  },
})

// ---------- task ----------
export const taskRepo = (db: DB) => ({
  listByProject(projectId: string, includeDeleted = false): TaskRow[] {
    const where = includeDeleted ? 'WHERE project_id = ?' : 'WHERE project_id = ? AND deleted_at IS NULL'
    return db.prepare(`SELECT * FROM task ${where} ORDER BY number DESC`).all(projectId) as unknown as TaskRow[]
  },
  get(id: string): TaskRow | undefined {
    return db.prepare('SELECT * FROM task WHERE id = ?').get(id) as unknown as TaskRow | undefined
  },
  /** 项目内编号：取当前最大编号 +1（软删除占用也跳过不复用，避免歧义） */
  nextNumber(projectId: string): number {
    const row = db.prepare('SELECT MAX(number) AS m FROM task WHERE project_id = ?').get(projectId) as { m: number | null }
    return (row.m ?? 0) + 1
  },
  create(data: { project_id: string; title: string; description?: string; status?: string; priority?: string; assignee_type?: string; assignee_id?: string; parent_task_id?: string | null }): TaskRow {
    const row: TaskRow = {
      id: genId('task'),
      project_id: data.project_id,
      number: this.nextNumber(data.project_id),
      title: data.title,
      description: data.description || '',
      status: data.status && (TASK_STATUSES as readonly string[]).includes(data.status) ? data.status : 'todo',
      priority: data.priority && (TASK_PRIORITIES as readonly string[]).includes(data.priority) ? data.priority : 'medium',
      assignee_type: data.assignee_type || 'none',
      assignee_id: data.assignee_id || '',
      parent_task_id: data.parent_task_id ?? null,
      position: 0,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
    }
    db.prepare(
      `INSERT INTO task (id, project_id, number, title, description, status, priority, assignee_type, assignee_id, parent_task_id, position, created_at, updated_at, deleted_at)
       VALUES (@id, @project_id, @number, @title, @description, @status, @priority, @assignee_type, @assignee_id, @parent_task_id, @position, @created_at, @updated_at, @deleted_at)`,
    ).run(row as unknown as Record<string, never>)
    return row
  },
  update(id: string, patch: Partial<Pick<TaskRow, 'title' | 'description' | 'status' | 'priority' | 'assignee_type' | 'assignee_id' | 'parent_task_id' | 'position'>>): TaskRow | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    if (patch.status && !(TASK_STATUSES as readonly string[]).includes(patch.status)) return undefined
    if (patch.priority && !(TASK_PRIORITIES as readonly string[]).includes(patch.priority)) return undefined
    const next = { ...cur, ...patch, updated_at: now() }
    db.prepare(
      `UPDATE task SET title=@title, description=@description, status=@status, priority=@priority, assignee_type=@assignee_type,
       assignee_id=@assignee_id, parent_task_id=@parent_task_id, position=@position, updated_at=@updated_at WHERE id=@id`,
    ).run({
      title: next.title,
      description: next.description,
      status: next.status,
      priority: next.priority,
      assignee_type: next.assignee_type,
      assignee_id: next.assignee_id,
      parent_task_id: next.parent_task_id,
      position: next.position,
      updated_at: next.updated_at,
      id: next.id,
    })
    return this.get(id)
  },
  softDelete(id: string): boolean {
    const cur = this.get(id)
    if (!cur) return false
    db.prepare('UPDATE task SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
    return true
  },
})

// ---------- chat_message（群聊消息记录）----------
export const chatMessageRepo = (db: DB) => ({
  listByScope(scope: string, limit = 200): ChatMessageRow[] {
    return db
      .prepare('SELECT * FROM chat_message WHERE scope = ? ORDER BY created_at DESC LIMIT ?')
      .all(scope, limit)
      .reverse() as unknown as ChatMessageRow[]
  },
  add(row: { scope: string; sender_type: ChatMessageRow['sender_type']; sender_id?: string; content?: string; meta?: unknown; id?: string }): ChatMessageRow {
    const rec: ChatMessageRow = {
      id: row.id ?? genId('msg'),
      scope: row.scope,
      sender_type: row.sender_type,
      sender_id: row.sender_id || '',
      content: row.content || '',
      meta: row.meta ? JSON.stringify(row.meta) : '{}',
      created_at: now(),
    }
    db.prepare(
      'INSERT INTO chat_message (id, scope, sender_type, sender_id, content, meta, created_at) VALUES (@id, @scope, @sender_type, @sender_id, @content, @meta, @created_at)',
    ).run(rec as unknown as Record<string, never>)
    return rec
  },
})
