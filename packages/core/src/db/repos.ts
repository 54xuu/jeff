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
  model_provider: string
  model_id: string
  /** 默认思考档位：'' /none/low/high/max（''=跟随模型配置） */
  thinking: string
  /** 分组分类（如：项目管理/医疗场景/项目开发；空=默认分组） */
  category: string
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
  /** 5 段式 cron（本机时区）：分 时 日 月 周 */
  cron_expr: string
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
  status: 'running' | 'ok' | 'failed' | 'missed' | 'skipped'
  is_catchup: number
  error: string
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
  create(data: { name: string; avatar?: string; description?: string; instructions?: string; model_provider?: string; model_id?: string; thinking?: string; category?: string; builtin?: number; id?: string }): AgentRow {
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
      category: data.category || '',
      builtin: data.builtin || 0,
      archived: 0,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
    }
    db.prepare(
      `INSERT INTO agent (id, name, avatar, description, instructions, model_provider, model_id, thinking, category, builtin, archived, created_at, updated_at, deleted_at)
       VALUES (@id, @name, @avatar, @description, @instructions, @model_provider, @model_id, @thinking, @category, @builtin, @archived, @created_at, @updated_at, @deleted_at)`,
    ).run(row as unknown as Record<string, never>)
    return row
  },
  update(id: string, patch: Partial<Pick<AgentRow, 'name' | 'avatar' | 'description' | 'instructions' | 'model_provider' | 'model_id' | 'thinking' | 'category' | 'archived'>>): AgentRow | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updated_at: now() }
    db.prepare(
      `UPDATE agent SET name=@name, avatar=@avatar, description=@description, instructions=@instructions,
       model_provider=@model_provider, model_id=@model_id, thinking=@thinking, category=@category, archived=@archived, updated_at=@updated_at WHERE id=@id`,
    ).run({
      name: next.name,
      avatar: next.avatar,
      description: next.description,
      instructions: next.instructions,
      model_provider: next.model_provider,
      model_id: next.model_id,
      thinking: next.thinking,
      category: next.category || '',
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
  add(projectId: string, agentId: string, role = 'worker', position = 0): void {
    const normalized = normalizeProjectRole(role)
    db.prepare(
      `INSERT INTO project_agent (project_id, agent_id, role, position, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, agent_id) DO UPDATE SET role = excluded.role, position = excluded.position`,
    ).run(projectId, agentId, normalized, position, now())
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
      `INSERT INTO cron_task (id, name, target_type, target_id, cron_expr, prompt, miss_policy, enabled, last_run_at, next_run_at, created_at, updated_at, deleted_at)
       VALUES (@id, @name, @target_type, @target_id, @cron_expr, @prompt, @miss_policy, @enabled, @last_run_at, @next_run_at, @created_at, @updated_at, @deleted_at)`,
    ).run(row as unknown as Record<string, never>)
    return row
  },
  update(
    id: string,
    patch: Partial<Pick<CronTaskRow, 'name' | 'target_type' | 'target_id' | 'cron_expr' | 'prompt' | 'miss_policy' | 'enabled' | 'next_run_at'>>,
  ): CronTaskRow | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updated_at: now() }
    db.prepare(
      `UPDATE cron_task SET name=@name, target_type=@target_type, target_id=@target_id, cron_expr=@cron_expr,
       prompt=@prompt, miss_policy=@miss_policy, enabled=@enabled, next_run_at=@next_run_at, updated_at=@updated_at WHERE id=@id`,
    ).run({
      name: next.name,
      target_type: next.target_type,
      target_id: next.target_id,
      cron_expr: next.cron_expr,
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
  finish(id: string, status: 'ok' | 'failed', error = ''): void {
    db.prepare('UPDATE cron_run SET finished_at = ?, status = ?, error = ? WHERE id = ?').run(now(), status, String(error).slice(0, 2000), id)
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

