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
  builtin       INTEGER NOT NULL DEFAULT 0,      -- 1=内置不可编辑（小杰）
  archived      INTEGER NOT NULL DEFAULT 0,      -- 1=已归档（保留历史）
  created_at    INTEGER NOT NULL,                -- 创建时间（ms）
  updated_at    INTEGER NOT NULL,                -- 更新时间（ms）
  deleted_at    INTEGER                          -- 软删除时间（ms，null=未删）
);

CREATE TABLE IF NOT EXISTS project (
  id              TEXT PRIMARY KEY,              -- 项目唯一 id（prj_*；= 微信群）
  title           TEXT NOT NULL,                 -- 群名
  description     TEXT NOT NULL DEFAULT '',      -- 群简介
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
  role       TEXT NOT NULL DEFAULT 'member',     -- 群内角色：开发/ui/测试/产品/leader/member
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
  UNIQUE (project_id, number)
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

CREATE INDEX IF NOT EXISTS idx_agent_name ON agent(name);
CREATE INDEX IF NOT EXISTS idx_task_project ON task(project_id, status);
CREATE INDEX IF NOT EXISTS idx_msg_scope ON chat_message(scope, created_at);
`)
}

export const now = (): number => Date.now()
