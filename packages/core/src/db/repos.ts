import { createHash } from 'node:crypto'
import { assertAgentEngine, engineId, type EngineId } from '../engines/contract.js'
import type { DB } from './db.js'
import { now } from './db.js'
import { genId } from '../util/id.js'
import { normalizeProjectRole } from '../util/projectRole.js'

// ---------- 类型 ----------
export interface AgentRow {
  id: string
  name: string
  avatar: string
  description: string
  instructions: string
  execution_engine?: EngineId
  engine_model?: string
  model_provider: string
  model_id: string
  /** 默认思考档位：'' /none/low/high/max（''=跟随模型配置） */
  thinking: string
  /** 分组分类（如：项目管理/医疗场景/项目开发；空=默认分组） */
  category: string
  /** 身份指令版本号：仅 instructions 实际变更时 +1（jeff_self_update 写前校验用） */
  instructions_version: number
  builtin: number
  archived: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface CronTaskRow {
  id: string
  name: string
  /** agent=私聊某智能体 / project=项目群 */
  target_type: 'agent' | 'project'
  target_id: string
  /** 5 段式 cron（本机时区）：分 时 日 月 周。一次性任务里只作兼容展示 */
  cron_expr: string
  /** 一次性绝对触发时间（ms）；null=按 cron 重复 */
  run_at: number | null
  prompt: string
  /** 错过处理：catchup=启动时补跑一次 / skip=顺延跳过 */
  miss_policy: 'catchup' | 'skip'
  enabled: number
  last_run_at: number | null
  next_run_at: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface CronRunRow {
  id: string
  task_id: string
  started_at: number
  finished_at: number | null
  status: 'running' | 'waiting_browser' | 'ok' | 'failed' | 'cancelled' | 'missed' | 'skipped'
  is_catchup: number
  error: string
}

export interface ProjectRow {
  id: string
  title: string
  description: string
  system_prompt: string
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
  duties: string
  model_override: string | null
  thinking_override: string | null
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
  due_at: number | null
  depends_on: string
  acceptance_criteria: string
  evidence_paths: string
  position: number
  created_at: number
  updated_at: number
  deleted_at: number | null
  goal: string
  result_summary: string
  submission_id: string
  submitted_spec_hash: string
  review_feedback: string
  reviewed_submission_id: string
}

export interface TaskActivityRow {
  id: string
  project_id: string
  task_id: string
  task_number: number
  title: string
  kind: 'created' | 'status_changed' | 'deleted' | 'submitted' | 'review_approved' | 'review_returned' | 'reopened'
  from_status: string
  to_status: string
  at: number
  details: string
}

export interface TaskRunRow {
  id: string
  task_id: string
  project_id: string
  thread_id: string
  agent_id: string
  status: 'queued' | 'running' | 'waiting_browser' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'needs_input'
  spec_hash: string
  task_snapshot: string
  started_at: number
  finished_at: number | null
  error: string
  submission_id: string
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
  /** 按前缀扫描全部键值（聊天记录抽屉清理当前会话指针等） */
  prefixScan(prefix: string): Array<[string, string]> {
    const rows = db.prepare('SELECT key, value FROM kv WHERE key LIKE ?').all(`${prefix}%`) as Array<{ key: string; value: string }>
    return rows.map((r) => [r.key, r.value])
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
  create(data: { execution_engine?: EngineId; engine_model?: string; name: string; avatar?: string; description?: string; instructions?: string; model_provider?: string; model_id?: string; thinking?: string; category?: string; builtin?: number; id?: string }): AgentRow {
    const id = data.id ?? genId('agt')
    const row: AgentRow = {
      id,
      name: data.name,
      avatar: data.avatar || '🤖',
      description: data.description || '',
      instructions: data.instructions || '',
      execution_engine: engineId(data.execution_engine || 'opencode'),
      engine_model: data.engine_model || '',
      model_provider: data.model_provider || '',
      model_id: data.model_id || '',
      thinking: data.thinking || '',
      category: data.category || '',
      instructions_version: 0,
      builtin: data.builtin || 0,
      archived: 0,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
    }
    assertAgentEngine(row)
    db.prepare(
      `INSERT INTO agent (id, name, avatar, description, instructions, execution_engine, engine_model, model_provider, model_id, thinking, category, instructions_version, builtin, archived, created_at, updated_at, deleted_at)
       VALUES (@id, @name, @avatar, @description, @instructions, @execution_engine, @engine_model, @model_provider, @model_id, @thinking, @category, @instructions_version, @builtin, @archived, @created_at, @updated_at, @deleted_at)`,
    ).run(row as unknown as Record<string, never>)
    return row
  },
  update(id: string, patch: Partial<Pick<AgentRow, 'name' | 'avatar' | 'description' | 'instructions' | 'execution_engine' | 'engine_model' | 'model_provider' | 'model_id' | 'thinking' | 'category' | 'archived'>>): AgentRow | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    // 版本号只在 instructions 真的变了时 +1（改模型/头像等不应让自改工具的写前校验误报）
    const instructionsVersion =
      patch.instructions !== undefined && patch.instructions !== cur.instructions ? (cur.instructions_version || 0) + 1 : cur.instructions_version || 0
    if (patch.execution_engine !== undefined) engineId(patch.execution_engine)
    const next = { ...cur, ...patch, instructions_version: instructionsVersion, updated_at: now() }
    assertAgentEngine(next)
    db.prepare(
      `UPDATE agent SET name=@name, avatar=@avatar, description=@description, instructions=@instructions,
       execution_engine=@execution_engine, engine_model=@engine_model, model_provider=@model_provider, model_id=@model_id, thinking=@thinking, category=@category,
       instructions_version=@instructions_version, archived=@archived, updated_at=@updated_at WHERE id=@id`,
    ).run({
      name: next.name,
      avatar: next.avatar,
      description: next.description,
      instructions: next.instructions,
      execution_engine: next.execution_engine || 'opencode',
      engine_model: next.engine_model || '',
      model_provider: next.model_provider,
      model_id: next.model_id,
      thinking: next.thinking,
      category: next.category || '',
      instructions_version: next.instructions_version,
      archived: next.archived,
      updated_at: next.updated_at,
      id: next.id,
    })
    return this.get(id)
  },
  /** 分类清单（去空去重，按出现频次降序 → 常用分类靠前） */
  categories(): string[] {
    const rows = db
      .prepare(`SELECT category, COUNT(*) AS n FROM agent WHERE deleted_at IS NULL AND trim(category) != '' GROUP BY category ORDER BY n DESC, category ASC`)
      .all() as unknown as Array<{ category: string; n: number }>
    return rows.map((r) => r.category)
  },
  softDelete(id: string): boolean {
    const cur = this.get(id)
    if (!cur || cur.builtin) return false
    db.prepare('UPDATE agent SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
    return true
  },
})

// ---------- project ----------
const PROJECT_COLUMNS = 'id, title, description, system_prompt, icon, status, leader_agent_id, workspace_dir, created_at, updated_at, deleted_at'
export const projectRepo = (db: DB) => ({
  list(includeDeleted = false): ProjectRow[] {
    const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL'
    return db.prepare(`SELECT ${PROJECT_COLUMNS} FROM project ${where} ORDER BY updated_at DESC`).all() as unknown as ProjectRow[]
  },
  get(id: string): ProjectRow | undefined {
    return db.prepare(`SELECT ${PROJECT_COLUMNS} FROM project WHERE id = ?`).get(id) as unknown as ProjectRow | undefined
  },
  create(data: { title: string; description?: string; system_prompt?: string; icon?: string; leader_agent_id?: string | null; status?: string; workspace_dir?: string }): ProjectRow {
    const row: ProjectRow = {
      id: genId('prj'),
      title: data.title,
      description: data.description || '',
      system_prompt: data.system_prompt || '',
      icon: data.icon || '👥',
      status: data.status || 'in_progress',
      leader_agent_id: data.leader_agent_id ?? null,
      workspace_dir: data.workspace_dir || '',
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
    }
    db.prepare(
      `INSERT INTO project (id, title, description, system_prompt, icon, status, leader_agent_id, workspace_dir, created_at, updated_at, deleted_at)
       VALUES (@id, @title, @description, @system_prompt, @icon, @status, @leader_agent_id, @workspace_dir, @created_at, @updated_at, @deleted_at)`,
    ).run(row as unknown as Record<string, never>)
    return row
  },
  update(id: string, patch: Partial<Pick<ProjectRow, 'title' | 'description' | 'system_prompt' | 'icon' | 'status' | 'leader_agent_id' | 'workspace_dir'>>): ProjectRow | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updated_at: now() }
    db.prepare(
      `UPDATE project SET title=@title, description=@description, system_prompt=@system_prompt, icon=@icon, status=@status, leader_agent_id=@leader_agent_id, workspace_dir=@workspace_dir, updated_at=@updated_at WHERE id=@id`,
    ).run({
      title: next.title,
      description: next.description,
      system_prompt: next.system_prompt,
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
  add(projectId: string, agentId: string, role = 'worker', position = 0): void {
    const normalized = normalizeProjectRole(role)
    db.prepare(
      `INSERT INTO project_agent (project_id, agent_id, role, position, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, agent_id) DO UPDATE SET role = excluded.role, position = excluded.position`,
    ).run(projectId, agentId, normalized, position, now())
  },
  updateConfig(projectId: string, agentId: string, patch: Partial<Pick<ProjectAgentRow, 'duties' | 'model_override' | 'thinking_override'>>): void {
    const current = db.prepare('SELECT * FROM project_agent WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as ProjectAgentRow | undefined
    if (!current) throw new Error('该智能体不在项目群中')
    db.prepare(`UPDATE project_agent SET duties=?, model_override=?, thinking_override=? WHERE project_id=? AND agent_id=?`)
      .run(patch.duties ?? current.duties ?? '', patch.model_override !== undefined ? patch.model_override : current.model_override ?? null,
        patch.thinking_override !== undefined ? patch.thinking_override : current.thinking_override ?? null, projectId, agentId)
  },
  remove(projectId: string, agentId: string): void {
    db.prepare('DELETE FROM project_agent WHERE project_id = ? AND agent_id = ?').run(projectId, agentId)
  },
  getRole(projectId: string, agentId: string): string | undefined {
    const row = db.prepare('SELECT role FROM project_agent WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as { role: string } | undefined
    return row?.role
  },
  /** 换群主：旧 leader 降为 worker，目标成员置为唯一 leader（事务，防中途失败留下双 leader） */
  setLeader(projectId: string, agentId: string): void {
    db.exec('BEGIN')
    try {
      db.prepare(`UPDATE project_agent SET role = 'worker' WHERE project_id = ? AND role = 'leader'`).run(projectId)
      this.add(projectId, agentId, 'leader')
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  /**
   * 完整成员快照替换（事务）：leader 必属成员集合且唯一；差集删除不在新集合中的旧成员。
   * memberIds 不含 leader 时会自动补上，保证「群主必在群里」。
   */
  replaceMembers(projectId: string, leaderId: string, memberIds: string[]): void {
    const uniq = Array.from(new Set([leaderId, ...memberIds]))
    db.exec('BEGIN')
    try {
      const keep = new Set(uniq)
      for (const row of this.listByProject(projectId)) {
        if (!keep.has(row.agent_id)) this.remove(projectId, row.agent_id)
      }
      let pos = 0
      for (const id of uniq) this.add(projectId, id, id === leaderId ? 'leader' : 'worker', pos++)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
})

// ---------- task ----------
function recordTaskActivity(db: DB, task: TaskRow, kind: TaskActivityRow['kind'], fromStatus = '', toStatus = task.status, details: Record<string, unknown> = {}): void {
  db.prepare('INSERT INTO task_activity (id, project_id, task_id, task_number, title, kind, from_status, to_status, at, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(genId('activity'), task.project_id, task.id, task.number, task.title, kind, fromStatus, toStatus, now(), JSON.stringify(details))
}

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
  create(data: { project_id: string; title: string; goal?: string; description?: string; status?: string; priority?: string; assignee_type?: string; assignee_id?: string; parent_task_id?: string | null; due_at?: number | null; depends_on?: string[]; acceptance_criteria?: string; evidence_paths?: string[] }): TaskRow {
    const dependencies = [...new Set(data.depends_on ?? [])]
    if (dependencies.some((id) => {
      const dependency = this.get(id)
      return !dependency || dependency.deleted_at != null || dependency.project_id !== data.project_id
    })) throw new Error('依赖任务必须存在且属于同一项目')
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
      due_at: data.due_at ?? null,
      depends_on: JSON.stringify(dependencies),
      acceptance_criteria: data.acceptance_criteria || '',
      evidence_paths: JSON.stringify(data.evidence_paths ?? []),
      position: 0,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
      goal: data.goal || '',
      result_summary: '',
      submission_id: '',
      submitted_spec_hash: '',
      review_feedback: '',
      reviewed_submission_id: '',
    }
    db.prepare(
      `INSERT INTO task (id, project_id, number, title, goal, description, status, priority, assignee_type, assignee_id, parent_task_id, due_at, depends_on, acceptance_criteria, evidence_paths, position, created_at, updated_at, deleted_at, result_summary, submission_id, submitted_spec_hash, review_feedback, reviewed_submission_id)
       VALUES (@id, @project_id, @number, @title, @goal, @description, @status, @priority, @assignee_type, @assignee_id, @parent_task_id, @due_at, @depends_on, @acceptance_criteria, @evidence_paths, @position, @created_at, @updated_at, @deleted_at, @result_summary, @submission_id, @submitted_spec_hash, @review_feedback, @reviewed_submission_id)`,
    ).run(row as unknown as Record<string, never>)
    recordTaskActivity(db, row, 'created', '', row.status)
    return row
  },
  update(id: string, patch: Partial<Pick<TaskRow, 'title' | 'goal' | 'description' | 'status' | 'priority' | 'assignee_type' | 'assignee_id' | 'parent_task_id' | 'position' | 'due_at' | 'depends_on' | 'acceptance_criteria' | 'evidence_paths' | 'result_summary' | 'submission_id' | 'submitted_spec_hash' | 'review_feedback' | 'reviewed_submission_id'>>): TaskRow | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    patch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as typeof patch
    const specFields = ['title', 'goal', 'description', 'acceptance_criteria', 'assignee_type', 'assignee_id', 'depends_on'] as const
    const specChanged = specFields.some((field) => patch[field] !== undefined && patch[field] !== cur[field])
    if (cur.status === 'done' && specChanged) throw new Error('已验收任务需要先重新打开，才能修改要求')
    if (cur.status === 'in_review' && specChanged) {
      patch = {
        ...patch,
        status: 'in_progress',
        submission_id: '',
        submitted_spec_hash: '',
        reviewed_submission_id: '',
        review_feedback: '',
      }
    }
    if (patch.status && !(TASK_STATUSES as readonly string[]).includes(patch.status)) return undefined
    if (patch.priority && !(TASK_PRIORITIES as readonly string[]).includes(patch.priority)) return undefined
    if (patch.depends_on !== undefined) {
      const dependencies = [...new Set(JSON.parse(patch.depends_on) as string[])]
      if (dependencies.includes(id) || dependencies.some((depId) => {
        const dependency = this.get(depId)
        return !dependency || dependency.deleted_at != null || dependency.project_id !== cur.project_id
      })) throw new Error('依赖任务必须是同一项目中的其他任务')
      const reachesCurrent = (depId: string, seen = new Set<string>()): boolean => {
        if (depId === id) return true
        if (seen.has(depId)) return false
        seen.add(depId)
        const task = this.get(depId)
        if (!task) return false
        let parents: string[] = []
        try { parents = JSON.parse(task.depends_on || '[]') as string[] } catch { /* legacy/corrupt value */ }
        return parents.some((parent) => reachesCurrent(parent, seen))
      }
      if (dependencies.some((depId) => reachesCurrent(depId))) throw new Error('任务依赖不能形成循环')
      patch = { ...patch, depends_on: JSON.stringify(dependencies) }
    }
    if (patch.status === 'done') {
      let dependencies: string[] = []
      try { dependencies = JSON.parse(patch.depends_on ?? cur.depends_on ?? '[]') as string[] } catch { /* ignore */ }
      if (dependencies.some((depId) => this.get(depId)?.status !== 'done')) throw new Error('依赖任务尚未完成，不能将此任务标记为完成')
    }
    const next = { ...cur, ...patch, updated_at: now() }
    db.prepare(
      `UPDATE task SET title=@title, goal=@goal, description=@description, status=@status, priority=@priority, assignee_type=@assignee_type,
       assignee_id=@assignee_id, parent_task_id=@parent_task_id, position=@position, due_at=@due_at, depends_on=@depends_on,
       acceptance_criteria=@acceptance_criteria, evidence_paths=@evidence_paths, result_summary=@result_summary,
       submission_id=@submission_id, submitted_spec_hash=@submitted_spec_hash, review_feedback=@review_feedback,
       reviewed_submission_id=@reviewed_submission_id, updated_at=@updated_at WHERE id=@id`,
    ).run({
      title: next.title,
      goal: next.goal,
      description: next.description,
      status: next.status,
      priority: next.priority,
      assignee_type: next.assignee_type,
      assignee_id: next.assignee_id,
      parent_task_id: next.parent_task_id,
      position: next.position,
      due_at: next.due_at,
      depends_on: next.depends_on,
      acceptance_criteria: next.acceptance_criteria,
      evidence_paths: next.evidence_paths,
      result_summary: next.result_summary,
      submission_id: next.submission_id,
      submitted_spec_hash: next.submitted_spec_hash,
      review_feedback: next.review_feedback,
      reviewed_submission_id: next.reviewed_submission_id,
      updated_at: next.updated_at,
      id: next.id,
    })
    if (next.status !== cur.status) recordTaskActivity(db, next, 'status_changed', cur.status, next.status)
    return this.get(id)
  },
  softDelete(id: string): boolean {
    const cur = this.get(id)
    if (!cur) return false
    const at = now()
    db.prepare('UPDATE task SET deleted_at = ?, updated_at = ? WHERE id = ?').run(at, at, id)
    recordTaskActivity(db, { ...cur, deleted_at: at }, 'deleted', cur.status, cur.status)
    return true
  },
  submit(id: string, data: { submissionId: string; resultSummary: string; specHash: string; evidencePaths: string[] }): TaskRow {
    const cur = this.get(id)
    if (!cur || cur.deleted_at) throw new Error('任务不存在或已删除')
    if (!data.resultSummary.trim()) throw new Error('提交结果不能为空')
    if (cur.status !== 'in_progress') throw new Error('任务当前不接受结果提交')
    const next = this.update(id, {
      status: 'in_review',
      result_summary: data.resultSummary.trim(),
      submission_id: data.submissionId,
      submitted_spec_hash: data.specHash,
      review_feedback: '',
      evidence_paths: JSON.stringify(data.evidencePaths),
    })
    if (!next) throw new Error('提交任务结果失败')
    recordTaskActivity(db, next, 'submitted', cur.status, next.status, {
      submissionId: data.submissionId, specHash: data.specHash, evidencePaths: data.evidencePaths,
    })
    return next
  },
  review(id: string, data: { action: 'approve' | 'return' | 'reopen'; submissionId: string; specHash: string; feedback?: string }): TaskRow {
    const cur = this.get(id)
    if (!cur || cur.deleted_at) throw new Error('任务不存在或已删除')
    if (data.action === 'reopen') {
      if (cur.status !== 'done') throw new Error('只有已完成的任务可以重新打开')
      const next = this.update(id, { status: 'todo', reviewed_submission_id: '' })
      if (!next) throw new Error('重新打开任务失败')
      recordTaskActivity(db, next, 'reopened', cur.status, next.status)
      return next
    }
    if (cur.status !== 'in_review') throw new Error('任务当前没有等待验收的提交')
    if (cur.submission_id !== data.submissionId || cur.submitted_spec_hash !== data.specHash) throw new Error('任务内容或提交已更新，请刷新后重新验收')
    const currentHash = taskSpecHash(cur)
    if (currentHash !== data.specHash) throw new Error('任务要求已变更，当前提交已失效；请退回并重新执行')
    if (data.action === 'approve') {
      const next = this.update(id, { status: 'done', reviewed_submission_id: data.submissionId })
      if (!next) throw new Error('验收任务失败')
      recordTaskActivity(db, next, 'review_approved', cur.status, next.status, { submissionId: data.submissionId, specHash: data.specHash })
      return next
    }
    const feedback = (data.feedback || '').trim()
    if (!feedback) throw new Error('退回时请填写原因')
    const next = this.update(id, { status: 'in_progress', review_feedback: feedback, reviewed_submission_id: '' })
    if (!next) throw new Error('退回任务失败')
    recordTaskActivity(db, next, 'review_returned', cur.status, next.status, { submissionId: data.submissionId, specHash: data.specHash, feedback })
    return next
  },
})

export const taskActivityRepo = (db: DB) => ({
  listByProject(projectId: string, startAt = Number.MIN_SAFE_INTEGER, endAt = Number.MAX_SAFE_INTEGER): TaskActivityRow[] {
    return db.prepare('SELECT * FROM task_activity WHERE project_id = ? AND at >= ? AND at <= ? ORDER BY at ASC, id ASC').all(projectId, startAt, endAt) as unknown as TaskActivityRow[]
  },
  listAll(): TaskActivityRow[] {
    return db.prepare('SELECT * FROM task_activity ORDER BY at ASC, id ASC').all() as unknown as TaskActivityRow[]
  },
  merge(rows: TaskActivityRow[]): number {
    const insert = db.prepare('INSERT OR IGNORE INTO task_activity (id, project_id, task_id, task_number, title, kind, from_status, to_status, at, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    let inserted = 0
    for (const row of rows) {
      const result = insert.run(row.id, row.project_id, row.task_id, row.task_number, row.title, row.kind, row.from_status, row.to_status, row.at, row.details || '{}')
      inserted += Number(result.changes || 0)
    }
    return inserted
  },
})

export const taskRunRepo = (db: DB) => ({
  get(id: string): TaskRunRow | undefined {
    return db.prepare('SELECT * FROM task_run WHERE id = ?').get(id) as unknown as TaskRunRow | undefined
  },
  getActive(taskId: string): TaskRunRow | undefined {
    return db.prepare("SELECT * FROM task_run WHERE task_id = ? AND status IN ('queued', 'running', 'waiting_browser') ORDER BY started_at DESC LIMIT 1").get(taskId) as unknown as TaskRunRow | undefined
  },
  list(taskId: string): TaskRunRow[] {
    return db.prepare('SELECT * FROM task_run WHERE task_id = ? ORDER BY started_at DESC').all(taskId) as unknown as TaskRunRow[]
  },
  create(data: Omit<TaskRunRow, 'finished_at' | 'error' | 'submission_id'>): TaskRunRow {
    db.prepare('INSERT INTO task_run (id, task_id, project_id, thread_id, agent_id, status, spec_hash, task_snapshot, started_at, finished_at, error, submission_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(data.id, data.task_id, data.project_id, data.thread_id, data.agent_id, data.status, data.spec_hash, data.task_snapshot, data.started_at, '', '')
    return this.get(data.id)!
  },
  update(id: string, patch: Partial<Pick<TaskRunRow, 'status' | 'finished_at' | 'error' | 'submission_id'>>): TaskRunRow {
    const current = this.get(id)
    if (!current) throw new Error('任务运行记录不存在')
    const next = { ...current, ...patch }
    db.prepare('UPDATE task_run SET status=?, finished_at=?, error=?, submission_id=? WHERE id=?')
      .run(next.status, next.finished_at, next.error, next.submission_id, id)
    return next
  },
  markOrphanedInterrupted(): number {
    const result = db.prepare("UPDATE task_run SET status='interrupted', finished_at=?, error='Jeff 重启时任务仍在运行，未自动重试' WHERE status IN ('queued', 'running')").run(now())
    return Number(result.changes || 0)
  },
})

export function taskSpecHash(task: Pick<TaskRow, 'project_id' | 'title' | 'goal' | 'description' | 'acceptance_criteria' | 'assignee_type' | 'assignee_id' | 'depends_on'>): string {
  return createHash('sha256').update(JSON.stringify([
    task.project_id, (task.title || '').trim(), (task.goal || '').trim(), (task.description || '').trim(), (task.acceptance_criteria || '').trim(),
    task.assignee_type || '', task.assignee_id || '', task.depends_on || '[]',
  ])).digest('hex')
}

// ---------- chat_message（群聊消息记录）----------
export const chatMessageRepo = (db: DB) => ({
  listByScope(scope: string, limit = 200): ChatMessageRow[] {
    return db
      .prepare('SELECT * FROM chat_message WHERE scope = ? ORDER BY created_at DESC LIMIT ?')
      .all(scope, limit)
      .reverse() as unknown as ChatMessageRow[]
  },
  /** 按 scope 前缀取最近消息（群 scope 为 group:<projectId>:<threadId>，需跨 thread 时用） */
  listByScopePrefix(prefix: string, limit = 200): ChatMessageRow[] {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`)
    return db
      .prepare("SELECT * FROM chat_message WHERE scope LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?")
      .all(`${escaped}%`, limit)
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
  /** 把旧 scope 整批迁到新 scope（群 thread 迁移） */
  reScope(fromScope: string, toScope: string): number {
    const r = db.prepare('UPDATE chat_message SET scope = ? WHERE scope = ?').run(toScope, fromScope)
    return Number(r.changes || 0)
  },
  deleteByScope(scope: string): number {
    const r = db.prepare('DELETE FROM chat_message WHERE scope = ?').run(scope)
    return Number(r.changes || 0)
  },
})

// ---------- cron_task（定时任务）----------
export const MISS_POLICIES = ['catchup', 'skip'] as const

export const cronTaskRepo = (db: DB) => ({
  list(includeDeleted = false): CronTaskRow[] {
    const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL'
    return db.prepare(`SELECT * FROM cron_task ${where} ORDER BY enabled DESC, next_run_at ASC, created_at DESC`).all() as unknown as CronTaskRow[]
  },
  /** 调度器用：启用且未删除的任务 */
  listEnabled(): CronTaskRow[] {
    return db.prepare('SELECT * FROM cron_task WHERE deleted_at IS NULL AND enabled = 1').all() as unknown as CronTaskRow[]
  },
  get(id: string): CronTaskRow | undefined {
    return db.prepare('SELECT * FROM cron_task WHERE id = ?').get(id) as unknown as CronTaskRow | undefined
  },
  create(data: {
    name: string
    target_type: 'agent' | 'project'
    target_id: string
    cron_expr: string
    /** 一次性绝对时间；不传=重复任务 */
    run_at?: number | null
    prompt?: string
    miss_policy?: string
    enabled?: number
    next_run_at?: number | null
  }): CronTaskRow {
    const row: CronTaskRow = {
      id: genId('cron'),
      name: data.name,
      target_type: data.target_type,
      target_id: data.target_id,
      cron_expr: data.cron_expr,
      run_at: data.run_at ?? null,
      prompt: data.prompt || '',
      miss_policy: data.miss_policy === 'skip' ? 'skip' : 'catchup',
      enabled: data.enabled === 0 ? 0 : 1,
      last_run_at: null,
      next_run_at: data.next_run_at ?? null,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
    }
    db.prepare(
      `INSERT INTO cron_task (id, name, target_type, target_id, cron_expr, run_at, prompt, miss_policy, enabled, last_run_at, next_run_at, created_at, updated_at, deleted_at)
       VALUES (@id, @name, @target_type, @target_id, @cron_expr, @run_at, @prompt, @miss_policy, @enabled, @last_run_at, @next_run_at, @created_at, @updated_at, @deleted_at)`,
    ).run(row as unknown as Record<string, never>)
    return row
  },
  update(
    id: string,
    patch: Partial<Pick<CronTaskRow, 'name' | 'target_type' | 'target_id' | 'cron_expr' | 'run_at' | 'prompt' | 'miss_policy' | 'enabled' | 'next_run_at'>>,
  ): CronTaskRow | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updated_at: now() }
    db.prepare(
      `UPDATE cron_task SET name=@name, target_type=@target_type, target_id=@target_id, cron_expr=@cron_expr, run_at=@run_at,
       prompt=@prompt, miss_policy=@miss_policy, enabled=@enabled, next_run_at=@next_run_at, updated_at=@updated_at WHERE id=@id`,
    ).run({
      name: next.name,
      target_type: next.target_type,
      target_id: next.target_id,
      cron_expr: next.cron_expr,
      run_at: next.run_at,
      prompt: next.prompt,
      miss_policy: next.miss_policy,
      enabled: next.enabled,
      next_run_at: next.next_run_at,
      updated_at: next.updated_at,
      id: next.id,
    })
    return this.get(id)
  },
  /**
   * 一次性任务已经入队：停用并清掉下次触发。
   * 这是定义变化（别的设备不能再跑一次），所以要推进 updated_at，和「重复任务只推 next_run_at」不同。
   */
  finishOnce(id: string): void {
    db.prepare('UPDATE cron_task SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
  },
  /**
   * 标记一次执行结果（调度器内部使用）。
   * 不动 updated_at：它是同步用的版本号，只有「定义被改」才该推进——否则一台机器只是跑了任务，
   * 同步时就会以更新的时间戳覆盖掉另一台机器上真实的编辑。
   */
  markRun(id: string, at: number, nextRunAt: number | null): void {
    db.prepare('UPDATE cron_task SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(at, nextRunAt, id)
  },
  /** 只更新下次触发时间（tick 推进 / 同步落地重算用，不动 last_run_at，也不动 updated_at——理由同 markRun） */
  setNextRun(id: string, nextRunAt: number | null): void {
    db.prepare('UPDATE cron_task SET next_run_at = ? WHERE id = ?').run(nextRunAt, id)
  },
  /** 只更新上次实际执行时间（一轮跑完后回填） */
  setLastRun(id: string, at: number): void {
    db.prepare('UPDATE cron_task SET last_run_at = ? WHERE id = ?').run(at, id)
  },
  softDelete(id: string): boolean {
    const cur = this.get(id)
    if (!cur) return false
    db.prepare('UPDATE cron_task SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
    return true
  },
})

// ---------- cron_run（定时任务运行历史，本机日志不进同步）----------
export const cronRunRepo = (db: DB) => ({
  start(taskId: string, isCatchup = false): CronRunRow {
    const row: CronRunRow = { id: genId('run'), task_id: taskId, started_at: now(), finished_at: null, status: 'running', is_catchup: isCatchup ? 1 : 0, error: '' }
    db.prepare('INSERT INTO cron_run (id, task_id, started_at, finished_at, status, is_catchup, error) VALUES (@id, @task_id, @started_at, @finished_at, @status, @is_catchup, @error)').run(
      row as unknown as Record<string, never>,
    )
    return row
  },
  finish(id: string, status: 'ok' | 'failed' | 'cancelled', error = ''): void {
    db.prepare('UPDATE cron_run SET finished_at = ?, status = ?, error = ? WHERE id = ?').run(now(), status, String(error).slice(0, 2000), id)
  },
  waitForBrowser(id: string, error = '等待用户完成浏览器验证'): boolean {
    const result = db.prepare("UPDATE cron_run SET finished_at = NULL, status = 'waiting_browser', error = ? WHERE id = ? AND status = 'running'").run(String(error).slice(0, 2000), id)
    return Number(result.changes || 0) > 0
  },
  listWaitingBrowser(): CronRunRow[] {
    return db.prepare("SELECT * FROM cron_run WHERE status = 'waiting_browser'").all() as unknown as CronRunRow[]
  },
  /** 不进执行的终态记录（missed/skipped） */
  log(taskId: string, status: 'missed' | 'skipped', error = ''): void {
    const t = now()
    db.prepare('INSERT INTO cron_run (id, task_id, started_at, finished_at, status, is_catchup, error) VALUES (?, ?, ?, ?, ?, 0, ?)').run(genId('run'), taskId, t, t, status, error)
  },
  listByTask(taskId: string, limit = 20): CronRunRow[] {
    return db.prepare('SELECT * FROM cron_run WHERE task_id = ? ORDER BY started_at DESC LIMIT ?').all(taskId, limit) as unknown as CronRunRow[]
  },
  /** 各任务最后一次运行的失败态（定时视图红点提示用） */
  lastStatusMap(): Record<string, CronRunRow> {
    const rows = db.prepare('SELECT * FROM cron_run ORDER BY started_at ASC').all() as unknown as CronRunRow[]
    const out: Record<string, CronRunRow> = {}
    for (const r of rows) out[r.task_id] = r
    return out
  },
  /** 清理旧记录（保留每任务最近 N 条） */
  prune(keepPerTask = 50): number {
    const r = db
      .prepare(
        `DELETE FROM cron_run WHERE id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rn FROM cron_run
           ) WHERE rn <= ?
         )`,
      )
      .run(keepPerTask)
    return Number(r.changes || 0)
  },
  /**
   * 把残留的 running 记录收尾为 failed。
   * 应用被关闭（含强杀/崩溃）会打断正在执行的回合，这些行永远等不到 finish——
   * 不清掉的话界面会一直显示「执行中」，看起来像卡住了。
   */
  failStale(reason = '应用退出导致本次执行中断'): number {
    const r = db.prepare("UPDATE cron_run SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'").run(now(), reason)
    return Number(r.changes || 0)
  },
})

