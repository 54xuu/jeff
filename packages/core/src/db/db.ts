import { DatabaseSync } from 'node:sqlite'
import type { JeffPaths } from '../paths.js'

export type DB = DatabaseSync

/**
 * 打开数据库并执行迁移。
 * 用 node:sqlite（Node >=22.13 与 Electron 39 均内置，含 FTS5）：零原生依赖，彻底避免双运行时 ABI 重编译问题。
 * 规范：所有字段必须有注释（SQLite 用 -- 注释，与 MySQL 规范保持同一精神）。
 */
export function openDb(p: JeffPaths): DB {
  const db = new DatabaseSync(p.dbFile)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db: DB): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent (
  id            TEXT PRIMARY KEY,                -- 智能体唯一 id（agt_*；小杰固定 agt_xiaojie）
  name          TEXT NOT NULL,                   -- 显示名（微信联系人名）
  avatar        TEXT NOT NULL DEFAULT '🤖',      -- 头像（emoji 或颜色标识）
  description   TEXT NOT NULL DEFAULT '',        -- 简介仅展示，不进 prompt
  instructions  TEXT NOT NULL DEFAULT '',        -- 身份指令，每次执行注入 system prompt
  model_provider TEXT NOT NULL DEFAULT '',       -- 默认模型 provider id（空=跟随全局默认）
  model_id      TEXT NOT NULL DEFAULT '',        -- 默认模型 id
  builtin       INTEGER NOT NULL DEFAULT 0,      -- 1=内置 Agent（保留名称/头像等系统标识）
  archived      INTEGER NOT NULL DEFAULT 0,      -- 1=已归档（保留历史）
  created_at    INTEGER NOT NULL,                -- 创建时间（ms）
  updated_at    INTEGER NOT NULL,                -- 更新时间（ms）
  deleted_at    INTEGER                          -- 软删除时间（ms，null=未删）
);

CREATE TABLE IF NOT EXISTS project (
  id              TEXT PRIMARY KEY,              -- 项目唯一 id（prj_*；= 微信群）
  title           TEXT NOT NULL,                 -- 群名
  description     TEXT NOT NULL DEFAULT '',      -- 群简介
  system_prompt   TEXT NOT NULL DEFAULT '',       -- 项目群规则（仅注入该群）
  icon            TEXT NOT NULL DEFAULT '👥',    -- 群图标
  status          TEXT NOT NULL DEFAULT 'in_progress', -- 状态：planned/in_progress/paused/completed/cancelled
  leader_agent_id TEXT,                          -- 群主（leader）agent id，统筹一切
  created_at      INTEGER NOT NULL,              -- 创建时间（ms）
  updated_at      INTEGER NOT NULL,              -- 更新时间（ms）
  deleted_at      INTEGER                        -- 软删除时间（ms）
);

CREATE TABLE IF NOT EXISTS project_agent (
  project_id TEXT NOT NULL,                      -- 项目 id
  agent_id   TEXT NOT NULL,                      -- 智能体 id
  role       TEXT NOT NULL DEFAULT 'worker',     -- 群关系：leader 表示该群群主，其余成员的职责写入 duties
  duties     TEXT NOT NULL DEFAULT '',           -- 该 Agent 在本群的职责说明
  model_override TEXT,                           -- 本群模型覆盖；NULL=继承 Agent 个人默认
  thinking_override TEXT,                        -- 本群思考覆盖；NULL=继承 Agent 个人默认
  position   INTEGER NOT NULL DEFAULT 0,         -- 排序
  created_at INTEGER NOT NULL,                   -- 加入时间（ms）
  PRIMARY KEY (project_id, agent_id)
);

CREATE TABLE IF NOT EXISTS task (
  id             TEXT PRIMARY KEY,               -- 任务唯一 id（task_*）
  project_id     TEXT NOT NULL,                  -- 所属项目 id
  number         INTEGER NOT NULL,               -- 项目内编号（JEF-n 的 n）
  title          TEXT NOT NULL,                  -- 标题
  description    TEXT NOT NULL DEFAULT '',       -- 描述/验收标准
  status         TEXT NOT NULL DEFAULT 'todo',   -- todo/in_progress/in_review/done/cancelled
  priority       TEXT NOT NULL DEFAULT 'medium', -- urgent/high/medium/low
  assignee_type  TEXT NOT NULL DEFAULT 'none',   -- none/agent
  assignee_id    TEXT NOT NULL DEFAULT '',       -- 指派对象 id（agent id）
  parent_task_id TEXT,                           -- 父任务 id（子任务拆分）
  position       INTEGER NOT NULL DEFAULT 0,     -- 看板内排序
  created_at     INTEGER NOT NULL,               -- 创建时间（ms）
  updated_at     INTEGER NOT NULL,               -- 更新时间（ms）
  deleted_at     INTEGER,                        -- 软删除时间（ms）
  goal           TEXT NOT NULL DEFAULT '',        -- 该任务希望达成的结果
  result_summary TEXT NOT NULL DEFAULT '',        -- 智能体最近一次提交给用户验收的结果摘要
  submission_id  TEXT NOT NULL DEFAULT '',        -- 当前待验收提交 ID，由服务端生成
  submitted_spec_hash TEXT NOT NULL DEFAULT '',   -- 提交时任务要求的内容哈希
  review_feedback TEXT NOT NULL DEFAULT '',       -- 用户最近一次退回意见
  reviewed_submission_id TEXT NOT NULL DEFAULT '', -- 用户已经通过的提交 ID
  UNIQUE (project_id, number)
);

CREATE TABLE IF NOT EXISTS task_activity (
  id          TEXT PRIMARY KEY,                 -- 活动唯一 id（activity_*）
  project_id  TEXT NOT NULL,                    -- 所属项目 id
  task_id     TEXT NOT NULL,                    -- 关联任务 id（任务软删除后记录仍保留）
  task_number INTEGER NOT NULL,                 -- 任务编号快照
  title       TEXT NOT NULL,                    -- 任务标题快照
  kind        TEXT NOT NULL,                    -- created/status_changed/deleted
  from_status TEXT NOT NULL DEFAULT '',          -- 变更前状态；创建时为空
  to_status   TEXT NOT NULL DEFAULT '',          -- 变更后状态；删除时为删除前状态
  at          INTEGER NOT NULL,                 -- 发生时间（ms）
  details     TEXT NOT NULL DEFAULT '{}'         -- 提交/验收等事件详情 JSON；不得放凭据
);

CREATE TABLE IF NOT EXISTS task_run (
  id            TEXT PRIMARY KEY,               -- 单次项目任务执行 ID
  task_id       TEXT NOT NULL,                   -- 所属项目任务
  project_id    TEXT NOT NULL,                   -- 项目快照
  thread_id     TEXT NOT NULL,                   -- 本机独立任务话题
  agent_id      TEXT NOT NULL,                   -- 本次实际执行的 Agent
  status        TEXT NOT NULL,                   -- queued/running/waiting_browser/succeeded/failed/cancelled/interrupted/needs_input
  spec_hash     TEXT NOT NULL,                   -- 开始执行时任务要求的 SHA-256
  task_snapshot TEXT NOT NULL,                   -- 开始执行时任务字段 JSON
  started_at    INTEGER NOT NULL,                -- 请求创建时间（ms）
  finished_at   INTEGER,                         -- 执行结束时间（ms）
  error         TEXT NOT NULL DEFAULT '',        -- 失败或中断原因
  submission_id TEXT NOT NULL DEFAULT ''        -- 本轮提交 ID（无提交时为空）
);

CREATE TABLE IF NOT EXISTS chat_message (
  id           TEXT PRIMARY KEY,                 -- 消息唯一 id
  scope        TEXT NOT NULL,                    -- 消息域：group:<projectId>
  sender_type  TEXT NOT NULL,                    -- user/agent/system
  sender_id    TEXT NOT NULL DEFAULT '',         -- agent id（user/system 为空）
  content      TEXT NOT NULL DEFAULT '',         -- 文本内容
  meta         TEXT NOT NULL DEFAULT '{}',       -- 扩展 JSON：task_card/delegation/借用信息
  created_at   INTEGER NOT NULL                  -- 时间（ms）
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,                        -- 键（settings:providers / session:private:<agentId> 等）
  value TEXT NOT NULL,                           -- JSON 值
  updated_at INTEGER NOT NULL                     -- 更新时间（ms）
);

CREATE TABLE IF NOT EXISTS cron_task (
  id           TEXT PRIMARY KEY,                 -- 定时任务唯一 id（cron_*）
  name         TEXT NOT NULL,                    -- 任务名（如「晨间病区动态」）
  target_type  TEXT NOT NULL,                    -- 目标类型：agent（私聊某个智能体）/ project（项目群）
  target_id    TEXT NOT NULL,                    -- 目标 id：agent id 或 project id
  cron_expr    TEXT NOT NULL,                    -- 5 段式 cron（本机时区）：分 时 日 月 周；一次性任务里只作兼容展示
  run_at       INTEGER,                          -- 一次性任务的绝对触发时间（ms，本机时区）；NULL=按 cron 重复
  prompt       TEXT NOT NULL DEFAULT '',         -- 触发时向目标发出的提示词
  miss_policy  TEXT NOT NULL DEFAULT 'catchup',  -- 错过处理：catchup=启动时补跑一次 / skip=顺延跳过
  enabled      INTEGER NOT NULL DEFAULT 1,       -- 1=启用 0=停用
  last_run_at  INTEGER,                          -- 上次触发时间（ms，null=从未执行）
  next_run_at  INTEGER,                          -- 下次触发时间（ms，null=待计算）
  created_at   INTEGER NOT NULL,                 -- 创建时间（ms）
  updated_at   INTEGER NOT NULL,                 -- 更新时间（ms）
  deleted_at   INTEGER                           -- 软删除时间（ms，null=未删）
);

CREATE TABLE IF NOT EXISTS cron_run (
  id          TEXT PRIMARY KEY,                  -- 单次运行记录 id
  task_id     TEXT NOT NULL,                     -- 所属定时任务 id（任务删除后记录保留，便于排障）
  started_at  INTEGER NOT NULL,                  -- 开始时间（ms）
  finished_at INTEGER,                           -- 结束时间（ms，null=进行中）
  status      TEXT NOT NULL DEFAULT 'running',   -- running/waiting_browser/ok/failed/cancelled/missed/skipped
  is_catchup  INTEGER NOT NULL DEFAULT 0,        -- 1=本次为错过后补跑
  error       TEXT NOT NULL DEFAULT ''           -- 失败原因（status=failed 时）
);

CREATE INDEX IF NOT EXISTS idx_agent_name ON agent(name);
CREATE INDEX IF NOT EXISTS idx_task_project ON task(project_id, status);
CREATE INDEX IF NOT EXISTS idx_task_activity_project ON task_activity(project_id, at);
CREATE INDEX IF NOT EXISTS idx_task_run_task ON task_run(task_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_run_active_unique ON task_run(task_id)
  WHERE status IN ('queued', 'running', 'waiting_browser');
CREATE INDEX IF NOT EXISTS idx_msg_scope ON chat_message(scope, created_at);
CREATE INDEX IF NOT EXISTS idx_cron_next ON cron_task(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_cron_run_task ON cron_run(task_id, started_at);
`)

  // 增量列迁移（CREATE TABLE IF NOT EXISTS 不会给旧库加列）
  addColumn(db, 'agent', 'execution_engine', "TEXT NOT NULL DEFAULT 'opencode'", '执行引擎；旧智能体默认 OpenCode')
  addColumn(db, 'agent', 'engine_model', "TEXT NOT NULL DEFAULT ''", '外部 CLI 模型；空串沿用 CLI 默认')
  addColumn(db, 'agent', 'thinking', "TEXT NOT NULL DEFAULT ''", "默认思考档位：'' /none/low/high/max（''=跟随模型配置）")
  addColumn(db, 'agent', 'category', "TEXT NOT NULL DEFAULT ''", "分组分类（如：项目管理/医疗场景/项目开发；空=默认分组）")
  addColumn(db, 'agent', 'instructions_version', 'INTEGER NOT NULL DEFAULT 0', '身份指令版本号：仅 instructions 实际变更时 +1（jeff_self_update 写前校验用，随同步携带）')
  addColumn(db, 'project', 'workspace_dir', "TEXT NOT NULL DEFAULT ''", '工作空间目录（空=全局 workspace，输出文件默认落这里）')
  addColumn(db, 'project', 'siyuan_notebook_id', "TEXT NOT NULL DEFAULT ''", '项目群关联的思源笔记本 ID；空=继承 Jeff 全局归档目标')
  addColumn(db, 'project', 'siyuan_parent_doc_id', "TEXT NOT NULL DEFAULT ''", '项目群关联的思源父文档 ID；空=笔记本根目录')
  dropColumn(db, 'project', 'workspace_state')
  addColumn(db, 'project', 'system_prompt', "TEXT NOT NULL DEFAULT ''", '项目群规则 System Prompt；旧项目默认空')
  addColumn(db, 'project_agent', 'duties', "TEXT NOT NULL DEFAULT ''", '成员在该项目群内的职责；旧成员默认空')
  addColumn(db, 'project_agent', 'model_override', 'TEXT', '群内成员模型覆盖；NULL=继承 Agent 个人默认')
  addColumn(db, 'project_agent', 'thinking_override', 'TEXT', '群内成员思考覆盖；NULL=继承 Agent 个人默认')
  addColumn(db, 'cron_task', 'run_at', 'INTEGER', '一次性任务的绝对触发时间（ms，本机时区）；NULL=按 cron 重复')
  addColumn(db, 'task', 'due_at', 'INTEGER', '任务截止时间（ms；null=未设）')
  addColumn(db, 'task', 'depends_on', "TEXT NOT NULL DEFAULT '[]'", '依赖任务 id 数组 JSON')
  addColumn(db, 'task', 'acceptance_criteria', "TEXT NOT NULL DEFAULT ''", '任务验收标准')
  addColumn(db, 'task', 'evidence_paths', "TEXT NOT NULL DEFAULT '[]'", '任务验收证据的工作区相对路径数组 JSON')
  addColumn(db, 'task', 'goal', "TEXT NOT NULL DEFAULT ''", '任务希望达成的结果')
  addColumn(db, 'task', 'result_summary', "TEXT NOT NULL DEFAULT ''", '最近一次智能体提交的结果摘要')
  addColumn(db, 'task', 'submission_id', "TEXT NOT NULL DEFAULT ''", '当前提交验收的唯一 ID')
  addColumn(db, 'task', 'submitted_spec_hash', "TEXT NOT NULL DEFAULT ''", '当前提交对应的任务要求哈希')
  addColumn(db, 'task', 'review_feedback', "TEXT NOT NULL DEFAULT ''", '最近一次用户退回意见')
  addColumn(db, 'task', 'reviewed_submission_id', "TEXT NOT NULL DEFAULT ''", '用户已经通过的提交 ID')
  addColumn(db, 'task_activity', 'details', "TEXT NOT NULL DEFAULT '{}'", '提交/验收等事件详情 JSON')

  // 旧任务只有当前状态和创建时间：回填创建事实，不猜测历史状态变化。
  db.exec(`INSERT OR IGNORE INTO task_activity (id, project_id, task_id, task_number, title, kind, from_status, to_status, at)
    SELECT 'activity_legacy_' || id, project_id, id, number, title, 'created', '', status, created_at FROM task`)

  // 角色归一：历史 member / 开发 / ui / 测试 / 产品 … → worker；再按 project.leader_agent_id 校正群主
  db.exec(`UPDATE project_agent SET role = 'worker' WHERE role IS NULL OR trim(role) = '' OR lower(role) != 'leader'`)
  db.exec(`
    UPDATE project_agent
    SET role = 'leader'
    WHERE EXISTS (
      SELECT 1 FROM project p
      WHERE p.id = project_agent.project_id AND p.leader_agent_id = project_agent.agent_id
    )
  `)
  db.exec(`
    UPDATE project_agent
    SET role = 'worker'
    WHERE lower(role) = 'leader'
      AND NOT EXISTS (
        SELECT 1 FROM project p
        WHERE p.id = project_agent.project_id AND p.leader_agent_id = project_agent.agent_id
      )
  `)

  // 已有库的同名索引不会被 CREATE IF NOT EXISTS 更新；等待浏览器的任务也必须独占该任务。
  db.exec(`DROP INDEX IF EXISTS idx_task_run_active_unique;
    CREATE UNIQUE INDEX idx_task_run_active_unique ON task_run(task_id)
    WHERE status IN ('queued', 'running', 'waiting_browser');`)
}

/** 若表缺列则 ALTER TABLE ADD COLUMN（幂等） */
function addColumn(db: DB, table: string, column: string, def: string, comment: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  comment // 注释仅作文档（SQLite 无法附加列注释），保持与建表注释同一精神
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
}

/** 删除已下线的结构化业务字段（SQLite 3.35+；保留同一任务的历史状态数据）。 */
function dropColumn(db: DB, table: string, column: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
}

export const now = (): number => Date.now()
