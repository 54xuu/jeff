import { ipcMain, nativeTheme, app, BrowserWindow, Tray, nativeImage, Menu, shell } from "electron";
import fs, { promises } from "node:fs";
import path$1 from "node:path";
import { EventEmitter } from "node:events";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import net, { isIP } from "node:net";
import http from "node:http";
import require$$0 from "util";
import { Agent } from "http";
import { Agent as Agent$1 } from "https";
import https from "node:https";
import zlib from "node:zlib";
import Stream, { PassThrough, pipeline as pipeline$1 } from "node:stream";
import { Buffer as Buffer$1 } from "node:buffer";
import { types as types$1, deprecate, promisify } from "node:util";
import { format } from "node:url";
import Stream$1 from "stream";
function jeffRoot(override) {
  return override || process.env.JEFF_HOME || path$1.join(os.homedir(), ".jeff");
}
function buildPaths(root) {
  const ocConfigHome = path$1.join(root, "oc-home", "config");
  const ocConfigDir = path$1.join(ocConfigHome, "opencode");
  return {
    root,
    dbFile: path$1.join(root, "jeff.db"),
    configFile: path$1.join(root, "config.json"),
    logDir: path$1.join(root, "logs"),
    memoryDir: path$1.join(root, "memory"),
    workspaceDir: path$1.join(root, "workspace"),
    ocConfigHome,
    ocDataHome: path$1.join(root, "oc-home", "data"),
    ocConfigDir,
    ocAgentsDir: path$1.join(ocConfigDir, "agent"),
    ocPluginsDir: path$1.join(ocConfigDir, "plugin"),
    ocSkillsDir: path$1.join(ocConfigDir, "skills")
  };
}
function ensureDirs(p) {
  for (const dir of [
    p.root,
    p.logDir,
    p.memoryDir,
    p.workspaceDir,
    p.ocConfigDir,
    p.ocAgentsDir,
    p.ocPluginsDir,
    p.ocSkillsDir,
    path$1.join(p.ocDataHome)
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
function openDb(p) {
  const db = new DatabaseSync(p.dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
function migrate(db) {
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
`);
}
const now = () => Date.now();
function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}
function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}
const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "cancelled"];
const TASK_PRIORITIES = ["urgent", "high", "medium", "low"];
const PROJECT_STATUSES = ["planned", "in_progress", "paused", "completed", "cancelled"];
const kvRepo = (db) => ({
  get(key) {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return row ? row.value : null;
  },
  getJSON(key, fallback) {
    const v = this.get(key);
    if (v == null) return fallback;
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    db.prepare(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(key, value, now());
  },
  setJSON(key, value) {
    this.set(key, JSON.stringify(value));
  },
  delete(key) {
    db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }
});
const agentRepo = (db) => ({
  list(includeDeleted = false) {
    const where = includeDeleted ? "" : "WHERE deleted_at IS NULL";
    return db.prepare(`SELECT * FROM agent ${where} ORDER BY builtin DESC, archived ASC, name ASC`).all();
  },
  get(id) {
    return db.prepare("SELECT * FROM agent WHERE id = ?").get(id);
  },
  create(data) {
    const id = data.id ?? genId("agt");
    const row = {
      id,
      name: data.name,
      avatar: data.avatar || "🤖",
      description: data.description || "",
      instructions: data.instructions || "",
      model_provider: data.model_provider || "",
      model_id: data.model_id || "",
      builtin: data.builtin || 0,
      archived: 0,
      created_at: now(),
      updated_at: now(),
      deleted_at: null
    };
    db.prepare(
      `INSERT INTO agent (id, name, avatar, description, instructions, model_provider, model_id, builtin, archived, created_at, updated_at, deleted_at)
       VALUES (@id, @name, @avatar, @description, @instructions, @model_provider, @model_id, @builtin, @archived, @created_at, @updated_at, @deleted_at)`
    ).run(row);
    return row;
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return void 0;
    const next = { ...cur, ...patch, updated_at: now() };
    db.prepare(
      `UPDATE agent SET name=@name, avatar=@avatar, description=@description, instructions=@instructions,
       model_provider=@model_provider, model_id=@model_id, archived=@archived, updated_at=@updated_at WHERE id=@id`
    ).run({
      name: next.name,
      avatar: next.avatar,
      description: next.description,
      instructions: next.instructions,
      model_provider: next.model_provider,
      model_id: next.model_id,
      archived: next.archived,
      updated_at: next.updated_at,
      id: next.id
    });
    return this.get(id);
  },
  softDelete(id) {
    const cur = this.get(id);
    if (!cur || cur.builtin) return false;
    db.prepare("UPDATE agent SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
    return true;
  }
});
const projectRepo = (db) => ({
  list(includeDeleted = false) {
    const where = includeDeleted ? "" : "WHERE deleted_at IS NULL";
    return db.prepare(`SELECT * FROM project ${where} ORDER BY updated_at DESC`).all();
  },
  get(id) {
    return db.prepare("SELECT * FROM project WHERE id = ?").get(id);
  },
  create(data) {
    const row = {
      id: genId("prj"),
      title: data.title,
      description: data.description || "",
      icon: data.icon || "👥",
      status: data.status || "in_progress",
      leader_agent_id: data.leader_agent_id ?? null,
      created_at: now(),
      updated_at: now(),
      deleted_at: null
    };
    db.prepare(
      `INSERT INTO project (id, title, description, icon, status, leader_agent_id, created_at, updated_at, deleted_at)
       VALUES (@id, @title, @description, @icon, @status, @leader_agent_id, @created_at, @updated_at, @deleted_at)`
    ).run(row);
    return row;
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return void 0;
    const next = { ...cur, ...patch, updated_at: now() };
    db.prepare(
      `UPDATE project SET title=@title, description=@description, icon=@icon, status=@status, leader_agent_id=@leader_agent_id, updated_at=@updated_at WHERE id=@id`
    ).run({
      title: next.title,
      description: next.description,
      icon: next.icon,
      status: next.status,
      leader_agent_id: next.leader_agent_id,
      updated_at: next.updated_at,
      id: next.id
    });
    return this.get(id);
  },
  softDelete(id) {
    const cur = this.get(id);
    if (!cur) return false;
    db.prepare("UPDATE project SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
    return true;
  }
});
const projectAgentRepo = (db) => ({
  listByProject(projectId) {
    return db.prepare("SELECT * FROM project_agent WHERE project_id = ? ORDER BY position, created_at").all(projectId);
  },
  add(projectId, agentId, role = "member", position = 0) {
    db.prepare(
      `INSERT INTO project_agent (project_id, agent_id, role, position, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, agent_id) DO UPDATE SET role = excluded.role, position = excluded.position`
    ).run(projectId, agentId, role, position, now());
  },
  remove(projectId, agentId) {
    db.prepare("DELETE FROM project_agent WHERE project_id = ? AND agent_id = ?").run(projectId, agentId);
  },
  getRole(projectId, agentId) {
    const row = db.prepare("SELECT role FROM project_agent WHERE project_id = ? AND agent_id = ?").get(projectId, agentId);
    return row?.role;
  }
});
const taskRepo = (db) => ({
  listByProject(projectId, includeDeleted = false) {
    const where = includeDeleted ? "WHERE project_id = ?" : "WHERE project_id = ? AND deleted_at IS NULL";
    return db.prepare(`SELECT * FROM task ${where} ORDER BY number DESC`).all(projectId);
  },
  get(id) {
    return db.prepare("SELECT * FROM task WHERE id = ?").get(id);
  },
  /** 项目内编号：取当前最大编号 +1（软删除占用也跳过不复用，避免歧义） */
  nextNumber(projectId) {
    const row = db.prepare("SELECT MAX(number) AS m FROM task WHERE project_id = ?").get(projectId);
    return (row.m ?? 0) + 1;
  },
  create(data) {
    const row = {
      id: genId("task"),
      project_id: data.project_id,
      number: this.nextNumber(data.project_id),
      title: data.title,
      description: data.description || "",
      status: data.status && TASK_STATUSES.includes(data.status) ? data.status : "todo",
      priority: data.priority && TASK_PRIORITIES.includes(data.priority) ? data.priority : "medium",
      assignee_type: data.assignee_type || "none",
      assignee_id: data.assignee_id || "",
      parent_task_id: data.parent_task_id ?? null,
      position: 0,
      created_at: now(),
      updated_at: now(),
      deleted_at: null
    };
    db.prepare(
      `INSERT INTO task (id, project_id, number, title, description, status, priority, assignee_type, assignee_id, parent_task_id, position, created_at, updated_at, deleted_at)
       VALUES (@id, @project_id, @number, @title, @description, @status, @priority, @assignee_type, @assignee_id, @parent_task_id, @position, @created_at, @updated_at, @deleted_at)`
    ).run(row);
    return row;
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return void 0;
    if (patch.status && !TASK_STATUSES.includes(patch.status)) return void 0;
    if (patch.priority && !TASK_PRIORITIES.includes(patch.priority)) return void 0;
    const next = { ...cur, ...patch, updated_at: now() };
    db.prepare(
      `UPDATE task SET title=@title, description=@description, status=@status, priority=@priority, assignee_type=@assignee_type,
       assignee_id=@assignee_id, parent_task_id=@parent_task_id, position=@position, updated_at=@updated_at WHERE id=@id`
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
      id: next.id
    });
    return this.get(id);
  },
  softDelete(id) {
    const cur = this.get(id);
    if (!cur) return false;
    db.prepare("UPDATE task SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
    return true;
  }
});
const chatMessageRepo = (db) => ({
  listByScope(scope, limit = 200) {
    return db.prepare("SELECT * FROM chat_message WHERE scope = ? ORDER BY created_at DESC LIMIT ?").all(scope, limit).reverse();
  },
  add(row) {
    const rec = {
      id: row.id ?? genId("msg"),
      scope: row.scope,
      sender_type: row.sender_type,
      sender_id: row.sender_id || "",
      content: row.content || "",
      meta: row.meta ? JSON.stringify(row.meta) : "{}",
      created_at: now()
    };
    db.prepare(
      "INSERT INTO chat_message (id, scope, sender_type, sender_id, content, meta, created_at) VALUES (@id, @scope, @sender_type, @sender_id, @content, @meta, @created_at)"
    ).run(rec);
    return rec;
  }
});
class SidecarManager extends EventEmitter {
  proc = null;
  opts;
  restarts = 0;
  stopping = false;
  healthTimer = null;
  port = 0;
  status = "stopped";
  lastError = "";
  constructor(opts) {
    super();
    this.opts = opts;
  }
  /** 解析 opencode 可执行文件路径 */
  resolveBinary() {
    if (this.opts.binaryPath && fs.existsSync(this.opts.binaryPath)) return this.opts.binaryPath;
    const envBin = process.env.JEFF_OPENCODE_BIN;
    if (envBin && fs.existsSync(envBin)) return envBin;
    if (this.opts.resourceBinDir) {
      const plat = process.platform === "win32" ? "windows-x64" : "linux-x64";
      const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
      const cand = path$1.join(this.opts.resourceBinDir, plat, exe);
      if (fs.existsSync(cand)) return cand;
    }
    const home = process.env.HOME || "";
    for (const cand of [path$1.join(home, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode")]) {
      if (cand && fs.existsSync(cand)) return cand;
    }
    const dirs = (process.env.PATH || "").split(path$1.delimiter);
    for (const d of dirs) {
      const exe = path$1.join(d, process.platform === "win32" ? "opencode.exe" : "opencode");
      if (fs.existsSync(exe)) return exe;
    }
    return null;
  }
  /** 隔离环境变量（XDG + OPENCODE_CONFIG_DIR 重定向，不碰用户全局 opencode 配置） */
  sidecarEnv() {
    return {
      ...process.env,
      XDG_CONFIG_HOME: this.opts.paths.ocConfigHome,
      XDG_DATA_HOME: this.opts.paths.ocDataHome,
      // 强制 opencode 只用我们的配置目录（否则会回退加载 ~/.opencode/opencode.json 用户全局配置）
      OPENCODE_CONFIG_DIR: this.opts.paths.ocConfigDir,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      // 技能只认 Jeff 自己的 skills 目录，不扫 ~/.claude、~/.agents 等外部目录
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      // 阻止 opencode 读取项目级 .opencode 配置造成串扰：cwd 固定在 Jeff 工作区
      HOME: process.env.HOME
    };
  }
  async start() {
    if (this.status === "running" || this.status === "starting") return this.port;
    const bin = this.resolveBinary();
    if (!bin) {
      this.lastError = "未找到 opencode 可执行文件（检查 JEFF_OPENCODE_BIN / 资源目录 / PATH）";
      this.status = "crashed";
      this.emit("status", this.status, this.lastError);
      throw new Error(this.lastError);
    }
    this.status = "starting";
    this.emit("status", this.status);
    const port = await pickFreePort(this.opts.minPort ?? 14096, this.opts.maxPort ?? 15096);
    const args = ["serve", "--port", String(port), "--hostname", "127.0.0.1"];
    const proc = spawn(bin, args, {
      cwd: this.opts.paths.workspaceDir,
      env: this.sidecarEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    this.proc = proc;
    this.port = port;
    proc.stdout?.on("data", (d) => this.emit("log", `[sidecar:out] ${String(d)}`));
    proc.stderr?.on("data", (d) => this.emit("log", `[sidecar:err] ${String(d)}`));
    proc.on("exit", (code, signal) => {
      this.proc = null;
      if (this.stopping) {
        this.status = "stopped";
        this.emit("status", this.status);
        return;
      }
      this.status = "crashed";
      this.emit("status", this.status, `exit code=${code} signal=${signal}`);
      this.scheduleRestart();
    });
    const ok = await this.waitHealthy(15e3);
    if (!ok) {
      this.lastError = `sidecar 启动超时（端口 ${port}）`;
      this.status = "crashed";
      this.emit("status", this.status, this.lastError);
      throw new Error(this.lastError);
    }
    this.status = "running";
    this.restarts = 0;
    this.emit("status", this.status);
    this.startHealthMonitor();
    return port;
  }
  startHealthMonitor() {
    this.stopHealthMonitor();
    this.healthTimer = setInterval(() => {
      if (this.status !== "running") return;
      void this.ping().then((ok) => {
        if (!ok && this.status === "running") {
          this.emit("log", "[sidecar] 健康检查未通过（进程仍在）");
        }
      });
    }, 15e3);
    this.healthTimer.unref?.();
  }
  stopHealthMonitor() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }
  scheduleRestart() {
    if (this.stopping) return;
    this.restarts += 1;
    if (this.restarts > 5) {
      this.lastError = "sidecar 连续崩溃超过 5 次，停止重启";
      this.emit("status", this.status, this.lastError);
      return;
    }
    const delay = Math.min(1e3 * this.restarts, 5e3);
    this.emit("log", `[sidecar] ${delay}ms 后第 ${this.restarts} 次重启`);
    setTimeout(() => {
      if (!this.stopping) void this.start().catch(() => {
      });
    }, delay);
  }
  async ping() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/doc`, { signal: AbortSignal.timeout(2e3) });
      return res.ok;
    } catch {
      return false;
    }
  }
  async waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.proc) return false;
      if (await this.ping()) return true;
      await sleep(250);
    }
    return false;
  }
  async stop() {
    this.stopping = true;
    this.stopHealthMonitor();
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      await new Promise((resolve) => {
        proc.once("exit", () => resolve());
        try {
          proc.kill("SIGTERM");
        } catch {
        }
        setTimeout(() => {
          try {
            if (proc.exitCode == null && proc.signalCode == null) proc.kill("SIGKILL");
          } catch {
          }
          resolve();
        }, 3e3).unref?.();
      });
    }
    this.status = "stopped";
    this.stopping = false;
    this.emit("status", this.status);
  }
}
function pickFreePort(min, max) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once("error", () => p < max ? tryPort(p + 1) : reject(new Error("无可用端口")));
      srv.once("listening", () => srv.close(() => resolve(p)));
      srv.listen(p, "127.0.0.1");
    };
    tryPort(min);
  });
}
const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
class OcClient extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
  }
  port;
  base() {
    return `http://127.0.0.1:${this.port}`;
  }
  async req(method, path2, body, timeoutMs = 3e4) {
    const res = await fetch(`${this.base()}${path2}`, {
      method,
      headers: body !== void 0 ? { "content-type": "application/json" } : void 0,
      body: body !== void 0 ? JSON.stringify(body) : void 0,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`opencode ${method} ${path2} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) return void 0;
    return await res.json();
  }
  // ---------- 会话 ----------
  async createSession(input) {
    return this.req("POST", "/session", input);
  }
  async getSession(sessionId) {
    return this.req("GET", `/session/${sessionId}`);
  }
  async listSessions() {
    return this.req("GET", "/session");
  }
  async deleteSession(sessionId) {
    await this.req("DELETE", `/session/${sessionId}`);
  }
  /** 获取会话消息（含 user/assistant 与 parts） */
  async getMessages(sessionId) {
    return this.req("GET", `/session/${sessionId}/message`);
  }
  /**
   * 发送一条用户消息并等待 assistant 回复完成。
   * @returns 完成的 assistant 消息 info
   */
  async sendMessage(input) {
    const returned = await this.req(
      "POST",
      `/session/${input.sessionId}/message`,
      {
        parts: [{ type: "text", text: input.text }],
        ...input.agent ? { agent: input.agent } : {},
        ...input.model ? { model: input.model } : {},
        ...input.system ? { system: input.system } : {},
        ...input.noReply ? { noReply: true } : {}
      },
      6e4
    );
    const assistantId = returned?.info?.id ?? returned?.id;
    if (!assistantId) throw new Error("发送消息未返回 assistant 消息 id");
    const deadline = Date.now() + (input.timeoutMs ?? 18e4);
    for (; ; ) {
      const msgs = await this.getMessages(input.sessionId);
      const found = msgs.find((m2) => m2.info?.id === assistantId)?.info;
      if (found) {
        if (found.error) throw new Error(`assistant 消息出错: ${JSON.stringify(found.error).slice(0, 300)}`);
        if (found.time?.completed) return found;
      } else if (Date.now() > deadline) {
        throw new Error("assistant 消息未创建（超时）");
      }
      if (Date.now() > deadline) throw new Error("等待 assistant 回复超时");
      await sleep(400);
    }
  }
  async abortSession(sessionId) {
    await this.req("POST", `/session/${sessionId}/abort`).catch(() => {
    });
  }
  // ---------- agent / provider ----------
  async listAgents() {
    return this.req("GET", "/agent");
  }
  /** 配置后的 provider + 模型目录 */
  async listProviders() {
    const data = await this.req("GET", "/config/providers");
    if (Array.isArray(data)) return data;
    return data.providers ?? [];
  }
  // ---------- SSE ----------
  /** 连接全局事件流；事件转发为 'event' 事件 {type, properties}；自动重连 */
  sseAbort = null;
  startEventStream() {
    if (this.sseAbort) return;
    const ctrl = new AbortController();
    this.sseAbort = ctrl;
    void this.runSse(ctrl);
  }
  stopEventStream() {
    this.sseAbort?.abort();
    this.sseAbort = null;
  }
  async runSse(ctrl) {
    for (; ; ) {
      try {
        const res = await fetch(`${this.base()}/event`, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              this.emit("event", JSON.parse(payload));
            } catch {
            }
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        this.emit("sse-error", err);
      }
      if (ctrl.signal.aborted) return;
      await sleep(1500);
    }
  }
}
function writeSidecarConfig(p, providers, opts = {}) {
  const configFile = path$1.join(p.ocConfigDir, "opencode.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {
  }
  const providerCfg = {};
  for (const pv of providers) {
    if (pv.kind === "custom") {
      providerCfg[pv.id] = {
        npm: "@ai-sdk/openai-compatible",
        name: pv.name || pv.id,
        options: { baseURL: pv.baseURL || "" },
        models: Object.fromEntries((pv.models || []).map((m2) => [m2.id, m2.name ? { name: m2.name } : {}]))
      };
    }
  }
  cfg["provider"] = providerCfg;
  if (opts.mcp) cfg["mcp"] = opts.mcp;
  if (opts.defaultModel?.providerID && opts.defaultModel?.modelID) {
    cfg["small_model"] = `${opts.defaultModel.providerID}/${opts.defaultModel.modelID}`;
  }
  cfg["permission"] = { edit: "allow", bash: "allow", webfetch: "allow" };
  fs.mkdirSync(p.ocConfigDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), "utf8");
  const auth = {};
  for (const pv of providers) {
    if (pv.apiKey) auth[pv.id] = { type: "api", key: pv.apiKey };
  }
  fs.writeFileSync(path$1.join(p.ocConfigDir, "auth.json"), JSON.stringify(auth, null, 2), "utf8");
}
const XIAOJIE_ID = "agt_xiaojie";
const IPC = {
  // invoke（渲染 → 主）
  appInfo: "app:info",
  agentsList: "agents:list",
  agentsGet: "agents:get",
  agentsUpsert: "agents:upsert",
  agentsDelete: "agents:delete",
  chatHistory: "chat:history",
  chatSend: "chat:send",
  chatNew: "chat:new",
  chatStop: "chat:stop",
  projectsList: "projects:list",
  projectSave: "project:save",
  projectDelete: "project:delete",
  projectMembers: "project:members",
  projectAddMember: "project:addMember",
  projectRemoveMember: "project:removeMember",
  tasksList: "tasks:list",
  taskSave: "task:save",
  taskDelete: "task:delete",
  groupHistory: "group:history",
  groupSend: "group:send",
  providersList: "providers:list",
  providersSave: "providers:save",
  providersCatalog: "providers:catalog",
  modelsDefault: "models:default",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  mcpList: "mcp:list",
  mcpSave: "mcp:save",
  memoryScopes: "memory:scopes",
  memoryGet: "memory:get",
  memorySave: "memory:save",
  syncNow: "sync:now",
  syncStatus: "sync:status",
  syncConfigure: "sync:configure"
};
const ADMIN_TOOL_NAMES = [
  "jeff_agent_create",
  "jeff_agent_update",
  "jeff_agent_delete",
  "jeff_agent_list",
  "jeff_agent_get"
];
function registerAdminTools(reg, deps) {
  const agents = agentRepo(deps.db);
  const [T_CREATE, T_UPDATE, T_DELETE, T_LIST, T_GET] = ADMIN_TOOL_NAMES;
  reg.register(T_CREATE, async (args) => {
    const name = (args.name || "").trim();
    if (!name) throw new Error("name 不能为空");
    const row = agents.create({
      name,
      avatar: args.avatar || "🤖",
      description: args.description || "",
      instructions: args.instructions || "",
      model_provider: args.model_provider || "",
      model_id: args.model_id || ""
    });
    deps.onChanged();
    return { id: row.id, name: row.name };
  });
  reg.register(T_UPDATE, async (args) => {
    if (!args.id) throw new Error("id 不能为空");
    if (args.id === XIAOJIE_ID) throw new Error("小杰是内置管家，不可编辑");
    const row = agents.update(args.id, {
      ...args.name !== void 0 ? { name: args.name } : {},
      ...args.description !== void 0 ? { description: args.description } : {},
      ...args.instructions !== void 0 ? { instructions: args.instructions } : {},
      ...args.avatar !== void 0 ? { avatar: args.avatar } : {},
      ...args.model_provider !== void 0 ? { model_provider: args.model_provider } : {},
      ...args.model_id !== void 0 ? { model_id: args.model_id } : {},
      ...args.archived !== void 0 ? { archived: args.archived ? 1 : 0 } : {}
    });
    if (!row) throw new Error(`智能体不存在: ${args.id}`);
    deps.onChanged();
    return { id: row.id, name: row.name };
  });
  reg.register(T_DELETE, async (args) => {
    if (!args.id) throw new Error("id 不能为空");
    if (args.id === XIAOJIE_ID) throw new Error("小杰是内置管家，不可删除");
    const ok = agents.softDelete(args.id);
    if (!ok) throw new Error(`删除失败（不存在或不可删除）: ${args.id}`);
    deps.onChanged();
    return { deleted: true };
  });
  reg.register(T_LIST, async () => {
    return agents.list().map((a) => ({ id: a.id, name: a.name, avatar: a.avatar, description: a.description, builtin: !!a.builtin, archived: !!a.archived }));
  });
  reg.register(T_GET, async (args) => {
    if (!args.id) throw new Error("id 不能为空");
    const a = agents.get(args.id);
    if (!a) throw new Error(`智能体不存在: ${args.id}`);
    return { id: a.id, name: a.name, avatar: a.avatar, description: a.description, instructions: a.instructions, model_provider: a.model_provider, model_id: a.model_id, builtin: !!a.builtin };
  });
}
const XIAOJIE_SLUG = "jeff_xiaojie";
function agentSlug(agentId) {
  if (agentId === XIAOJIE_ID) return XIAOJIE_SLUG;
  const safe = agentId.replace(/[^a-zA-Z0-9]/g, "");
  return `jeff_${safe.slice(0, 16)}`;
}
const XIAOJIE_INSTRUCTIONS = `你是「小杰」，Jeff 桌面应用的内置管家 agent。Jeff 把工作组织成：智能体（聊天好友）、项目群（群主 leader + 成员智能体，像微信群）、任务（待办/进行/待审/完成，编号 JEF-n）。

你的职责（你是唯一的管家，管理工具仅你拥有）：
1. 问答与使用指导：用户问「Jeff 怎么用」时直接讲解。
2. 智能体管理：jeff_agent_* 工具创建/修改/删除其他智能体。
3. 项目群管理：jeff_project_* 工具建群、配群主（leader）与成员（角色如 开发/UI/测试/产品）。
4. 任务管理：jeff_task_* 工具创建/流转任务；任务卡片会出现在对应项目群里。
5. 你没有编码/文件工具；技术活建议用户去对应智能体或项目群里完成。
6. 你有长期记忆（jeff_memory）：记住用户偏好、常用项目背景、被纠正过的做法；会用 jeff_session_search 回忆历史对话。

要求：
- 用简体中文回复，简洁友好，像微信里的靠谱同事。
- 创建智能体：先问清「名字、用途、模型（可默认）」，确认后调用 jeff_agent_create。
- 创建项目群：先问清「群名、谁当群主、成员与角色」，确认后调用 jeff_project_create；群主必须是已存在的智能体。
- 创建任务：确认归属的项目群、标题、优先级、指派对象（可选）。
- 用户画像类信息（称呼偏好、技术栈口味）用 jeff_memory 的 scope:'user' 写；其他默认写自己的记忆。
- 破坏性操作（删除）必须先和用户确认一次。`;
function renderAgentMd(agent, defaultModel) {
  const lines = ["---"];
  lines.push(`description: ${JSON.stringify(agent.description || agent.name)}`);
  lines.push("mode: all");
  const model = agent.model_provider && agent.model_id ? `${agent.model_provider}/${agent.model_id}` : agent.builtin && defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID}` : "";
  if (model) lines.push(`model: ${model}`);
  if (!agent.builtin) {
    lines.push("tools:");
    for (const t2 of ADMIN_TOOL_NAMES) lines.push(`  ${t2}: false`);
  }
  lines.push("---", "");
  const body = agent.builtin ? XIAOJIE_INSTRUCTIONS : agent.instructions;
  lines.push(body, "");
  return lines.join("\n");
}
class AgentRegistry {
  constructor(db, paths) {
    this.db = db;
    this.paths = paths;
  }
  db;
  paths;
  /** 全量同步：写入所有 agent md，清理失效文件 */
  syncAll(defaultModel) {
    fs.mkdirSync(this.paths.ocAgentsDir, { recursive: true });
    const agents = agentRepo(this.db).list();
    const wanted = /* @__PURE__ */ new Set();
    for (const a of agents) {
      const file = `${agentSlug(a.id)}.md`;
      wanted.add(file);
      const content = renderAgentMd(a, defaultModel);
      const target = path$1.join(this.paths.ocAgentsDir, file);
      try {
        if (fs.readFileSync(target, "utf8") !== content) fs.writeFileSync(target, content, "utf8");
      } catch {
        fs.writeFileSync(target, content, "utf8");
      }
    }
    for (const f2 of fs.readdirSync(this.paths.ocAgentsDir)) {
      if (f2.startsWith("jeff_") && f2.endsWith(".md") && !wanted.has(f2)) {
        fs.rmSync(path$1.join(this.paths.ocAgentsDir, f2), { force: true });
      }
    }
  }
  /** 删除单个 agent 的 md 文件 */
  remove(agentId) {
    const file = path$1.join(this.paths.ocAgentsDir, `${agentSlug(agentId)}.md`);
    fs.rmSync(file, { force: true });
  }
}
class ToolBridge extends EventEmitter {
  server = null;
  handlers = /* @__PURE__ */ new Map();
  token = randomToken();
  port = 0;
  register(name, handler) {
    this.handlers.set(name, handler);
  }
  url() {
    return `http://127.0.0.1:${this.port}`;
  }
  async start() {
    const server = http.createServer((req, res) => {
      const done = (code, body2) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body2));
      };
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        done(200, { ok: true });
        return;
      }
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${this.token}`) {
        done(401, { ok: false, error: "unauthorized" });
        return;
      }
      const match2 = /^\/tools\/([a-z0-9_.-]+)$/i.exec(url.pathname);
      if (req.method !== "POST" || !match2) {
        done(404, { ok: false, error: "not found" });
        return;
      }
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", () => {
        const name = match2[1];
        const handler = this.handlers.get(name);
        if (!handler) {
          done(404, { ok: false, error: `未知工具: ${name}` });
          return;
        }
        let args = {};
        try {
          args = body ? JSON.parse(body) : {};
        } catch {
          done(400, { ok: false, error: "请求体不是合法 JSON" });
          return;
        }
        Promise.resolve().then(() => handler(args)).then((data) => {
          this.emit("tool-call", name);
          done(200, { ok: true, data });
        }).catch((err) => done(200, { ok: false, error: String(err?.message || err) }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    this.port = server.address().port;
  }
  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }
}
function renderBridgePlugin(bridgeUrl, token, tools) {
  const toolDefs = tools.map((t2) => {
    const args = JSON.stringify(
      Object.fromEntries(
        Object.entries(t2.args).map(([k, v]) => [
          k,
          { type: v.type, description: v.description, ...v.items ? { items: v.items } : {}, ...v.enum ? { enum: v.enum } : {} }
        ])
      )
    );
    return `    '${t2.name}': {
      description: ${JSON.stringify(t2.description)},
      args: ${args},
      async execute(args, ctx) {
        return await call('${t2.name}', args, ctx)
      },
    },`;
  }).join("\n");
  return `// 由 Jeff 自动生成 — 工具桥接插件（勿手工编辑）
export const JeffBridge = async () => {
  const BASE = ${JSON.stringify(bridgeUrl)}
  const TOKEN = ${JSON.stringify(token)}
  async function call(name, args, ctx) {
    const payload = { ...(args ?? {}), __ctx: { sessionID: ctx?.sessionID, agent: ctx?.agent, messageID: ctx?.messageID } }
    const res = await fetch(BASE + '/tools/' + name, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || '工具调用失败')
    return data.data == null ? 'ok' : (typeof data.data === 'string' ? data.data : JSON.stringify(data.data))
  }
  return {
    tool: {
${toolDefs}
    },
  }
}
`;
}
function registerProjectTools(reg, deps) {
  const projects = projectRepo(deps.db);
  const members = projectAgentRepo(deps.db);
  const agents = agentRepo(deps.db);
  const tasks = taskRepo(deps.db);
  reg.register("jeff_project_create", async (args) => {
    const title = (args.title || "").trim();
    if (!title) throw new Error("title（群名）不能为空");
    const leaderId = args.leader_agent_id;
    if (!leaderId) throw new Error("必须指定群主 leader_agent_id（一个 agent）");
    if (!agents.get(leaderId)) throw new Error(`群主智能体不存在: ${leaderId}`);
    const p = projects.create({ title, icon: args.icon || "👥", description: args.description || "", leader_agent_id: leaderId });
    members.add(p.id, leaderId, "leader", 0);
    for (const m2 of args.members || []) {
      const id = m2.agentId || m2.agent_id;
      if (!id || id === leaderId) continue;
      if (!agents.get(id)) throw new Error(`成员智能体不存在: ${id}`);
      members.add(p.id, id, m2.role || "member");
    }
    deps.onProjectChanged();
    return { id: p.id, title: p.title, leader_agent_id: p.leader_agent_id };
  });
  reg.register("jeff_project_update", async (args) => {
    if (!args.id) throw new Error("id 不能为空");
    const row = projects.update(args.id, {
      ...args.title !== void 0 ? { title: args.title } : {},
      ...args.description !== void 0 ? { description: args.description } : {},
      ...args.icon !== void 0 ? { icon: args.icon } : {},
      ...args.status !== void 0 ? { status: args.status } : {},
      ...args.leader_agent_id !== void 0 ? { leader_agent_id: args.leader_agent_id } : {}
    });
    if (!row) throw new Error(`项目不存在: ${args.id}`);
    if (args.leader_agent_id) members.add(args.id, args.leader_agent_id, "leader");
    deps.onProjectChanged();
    return { id: row.id, title: row.title };
  });
  reg.register("jeff_project_list", async () => {
    return projects.list().map((p) => ({
      id: p.id,
      title: p.title,
      icon: p.icon,
      status: p.status,
      description: p.description,
      leader_agent_id: p.leader_agent_id,
      members: members.listByProject(p.id).map((m2) => ({ agentId: m2.agent_id, role: m2.role }))
    }));
  });
  reg.register("jeff_project_add_member", async (args) => {
    if (!args.project_id || !args.agent_id) throw new Error("project_id 与 agent_id 必填");
    if (!projects.get(args.project_id)) throw new Error(`项目不存在: ${args.project_id}`);
    if (!agents.get(args.agent_id)) throw new Error(`智能体不存在: ${args.agent_id}`);
    members.add(args.project_id, args.agent_id, args.role || "member");
    deps.onProjectChanged();
    return { added: true };
  });
  reg.register("jeff_project_remove_member", async (args) => {
    if (!args.project_id || !args.agent_id) throw new Error("project_id 与 agent_id 必填");
    const p = projects.get(args.project_id);
    if (!p) throw new Error(`项目不存在: ${args.project_id}`);
    if (p.leader_agent_id === args.agent_id) throw new Error("不能移除群主（leader）；请先改群主");
    members.remove(args.project_id, args.agent_id);
    deps.onProjectChanged();
    return { removed: true };
  });
  reg.register("jeff_task_create", async (args) => {
    if (!args.project_id) throw new Error("project_id 必填");
    const title = (args.title || "").trim();
    if (!title) throw new Error("title 必填");
    if (!projects.get(args.project_id)) throw new Error(`项目不存在: ${args.project_id}`);
    const assigneeType = args.assignee_agent_id ? "agent" : "none";
    if (args.assignee_agent_id && !agents.get(args.assignee_agent_id)) throw new Error(`指派的智能体不存在: ${args.assignee_agent_id}`);
    const t2 = tasks.create({
      project_id: args.project_id,
      title,
      description: args.description || "",
      priority: args.priority,
      assignee_type: assigneeType,
      assignee_id: args.assignee_agent_id || "",
      parent_task_id: args.parent_task_id || null
    });
    deps.onTaskChanged(args.project_id, t2.id);
    return { id: t2.id, key: `JEF-${t2.number}`, title: t2.title, status: t2.status };
  });
  reg.register("jeff_task_update", async (args) => {
    if (!args.id) throw new Error("id 必填");
    const cur = tasks.get(args.id);
    if (!cur) throw new Error(`任务不存在: ${args.id}`);
    if (args.assignee_agent_id !== void 0 && args.assignee_agent_id !== "" && !agents.get(args.assignee_agent_id)) {
      throw new Error(`指派的智能体不存在: ${args.assignee_agent_id}`);
    }
    const row = tasks.update(args.id, {
      ...args.title !== void 0 ? { title: args.title } : {},
      ...args.description !== void 0 ? { description: args.description } : {},
      ...args.status !== void 0 ? { status: args.status } : {},
      ...args.priority !== void 0 ? { priority: args.priority } : {},
      ...args.assignee_agent_id !== void 0 ? { assignee_type: args.assignee_agent_id ? "agent" : "none", assignee_id: args.assignee_agent_id } : {}
    });
    deps.onTaskChanged(cur.project_id, args.id);
    return { id: row.id, key: `JEF-${row.number}`, status: row.status };
  });
  reg.register("jeff_task_list", async (args) => {
    if (!args.project_id) throw new Error("project_id 必填");
    let list = tasks.listByProject(args.project_id);
    if (args.status) list = list.filter((t2) => t2.status === args.status);
    return list.map((t2) => ({
      id: t2.id,
      key: `JEF-${t2.number}`,
      title: t2.title,
      status: t2.status,
      priority: t2.priority,
      assignee_agent_id: t2.assignee_id || null,
      assignee_name: t2.assignee_id ? agents.get(t2.assignee_id)?.name || null : null
    }));
  });
  reg.register("jeff_task_delete", async (args) => {
    if (!args.id) throw new Error("id 必填");
    const cur = tasks.get(args.id);
    if (!cur) throw new Error(`任务不存在: ${args.id}`);
    tasks.softDelete(args.id);
    deps.onTaskChanged(cur.project_id, args.id);
    return { deleted: true };
  });
}
function taskCardMessage(db, projectId, taskId) {
  const t2 = taskRepo(db).get(taskId);
  if (!t2) return { content: "", meta: {} };
  const assignee = t2.assignee_id ? agentRepo(db).get(t2.assignee_id)?.name : void 0;
  const meta = { type: "task", taskId: t2.id, projectId };
  const who = assignee ? ` → ${assignee}` : "";
  return { content: `📋 任务 ${`JEF-${t2.number}`}：${t2.title}（${statusLabel(t2.status)}${who}）`, meta };
}
function statusLabel(status) {
  const map = { todo: "待办", in_progress: "进行中", in_review: "待审", done: "完成", cancelled: "已取消" };
  return map[status] || status;
}
const MEMORY_TOOL = "jeff_memory";
const SEARCH_TOOL = "jeff_session_search";
const DELEGATE_TOOL = "jeff_delegate";
function registerMemoryTools(reg, deps) {
  const agents = agentRepo(deps.db);
  reg.register(MEMORY_TOOL, async (raw) => {
    const { __ctx, action, text, old_text, new_text, operations, scope } = raw;
    const ctx = __ctx || {};
    const resolved = ctx.sessionID ? deps.resolveSession(ctx.sessionID) : null;
    const agentId = resolved?.agentId || (ctx.agent ? agents.list().find((a) => a.name === ctx.agent)?.id : void 0);
    if (!agentId) return { ok: false, error: "无法识别调用者身份（无会话上下文）" };
    const target = resolveMemoryScope(deps.db, { agentId, resolved, explicit: scope, builtin: !!agents.get(agentId)?.builtin });
    if ("error" in target) return { ok: false, error: target.error };
    const memScope = target.scope;
    try {
      if (action === "list") {
        const entries = deps.store.list(memScope);
        return { ok: true, entries, totalChars: entries.join("\n").length, budget: deps.store.budget(memScope), scope: deps.store.label(memScope) };
      }
      if (action === "batch" && Array.isArray(operations)) {
        const r2 = deps.store.batch(memScope, operations);
        return r2;
      }
      if (action === "add") return deps.store.add(memScope, String(text || ""));
      if (action === "replace") return deps.store.replace(memScope, String(old_text || ""), String(new_text ?? ""));
      if (action === "remove") return deps.store.remove(memScope, String(old_text || ""));
      return { ok: false, error: "action 必须是 list/add/replace/remove/batch" };
    } finally {
    }
  });
  reg.register(SEARCH_TOOL, async (raw) => {
    const { __ctx, query, limit, scope } = raw;
    if (!query?.trim()) return { ok: false, error: "query 必填" };
    const ctx = __ctx || {};
    const resolved = ctx.sessionID ? deps.resolveSession(ctx.sessionID) : null;
    let scopeFilter;
    if (scope && scope !== "all") scopeFilter = scope;
    else if (!scope && resolved) {
      scopeFilter = resolved.kind === "group" ? `group:${resolved.projectId}` : `private:${resolved.agentId}`;
    }
    const hits = deps.indexer.search(query, { limit, scope: scopeFilter });
    return {
      ok: true,
      count: hits.length,
      hits: hits.map((h2) => ({ scope: h2.scope, sender: h2.sender, snippet: h2.snippet, sessionId: h2.sessionId, time: new Date(h2.ts).toISOString() }))
    };
  });
}
function resolveMemoryScope(db, input) {
  if (input.explicit) {
    if (input.explicit === "self") return { scope: { kind: "agent", agentId: input.agentId } };
    if (input.explicit === "user") {
      if (!input.builtin) return { error: "用户画像记忆（user）只能由管家小杰维护" };
      return { scope: { kind: "user" } };
    }
    if (input.explicit.startsWith("project:")) {
      const projectId = input.explicit.slice(8);
      if (!input.builtin) {
        const inProject = projectAgentRepo(db).getRole(projectId, input.agentId);
        if (!inProject) return { error: `你不属于项目 ${projectId}，不能写它的共享记忆` };
      }
      return { scope: { kind: "project", projectId } };
    }
    return { error: `未知 scope: ${input.explicit}` };
  }
  if (input.resolved?.kind === "group") return { scope: { kind: "project", projectId: input.resolved.projectId } };
  return { scope: { kind: "agent", agentId: input.agentId } };
}
const sesMetaKey = (sessionId) => `sesmeta:${sessionId}`;
function allToolDefs() {
  return [
    {
      name: ADMIN_TOOL_NAMES[0],
      // jeff_agent_create
      description: "创建一个新的智能体（Jeff 里的聊天好友）。创建前先和用户确认名字与用途；模型可留空表示跟随全局默认。返回新智能体 id。",
      args: {
        name: { type: "string", description: "显示名，如「架构师阿伟」" },
        avatar: { type: "string", description: "头像 emoji，默认 🤖" },
        description: { type: "string", description: "一句话简介（仅展示）" },
        instructions: { type: "string", description: "身份指令/系统提示（它擅长什么、怎么干活的规矩）" },
        model_provider: { type: "string", description: "默认模型 provider id，可留空" },
        model_id: { type: "string", description: "默认模型 id，可留空" }
      }
    },
    {
      name: ADMIN_TOOL_NAMES[1],
      // jeff_agent_update
      description: "修改智能体信息（名字/头像/简介/指令/默认模型/归档）。内置管家小杰不可修改。",
      args: {
        id: { type: "string", description: "智能体 id" },
        name: { type: "string", description: "新名字（可选）" },
        avatar: { type: "string", description: "新头像 emoji（可选）" },
        description: { type: "string", description: "新简介（可选）" },
        instructions: { type: "string", description: "新指令（可选）" },
        model_provider: { type: "string", description: "模型 provider（可选）" },
        model_id: { type: "string", description: "模型 id（可选）" },
        archived: { type: "boolean", description: "归档/取消归档（可选）" }
      }
    },
    {
      name: ADMIN_TOOL_NAMES[2],
      // jeff_agent_delete
      description: "删除智能体（软删除）。内置管家小杰不可删除。删除前必须先跟用户确认。",
      args: { id: { type: "string", description: "智能体 id" } }
    },
    {
      name: ADMIN_TOOL_NAMES[3],
      // jeff_agent_list
      description: "列出所有智能体（含内置管家小杰）。",
      args: {}
    },
    {
      name: ADMIN_TOOL_NAMES[4],
      // jeff_agent_get
      description: "查询单个智能体详情。",
      args: { id: { type: "string", description: "智能体 id" } }
    },
    // M2 追加：project/task 工具
    {
      name: "jeff_project_create",
      description: "创建项目群（= 微信群）：需要群名、群主 leader（某个智能体 id，统筹一切）和成员智能体列表。返回项目 id。",
      args: {
        title: { type: "string", description: "群名" },
        icon: { type: "string", description: "群图标 emoji" },
        description: { type: "string", description: "群简介" },
        leader_agent_id: { type: "string", description: "群主智能体 id（必须已存在）" },
        members: {
          type: "array",
          description: "成员列表（不含群主也要包含的话请一并给出），每项 {agentId, role}",
          items: { type: "object" }
        }
      }
    },
    {
      name: "jeff_project_update",
      description: "修改项目群（名称/简介/图标/状态/群主）。",
      args: {
        id: { type: "string", description: "项目 id" },
        title: { type: "string", description: "新群名（可选）" },
        description: { type: "string", description: "新简介（可选）" },
        icon: { type: "string", description: "新图标（可选）" },
        status: { type: "string", description: "状态", enum: [...PROJECT_STATUSES] },
        leader_agent_id: { type: "string", description: "新群主 id（可选）" }
      }
    },
    {
      name: "jeff_project_list",
      description: "列出所有项目群（含成员与群主）。",
      args: {}
    },
    {
      name: "jeff_project_add_member",
      description: "向项目群添加成员智能体（可指定群内角色：开发/ui/测试/产品/leader 等）。",
      args: {
        project_id: { type: "string", description: "项目 id" },
        agent_id: { type: "string", description: "智能体 id" },
        role: { type: "string", description: "群内角色" }
      }
    },
    {
      name: "jeff_project_remove_member",
      description: "把成员智能体移出项目群。",
      args: { project_id: { type: "string", description: "项目 id" }, agent_id: { type: "string", description: "智能体 id" } }
    },
    {
      name: "jeff_task_create",
      description: "在项目里创建任务（编号自动生成 JEF-n）。可指定指派对象（智能体）、优先级。",
      args: {
        project_id: { type: "string", description: "项目 id" },
        title: { type: "string", description: "标题" },
        description: { type: "string", description: "描述/验收标准" },
        priority: { type: "string", description: "优先级", enum: [...TASK_PRIORITIES] },
        assignee_agent_id: { type: "string", description: "指派的智能体 id（可选）" },
        parent_task_id: { type: "string", description: "父任务 id（可选，子任务拆分）" }
      }
    },
    {
      name: "jeff_task_update",
      description: "修改任务（标题/描述/状态/优先级/指派/排序）。",
      args: {
        id: { type: "string", description: "任务 id" },
        title: { type: "string", description: "新标题（可选）" },
        description: { type: "string", description: "新描述（可选）" },
        status: { type: "string", description: "新状态", enum: [...TASK_STATUSES] },
        priority: { type: "string", description: "新优先级", enum: [...TASK_PRIORITIES] },
        assignee_agent_id: { type: "string", description: "改指派（传空串清除）" }
      }
    },
    {
      name: "jeff_task_list",
      description: "列出项目里的任务（可按状态过滤）。",
      args: {
        project_id: { type: "string", description: "项目 id" },
        status: { type: "string", description: "状态过滤（可选）", enum: [...TASK_STATUSES] }
      }
    },
    {
      name: "jeff_task_delete",
      description: "删除任务（软删除）。",
      args: { id: { type: "string", description: "任务 id" } }
    },
    // M3 追加：memory / session_search / delegate
    {
      name: "jeff_memory",
      description: "读写你自己的长期记忆（会在每次对话时注入你的 system prompt，请保持精炼）。action: list 查看 / add 新增（与现有条目重复则不重复添加）/ replace 用 new_text 替换 old_text 唯一匹配的条目 / remove 删除 old_text 唯一匹配的条目 / batch 原子执行一组操作（用于腾空间时合并整理）。适合记：用户偏好、环境事实、被纠正的错误、长期惯例；不要记：可随时重查的信息、当前会话临时内容。",
      args: {
        action: { type: "string", description: "操作", enum: ["list", "add", "replace", "remove", "batch"] },
        text: { type: "string", description: "add 的新条目内容" },
        old_text: { type: "string", description: "replace/remove 的唯一子串匹配" },
        new_text: { type: "string", description: "replace 的替换内容" },
        operations: {
          type: "array",
          description: "batch 的操作数组，每项 {action, text?, old_text?, new_text?}",
          items: { type: "object" }
        }
      }
    },
    {
      name: "jeff_session_search",
      description: "全文搜索所有历史会话（你自己的、项目群里的）。返回命中的会话与消息片段。用于回忆「之前说过什么/怎么定的」。",
      args: {
        query: { type: "string", description: "关键词（支持中文）" },
        limit: { type: "number", description: "返回条数，默认 8" },
        scope: { type: "string", description: "限定范围（可选）：private:<agentId> 或 group:<projectId>" }
      }
    },
    {
      name: "jeff_delegate",
      description: "（仅群主 leader）把一项具体工作委派给群成员智能体执行：它会带着群上下文在独立会话里干完并把结果回帖到群里。委派后你会被唤醒看到结果，再决定是否汇总或继续委派。instruction 要具体：做什么、产出什么、何时算完成。",
      args: {
        member_agent_id: { type: "string", description: "成员智能体 id" },
        instruction: { type: "string", description: "具体任务指令" }
      }
    }
  ];
}
const SESSION_KEY$1 = (agentId) => `session:private:${agentId}`;
class PrivateChat {
  constructor(db, getOc, hooks) {
    this.db = db;
    this.getOc = getOc;
    this.hooks = hooks;
  }
  db;
  getOc;
  hooks;
  /** 取该 agent 的活跃会话（不存在则创建并记录） */
  async ensureSession(agentId, agentName) {
    await this.hooks?.beforeEnsure?.();
    const kv = kvRepo(this.db);
    const existing = kv.get(SESSION_KEY$1(agentId));
    if (existing) {
      try {
        await this.getOc().getSession(existing);
        return existing;
      } catch {
        kv.delete(SESSION_KEY$1(agentId));
      }
    }
    const s = await this.getOc().createSession({ title: `与 ${agentName} 的聊天`, agent: agentSlug(agentId) });
    kv.set(SESSION_KEY$1(agentId), s.id);
    this.hooks?.onSessionCreated?.(s.id, { kind: "private", agentId });
    return s.id;
  }
  /** 开启全新会话（旧会话保留在 opencode 历史中） */
  async newSession(agentId, agentName) {
    await this.hooks?.beforeEnsure?.();
    kvRepo(this.db).delete(SESSION_KEY$1(agentId));
    return this.ensureSession(agentId, agentName);
  }
  getSessionId(agentId) {
    return kvRepo(this.db).get(SESSION_KEY$1(agentId));
  }
  /** 发送消息并等待回复完成 */
  async send(agentId, agentName, text, model) {
    const sessionId = await this.ensureSession(agentId, agentName);
    const reply = await this.getOc().sendMessage({
      sessionId,
      text,
      agent: agentSlug(agentId),
      system: this.hooks?.buildSystem?.(agentId),
      ...model && model.providerID && model.modelID ? { model } : {}
    });
    this.hooks?.afterReply?.({ kind: "private", agentId });
    return reply;
  }
  /** 读取历史消息（映射为 UI 形状） */
  async history(agentId) {
    const sessionId = this.getSessionId(agentId);
    if (!sessionId) return [];
    return this.mapSessionMessages(sessionId);
  }
  async mapSessionMessages(sessionId) {
    const msgs = await this.getOc().getMessages(sessionId);
    const out = [];
    for (const m2 of msgs) {
      const info = m2.info;
      const role = info.role === "user" ? "user" : info.role === "assistant" ? "assistant" : "system";
      const parts = m2.parts || info.parts || [];
      let text = "";
      const tools = [];
      for (const p of parts) {
        if (p.type === "text" && !p.synthetic && typeof p.text === "string" && p.text.trim()) {
          text += (text ? "\n" : "") + p.text;
        } else if (p.type === "tool") {
          const st = p.state || {};
          tools.push({ tool: String(p.tool || ""), status: st.status, output: (st.output || "").slice(0, 2e3), error: st.error });
        }
      }
      if (role === "assistant" && !text.trim() && tools.length === 0) continue;
      out.push({
        id: info.id,
        role,
        agentId: info.agent,
        text,
        time: info.time?.created || 0,
        ...tools.length ? { tools } : {}
      });
    }
    return out;
  }
}
const SESSION_KEY = (projectId, agentId) => `session:group:${projectId}:${agentId}`;
class GroupChat {
  constructor(db, getOc, hooks) {
    this.db = db;
    this.getOc = getOc;
    this.hooks = hooks;
  }
  db;
  getOc;
  hooks;
  /** 项目 scope（chat_message 的 scope 值） */
  static scope(projectId) {
    return `group:${projectId}`;
  }
  async ensureSession(projectId, agentId) {
    await this.hooks?.beforeEnsure?.();
    const kv = kvRepo(this.db);
    const key = SESSION_KEY(projectId, agentId);
    const existing = kv.get(key);
    if (existing) {
      try {
        await this.getOc().getSession(existing);
        return existing;
      } catch {
        kv.delete(key);
      }
    }
    const project = projectRepo(this.db).get(projectId);
    const agent = agentRepo(this.db).get(agentId);
    const s = await this.getOc().createSession({
      title: `群「${project?.title || projectId}」· ${agent?.name || agentId}`,
      agent: agentSlug(agentId)
    });
    kv.set(key, s.id);
    this.hooks?.onSessionCreated?.(s.id, { kind: "group", agentId, projectId });
    return s.id;
  }
  getSessionId(projectId, agentId) {
    return kvRepo(this.db).get(SESSION_KEY(projectId, agentId));
  }
  /** 解析 @提及：返回命中的成员 agentId（按名字精确匹配优先、包含匹配兜底） */
  parseMention(text, members) {
    const hits = members.filter((m2) => text.includes(`@${m2.name}`));
    if (hits.length === 0) return null;
    hits.sort((a, b) => b.name.length - a.name.length);
    return hits[0].agent_id;
  }
  /** roster briefing（注入到每条群消息的 system；按接收者 agent 区分 leader/成员视角） */
  buildBriefing(projectId, agentId) {
    const project = projectRepo(this.db).get(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const agents = agentRepo(this.db);
    const members = projectAgentRepo(this.db).listByProject(projectId);
    const roster = members.map((m2) => {
      const a = agents.get(m2.agent_id);
      return `- ${a?.name || m2.agent_id}（角色: ${m2.role}${m2.agent_id === project.leader_agent_id ? "，群主/leader" : ""}）id=${m2.agent_id}`;
    }).join("\n");
    const isLeaderBriefing = project.leader_agent_id === agentId;
    const leaderLine = isLeaderBriefing ? "你是本群群主（leader），用户的消息默认由你统筹：能自己答就答；需要别人干活的，说明你打算怎么做（M3 将支持直接委派工具）。" : "你是本群成员，就你职责范围内的问题作答。";
    return [
      `【项目群上下文】群名：${project.title}`,
      project.description ? `群简介：${project.description}` : "",
      `成员名册：`,
      roster,
      leaderLine,
      `用户消息里 @某成员名 表示直接指名对话；回复请用简体中文，简洁、可执行。`
    ].filter(Boolean).join("\n");
  }
  /** 用户在群里发消息：存储 + 路由（@直达 或 leader）+ 回帖 */
  async send(input) {
    const { projectId, text } = input;
    const project = projectRepo(this.db).get(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    if (!project.leader_agent_id) throw new Error("项目未设置群主（leader）");
    const members = projectAgentRepo(this.db).listByProject(projectId);
    const agents = agentRepo(this.db);
    const scope = GroupChat.scope(projectId);
    chatMessageRepo(this.db).add({ scope, sender_type: "user", content: text });
    const memberInfos = members.map((m2) => ({ agent_id: m2.agent_id, name: agents.get(m2.agent_id)?.name || "" }));
    const mentioned = this.parseMention(text, memberInfos);
    const targetId = mentioned ?? project.leader_agent_id;
    const target = agents.get(targetId);
    if (!target) throw new Error(`路由目标不存在: ${targetId}`);
    const sessionId = await this.ensureSession(projectId, targetId);
    let reply;
    const memoryBlock = this.hooks?.buildMemory?.(targetId, projectId);
    const system = memoryBlock ? `${this.buildBriefing(projectId, targetId)}

${memoryBlock}` : this.buildBriefing(projectId, targetId);
    try {
      reply = await this.getOc().sendMessage({
        sessionId,
        text,
        agent: agentSlug(targetId),
        system,
        ...input.model && input.model.providerID && input.model.modelID ? { model: input.model } : {}
      });
    } catch (err) {
      chatMessageRepo(this.db).add({
        scope,
        sender_type: "system",
        content: `⚠️ ${target.name} 处理消息失败：${String(err?.message || err).slice(0, 200)}`
      });
      throw err;
    }
    const textParts = (reply.parts || []).filter((p) => p.type === "text");
    const toolParts = (reply.parts || []).filter((p) => p.type === "tool");
    let content = textParts.map((p) => p.text).join("\n");
    if (toolParts.length > 0) {
      const toolLine = toolParts.map((t2) => `🔧 ${t2.tool}`).join("、");
      content = `${toolLine}
${content}`;
    }
    chatMessageRepo(this.db).add({
      scope,
      sender_type: "agent",
      sender_id: targetId,
      content,
      meta: { sessionId, messageId: reply.id }
    });
    this.hooks?.afterReply?.({ kind: "group", projectId, agentId: targetId });
    return { routedTo: targetId };
  }
  /** 读取群消息（映射 UI 形状，含发送者信息） */
  history(projectId) {
    const agents = agentRepo(this.db);
    const scope = GroupChat.scope(projectId);
    const rows = chatMessageRepo(this.db).listByScope(scope);
    return rows.map((r2) => {
      const a = r2.sender_id ? agents.get(r2.sender_id) : void 0;
      return {
        id: r2.id,
        role: r2.sender_type === "user" ? "user" : r2.sender_type === "agent" ? "assistant" : "system",
        agentId: r2.sender_id || void 0,
        text: r2.content,
        time: r2.created_at,
        meta: safeJson(r2.meta),
        sender_name: r2.sender_type === "user" ? "我" : a?.name || "系统",
        sender_avatar: r2.sender_type === "user" ? "🧑" : a?.avatar || "⚙️"
      };
    });
  }
  /** 追加系统消息（任务卡片等） */
  addSystemMessage(projectId, content, meta) {
    chatMessageRepo(this.db).add({
      scope: GroupChat.scope(projectId),
      sender_type: "system",
      content,
      meta
    });
  }
}
function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
const DELEGATE_TIMEOUT_MS = 10 * 60 * 1e3;
const MAX_DELEGATIONS_PER_MESSAGE = 5;
class Delegator {
  constructor(db, getOc, groupChat, notify) {
    this.db = db;
    this.getOc = getOc;
    this.groupChat = groupChat;
    this.notify = notify;
  }
  db;
  getOc;
  groupChat;
  notify;
  inflight = /* @__PURE__ */ new Set();
  perMessageCount = /* @__PURE__ */ new Map();
  /** 会话上下文 → 是否可委派（群主 + 群会话） */
  resolveDelegateScope(sessionId, agentId) {
    const project = projectRepo(this.db).list();
    for (const p of project) {
      if (this.groupChat.getSessionId(p.id, agentId) === sessionId) {
        if (p.leader_agent_id === agentId) return { projectId: p.id, leaderAgentId: agentId };
        return null;
      }
    }
    return null;
  }
  async delegate(ctx, memberId, instruction, sourceMessageId) {
    const project = projectRepo(this.db).get(ctx.projectId);
    if (!project) return { ok: false, memberName: "", error: `项目不存在: ${ctx.projectId}` };
    if (project.leader_agent_id !== ctx.leaderAgentId) return { ok: false, memberName: "", error: "只有群主（leader）可以委派" };
    const agents = agentRepo(this.db);
    const member = agents.get(memberId);
    if (!member) return { ok: false, memberName: "", error: `成员智能体不存在: ${memberId}` };
    if (memberId === ctx.leaderAgentId) return { ok: false, memberName: member.name, error: "不能委派给自己" };
    if (!projectAgentRepo(this.db).getRole(ctx.projectId, memberId)) {
      return { ok: false, memberName: member.name, error: `${member.name} 不在本群里，先用 jeff_project_add_member 邀入` };
    }
    if (!instruction.trim()) return { ok: false, memberName: member.name, error: "instruction 不能为空" };
    const mid = sourceMessageId || "unknown";
    const count = (this.perMessageCount.get(mid) || 0) + 1;
    if (count > MAX_DELEGATIONS_PER_MESSAGE) {
      return { ok: false, memberName: member.name, error: `同一条消息的委派已达上限（${MAX_DELEGATIONS_PER_MESSAGE} 次），请先汇总当前进展` };
    }
    this.perMessageCount.set(mid, count);
    const sig = `${ctx.projectId}:${memberId}:${crypto.createHash("sha1").update(instruction.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12)}`;
    if (this.inflight.has(sig)) {
      return { ok: false, memberName: member.name, error: `已有一个相同的委派给 ${member.name} 正在进行，请等待其完成，不要重复发起` };
    }
    this.inflight.add(sig);
    const scope = GroupChatScope(ctx.projectId);
    const leaderName = agents.get(ctx.leaderAgentId)?.name || "群主";
    try {
      chatMessageRepo(this.db).add({
        scope,
        sender_type: "system",
        content: `🔗 ${leaderName} 委派任务给 ${member.name}：${instruction.slice(0, 120)}${instruction.length > 120 ? "…" : ""}`,
        meta: { type: "delegation", projectId: ctx.projectId, leaderId: ctx.leaderAgentId, memberId }
      });
      this.notify(ctx.projectId);
      const sessionId = await this.groupChat.ensureSession(ctx.projectId, memberId);
      const instructionText = `【群主 ${leaderName} 指派】${instruction}`;
      const reply = await this.getOc().sendMessage({
        sessionId,
        text: instructionText,
        agent: agentSlug(memberId),
        system: this.memberBriefing(ctx.projectId, memberId, leaderName),
        timeoutMs: DELEGATE_TIMEOUT_MS
      });
      const parts = (reply.parts || []).filter((p) => p.type === "text");
      const resultText = parts.map((p) => p.text).join("\n") || "（成员没有返回文本内容）";
      chatMessageRepo(this.db).add({
        scope,
        sender_type: "agent",
        sender_id: memberId,
        content: resultText,
        meta: { sessionId, messageId: reply.id, delegatedBy: ctx.leaderAgentId }
      });
      this.notify(ctx.projectId);
      return { ok: true, memberName: member.name, result: resultText };
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 300);
      chatMessageRepo(this.db).add({
        scope,
        sender_type: "system",
        content: `⚠️ ${member.name} 执行委派任务失败：${msg}`
      });
      this.notify(ctx.projectId);
      return { ok: false, memberName: member.name, error: msg };
    } finally {
      this.inflight.delete(sig);
    }
  }
  /** 成员执行委派时的上下文（比 leader 的 briefing 多一层指派说明） */
  memberBriefing(projectId, memberId, leaderName) {
    const base = this.groupChat.buildBriefing(projectId, memberId);
    return `${base}

【本次为群主指派任务】${leaderName} 通过委派工具把指令交给你。把它当作你的工作任务：能做就做完并给出结果与结论；做不到就明确说明原因和阻塞点。`;
  }
}
function GroupChatScope(projectId) {
  return `group:${projectId}`;
}
const ENTRY_DELIMITER = "\n§\n";
const MEMORY_BUDGETS = {
  user: 1375,
  agent: 2200,
  project: 2200
};
function scopeKey(scope) {
  if (scope.kind === "user") return "user";
  if (scope.kind === "agent") return `agent:${scope.agentId}`;
  return `project:${scope.projectId}`;
}
class MemoryStore {
  constructor(paths) {
    this.paths = paths;
  }
  paths;
  file(scope) {
    const k = scopeKey(scope);
    if (k === "user") return path$1.join(this.paths.memoryDir, "USER.md");
    if (k.startsWith("agent:")) return path$1.join(this.paths.memoryDir, "agents", k.slice(6), "MEMORY.md");
    return path$1.join(this.paths.memoryDir, "projects", k.slice(8), "MEMORY.md");
  }
  label(scope) {
    if (scope.kind === "user") return "全局用户画像";
    if (scope.kind === "agent") return `agent ${scope.agentId} 记忆`;
    return `项目 ${scope.projectId} 共享记忆`;
  }
  budget(scope) {
    return MEMORY_BUDGETS[scope.kind];
  }
  /** 读取条目（文件不存在 → 空） */
  list(scope) {
    return parseEntries(this.readRaw(scope));
  }
  readRaw(scope) {
    try {
      return fs.readFileSync(this.file(scope), "utf8");
    } catch {
      return "";
    }
  }
  /** 注入 system prompt 的记忆块（空记忆返回 null） */
  renderBlock(scope) {
    const entries = this.list(scope);
    if (entries.length === 0) return null;
    const total = entries.join("\n").length;
    const pct = Math.min(100, Math.round(total / this.budget(scope) * 100));
    return [`### ${this.label(scope)}（${entries.length} 条 · 预算 ${pct}%）`, ...entries.map((e2) => `- ${e2}`)].join("\n");
  }
  add(scope, text) {
    return this.batch(scope, [{ action: "add", text }]);
  }
  replace(scope, oldText, newText) {
    return this.batch(scope, [{ action: "replace", old_text: oldText, new_text: newText }]);
  }
  remove(scope, oldText) {
    return this.batch(scope, [{ action: "remove", old_text: oldText }]);
  }
  /** 原子执行一组操作（预算只对最终状态检查） */
  batch(scope, ops) {
    const budget = this.budget(scope);
    if (ops.length === 0) return { ok: false, error: "operations 为空", entries: this.list(scope), budget };
    for (const op of ops) {
      if (op.action === "add" && !op.text?.trim()) return { ok: false, error: "add 需要非空 text" };
      if (op.action === "replace" && !op.old_text?.trim()) return { ok: false, error: "replace 需要 old_text" };
      if (op.action === "remove" && !op.old_text?.trim()) return { ok: false, error: "remove 需要 old_text" };
      if (op.action === "replace" && op.new_text == null) return { ok: false, error: "replace 需要 new_text（可为空串）" };
    }
    const release = this.lock(scope);
    try {
      let entries = parseEntries(this.readRaw(scope));
      for (const op of ops) {
        if (op.action === "add") {
          const text = normalize$1(op.text);
          if (entries.some((e2) => e2 === text)) continue;
          entries.push(text);
        } else {
          const idx = matchUnique(entries, op.old_text);
          if (idx < 0) {
            return { ok: false, error: `old_text 未匹配到唯一条目（0 或多个）:「${op.old_text.slice(0, 60)}」`, entries, budget };
          }
          if (op.action === "remove") {
            entries.splice(idx, 1);
          } else {
            entries[idx] = normalize$1(op.new_text ?? "");
          }
        }
        entries = dedupePreserveOrder(entries);
      }
      const total = entries.join(ENTRY_DELIMITER).length;
      if (total > budget) {
        return {
          ok: false,
          error: `记忆超预算：${total}/${budget} 字符。请用 batch 原子操作先整合（合并或删除旧条目）再重试。当前条目如下：
` + entries.map((e2, i2) => `${i2 + 1}. ${e2}`).join("\n"),
          entries,
          totalChars: total,
          budget
        };
      }
      this.writeEntries(scope, entries);
      return { ok: true, entries, totalChars: total, budget };
    } finally {
      release();
    }
  }
  /** 覆写整个文件（UI 编辑用） */
  writeRaw(scope, content) {
    const release = this.lock(scope);
    try {
      this.writeEntries(scope, parseEntries(content));
    } finally {
      release();
    }
  }
  writeEntries(scope, entries) {
    const file = this.file(scope);
    fs.mkdirSync(path$1.dirname(file), { recursive: true });
    const content = entries.length === 0 ? "" : entries.join(ENTRY_DELIMITER) + "\n";
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
  }
  /** 简单目录锁：mkdir 原子性 + 过期自动清理 */
  lock(scope) {
    const dir = path$1.join(this.paths.memoryDir, ".locks");
    fs.mkdirSync(dir, { recursive: true });
    const lockDir = path$1.join(dir, `${sha(scopeKey(scope)).slice(0, 16)}.lock`);
    const deadline = Date.now() + 5e3;
    for (; ; ) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch {
        if (Date.now() > deadline) {
          try {
            fs.rmSync(lockDir, { recursive: true, force: true });
          } catch {
          }
          continue;
        }
      }
    }
    return () => {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
      }
    };
  }
}
function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function parseEntries(raw) {
  if (!raw.trim()) return [];
  return raw.split(ENTRY_DELIMITER).map((e2) => e2.trim()).filter(Boolean);
}
function normalize$1(text) {
  return text.trim().replace(/\s+\n/g, "\n");
}
function dedupePreserveOrder(entries) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const e2 of entries) {
    if (seen.has(e2)) continue;
    seen.add(e2);
    out.push(e2);
  }
  return out;
}
function matchUnique(entries, needle) {
  let hit = -1;
  let count = 0;
  for (let i2 = 0; i2 < entries.length; i2++) {
    if (entries[i2].includes(needle)) {
      count += 1;
      hit = i2;
      if (count > 1) return -1;
    }
  }
  return count === 1 ? hit : -1;
}
class SessionIndex {
  constructor(db) {
    this.db = db;
    this.ensureSchema();
  }
  db;
  ensureSchema() {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS msg_fts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts_idx USING fts5(body, content='msg_fts', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS msg_fts_ai AFTER INSERT ON msg_fts BEGIN
  INSERT INTO msg_fts_idx(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_ad AFTER DELETE ON msg_fts BEGIN
  INSERT INTO msg_fts_idx(msg_fts_idx, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_au AFTER UPDATE ON msg_fts BEGIN
  INSERT INTO msg_fts_idx(msg_fts_idx, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO msg_fts_idx(rowid, body) VALUES (new.rowid, new.body);
END;
`);
  }
  has(id) {
    const row = this.db.prepare("SELECT id FROM msg_fts WHERE id = ?").get(id);
    return !!row;
  }
  index(doc) {
    if (!doc.text?.trim()) return;
    this.db.prepare(
      `INSERT INTO msg_fts (id, scope, session_id, sender, ts, body) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET scope=excluded.scope, session_id=excluded.session_id, sender=excluded.sender, ts=excluded.ts, body=excluded.body`
    ).run(doc.id, doc.scope, doc.sessionId || "", doc.sender, doc.ts || now(), cjkSplit(doc.text));
  }
  search(query, opts = {}) {
    const q = buildMatchQuery(query);
    if (!q) return [];
    const limit = Math.min(opts.limit ?? 8, 30);
    const scopeFilter = opts.scope ? "AND scope = ?" : "";
    const params = opts.scope ? [q, opts.scope, limit] : [q, limit];
    const rows = this.db.prepare(
      `SELECT f.id AS id, f.scope AS scope, f.session_id AS session_id, f.sender AS sender, f.ts AS ts,
                snippet(msg_fts_idx, 0, '「', '」', '…', 12) AS snippet, bm25(msg_fts_idx) AS rank
         FROM msg_fts_idx
         JOIN msg_fts f ON f.rowid = msg_fts_idx.rowid
         WHERE msg_fts_idx MATCH ? ${scopeFilter}
         ORDER BY rank LIMIT ?`
    ).all(...params);
    return rows.map((r2) => ({
      id: String(r2["id"]),
      scope: String(r2["scope"]),
      sessionId: String(r2["session_id"]),
      sender: String(r2["sender"]),
      ts: Number(r2["ts"]),
      snippet: String(r2["snippet"]),
      rank: Number(r2["rank"])
    }));
  }
}
function cjkSplit(text) {
  return text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]+/g, (m2) => m2.split("").join(" "));
}
function buildMatchQuery(query) {
  const parts = [];
  for (const raw of query.split(/\s+/)) {
    if (!raw) continue;
    const cleaned = raw.replace(/["'()*:^]/g, " ");
    if (!cleaned.trim()) continue;
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(cleaned)) {
      const chars = cleaned.replace(/[^\u4e00-\u9fff\u3400-\u4dbf a-zA-Z0-9]/g, "").trim();
      if (!chars) continue;
      parts.push(`"${cjkSplit(chars)}"`);
    } else {
      parts.push(`"${cleaned.replace(/ /g, "")}"*`);
    }
  }
  return parts.join(" OR ");
}
var commonjsGlobal = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : {};
function getDefaultExportFromCjs(x2) {
  return x2 && x2.__esModule && Object.prototype.hasOwnProperty.call(x2, "default") ? x2["default"] : x2;
}
var requiresPort;
var hasRequiredRequiresPort;
function requireRequiresPort() {
  if (hasRequiredRequiresPort) return requiresPort;
  hasRequiredRequiresPort = 1;
  requiresPort = function required(port, protocol) {
    protocol = protocol.split(":")[0];
    port = +port;
    if (!port) return false;
    switch (protocol) {
      case "http":
      case "ws":
        return port !== 80;
      case "https":
      case "wss":
        return port !== 443;
      case "ftp":
        return port !== 21;
      case "gopher":
        return port !== 70;
      case "file":
        return false;
    }
    return port !== 0;
  };
  return requiresPort;
}
var querystringify = {};
var hasRequiredQuerystringify;
function requireQuerystringify() {
  if (hasRequiredQuerystringify) return querystringify;
  hasRequiredQuerystringify = 1;
  var has = Object.prototype.hasOwnProperty, undef;
  function decode(input) {
    try {
      return decodeURIComponent(input.replace(/\+/g, " "));
    } catch (e2) {
      return null;
    }
  }
  function encode(input) {
    try {
      return encodeURIComponent(input);
    } catch (e2) {
      return null;
    }
  }
  function querystring(query) {
    var parser = /([^=?#&]+)=?([^&]*)/g, result = {}, part;
    while (part = parser.exec(query)) {
      var key = decode(part[1]), value = decode(part[2]);
      if (key === null || value === null || key in result) continue;
      result[key] = value;
    }
    return result;
  }
  function querystringify$1(obj, prefix) {
    prefix = prefix || "";
    var pairs = [], value, key;
    if ("string" !== typeof prefix) prefix = "?";
    for (key in obj) {
      if (has.call(obj, key)) {
        value = obj[key];
        if (!value && (value === null || value === undef || isNaN(value))) {
          value = "";
        }
        key = encode(key);
        value = encode(value);
        if (key === null || value === null) continue;
        pairs.push(key + "=" + value);
      }
    }
    return pairs.length ? prefix + pairs.join("&") : "";
  }
  querystringify.stringify = querystringify$1;
  querystringify.parse = querystring;
  return querystringify;
}
var urlParse;
var hasRequiredUrlParse;
function requireUrlParse() {
  if (hasRequiredUrlParse) return urlParse;
  hasRequiredUrlParse = 1;
  var required = requireRequiresPort(), qs = requireQuerystringify(), controlOrWhitespace = /^[\x00-\x20\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/, CRHTLF = /[\n\r\t]/g, slashes = /^[A-Za-z][A-Za-z0-9+-.]*:\/\//, port = /:\d+$/, protocolre = /^([a-z][a-z0-9.+-]*:)?(\/\/)?([\\/]+)?([\S\s]*)/i, windowsDriveLetter = /^[a-zA-Z]:/;
  function trimLeft(str) {
    return (str ? str : "").toString().replace(controlOrWhitespace, "");
  }
  var rules = [
    ["#", "hash"],
    // Extract from the back.
    ["?", "query"],
    // Extract from the back.
    function sanitize(address, url) {
      return isSpecial(url.protocol) ? address.replace(/\\/g, "/") : address;
    },
    ["/", "pathname"],
    // Extract from the back.
    ["@", "auth", 1],
    // Extract from the front.
    [NaN, "host", void 0, 1, 1],
    // Set left over value.
    [/:(\d*)$/, "port", void 0, 1],
    // RegExp the back.
    [NaN, "hostname", void 0, 1, 1]
    // Set left over.
  ];
  var ignore = { hash: 1, query: 1 };
  function lolcation(loc) {
    var globalVar;
    if (typeof window !== "undefined") globalVar = window;
    else if (typeof commonjsGlobal !== "undefined") globalVar = commonjsGlobal;
    else if (typeof self !== "undefined") globalVar = self;
    else globalVar = {};
    var location = globalVar.location || {};
    loc = loc || location;
    var finaldestination = {}, type = typeof loc, key;
    if ("blob:" === loc.protocol) {
      finaldestination = new Url(unescape(loc.pathname), {});
    } else if ("string" === type) {
      finaldestination = new Url(loc, {});
      for (key in ignore) delete finaldestination[key];
    } else if ("object" === type) {
      for (key in loc) {
        if (key in ignore) continue;
        finaldestination[key] = loc[key];
      }
      if (finaldestination.slashes === void 0) {
        finaldestination.slashes = slashes.test(loc.href);
      }
    }
    return finaldestination;
  }
  function isSpecial(scheme) {
    return scheme === "file:" || scheme === "ftp:" || scheme === "http:" || scheme === "https:" || scheme === "ws:" || scheme === "wss:";
  }
  function extractProtocol(address, location) {
    address = trimLeft(address);
    address = address.replace(CRHTLF, "");
    location = location || {};
    var match2 = protocolre.exec(address);
    var protocol = match2[1] ? match2[1].toLowerCase() : "";
    var forwardSlashes = !!match2[2];
    var otherSlashes = !!match2[3];
    var slashesCount = 0;
    var rest;
    if (forwardSlashes) {
      if (otherSlashes) {
        rest = match2[2] + match2[3] + match2[4];
        slashesCount = match2[2].length + match2[3].length;
      } else {
        rest = match2[2] + match2[4];
        slashesCount = match2[2].length;
      }
    } else {
      if (otherSlashes) {
        rest = match2[3] + match2[4];
        slashesCount = match2[3].length;
      } else {
        rest = match2[4];
      }
    }
    if (protocol === "file:") {
      if (slashesCount >= 2) {
        rest = rest.slice(2);
      }
    } else if (isSpecial(protocol)) {
      rest = match2[4];
    } else if (protocol) {
      if (forwardSlashes) {
        rest = rest.slice(2);
      }
    } else if (slashesCount >= 2 && isSpecial(location.protocol)) {
      rest = match2[4];
    }
    return {
      protocol,
      slashes: forwardSlashes || isSpecial(protocol),
      slashesCount,
      rest
    };
  }
  function resolve(relative, base) {
    if (relative === "") return base;
    var path2 = (base || "/").split("/").slice(0, -1).concat(relative.split("/")), i2 = path2.length, last = path2[i2 - 1], unshift = false, up = 0;
    while (i2--) {
      if (path2[i2] === ".") {
        path2.splice(i2, 1);
      } else if (path2[i2] === "..") {
        path2.splice(i2, 1);
        up++;
      } else if (up) {
        if (i2 === 0) unshift = true;
        path2.splice(i2, 1);
        up--;
      }
    }
    if (unshift) path2.unshift("");
    if (last === "." || last === "..") path2.push("");
    return path2.join("/");
  }
  function Url(address, location, parser) {
    address = trimLeft(address);
    address = address.replace(CRHTLF, "");
    if (!(this instanceof Url)) {
      return new Url(address, location, parser);
    }
    var relative, extracted, parse, instruction, index, key, instructions = rules.slice(), type = typeof location, url = this, i2 = 0;
    if ("object" !== type && "string" !== type) {
      parser = location;
      location = null;
    }
    if (parser && "function" !== typeof parser) parser = qs.parse;
    location = lolcation(location);
    extracted = extractProtocol(address || "", location);
    relative = !extracted.protocol && !extracted.slashes;
    url.slashes = extracted.slashes || relative && location.slashes;
    url.protocol = extracted.protocol || location.protocol || "";
    address = extracted.rest;
    if (extracted.protocol === "file:" && (extracted.slashesCount !== 2 || windowsDriveLetter.test(address)) || !extracted.slashes && (extracted.protocol || extracted.slashesCount < 2 || !isSpecial(url.protocol))) {
      instructions[3] = [/(.*)/, "pathname"];
    }
    for (; i2 < instructions.length; i2++) {
      instruction = instructions[i2];
      if (typeof instruction === "function") {
        address = instruction(address, url);
        continue;
      }
      parse = instruction[0];
      key = instruction[1];
      if (parse !== parse) {
        url[key] = address;
      } else if ("string" === typeof parse) {
        index = parse === "@" ? address.lastIndexOf(parse) : address.indexOf(parse);
        if (~index) {
          if ("number" === typeof instruction[2]) {
            url[key] = address.slice(0, index);
            address = address.slice(index + instruction[2]);
          } else {
            url[key] = address.slice(index);
            address = address.slice(0, index);
          }
        }
      } else if (index = parse.exec(address)) {
        url[key] = index[1];
        address = address.slice(0, index.index);
      }
      url[key] = url[key] || (relative && instruction[3] ? location[key] || "" : "");
      if (instruction[4]) url[key] = url[key].toLowerCase();
    }
    if (parser) url.query = parser(url.query);
    if (relative && location.slashes && url.pathname.charAt(0) !== "/" && (url.pathname !== "" || location.pathname !== "")) {
      url.pathname = resolve(url.pathname, location.pathname);
    }
    if (url.pathname.charAt(0) !== "/" && isSpecial(url.protocol)) {
      url.pathname = "/" + url.pathname;
    }
    if (!required(url.port, url.protocol)) {
      url.host = url.hostname;
      url.port = "";
    }
    url.username = url.password = "";
    if (url.auth) {
      index = url.auth.indexOf(":");
      if (~index) {
        url.username = url.auth.slice(0, index);
        url.username = encodeURIComponent(decodeURIComponent(url.username));
        url.password = url.auth.slice(index + 1);
        url.password = encodeURIComponent(decodeURIComponent(url.password));
      } else {
        url.username = encodeURIComponent(decodeURIComponent(url.auth));
      }
      url.auth = url.password ? url.username + ":" + url.password : url.username;
    }
    url.origin = url.protocol !== "file:" && isSpecial(url.protocol) && url.host ? url.protocol + "//" + url.host : "null";
    url.href = url.toString();
  }
  function set(part, value, fn) {
    var url = this;
    switch (part) {
      case "query":
        if ("string" === typeof value && value.length) {
          value = (fn || qs.parse)(value);
        }
        url[part] = value;
        break;
      case "port":
        url[part] = value;
        if (!required(value, url.protocol)) {
          url.host = url.hostname;
          url[part] = "";
        } else if (value) {
          url.host = url.hostname + ":" + value;
        }
        break;
      case "hostname":
        url[part] = value;
        if (url.port) value += ":" + url.port;
        url.host = value;
        break;
      case "host":
        url[part] = value;
        if (port.test(value)) {
          value = value.split(":");
          url.port = value.pop();
          url.hostname = value.join(":");
        } else {
          url.hostname = value;
          url.port = "";
        }
        break;
      case "protocol":
        url.protocol = value.toLowerCase();
        url.slashes = !fn;
        break;
      case "pathname":
      case "hash":
        if (value) {
          var char = part === "pathname" ? "/" : "#";
          url[part] = value.charAt(0) !== char ? char + value : value;
        } else {
          url[part] = value;
        }
        break;
      case "username":
      case "password":
        url[part] = encodeURIComponent(value);
        break;
      case "auth":
        var index = value.indexOf(":");
        if (~index) {
          url.username = value.slice(0, index);
          url.username = encodeURIComponent(decodeURIComponent(url.username));
          url.password = value.slice(index + 1);
          url.password = encodeURIComponent(decodeURIComponent(url.password));
        } else {
          url.username = encodeURIComponent(decodeURIComponent(value));
        }
    }
    for (var i2 = 0; i2 < rules.length; i2++) {
      var ins = rules[i2];
      if (ins[4]) url[ins[1]] = url[ins[1]].toLowerCase();
    }
    url.auth = url.password ? url.username + ":" + url.password : url.username;
    url.origin = url.protocol !== "file:" && isSpecial(url.protocol) && url.host ? url.protocol + "//" + url.host : "null";
    url.href = url.toString();
    return url;
  }
  function toString(stringify) {
    if (!stringify || "function" !== typeof stringify) stringify = qs.stringify;
    var query, url = this, host = url.host, protocol = url.protocol;
    if (protocol && protocol.charAt(protocol.length - 1) !== ":") protocol += ":";
    var result = protocol + (url.protocol && url.slashes || isSpecial(url.protocol) ? "//" : "");
    if (url.username) {
      result += url.username;
      if (url.password) result += ":" + url.password;
      result += "@";
    } else if (url.password) {
      result += ":" + url.password;
      result += "@";
    } else if (url.protocol !== "file:" && isSpecial(url.protocol) && !host && url.pathname !== "/") {
      result += "@";
    }
    if (host[host.length - 1] === ":" || port.test(url.hostname) && !url.port) {
      host += ":";
    }
    result += host + url.pathname;
    query = "object" === typeof url.query ? stringify(url.query) : url.query;
    if (query) result += "?" !== query.charAt(0) ? "?" + query : query;
    if (url.hash) result += url.hash;
    return result;
  }
  Url.prototype = { set, toString };
  Url.extractProtocol = extractProtocol;
  Url.location = lolcation;
  Url.trimLeft = trimLeft;
  Url.qs = qs;
  urlParse = Url;
  return urlParse;
}
var urlParseExports = requireUrlParse();
const URL$1 = /* @__PURE__ */ getDefaultExportFromCjs(urlParseExports);
function assertError(err) {
  if (!isError(err)) {
    throw new Error("Parameter was not an error");
  }
}
function isError(err) {
  return !!err && typeof err === "object" && objectToString(err) === "[object Error]" || err instanceof Error;
}
function objectToString(obj) {
  return Object.prototype.toString.call(obj);
}
const NAME$1 = "Layerr";
let __name = NAME$1;
function getGlobalName() {
  return __name;
}
function parseArguments(args) {
  let options, shortMessage = "";
  if (args.length === 0) {
    options = {};
  } else if (isError(args[0])) {
    options = {
      cause: args[0]
    };
    shortMessage = args.slice(1).join(" ") || "";
  } else if (args[0] && typeof args[0] === "object") {
    options = Object.assign({}, args[0]);
    shortMessage = args.slice(1).join(" ") || "";
  } else if (typeof args[0] === "string") {
    options = {};
    shortMessage = shortMessage = args.join(" ") || "";
  } else {
    throw new Error("Invalid arguments passed to Layerr");
  }
  return {
    options,
    shortMessage
  };
}
class Layerr extends Error {
  constructor(errorOptionsOrMessage, messageText) {
    const args = [...arguments];
    const { options, shortMessage } = parseArguments(args);
    let message = shortMessage;
    if (options.cause) {
      message = `${message}: ${options.cause.message}`;
    }
    super(message);
    this.message = message;
    if (options.name && typeof options.name === "string") {
      this.name = options.name;
    } else {
      this.name = getGlobalName();
    }
    if (options.cause) {
      Object.defineProperty(this, "_cause", { value: options.cause });
    }
    Object.defineProperty(this, "_info", { value: {} });
    if (options.info && typeof options.info === "object") {
      Object.assign(this._info, options.info);
    }
    if (Error.captureStackTrace) {
      const ctor = options.constructorOpt || this.constructor;
      Error.captureStackTrace(this, ctor);
    }
  }
  static cause(err) {
    assertError(err);
    if (!err._cause)
      return null;
    return isError(err._cause) ? err._cause : null;
  }
  static fullStack(err) {
    assertError(err);
    const cause = Layerr.cause(err);
    if (cause) {
      return `${err.stack}
caused by: ${Layerr.fullStack(cause)}`;
    }
    return err.stack ?? "";
  }
  static info(err) {
    assertError(err);
    const output = {};
    const cause = Layerr.cause(err);
    if (cause) {
      Object.assign(output, Layerr.info(cause));
    }
    if (err._info) {
      Object.assign(output, err._info);
    }
    return output;
  }
  toString() {
    let output = this.name || this.constructor.name || this.constructor.prototype.name;
    if (this.message) {
      output = `${output}: ${this.message}`;
    }
    return output;
  }
}
function normalize(strArray) {
  var resultArray = [];
  if (strArray.length === 0) {
    return "";
  }
  if (typeof strArray[0] !== "string") {
    throw new TypeError("Url must be a string. Received " + strArray[0]);
  }
  if (strArray[0].match(/^[^/:]+:\/*$/) && strArray.length > 1) {
    var first = strArray.shift();
    strArray[0] = first + strArray[0];
  }
  if (strArray[0].match(/^file:\/\/\//)) {
    strArray[0] = strArray[0].replace(/^([^/:]+):\/*/, "$1:///");
  } else {
    strArray[0] = strArray[0].replace(/^([^/:]+):\/*/, "$1://");
  }
  for (var i2 = 0; i2 < strArray.length; i2++) {
    var component = strArray[i2];
    if (typeof component !== "string") {
      throw new TypeError("Url must be a string. Received " + component);
    }
    if (component === "") {
      continue;
    }
    if (i2 > 0) {
      component = component.replace(/^[\/]+/, "");
    }
    if (i2 < strArray.length - 1) {
      component = component.replace(/[\/]+$/, "");
    } else {
      component = component.replace(/[\/]+$/, "/");
    }
    resultArray.push(component);
  }
  var str = resultArray.join("/");
  str = str.replace(/\/(\?|&|#[^!])/g, "$1");
  var parts = str.split("?");
  str = parts.shift() + (parts.length > 0 ? "?" : "") + parts.join("&");
  return str;
}
function urlJoin() {
  var input;
  if (typeof arguments[0] === "object") {
    input = arguments[0];
  } else {
    input = [].slice.call(arguments);
  }
  return normalize(input);
}
var pathPosix$1;
var hasRequiredPathPosix;
function requirePathPosix() {
  if (hasRequiredPathPosix) return pathPosix$1;
  hasRequiredPathPosix = 1;
  var util = require$$0;
  var isString = function(x2) {
    return typeof x2 === "string";
  };
  function normalizeArray(parts, allowAboveRoot) {
    var res = [];
    for (var i2 = 0; i2 < parts.length; i2++) {
      var p = parts[i2];
      if (!p || p === ".")
        continue;
      if (p === "..") {
        if (res.length && res[res.length - 1] !== "..") {
          res.pop();
        } else if (allowAboveRoot) {
          res.push("..");
        }
      } else {
        res.push(p);
      }
    }
    return res;
  }
  var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
  var posix = {};
  function posixSplitPath(filename) {
    return splitPathRe.exec(filename).slice(1);
  }
  posix.resolve = function() {
    var resolvedPath = "", resolvedAbsolute = false;
    for (var i2 = arguments.length - 1; i2 >= -1 && !resolvedAbsolute; i2--) {
      var path2 = i2 >= 0 ? arguments[i2] : process.cwd();
      if (!isString(path2)) {
        throw new TypeError("Arguments to path.resolve must be strings");
      } else if (!path2) {
        continue;
      }
      resolvedPath = path2 + "/" + resolvedPath;
      resolvedAbsolute = path2.charAt(0) === "/";
    }
    resolvedPath = normalizeArray(
      resolvedPath.split("/"),
      !resolvedAbsolute
    ).join("/");
    return (resolvedAbsolute ? "/" : "") + resolvedPath || ".";
  };
  posix.normalize = function(path2) {
    var isAbsolute = posix.isAbsolute(path2), trailingSlash = path2.substr(-1) === "/";
    path2 = normalizeArray(path2.split("/"), !isAbsolute).join("/");
    if (!path2 && !isAbsolute) {
      path2 = ".";
    }
    if (path2 && trailingSlash) {
      path2 += "/";
    }
    return (isAbsolute ? "/" : "") + path2;
  };
  posix.isAbsolute = function(path2) {
    return path2.charAt(0) === "/";
  };
  posix.join = function() {
    var path2 = "";
    for (var i2 = 0; i2 < arguments.length; i2++) {
      var segment = arguments[i2];
      if (!isString(segment)) {
        throw new TypeError("Arguments to path.join must be strings");
      }
      if (segment) {
        if (!path2) {
          path2 += segment;
        } else {
          path2 += "/" + segment;
        }
      }
    }
    return posix.normalize(path2);
  };
  posix.relative = function(from, to) {
    from = posix.resolve(from).substr(1);
    to = posix.resolve(to).substr(1);
    function trim(arr) {
      var start = 0;
      for (; start < arr.length; start++) {
        if (arr[start] !== "") break;
      }
      var end = arr.length - 1;
      for (; end >= 0; end--) {
        if (arr[end] !== "") break;
      }
      if (start > end) return [];
      return arr.slice(start, end + 1);
    }
    var fromParts = trim(from.split("/"));
    var toParts = trim(to.split("/"));
    var length = Math.min(fromParts.length, toParts.length);
    var samePartsLength = length;
    for (var i2 = 0; i2 < length; i2++) {
      if (fromParts[i2] !== toParts[i2]) {
        samePartsLength = i2;
        break;
      }
    }
    var outputParts = [];
    for (var i2 = samePartsLength; i2 < fromParts.length; i2++) {
      outputParts.push("..");
    }
    outputParts = outputParts.concat(toParts.slice(samePartsLength));
    return outputParts.join("/");
  };
  posix._makeLong = function(path2) {
    return path2;
  };
  posix.dirname = function(path2) {
    var result = posixSplitPath(path2), root = result[0], dir = result[1];
    if (!root && !dir) {
      return ".";
    }
    if (dir) {
      dir = dir.substr(0, dir.length - 1);
    }
    return root + dir;
  };
  posix.basename = function(path2, ext2) {
    var f2 = posixSplitPath(path2)[2];
    if (ext2 && f2.substr(-1 * ext2.length) === ext2) {
      f2 = f2.substr(0, f2.length - ext2.length);
    }
    return f2;
  };
  posix.extname = function(path2) {
    return posixSplitPath(path2)[3];
  };
  posix.format = function(pathObject) {
    if (!util.isObject(pathObject)) {
      throw new TypeError(
        "Parameter 'pathObject' must be an object, not " + typeof pathObject
      );
    }
    var root = pathObject.root || "";
    if (!isString(root)) {
      throw new TypeError(
        "'pathObject.root' must be a string or undefined, not " + typeof pathObject.root
      );
    }
    var dir = pathObject.dir ? pathObject.dir + posix.sep : "";
    var base = pathObject.base || "";
    return dir + base;
  };
  posix.parse = function(pathString) {
    if (!isString(pathString)) {
      throw new TypeError(
        "Parameter 'pathString' must be a string, not " + typeof pathString
      );
    }
    var allParts = posixSplitPath(pathString);
    if (!allParts || allParts.length !== 4) {
      throw new TypeError("Invalid path '" + pathString + "'");
    }
    allParts[1] = allParts[1] || "";
    allParts[2] = allParts[2] || "";
    allParts[3] = allParts[3] || "";
    return {
      root: allParts[0],
      dir: allParts[0] + allParts[1].slice(0, allParts[1].length - 1),
      base: allParts[2],
      ext: allParts[3],
      name: allParts[2].slice(0, allParts[2].length - allParts[3].length)
    };
  };
  posix.sep = "/";
  posix.delimiter = ":";
  pathPosix$1 = posix;
  return pathPosix$1;
}
var pathPosixExports = requirePathPosix();
const pathPosix = /* @__PURE__ */ getDefaultExportFromCjs(pathPosixExports);
const SEP_PATH_POSIX = "__PATH_SEPARATOR_POSIX__";
const SEP_PATH_WINDOWS = "__PATH_SEPARATOR_WINDOWS__";
function encodePath(filePath) {
  try {
    const replaced = filePath.replace(/\//g, SEP_PATH_POSIX).replace(/\\\\/g, SEP_PATH_WINDOWS);
    const formatted = encodeURIComponent(replaced);
    return formatted.split(SEP_PATH_WINDOWS).join("\\\\").split(SEP_PATH_POSIX).join("/");
  } catch (err) {
    throw new Layerr(err, "Failed encoding path");
  }
}
function getAllDirectories(directory) {
  if (!directory || directory === "/")
    return [];
  let currentPath = directory;
  const output = [];
  do {
    output.push(currentPath);
    currentPath = pathPosix.dirname(currentPath);
  } while (currentPath && currentPath !== "/");
  return output;
}
function makePathAbsolute(pathStr) {
  return pathStr.startsWith("/") ? pathStr : "/" + pathStr;
}
function normalisePath(pathStr) {
  let normalisedPath = pathStr;
  if (normalisedPath[0] !== "/") {
    normalisedPath = "/" + normalisedPath;
  }
  if (/^.+\/$/.test(normalisedPath)) {
    normalisedPath = normalisedPath.substr(0, normalisedPath.length - 1);
  }
  return normalisedPath;
}
function extractURLPath(fullURL) {
  const url = new URL$1(fullURL);
  let urlPath = url.pathname;
  if (urlPath.length <= 0) {
    urlPath = "/";
  }
  return normalisePath(urlPath);
}
function joinURL(...parts) {
  return urlJoin(parts.reduce((output, nextPart, partIndex) => {
    if (partIndex === 0 || nextPart !== "/" || nextPart === "/" && output[output.length - 1] !== "/") {
      output.push(nextPart);
    }
    return output;
  }, []));
}
function normaliseHREF(href) {
  try {
    const normalisedHref = href.replace(/^https?:\/\/[^\/]+/, "");
    return normalisedHref;
  } catch (err) {
    throw new Layerr(err, "Failed normalising HREF");
  }
}
var md5$1 = { exports: {} };
var crypt = { exports: {} };
var hasRequiredCrypt;
function requireCrypt() {
  if (hasRequiredCrypt) return crypt.exports;
  hasRequiredCrypt = 1;
  (function() {
    var base64map = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", crypt$1 = {
      // Bit-wise rotation left
      rotl: function(n, b) {
        return n << b | n >>> 32 - b;
      },
      // Bit-wise rotation right
      rotr: function(n, b) {
        return n << 32 - b | n >>> b;
      },
      // Swap big-endian to little-endian and vice versa
      endian: function(n) {
        if (n.constructor == Number) {
          return crypt$1.rotl(n, 8) & 16711935 | crypt$1.rotl(n, 24) & 4278255360;
        }
        for (var i2 = 0; i2 < n.length; i2++)
          n[i2] = crypt$1.endian(n[i2]);
        return n;
      },
      // Generate an array of any length of random bytes
      randomBytes: function(n) {
        for (var bytes = []; n > 0; n--)
          bytes.push(Math.floor(Math.random() * 256));
        return bytes;
      },
      // Convert a byte array to big-endian 32-bit words
      bytesToWords: function(bytes) {
        for (var words = [], i2 = 0, b = 0; i2 < bytes.length; i2++, b += 8)
          words[b >>> 5] |= bytes[i2] << 24 - b % 32;
        return words;
      },
      // Convert big-endian 32-bit words to a byte array
      wordsToBytes: function(words) {
        for (var bytes = [], b = 0; b < words.length * 32; b += 8)
          bytes.push(words[b >>> 5] >>> 24 - b % 32 & 255);
        return bytes;
      },
      // Convert a byte array to a hex string
      bytesToHex: function(bytes) {
        for (var hex = [], i2 = 0; i2 < bytes.length; i2++) {
          hex.push((bytes[i2] >>> 4).toString(16));
          hex.push((bytes[i2] & 15).toString(16));
        }
        return hex.join("");
      },
      // Convert a hex string to a byte array
      hexToBytes: function(hex) {
        for (var bytes = [], c = 0; c < hex.length; c += 2)
          bytes.push(parseInt(hex.substr(c, 2), 16));
        return bytes;
      },
      // Convert a byte array to a base-64 string
      bytesToBase64: function(bytes) {
        for (var base642 = [], i2 = 0; i2 < bytes.length; i2 += 3) {
          var triplet = bytes[i2] << 16 | bytes[i2 + 1] << 8 | bytes[i2 + 2];
          for (var j = 0; j < 4; j++)
            if (i2 * 8 + j * 6 <= bytes.length * 8)
              base642.push(base64map.charAt(triplet >>> 6 * (3 - j) & 63));
            else
              base642.push("=");
        }
        return base642.join("");
      },
      // Convert a base-64 string to a byte array
      base64ToBytes: function(base642) {
        base642 = base642.replace(/[^A-Z0-9+\/]/ig, "");
        for (var bytes = [], i2 = 0, imod4 = 0; i2 < base642.length; imod4 = ++i2 % 4) {
          if (imod4 == 0) continue;
          bytes.push((base64map.indexOf(base642.charAt(i2 - 1)) & Math.pow(2, -2 * imod4 + 8) - 1) << imod4 * 2 | base64map.indexOf(base642.charAt(i2)) >>> 6 - imod4 * 2);
        }
        return bytes;
      }
    };
    crypt.exports = crypt$1;
  })();
  return crypt.exports;
}
var charenc_1;
var hasRequiredCharenc;
function requireCharenc() {
  if (hasRequiredCharenc) return charenc_1;
  hasRequiredCharenc = 1;
  var charenc = {
    // UTF-8 encoding
    utf8: {
      // Convert a string to a byte array
      stringToBytes: function(str) {
        return charenc.bin.stringToBytes(unescape(encodeURIComponent(str)));
      },
      // Convert a byte array to a string
      bytesToString: function(bytes) {
        return decodeURIComponent(escape(charenc.bin.bytesToString(bytes)));
      }
    },
    // Binary encoding
    bin: {
      // Convert a string to a byte array
      stringToBytes: function(str) {
        for (var bytes = [], i2 = 0; i2 < str.length; i2++)
          bytes.push(str.charCodeAt(i2) & 255);
        return bytes;
      },
      // Convert a byte array to a string
      bytesToString: function(bytes) {
        for (var str = [], i2 = 0; i2 < bytes.length; i2++)
          str.push(String.fromCharCode(bytes[i2]));
        return str.join("");
      }
    }
  };
  charenc_1 = charenc;
  return charenc_1;
}
var isBuffer_1;
var hasRequiredIsBuffer;
function requireIsBuffer() {
  if (hasRequiredIsBuffer) return isBuffer_1;
  hasRequiredIsBuffer = 1;
  isBuffer_1 = function(obj) {
    return obj != null && (isBuffer2(obj) || isSlowBuffer(obj) || !!obj._isBuffer);
  };
  function isBuffer2(obj) {
    return !!obj.constructor && typeof obj.constructor.isBuffer === "function" && obj.constructor.isBuffer(obj);
  }
  function isSlowBuffer(obj) {
    return typeof obj.readFloatLE === "function" && typeof obj.slice === "function" && isBuffer2(obj.slice(0, 0));
  }
  return isBuffer_1;
}
var hasRequiredMd5;
function requireMd5() {
  if (hasRequiredMd5) return md5$1.exports;
  hasRequiredMd5 = 1;
  (function() {
    var crypt2 = requireCrypt(), utf8 = requireCharenc().utf8, isBuffer2 = requireIsBuffer(), bin = requireCharenc().bin, md52 = function(message, options) {
      if (message.constructor == String)
        if (options && options.encoding === "binary")
          message = bin.stringToBytes(message);
        else
          message = utf8.stringToBytes(message);
      else if (isBuffer2(message))
        message = Array.prototype.slice.call(message, 0);
      else if (!Array.isArray(message) && message.constructor !== Uint8Array)
        message = message.toString();
      var m2 = crypt2.bytesToWords(message), l = message.length * 8, a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
      for (var i2 = 0; i2 < m2.length; i2++) {
        m2[i2] = (m2[i2] << 8 | m2[i2] >>> 24) & 16711935 | (m2[i2] << 24 | m2[i2] >>> 8) & 4278255360;
      }
      m2[l >>> 5] |= 128 << l % 32;
      m2[(l + 64 >>> 9 << 4) + 14] = l;
      var FF = md52._ff, GG = md52._gg, HH = md52._hh, II = md52._ii;
      for (var i2 = 0; i2 < m2.length; i2 += 16) {
        var aa = a, bb = b, cc = c, dd = d;
        a = FF(a, b, c, d, m2[i2 + 0], 7, -680876936);
        d = FF(d, a, b, c, m2[i2 + 1], 12, -389564586);
        c = FF(c, d, a, b, m2[i2 + 2], 17, 606105819);
        b = FF(b, c, d, a, m2[i2 + 3], 22, -1044525330);
        a = FF(a, b, c, d, m2[i2 + 4], 7, -176418897);
        d = FF(d, a, b, c, m2[i2 + 5], 12, 1200080426);
        c = FF(c, d, a, b, m2[i2 + 6], 17, -1473231341);
        b = FF(b, c, d, a, m2[i2 + 7], 22, -45705983);
        a = FF(a, b, c, d, m2[i2 + 8], 7, 1770035416);
        d = FF(d, a, b, c, m2[i2 + 9], 12, -1958414417);
        c = FF(c, d, a, b, m2[i2 + 10], 17, -42063);
        b = FF(b, c, d, a, m2[i2 + 11], 22, -1990404162);
        a = FF(a, b, c, d, m2[i2 + 12], 7, 1804603682);
        d = FF(d, a, b, c, m2[i2 + 13], 12, -40341101);
        c = FF(c, d, a, b, m2[i2 + 14], 17, -1502002290);
        b = FF(b, c, d, a, m2[i2 + 15], 22, 1236535329);
        a = GG(a, b, c, d, m2[i2 + 1], 5, -165796510);
        d = GG(d, a, b, c, m2[i2 + 6], 9, -1069501632);
        c = GG(c, d, a, b, m2[i2 + 11], 14, 643717713);
        b = GG(b, c, d, a, m2[i2 + 0], 20, -373897302);
        a = GG(a, b, c, d, m2[i2 + 5], 5, -701558691);
        d = GG(d, a, b, c, m2[i2 + 10], 9, 38016083);
        c = GG(c, d, a, b, m2[i2 + 15], 14, -660478335);
        b = GG(b, c, d, a, m2[i2 + 4], 20, -405537848);
        a = GG(a, b, c, d, m2[i2 + 9], 5, 568446438);
        d = GG(d, a, b, c, m2[i2 + 14], 9, -1019803690);
        c = GG(c, d, a, b, m2[i2 + 3], 14, -187363961);
        b = GG(b, c, d, a, m2[i2 + 8], 20, 1163531501);
        a = GG(a, b, c, d, m2[i2 + 13], 5, -1444681467);
        d = GG(d, a, b, c, m2[i2 + 2], 9, -51403784);
        c = GG(c, d, a, b, m2[i2 + 7], 14, 1735328473);
        b = GG(b, c, d, a, m2[i2 + 12], 20, -1926607734);
        a = HH(a, b, c, d, m2[i2 + 5], 4, -378558);
        d = HH(d, a, b, c, m2[i2 + 8], 11, -2022574463);
        c = HH(c, d, a, b, m2[i2 + 11], 16, 1839030562);
        b = HH(b, c, d, a, m2[i2 + 14], 23, -35309556);
        a = HH(a, b, c, d, m2[i2 + 1], 4, -1530992060);
        d = HH(d, a, b, c, m2[i2 + 4], 11, 1272893353);
        c = HH(c, d, a, b, m2[i2 + 7], 16, -155497632);
        b = HH(b, c, d, a, m2[i2 + 10], 23, -1094730640);
        a = HH(a, b, c, d, m2[i2 + 13], 4, 681279174);
        d = HH(d, a, b, c, m2[i2 + 0], 11, -358537222);
        c = HH(c, d, a, b, m2[i2 + 3], 16, -722521979);
        b = HH(b, c, d, a, m2[i2 + 6], 23, 76029189);
        a = HH(a, b, c, d, m2[i2 + 9], 4, -640364487);
        d = HH(d, a, b, c, m2[i2 + 12], 11, -421815835);
        c = HH(c, d, a, b, m2[i2 + 15], 16, 530742520);
        b = HH(b, c, d, a, m2[i2 + 2], 23, -995338651);
        a = II(a, b, c, d, m2[i2 + 0], 6, -198630844);
        d = II(d, a, b, c, m2[i2 + 7], 10, 1126891415);
        c = II(c, d, a, b, m2[i2 + 14], 15, -1416354905);
        b = II(b, c, d, a, m2[i2 + 5], 21, -57434055);
        a = II(a, b, c, d, m2[i2 + 12], 6, 1700485571);
        d = II(d, a, b, c, m2[i2 + 3], 10, -1894986606);
        c = II(c, d, a, b, m2[i2 + 10], 15, -1051523);
        b = II(b, c, d, a, m2[i2 + 1], 21, -2054922799);
        a = II(a, b, c, d, m2[i2 + 8], 6, 1873313359);
        d = II(d, a, b, c, m2[i2 + 15], 10, -30611744);
        c = II(c, d, a, b, m2[i2 + 6], 15, -1560198380);
        b = II(b, c, d, a, m2[i2 + 13], 21, 1309151649);
        a = II(a, b, c, d, m2[i2 + 4], 6, -145523070);
        d = II(d, a, b, c, m2[i2 + 11], 10, -1120210379);
        c = II(c, d, a, b, m2[i2 + 2], 15, 718787259);
        b = II(b, c, d, a, m2[i2 + 9], 21, -343485551);
        a = a + aa >>> 0;
        b = b + bb >>> 0;
        c = c + cc >>> 0;
        d = d + dd >>> 0;
      }
      return crypt2.endian([a, b, c, d]);
    };
    md52._ff = function(a, b, c, d, x2, s, t2) {
      var n = a + (b & c | ~b & d) + (x2 >>> 0) + t2;
      return (n << s | n >>> 32 - s) + b;
    };
    md52._gg = function(a, b, c, d, x2, s, t2) {
      var n = a + (b & d | c & ~d) + (x2 >>> 0) + t2;
      return (n << s | n >>> 32 - s) + b;
    };
    md52._hh = function(a, b, c, d, x2, s, t2) {
      var n = a + (b ^ c ^ d) + (x2 >>> 0) + t2;
      return (n << s | n >>> 32 - s) + b;
    };
    md52._ii = function(a, b, c, d, x2, s, t2) {
      var n = a + (c ^ (b | ~d)) + (x2 >>> 0) + t2;
      return (n << s | n >>> 32 - s) + b;
    };
    md52._blocksize = 16;
    md52._digestsize = 16;
    md5$1.exports = function(message, options) {
      if (message === void 0 || message === null)
        throw new Error("Illegal argument " + message);
      var digestbytes = crypt2.wordsToBytes(md52(message, options));
      return options && options.asBytes ? digestbytes : options && options.asString ? bin.bytesToString(digestbytes) : crypt2.bytesToHex(digestbytes);
    };
  })();
  return md5$1.exports;
}
var md5Exports = requireMd5();
const md5 = /* @__PURE__ */ getDefaultExportFromCjs(md5Exports);
function ha1Compute(algorithm, user, realm, pass, nonce, cnonce, ha1) {
  const ha1Hash = ha1 || md5(`${user}:${realm}:${pass}`);
  if (algorithm && algorithm.toLowerCase() === "md5-sess") {
    return md5(`${ha1Hash}:${nonce}:${cnonce}`);
  }
  return ha1Hash;
}
const NONCE_CHARS = "abcdef0123456789";
const NONCE_SIZE = 32;
function createDigestContext(username, password, ha1) {
  return { username, password, ha1, nc: 0, algorithm: "md5", hasDigestAuth: false };
}
function generateDigestAuthHeader(options, digest) {
  const url = options.url.replace("//", "");
  const uri = url.indexOf("/") == -1 ? "/" : url.slice(url.indexOf("/"));
  const method = options.method ? options.method.toUpperCase() : "GET";
  const qop = /(^|,)\s*auth\s*($|,)/.test(digest.qop) ? "auth" : false;
  const ncString = `00000000${digest.nc}`.slice(-8);
  const ha1 = ha1Compute(digest.algorithm, digest.username, digest.realm, digest.password, digest.nonce, digest.cnonce, digest.ha1);
  const ha2 = md5(`${method}:${uri}`);
  const digestResponse = qop ? md5(`${ha1}:${digest.nonce}:${ncString}:${digest.cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${digest.nonce}:${ha2}`);
  const authValues = {
    username: digest.username,
    realm: digest.realm,
    nonce: digest.nonce,
    uri,
    qop,
    response: digestResponse,
    nc: ncString,
    cnonce: digest.cnonce,
    algorithm: digest.algorithm,
    opaque: digest.opaque
  };
  const authHeader = [];
  for (const k in authValues) {
    if (authValues[k]) {
      if (k === "qop" || k === "nc" || k === "algorithm") {
        authHeader.push(`${k}=${authValues[k]}`);
      } else {
        authHeader.push(`${k}="${authValues[k]}"`);
      }
    }
  }
  return `Digest ${authHeader.join(", ")}`;
}
function makeNonce() {
  let uid = "";
  for (let i2 = 0; i2 < NONCE_SIZE; ++i2) {
    uid = `${uid}${NONCE_CHARS[Math.floor(Math.random() * NONCE_CHARS.length)]}`;
  }
  return uid;
}
function parseDigestAuth(response, _digest) {
  const isDigest = responseIndicatesDigestAuth(response);
  if (!isDigest) {
    return false;
  }
  const re = /([a-z0-9_-]+)=(?:"([^"]+)"|([a-z0-9_-]+))/gi;
  for (; ; ) {
    const authHeader = response.headers && response.headers.get("www-authenticate") || "";
    const match2 = re.exec(authHeader);
    if (!match2) {
      break;
    }
    _digest[match2[1]] = match2[2] || match2[3];
  }
  _digest.nc += 1;
  _digest.cnonce = makeNonce();
  return true;
}
function responseIndicatesDigestAuth(response) {
  const authHeader = response.headers && response.headers.get("www-authenticate") || "";
  return authHeader.split(/\s/)[0].toLowerCase() === "digest";
}
var base64$2 = { exports: {} };
var base64$1 = base64$2.exports;
var hasRequiredBase64;
function requireBase64() {
  if (hasRequiredBase64) return base64$2.exports;
  hasRequiredBase64 = 1;
  (function(module, exports) {
    (function(root) {
      var freeExports = exports;
      var freeModule = module && module.exports == freeExports && module;
      var freeGlobal = typeof commonjsGlobal == "object" && commonjsGlobal;
      if (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal) {
        root = freeGlobal;
      }
      var InvalidCharacterError = function(message) {
        this.message = message;
      };
      InvalidCharacterError.prototype = new Error();
      InvalidCharacterError.prototype.name = "InvalidCharacterError";
      var error = function(message) {
        throw new InvalidCharacterError(message);
      };
      var TABLE2 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      var REGEX_SPACE_CHARACTERS = /[\t\n\f\r ]/g;
      var decode = function(input) {
        input = String(input).replace(REGEX_SPACE_CHARACTERS, "");
        var length = input.length;
        if (length % 4 == 0) {
          input = input.replace(/==?$/, "");
          length = input.length;
        }
        if (length % 4 == 1 || // http://whatwg.org/C#alphanumeric-ascii-characters
        /[^+a-zA-Z0-9/]/.test(input)) {
          error(
            "Invalid character: the string to be decoded is not correctly encoded."
          );
        }
        var bitCounter = 0;
        var bitStorage;
        var buffer;
        var output = "";
        var position = -1;
        while (++position < length) {
          buffer = TABLE2.indexOf(input.charAt(position));
          bitStorage = bitCounter % 4 ? bitStorage * 64 + buffer : buffer;
          if (bitCounter++ % 4) {
            output += String.fromCharCode(
              255 & bitStorage >> (-2 * bitCounter & 6)
            );
          }
        }
        return output;
      };
      var encode = function(input) {
        input = String(input);
        if (/[^\0-\xFF]/.test(input)) {
          error(
            "The string to be encoded contains characters outside of the Latin1 range."
          );
        }
        var padding = input.length % 3;
        var output = "";
        var position = -1;
        var a;
        var b;
        var c;
        var buffer;
        var length = input.length - padding;
        while (++position < length) {
          a = input.charCodeAt(position) << 16;
          b = input.charCodeAt(++position) << 8;
          c = input.charCodeAt(++position);
          buffer = a + b + c;
          output += TABLE2.charAt(buffer >> 18 & 63) + TABLE2.charAt(buffer >> 12 & 63) + TABLE2.charAt(buffer >> 6 & 63) + TABLE2.charAt(buffer & 63);
        }
        if (padding == 2) {
          a = input.charCodeAt(position) << 8;
          b = input.charCodeAt(++position);
          buffer = a + b;
          output += TABLE2.charAt(buffer >> 10) + TABLE2.charAt(buffer >> 4 & 63) + TABLE2.charAt(buffer << 2 & 63) + "=";
        } else if (padding == 1) {
          buffer = input.charCodeAt(position);
          output += TABLE2.charAt(buffer >> 2) + TABLE2.charAt(buffer << 4 & 63) + "==";
        }
        return output;
      };
      var base642 = {
        "encode": encode,
        "decode": decode,
        "version": "1.0.0"
      };
      if (freeExports && !freeExports.nodeType) {
        if (freeModule) {
          freeModule.exports = base642;
        } else {
          for (var key in base642) {
            base642.hasOwnProperty(key) && (freeExports[key] = base642[key]);
          }
        }
      } else {
        root.base64 = base642;
      }
    })(base64$1);
  })(base64$2, base64$2.exports);
  return base64$2.exports;
}
var base64Exports = requireBase64();
const base64 = /* @__PURE__ */ getDefaultExportFromCjs(base64Exports);
function isReactNative() {
  return typeof TARGET === "string" && TARGET === "react-native";
}
function isWeb() {
  return typeof TARGET === "string" && TARGET === "web";
}
function fromBase64(text) {
  return base64.decode(text);
}
function toBase64(text) {
  return base64.encode(text);
}
function generateBasicAuthHeader(username, password) {
  const encoded = toBase64(`${username}:${password}`);
  return `Basic ${encoded}`;
}
function generateTokenAuthHeader(token) {
  return `${token.token_type} ${token.access_token}`;
}
function dataUriToBuffer(uri) {
  if (!/^data:/i.test(uri)) {
    throw new TypeError('`uri` does not appear to be a Data URI (must begin with "data:")');
  }
  uri = uri.replace(/\r?\n/g, "");
  const firstComma = uri.indexOf(",");
  if (firstComma === -1 || firstComma <= 4) {
    throw new TypeError("malformed data: URI");
  }
  const meta = uri.substring(5, firstComma).split(";");
  let charset = "";
  let base642 = false;
  const type = meta[0] || "text/plain";
  let typeFull = type;
  for (let i2 = 1; i2 < meta.length; i2++) {
    if (meta[i2] === "base64") {
      base642 = true;
    } else if (meta[i2]) {
      typeFull += `;${meta[i2]}`;
      if (meta[i2].indexOf("charset=") === 0) {
        charset = meta[i2].substring(8);
      }
    }
  }
  if (!meta[0] && !charset.length) {
    typeFull += ";charset=US-ASCII";
    charset = "US-ASCII";
  }
  const encoding = base642 ? "base64" : "ascii";
  const data = unescape(uri.substring(firstComma + 1));
  const buffer = Buffer.from(data, encoding);
  buffer.type = type;
  buffer.typeFull = typeFull;
  buffer.charset = charset;
  return buffer;
}
var streams = {};
var ponyfill_es2018$1 = { exports: {} };
var ponyfill_es2018 = ponyfill_es2018$1.exports;
var hasRequiredPonyfill_es2018;
function requirePonyfill_es2018() {
  if (hasRequiredPonyfill_es2018) return ponyfill_es2018$1.exports;
  hasRequiredPonyfill_es2018 = 1;
  (function(module, exports) {
    (function(global2, factory) {
      factory(exports);
    })(ponyfill_es2018, (function(exports2) {
      function noop() {
        return void 0;
      }
      function typeIsObject(x2) {
        return typeof x2 === "object" && x2 !== null || typeof x2 === "function";
      }
      const rethrowAssertionErrorRejection = noop;
      function setFunctionName(fn, name) {
        try {
          Object.defineProperty(fn, "name", {
            value: name,
            configurable: true
          });
        } catch (_a3) {
        }
      }
      const originalPromise = Promise;
      const originalPromiseThen = Promise.prototype.then;
      const originalPromiseReject = Promise.reject.bind(originalPromise);
      function newPromise(executor) {
        return new originalPromise(executor);
      }
      function promiseResolvedWith(value) {
        return newPromise((resolve) => resolve(value));
      }
      function promiseRejectedWith(reason) {
        return originalPromiseReject(reason);
      }
      function PerformPromiseThen(promise, onFulfilled, onRejected) {
        return originalPromiseThen.call(promise, onFulfilled, onRejected);
      }
      function uponPromise(promise, onFulfilled, onRejected) {
        PerformPromiseThen(PerformPromiseThen(promise, onFulfilled, onRejected), void 0, rethrowAssertionErrorRejection);
      }
      function uponFulfillment(promise, onFulfilled) {
        uponPromise(promise, onFulfilled);
      }
      function uponRejection(promise, onRejected) {
        uponPromise(promise, void 0, onRejected);
      }
      function transformPromiseWith(promise, fulfillmentHandler, rejectionHandler) {
        return PerformPromiseThen(promise, fulfillmentHandler, rejectionHandler);
      }
      function setPromiseIsHandledToTrue(promise) {
        PerformPromiseThen(promise, void 0, rethrowAssertionErrorRejection);
      }
      let _queueMicrotask = (callback) => {
        if (typeof queueMicrotask === "function") {
          _queueMicrotask = queueMicrotask;
        } else {
          const resolvedPromise = promiseResolvedWith(void 0);
          _queueMicrotask = (cb) => PerformPromiseThen(resolvedPromise, cb);
        }
        return _queueMicrotask(callback);
      };
      function reflectCall(F, V, args) {
        if (typeof F !== "function") {
          throw new TypeError("Argument is not a function");
        }
        return Function.prototype.apply.call(F, V, args);
      }
      function promiseCall(F, V, args) {
        try {
          return promiseResolvedWith(reflectCall(F, V, args));
        } catch (value) {
          return promiseRejectedWith(value);
        }
      }
      const QUEUE_MAX_ARRAY_SIZE = 16384;
      class SimpleQueue {
        constructor() {
          this._cursor = 0;
          this._size = 0;
          this._front = {
            _elements: [],
            _next: void 0
          };
          this._back = this._front;
          this._cursor = 0;
          this._size = 0;
        }
        get length() {
          return this._size;
        }
        // For exception safety, this method is structured in order:
        // 1. Read state
        // 2. Calculate required state mutations
        // 3. Perform state mutations
        push(element) {
          const oldBack = this._back;
          let newBack = oldBack;
          if (oldBack._elements.length === QUEUE_MAX_ARRAY_SIZE - 1) {
            newBack = {
              _elements: [],
              _next: void 0
            };
          }
          oldBack._elements.push(element);
          if (newBack !== oldBack) {
            this._back = newBack;
            oldBack._next = newBack;
          }
          ++this._size;
        }
        // Like push(), shift() follows the read -> calculate -> mutate pattern for
        // exception safety.
        shift() {
          const oldFront = this._front;
          let newFront = oldFront;
          const oldCursor = this._cursor;
          let newCursor = oldCursor + 1;
          const elements = oldFront._elements;
          const element = elements[oldCursor];
          if (newCursor === QUEUE_MAX_ARRAY_SIZE) {
            newFront = oldFront._next;
            newCursor = 0;
          }
          --this._size;
          this._cursor = newCursor;
          if (oldFront !== newFront) {
            this._front = newFront;
          }
          elements[oldCursor] = void 0;
          return element;
        }
        // The tricky thing about forEach() is that it can be called
        // re-entrantly. The queue may be mutated inside the callback. It is easy to
        // see that push() within the callback has no negative effects since the end
        // of the queue is checked for on every iteration. If shift() is called
        // repeatedly within the callback then the next iteration may return an
        // element that has been removed. In this case the callback will be called
        // with undefined values until we either "catch up" with elements that still
        // exist or reach the back of the queue.
        forEach(callback) {
          let i2 = this._cursor;
          let node = this._front;
          let elements = node._elements;
          while (i2 !== elements.length || node._next !== void 0) {
            if (i2 === elements.length) {
              node = node._next;
              elements = node._elements;
              i2 = 0;
              if (elements.length === 0) {
                break;
              }
            }
            callback(elements[i2]);
            ++i2;
          }
        }
        // Return the element that would be returned if shift() was called now,
        // without modifying the queue.
        peek() {
          const front = this._front;
          const cursor = this._cursor;
          return front._elements[cursor];
        }
      }
      const AbortSteps = /* @__PURE__ */ Symbol("[[AbortSteps]]");
      const ErrorSteps = /* @__PURE__ */ Symbol("[[ErrorSteps]]");
      const CancelSteps = /* @__PURE__ */ Symbol("[[CancelSteps]]");
      const PullSteps = /* @__PURE__ */ Symbol("[[PullSteps]]");
      const ReleaseSteps = /* @__PURE__ */ Symbol("[[ReleaseSteps]]");
      function ReadableStreamReaderGenericInitialize(reader, stream) {
        reader._ownerReadableStream = stream;
        stream._reader = reader;
        if (stream._state === "readable") {
          defaultReaderClosedPromiseInitialize(reader);
        } else if (stream._state === "closed") {
          defaultReaderClosedPromiseInitializeAsResolved(reader);
        } else {
          defaultReaderClosedPromiseInitializeAsRejected(reader, stream._storedError);
        }
      }
      function ReadableStreamReaderGenericCancel(reader, reason) {
        const stream = reader._ownerReadableStream;
        return ReadableStreamCancel(stream, reason);
      }
      function ReadableStreamReaderGenericRelease(reader) {
        const stream = reader._ownerReadableStream;
        if (stream._state === "readable") {
          defaultReaderClosedPromiseReject(reader, new TypeError(`Reader was released and can no longer be used to monitor the stream's closedness`));
        } else {
          defaultReaderClosedPromiseResetToRejected(reader, new TypeError(`Reader was released and can no longer be used to monitor the stream's closedness`));
        }
        stream._readableStreamController[ReleaseSteps]();
        stream._reader = void 0;
        reader._ownerReadableStream = void 0;
      }
      function readerLockException(name) {
        return new TypeError("Cannot " + name + " a stream using a released reader");
      }
      function defaultReaderClosedPromiseInitialize(reader) {
        reader._closedPromise = newPromise((resolve, reject) => {
          reader._closedPromise_resolve = resolve;
          reader._closedPromise_reject = reject;
        });
      }
      function defaultReaderClosedPromiseInitializeAsRejected(reader, reason) {
        defaultReaderClosedPromiseInitialize(reader);
        defaultReaderClosedPromiseReject(reader, reason);
      }
      function defaultReaderClosedPromiseInitializeAsResolved(reader) {
        defaultReaderClosedPromiseInitialize(reader);
        defaultReaderClosedPromiseResolve(reader);
      }
      function defaultReaderClosedPromiseReject(reader, reason) {
        if (reader._closedPromise_reject === void 0) {
          return;
        }
        setPromiseIsHandledToTrue(reader._closedPromise);
        reader._closedPromise_reject(reason);
        reader._closedPromise_resolve = void 0;
        reader._closedPromise_reject = void 0;
      }
      function defaultReaderClosedPromiseResetToRejected(reader, reason) {
        defaultReaderClosedPromiseInitializeAsRejected(reader, reason);
      }
      function defaultReaderClosedPromiseResolve(reader) {
        if (reader._closedPromise_resolve === void 0) {
          return;
        }
        reader._closedPromise_resolve(void 0);
        reader._closedPromise_resolve = void 0;
        reader._closedPromise_reject = void 0;
      }
      const NumberIsFinite = Number.isFinite || function(x2) {
        return typeof x2 === "number" && isFinite(x2);
      };
      const MathTrunc = Math.trunc || function(v) {
        return v < 0 ? Math.ceil(v) : Math.floor(v);
      };
      function isDictionary(x2) {
        return typeof x2 === "object" || typeof x2 === "function";
      }
      function assertDictionary(obj, context) {
        if (obj !== void 0 && !isDictionary(obj)) {
          throw new TypeError(`${context} is not an object.`);
        }
      }
      function assertFunction(x2, context) {
        if (typeof x2 !== "function") {
          throw new TypeError(`${context} is not a function.`);
        }
      }
      function isObject(x2) {
        return typeof x2 === "object" && x2 !== null || typeof x2 === "function";
      }
      function assertObject(x2, context) {
        if (!isObject(x2)) {
          throw new TypeError(`${context} is not an object.`);
        }
      }
      function assertRequiredArgument(x2, position, context) {
        if (x2 === void 0) {
          throw new TypeError(`Parameter ${position} is required in '${context}'.`);
        }
      }
      function assertRequiredField(x2, field, context) {
        if (x2 === void 0) {
          throw new TypeError(`${field} is required in '${context}'.`);
        }
      }
      function convertUnrestrictedDouble(value) {
        return Number(value);
      }
      function censorNegativeZero(x2) {
        return x2 === 0 ? 0 : x2;
      }
      function integerPart(x2) {
        return censorNegativeZero(MathTrunc(x2));
      }
      function convertUnsignedLongLongWithEnforceRange(value, context) {
        const lowerBound = 0;
        const upperBound = Number.MAX_SAFE_INTEGER;
        let x2 = Number(value);
        x2 = censorNegativeZero(x2);
        if (!NumberIsFinite(x2)) {
          throw new TypeError(`${context} is not a finite number`);
        }
        x2 = integerPart(x2);
        if (x2 < lowerBound || x2 > upperBound) {
          throw new TypeError(`${context} is outside the accepted range of ${lowerBound} to ${upperBound}, inclusive`);
        }
        if (!NumberIsFinite(x2) || x2 === 0) {
          return 0;
        }
        return x2;
      }
      function assertReadableStream(x2, context) {
        if (!IsReadableStream(x2)) {
          throw new TypeError(`${context} is not a ReadableStream.`);
        }
      }
      function AcquireReadableStreamDefaultReader(stream) {
        return new ReadableStreamDefaultReader(stream);
      }
      function ReadableStreamAddReadRequest(stream, readRequest) {
        stream._reader._readRequests.push(readRequest);
      }
      function ReadableStreamFulfillReadRequest(stream, chunk, done) {
        const reader = stream._reader;
        const readRequest = reader._readRequests.shift();
        if (done) {
          readRequest._closeSteps();
        } else {
          readRequest._chunkSteps(chunk);
        }
      }
      function ReadableStreamGetNumReadRequests(stream) {
        return stream._reader._readRequests.length;
      }
      function ReadableStreamHasDefaultReader(stream) {
        const reader = stream._reader;
        if (reader === void 0) {
          return false;
        }
        if (!IsReadableStreamDefaultReader(reader)) {
          return false;
        }
        return true;
      }
      class ReadableStreamDefaultReader {
        constructor(stream) {
          assertRequiredArgument(stream, 1, "ReadableStreamDefaultReader");
          assertReadableStream(stream, "First parameter");
          if (IsReadableStreamLocked(stream)) {
            throw new TypeError("This stream has already been locked for exclusive reading by another reader");
          }
          ReadableStreamReaderGenericInitialize(this, stream);
          this._readRequests = new SimpleQueue();
        }
        /**
         * Returns a promise that will be fulfilled when the stream becomes closed,
         * or rejected if the stream ever errors or the reader's lock is released before the stream finishes closing.
         */
        get closed() {
          if (!IsReadableStreamDefaultReader(this)) {
            return promiseRejectedWith(defaultReaderBrandCheckException("closed"));
          }
          return this._closedPromise;
        }
        /**
         * If the reader is active, behaves the same as {@link ReadableStream.cancel | stream.cancel(reason)}.
         */
        cancel(reason = void 0) {
          if (!IsReadableStreamDefaultReader(this)) {
            return promiseRejectedWith(defaultReaderBrandCheckException("cancel"));
          }
          if (this._ownerReadableStream === void 0) {
            return promiseRejectedWith(readerLockException("cancel"));
          }
          return ReadableStreamReaderGenericCancel(this, reason);
        }
        /**
         * Returns a promise that allows access to the next chunk from the stream's internal queue, if available.
         *
         * If reading a chunk causes the queue to become empty, more data will be pulled from the underlying source.
         */
        read() {
          if (!IsReadableStreamDefaultReader(this)) {
            return promiseRejectedWith(defaultReaderBrandCheckException("read"));
          }
          if (this._ownerReadableStream === void 0) {
            return promiseRejectedWith(readerLockException("read from"));
          }
          let resolvePromise;
          let rejectPromise;
          const promise = newPromise((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
          });
          const readRequest = {
            _chunkSteps: (chunk) => resolvePromise({ value: chunk, done: false }),
            _closeSteps: () => resolvePromise({ value: void 0, done: true }),
            _errorSteps: (e2) => rejectPromise(e2)
          };
          ReadableStreamDefaultReaderRead(this, readRequest);
          return promise;
        }
        /**
         * Releases the reader's lock on the corresponding stream. After the lock is released, the reader is no longer active.
         * If the associated stream is errored when the lock is released, the reader will appear errored in the same way
         * from now on; otherwise, the reader will appear closed.
         *
         * A reader's lock cannot be released while it still has a pending read request, i.e., if a promise returned by
         * the reader's {@link ReadableStreamDefaultReader.read | read()} method has not yet been settled. Attempting to
         * do so will throw a `TypeError` and leave the reader locked to the stream.
         */
        releaseLock() {
          if (!IsReadableStreamDefaultReader(this)) {
            throw defaultReaderBrandCheckException("releaseLock");
          }
          if (this._ownerReadableStream === void 0) {
            return;
          }
          ReadableStreamDefaultReaderRelease(this);
        }
      }
      Object.defineProperties(ReadableStreamDefaultReader.prototype, {
        cancel: { enumerable: true },
        read: { enumerable: true },
        releaseLock: { enumerable: true },
        closed: { enumerable: true }
      });
      setFunctionName(ReadableStreamDefaultReader.prototype.cancel, "cancel");
      setFunctionName(ReadableStreamDefaultReader.prototype.read, "read");
      setFunctionName(ReadableStreamDefaultReader.prototype.releaseLock, "releaseLock");
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(ReadableStreamDefaultReader.prototype, Symbol.toStringTag, {
          value: "ReadableStreamDefaultReader",
          configurable: true
        });
      }
      function IsReadableStreamDefaultReader(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_readRequests")) {
          return false;
        }
        return x2 instanceof ReadableStreamDefaultReader;
      }
      function ReadableStreamDefaultReaderRead(reader, readRequest) {
        const stream = reader._ownerReadableStream;
        stream._disturbed = true;
        if (stream._state === "closed") {
          readRequest._closeSteps();
        } else if (stream._state === "errored") {
          readRequest._errorSteps(stream._storedError);
        } else {
          stream._readableStreamController[PullSteps](readRequest);
        }
      }
      function ReadableStreamDefaultReaderRelease(reader) {
        ReadableStreamReaderGenericRelease(reader);
        const e2 = new TypeError("Reader was released");
        ReadableStreamDefaultReaderErrorReadRequests(reader, e2);
      }
      function ReadableStreamDefaultReaderErrorReadRequests(reader, e2) {
        const readRequests = reader._readRequests;
        reader._readRequests = new SimpleQueue();
        readRequests.forEach((readRequest) => {
          readRequest._errorSteps(e2);
        });
      }
      function defaultReaderBrandCheckException(name) {
        return new TypeError(`ReadableStreamDefaultReader.prototype.${name} can only be used on a ReadableStreamDefaultReader`);
      }
      const AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(async function* () {
      }).prototype);
      class ReadableStreamAsyncIteratorImpl {
        constructor(reader, preventCancel) {
          this._ongoingPromise = void 0;
          this._isFinished = false;
          this._reader = reader;
          this._preventCancel = preventCancel;
        }
        next() {
          const nextSteps = () => this._nextSteps();
          this._ongoingPromise = this._ongoingPromise ? transformPromiseWith(this._ongoingPromise, nextSteps, nextSteps) : nextSteps();
          return this._ongoingPromise;
        }
        return(value) {
          const returnSteps = () => this._returnSteps(value);
          return this._ongoingPromise ? transformPromiseWith(this._ongoingPromise, returnSteps, returnSteps) : returnSteps();
        }
        _nextSteps() {
          if (this._isFinished) {
            return Promise.resolve({ value: void 0, done: true });
          }
          const reader = this._reader;
          let resolvePromise;
          let rejectPromise;
          const promise = newPromise((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
          });
          const readRequest = {
            _chunkSteps: (chunk) => {
              this._ongoingPromise = void 0;
              _queueMicrotask(() => resolvePromise({ value: chunk, done: false }));
            },
            _closeSteps: () => {
              this._ongoingPromise = void 0;
              this._isFinished = true;
              ReadableStreamReaderGenericRelease(reader);
              resolvePromise({ value: void 0, done: true });
            },
            _errorSteps: (reason) => {
              this._ongoingPromise = void 0;
              this._isFinished = true;
              ReadableStreamReaderGenericRelease(reader);
              rejectPromise(reason);
            }
          };
          ReadableStreamDefaultReaderRead(reader, readRequest);
          return promise;
        }
        _returnSteps(value) {
          if (this._isFinished) {
            return Promise.resolve({ value, done: true });
          }
          this._isFinished = true;
          const reader = this._reader;
          if (!this._preventCancel) {
            const result = ReadableStreamReaderGenericCancel(reader, value);
            ReadableStreamReaderGenericRelease(reader);
            return transformPromiseWith(result, () => ({ value, done: true }));
          }
          ReadableStreamReaderGenericRelease(reader);
          return promiseResolvedWith({ value, done: true });
        }
      }
      const ReadableStreamAsyncIteratorPrototype = {
        next() {
          if (!IsReadableStreamAsyncIterator(this)) {
            return promiseRejectedWith(streamAsyncIteratorBrandCheckException("next"));
          }
          return this._asyncIteratorImpl.next();
        },
        return(value) {
          if (!IsReadableStreamAsyncIterator(this)) {
            return promiseRejectedWith(streamAsyncIteratorBrandCheckException("return"));
          }
          return this._asyncIteratorImpl.return(value);
        }
      };
      Object.setPrototypeOf(ReadableStreamAsyncIteratorPrototype, AsyncIteratorPrototype);
      function AcquireReadableStreamAsyncIterator(stream, preventCancel) {
        const reader = AcquireReadableStreamDefaultReader(stream);
        const impl = new ReadableStreamAsyncIteratorImpl(reader, preventCancel);
        const iterator = Object.create(ReadableStreamAsyncIteratorPrototype);
        iterator._asyncIteratorImpl = impl;
        return iterator;
      }
      function IsReadableStreamAsyncIterator(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_asyncIteratorImpl")) {
          return false;
        }
        try {
          return x2._asyncIteratorImpl instanceof ReadableStreamAsyncIteratorImpl;
        } catch (_a3) {
          return false;
        }
      }
      function streamAsyncIteratorBrandCheckException(name) {
        return new TypeError(`ReadableStreamAsyncIterator.${name} can only be used on a ReadableSteamAsyncIterator`);
      }
      const NumberIsNaN = Number.isNaN || function(x2) {
        return x2 !== x2;
      };
      var _a2, _b, _c;
      function CreateArrayFromList(elements) {
        return elements.slice();
      }
      function CopyDataBlockBytes(dest, destOffset, src, srcOffset, n) {
        new Uint8Array(dest).set(new Uint8Array(src, srcOffset, n), destOffset);
      }
      let TransferArrayBuffer = (O) => {
        if (typeof O.transfer === "function") {
          TransferArrayBuffer = (buffer) => buffer.transfer();
        } else if (typeof structuredClone === "function") {
          TransferArrayBuffer = (buffer) => structuredClone(buffer, { transfer: [buffer] });
        } else {
          TransferArrayBuffer = (buffer) => buffer;
        }
        return TransferArrayBuffer(O);
      };
      let IsDetachedBuffer = (O) => {
        if (typeof O.detached === "boolean") {
          IsDetachedBuffer = (buffer) => buffer.detached;
        } else {
          IsDetachedBuffer = (buffer) => buffer.byteLength === 0;
        }
        return IsDetachedBuffer(O);
      };
      function ArrayBufferSlice(buffer, begin, end) {
        if (buffer.slice) {
          return buffer.slice(begin, end);
        }
        const length = end - begin;
        const slice = new ArrayBuffer(length);
        CopyDataBlockBytes(slice, 0, buffer, begin, length);
        return slice;
      }
      function GetMethod(receiver, prop) {
        const func = receiver[prop];
        if (func === void 0 || func === null) {
          return void 0;
        }
        if (typeof func !== "function") {
          throw new TypeError(`${String(prop)} is not a function`);
        }
        return func;
      }
      function CreateAsyncFromSyncIterator(syncIteratorRecord) {
        const syncIterable = {
          [Symbol.iterator]: () => syncIteratorRecord.iterator
        };
        const asyncIterator = (async function* () {
          return yield* syncIterable;
        })();
        const nextMethod = asyncIterator.next;
        return { iterator: asyncIterator, nextMethod, done: false };
      }
      const SymbolAsyncIterator = (_c = (_a2 = Symbol.asyncIterator) !== null && _a2 !== void 0 ? _a2 : (_b = Symbol.for) === null || _b === void 0 ? void 0 : _b.call(Symbol, "Symbol.asyncIterator")) !== null && _c !== void 0 ? _c : "@@asyncIterator";
      function GetIterator(obj, hint = "sync", method) {
        if (method === void 0) {
          if (hint === "async") {
            method = GetMethod(obj, SymbolAsyncIterator);
            if (method === void 0) {
              const syncMethod = GetMethod(obj, Symbol.iterator);
              const syncIteratorRecord = GetIterator(obj, "sync", syncMethod);
              return CreateAsyncFromSyncIterator(syncIteratorRecord);
            }
          } else {
            method = GetMethod(obj, Symbol.iterator);
          }
        }
        if (method === void 0) {
          throw new TypeError("The object is not iterable");
        }
        const iterator = reflectCall(method, obj, []);
        if (!typeIsObject(iterator)) {
          throw new TypeError("The iterator method must return an object");
        }
        const nextMethod = iterator.next;
        return { iterator, nextMethod, done: false };
      }
      function IteratorNext(iteratorRecord) {
        const result = reflectCall(iteratorRecord.nextMethod, iteratorRecord.iterator, []);
        if (!typeIsObject(result)) {
          throw new TypeError("The iterator.next() method must return an object");
        }
        return result;
      }
      function IteratorComplete(iterResult) {
        return Boolean(iterResult.done);
      }
      function IteratorValue(iterResult) {
        return iterResult.value;
      }
      function IsNonNegativeNumber(v) {
        if (typeof v !== "number") {
          return false;
        }
        if (NumberIsNaN(v)) {
          return false;
        }
        if (v < 0) {
          return false;
        }
        return true;
      }
      function CloneAsUint8Array(O) {
        const buffer = ArrayBufferSlice(O.buffer, O.byteOffset, O.byteOffset + O.byteLength);
        return new Uint8Array(buffer);
      }
      function DequeueValue(container) {
        const pair = container._queue.shift();
        container._queueTotalSize -= pair.size;
        if (container._queueTotalSize < 0) {
          container._queueTotalSize = 0;
        }
        return pair.value;
      }
      function EnqueueValueWithSize(container, value, size) {
        if (!IsNonNegativeNumber(size) || size === Infinity) {
          throw new RangeError("Size must be a finite, non-NaN, non-negative number.");
        }
        container._queue.push({ value, size });
        container._queueTotalSize += size;
      }
      function PeekQueueValue(container) {
        const pair = container._queue.peek();
        return pair.value;
      }
      function ResetQueue(container) {
        container._queue = new SimpleQueue();
        container._queueTotalSize = 0;
      }
      function isDataViewConstructor(ctor) {
        return ctor === DataView;
      }
      function isDataView(view) {
        return isDataViewConstructor(view.constructor);
      }
      function arrayBufferViewElementSize(ctor) {
        if (isDataViewConstructor(ctor)) {
          return 1;
        }
        return ctor.BYTES_PER_ELEMENT;
      }
      class ReadableStreamBYOBRequest {
        constructor() {
          throw new TypeError("Illegal constructor");
        }
        /**
         * Returns the view for writing in to, or `null` if the BYOB request has already been responded to.
         */
        get view() {
          if (!IsReadableStreamBYOBRequest(this)) {
            throw byobRequestBrandCheckException("view");
          }
          return this._view;
        }
        respond(bytesWritten) {
          if (!IsReadableStreamBYOBRequest(this)) {
            throw byobRequestBrandCheckException("respond");
          }
          assertRequiredArgument(bytesWritten, 1, "respond");
          bytesWritten = convertUnsignedLongLongWithEnforceRange(bytesWritten, "First parameter");
          if (this._associatedReadableByteStreamController === void 0) {
            throw new TypeError("This BYOB request has been invalidated");
          }
          if (IsDetachedBuffer(this._view.buffer)) {
            throw new TypeError(`The BYOB request's buffer has been detached and so cannot be used as a response`);
          }
          ReadableByteStreamControllerRespond(this._associatedReadableByteStreamController, bytesWritten);
        }
        respondWithNewView(view) {
          if (!IsReadableStreamBYOBRequest(this)) {
            throw byobRequestBrandCheckException("respondWithNewView");
          }
          assertRequiredArgument(view, 1, "respondWithNewView");
          if (!ArrayBuffer.isView(view)) {
            throw new TypeError("You can only respond with array buffer views");
          }
          if (this._associatedReadableByteStreamController === void 0) {
            throw new TypeError("This BYOB request has been invalidated");
          }
          if (IsDetachedBuffer(view.buffer)) {
            throw new TypeError("The given view's buffer has been detached and so cannot be used as a response");
          }
          ReadableByteStreamControllerRespondWithNewView(this._associatedReadableByteStreamController, view);
        }
      }
      Object.defineProperties(ReadableStreamBYOBRequest.prototype, {
        respond: { enumerable: true },
        respondWithNewView: { enumerable: true },
        view: { enumerable: true }
      });
      setFunctionName(ReadableStreamBYOBRequest.prototype.respond, "respond");
      setFunctionName(ReadableStreamBYOBRequest.prototype.respondWithNewView, "respondWithNewView");
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(ReadableStreamBYOBRequest.prototype, Symbol.toStringTag, {
          value: "ReadableStreamBYOBRequest",
          configurable: true
        });
      }
      class ReadableByteStreamController {
        constructor() {
          throw new TypeError("Illegal constructor");
        }
        /**
         * Returns the current BYOB pull request, or `null` if there isn't one.
         */
        get byobRequest() {
          if (!IsReadableByteStreamController(this)) {
            throw byteStreamControllerBrandCheckException("byobRequest");
          }
          return ReadableByteStreamControllerGetBYOBRequest(this);
        }
        /**
         * Returns the desired size to fill the controlled stream's internal queue. It can be negative, if the queue is
         * over-full. An underlying byte source ought to use this information to determine when and how to apply backpressure.
         */
        get desiredSize() {
          if (!IsReadableByteStreamController(this)) {
            throw byteStreamControllerBrandCheckException("desiredSize");
          }
          return ReadableByteStreamControllerGetDesiredSize(this);
        }
        /**
         * Closes the controlled readable stream. Consumers will still be able to read any previously-enqueued chunks from
         * the stream, but once those are read, the stream will become closed.
         */
        close() {
          if (!IsReadableByteStreamController(this)) {
            throw byteStreamControllerBrandCheckException("close");
          }
          if (this._closeRequested) {
            throw new TypeError("The stream has already been closed; do not close it again!");
          }
          const state = this._controlledReadableByteStream._state;
          if (state !== "readable") {
            throw new TypeError(`The stream (in ${state} state) is not in the readable state and cannot be closed`);
          }
          ReadableByteStreamControllerClose(this);
        }
        enqueue(chunk) {
          if (!IsReadableByteStreamController(this)) {
            throw byteStreamControllerBrandCheckException("enqueue");
          }
          assertRequiredArgument(chunk, 1, "enqueue");
          if (!ArrayBuffer.isView(chunk)) {
            throw new TypeError("chunk must be an array buffer view");
          }
          if (chunk.byteLength === 0) {
            throw new TypeError("chunk must have non-zero byteLength");
          }
          if (chunk.buffer.byteLength === 0) {
            throw new TypeError(`chunk's buffer must have non-zero byteLength`);
          }
          if (this._closeRequested) {
            throw new TypeError("stream is closed or draining");
          }
          const state = this._controlledReadableByteStream._state;
          if (state !== "readable") {
            throw new TypeError(`The stream (in ${state} state) is not in the readable state and cannot be enqueued to`);
          }
          ReadableByteStreamControllerEnqueue(this, chunk);
        }
        /**
         * Errors the controlled readable stream, making all future interactions with it fail with the given error `e`.
         */
        error(e2 = void 0) {
          if (!IsReadableByteStreamController(this)) {
            throw byteStreamControllerBrandCheckException("error");
          }
          ReadableByteStreamControllerError(this, e2);
        }
        /** @internal */
        [CancelSteps](reason) {
          ReadableByteStreamControllerClearPendingPullIntos(this);
          ResetQueue(this);
          const result = this._cancelAlgorithm(reason);
          ReadableByteStreamControllerClearAlgorithms(this);
          return result;
        }
        /** @internal */
        [PullSteps](readRequest) {
          const stream = this._controlledReadableByteStream;
          if (this._queueTotalSize > 0) {
            ReadableByteStreamControllerFillReadRequestFromQueue(this, readRequest);
            return;
          }
          const autoAllocateChunkSize = this._autoAllocateChunkSize;
          if (autoAllocateChunkSize !== void 0) {
            let buffer;
            try {
              buffer = new ArrayBuffer(autoAllocateChunkSize);
            } catch (bufferE) {
              readRequest._errorSteps(bufferE);
              return;
            }
            const pullIntoDescriptor = {
              buffer,
              bufferByteLength: autoAllocateChunkSize,
              byteOffset: 0,
              byteLength: autoAllocateChunkSize,
              bytesFilled: 0,
              minimumFill: 1,
              elementSize: 1,
              viewConstructor: Uint8Array,
              readerType: "default"
            };
            this._pendingPullIntos.push(pullIntoDescriptor);
          }
          ReadableStreamAddReadRequest(stream, readRequest);
          ReadableByteStreamControllerCallPullIfNeeded(this);
        }
        /** @internal */
        [ReleaseSteps]() {
          if (this._pendingPullIntos.length > 0) {
            const firstPullInto = this._pendingPullIntos.peek();
            firstPullInto.readerType = "none";
            this._pendingPullIntos = new SimpleQueue();
            this._pendingPullIntos.push(firstPullInto);
          }
        }
      }
      Object.defineProperties(ReadableByteStreamController.prototype, {
        close: { enumerable: true },
        enqueue: { enumerable: true },
        error: { enumerable: true },
        byobRequest: { enumerable: true },
        desiredSize: { enumerable: true }
      });
      setFunctionName(ReadableByteStreamController.prototype.close, "close");
      setFunctionName(ReadableByteStreamController.prototype.enqueue, "enqueue");
      setFunctionName(ReadableByteStreamController.prototype.error, "error");
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(ReadableByteStreamController.prototype, Symbol.toStringTag, {
          value: "ReadableByteStreamController",
          configurable: true
        });
      }
      function IsReadableByteStreamController(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_controlledReadableByteStream")) {
          return false;
        }
        return x2 instanceof ReadableByteStreamController;
      }
      function IsReadableStreamBYOBRequest(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_associatedReadableByteStreamController")) {
          return false;
        }
        return x2 instanceof ReadableStreamBYOBRequest;
      }
      function ReadableByteStreamControllerCallPullIfNeeded(controller) {
        const shouldPull = ReadableByteStreamControllerShouldCallPull(controller);
        if (!shouldPull) {
          return;
        }
        if (controller._pulling) {
          controller._pullAgain = true;
          return;
        }
        controller._pulling = true;
        const pullPromise = controller._pullAlgorithm();
        uponPromise(pullPromise, () => {
          controller._pulling = false;
          if (controller._pullAgain) {
            controller._pullAgain = false;
            ReadableByteStreamControllerCallPullIfNeeded(controller);
          }
          return null;
        }, (e2) => {
          ReadableByteStreamControllerError(controller, e2);
          return null;
        });
      }
      function ReadableByteStreamControllerClearPendingPullIntos(controller) {
        ReadableByteStreamControllerInvalidateBYOBRequest(controller);
        controller._pendingPullIntos = new SimpleQueue();
      }
      function ReadableByteStreamControllerCommitPullIntoDescriptor(stream, pullIntoDescriptor) {
        let done = false;
        if (stream._state === "closed") {
          done = true;
        }
        const filledView = ReadableByteStreamControllerConvertPullIntoDescriptor(pullIntoDescriptor);
        if (pullIntoDescriptor.readerType === "default") {
          ReadableStreamFulfillReadRequest(stream, filledView, done);
        } else {
          ReadableStreamFulfillReadIntoRequest(stream, filledView, done);
        }
      }
      function ReadableByteStreamControllerConvertPullIntoDescriptor(pullIntoDescriptor) {
        const bytesFilled = pullIntoDescriptor.bytesFilled;
        const elementSize = pullIntoDescriptor.elementSize;
        return new pullIntoDescriptor.viewConstructor(pullIntoDescriptor.buffer, pullIntoDescriptor.byteOffset, bytesFilled / elementSize);
      }
      function ReadableByteStreamControllerEnqueueChunkToQueue(controller, buffer, byteOffset, byteLength) {
        controller._queue.push({ buffer, byteOffset, byteLength });
        controller._queueTotalSize += byteLength;
      }
      function ReadableByteStreamControllerEnqueueClonedChunkToQueue(controller, buffer, byteOffset, byteLength) {
        let clonedChunk;
        try {
          clonedChunk = ArrayBufferSlice(buffer, byteOffset, byteOffset + byteLength);
        } catch (cloneE) {
          ReadableByteStreamControllerError(controller, cloneE);
          throw cloneE;
        }
        ReadableByteStreamControllerEnqueueChunkToQueue(controller, clonedChunk, 0, byteLength);
      }
      function ReadableByteStreamControllerEnqueueDetachedPullIntoToQueue(controller, firstDescriptor) {
        if (firstDescriptor.bytesFilled > 0) {
          ReadableByteStreamControllerEnqueueClonedChunkToQueue(controller, firstDescriptor.buffer, firstDescriptor.byteOffset, firstDescriptor.bytesFilled);
        }
        ReadableByteStreamControllerShiftPendingPullInto(controller);
      }
      function ReadableByteStreamControllerFillPullIntoDescriptorFromQueue(controller, pullIntoDescriptor) {
        const maxBytesToCopy = Math.min(controller._queueTotalSize, pullIntoDescriptor.byteLength - pullIntoDescriptor.bytesFilled);
        const maxBytesFilled = pullIntoDescriptor.bytesFilled + maxBytesToCopy;
        let totalBytesToCopyRemaining = maxBytesToCopy;
        let ready = false;
        const remainderBytes = maxBytesFilled % pullIntoDescriptor.elementSize;
        const maxAlignedBytes = maxBytesFilled - remainderBytes;
        if (maxAlignedBytes >= pullIntoDescriptor.minimumFill) {
          totalBytesToCopyRemaining = maxAlignedBytes - pullIntoDescriptor.bytesFilled;
          ready = true;
        }
        const queue = controller._queue;
        while (totalBytesToCopyRemaining > 0) {
          const headOfQueue = queue.peek();
          const bytesToCopy = Math.min(totalBytesToCopyRemaining, headOfQueue.byteLength);
          const destStart = pullIntoDescriptor.byteOffset + pullIntoDescriptor.bytesFilled;
          CopyDataBlockBytes(pullIntoDescriptor.buffer, destStart, headOfQueue.buffer, headOfQueue.byteOffset, bytesToCopy);
          if (headOfQueue.byteLength === bytesToCopy) {
            queue.shift();
          } else {
            headOfQueue.byteOffset += bytesToCopy;
            headOfQueue.byteLength -= bytesToCopy;
          }
          controller._queueTotalSize -= bytesToCopy;
          ReadableByteStreamControllerFillHeadPullIntoDescriptor(controller, bytesToCopy, pullIntoDescriptor);
          totalBytesToCopyRemaining -= bytesToCopy;
        }
        return ready;
      }
      function ReadableByteStreamControllerFillHeadPullIntoDescriptor(controller, size, pullIntoDescriptor) {
        pullIntoDescriptor.bytesFilled += size;
      }
      function ReadableByteStreamControllerHandleQueueDrain(controller) {
        if (controller._queueTotalSize === 0 && controller._closeRequested) {
          ReadableByteStreamControllerClearAlgorithms(controller);
          ReadableStreamClose(controller._controlledReadableByteStream);
        } else {
          ReadableByteStreamControllerCallPullIfNeeded(controller);
        }
      }
      function ReadableByteStreamControllerInvalidateBYOBRequest(controller) {
        if (controller._byobRequest === null) {
          return;
        }
        controller._byobRequest._associatedReadableByteStreamController = void 0;
        controller._byobRequest._view = null;
        controller._byobRequest = null;
      }
      function ReadableByteStreamControllerProcessPullIntoDescriptorsUsingQueue(controller) {
        while (controller._pendingPullIntos.length > 0) {
          if (controller._queueTotalSize === 0) {
            return;
          }
          const pullIntoDescriptor = controller._pendingPullIntos.peek();
          if (ReadableByteStreamControllerFillPullIntoDescriptorFromQueue(controller, pullIntoDescriptor)) {
            ReadableByteStreamControllerShiftPendingPullInto(controller);
            ReadableByteStreamControllerCommitPullIntoDescriptor(controller._controlledReadableByteStream, pullIntoDescriptor);
          }
        }
      }
      function ReadableByteStreamControllerProcessReadRequestsUsingQueue(controller) {
        const reader = controller._controlledReadableByteStream._reader;
        while (reader._readRequests.length > 0) {
          if (controller._queueTotalSize === 0) {
            return;
          }
          const readRequest = reader._readRequests.shift();
          ReadableByteStreamControllerFillReadRequestFromQueue(controller, readRequest);
        }
      }
      function ReadableByteStreamControllerPullInto(controller, view, min, readIntoRequest) {
        const stream = controller._controlledReadableByteStream;
        const ctor = view.constructor;
        const elementSize = arrayBufferViewElementSize(ctor);
        const { byteOffset, byteLength } = view;
        const minimumFill = min * elementSize;
        let buffer;
        try {
          buffer = TransferArrayBuffer(view.buffer);
        } catch (e2) {
          readIntoRequest._errorSteps(e2);
          return;
        }
        const pullIntoDescriptor = {
          buffer,
          bufferByteLength: buffer.byteLength,
          byteOffset,
          byteLength,
          bytesFilled: 0,
          minimumFill,
          elementSize,
          viewConstructor: ctor,
          readerType: "byob"
        };
        if (controller._pendingPullIntos.length > 0) {
          controller._pendingPullIntos.push(pullIntoDescriptor);
          ReadableStreamAddReadIntoRequest(stream, readIntoRequest);
          return;
        }
        if (stream._state === "closed") {
          const emptyView = new ctor(pullIntoDescriptor.buffer, pullIntoDescriptor.byteOffset, 0);
          readIntoRequest._closeSteps(emptyView);
          return;
        }
        if (controller._queueTotalSize > 0) {
          if (ReadableByteStreamControllerFillPullIntoDescriptorFromQueue(controller, pullIntoDescriptor)) {
            const filledView = ReadableByteStreamControllerConvertPullIntoDescriptor(pullIntoDescriptor);
            ReadableByteStreamControllerHandleQueueDrain(controller);
            readIntoRequest._chunkSteps(filledView);
            return;
          }
          if (controller._closeRequested) {
            const e2 = new TypeError("Insufficient bytes to fill elements in the given buffer");
            ReadableByteStreamControllerError(controller, e2);
            readIntoRequest._errorSteps(e2);
            return;
          }
        }
        controller._pendingPullIntos.push(pullIntoDescriptor);
        ReadableStreamAddReadIntoRequest(stream, readIntoRequest);
        ReadableByteStreamControllerCallPullIfNeeded(controller);
      }
      function ReadableByteStreamControllerRespondInClosedState(controller, firstDescriptor) {
        if (firstDescriptor.readerType === "none") {
          ReadableByteStreamControllerShiftPendingPullInto(controller);
        }
        const stream = controller._controlledReadableByteStream;
        if (ReadableStreamHasBYOBReader(stream)) {
          while (ReadableStreamGetNumReadIntoRequests(stream) > 0) {
            const pullIntoDescriptor = ReadableByteStreamControllerShiftPendingPullInto(controller);
            ReadableByteStreamControllerCommitPullIntoDescriptor(stream, pullIntoDescriptor);
          }
        }
      }
      function ReadableByteStreamControllerRespondInReadableState(controller, bytesWritten, pullIntoDescriptor) {
        ReadableByteStreamControllerFillHeadPullIntoDescriptor(controller, bytesWritten, pullIntoDescriptor);
        if (pullIntoDescriptor.readerType === "none") {
          ReadableByteStreamControllerEnqueueDetachedPullIntoToQueue(controller, pullIntoDescriptor);
          ReadableByteStreamControllerProcessPullIntoDescriptorsUsingQueue(controller);
          return;
        }
        if (pullIntoDescriptor.bytesFilled < pullIntoDescriptor.minimumFill) {
          return;
        }
        ReadableByteStreamControllerShiftPendingPullInto(controller);
        const remainderSize = pullIntoDescriptor.bytesFilled % pullIntoDescriptor.elementSize;
        if (remainderSize > 0) {
          const end = pullIntoDescriptor.byteOffset + pullIntoDescriptor.bytesFilled;
          ReadableByteStreamControllerEnqueueClonedChunkToQueue(controller, pullIntoDescriptor.buffer, end - remainderSize, remainderSize);
        }
        pullIntoDescriptor.bytesFilled -= remainderSize;
        ReadableByteStreamControllerCommitPullIntoDescriptor(controller._controlledReadableByteStream, pullIntoDescriptor);
        ReadableByteStreamControllerProcessPullIntoDescriptorsUsingQueue(controller);
      }
      function ReadableByteStreamControllerRespondInternal(controller, bytesWritten) {
        const firstDescriptor = controller._pendingPullIntos.peek();
        ReadableByteStreamControllerInvalidateBYOBRequest(controller);
        const state = controller._controlledReadableByteStream._state;
        if (state === "closed") {
          ReadableByteStreamControllerRespondInClosedState(controller, firstDescriptor);
        } else {
          ReadableByteStreamControllerRespondInReadableState(controller, bytesWritten, firstDescriptor);
        }
        ReadableByteStreamControllerCallPullIfNeeded(controller);
      }
      function ReadableByteStreamControllerShiftPendingPullInto(controller) {
        const descriptor = controller._pendingPullIntos.shift();
        return descriptor;
      }
      function ReadableByteStreamControllerShouldCallPull(controller) {
        const stream = controller._controlledReadableByteStream;
        if (stream._state !== "readable") {
          return false;
        }
        if (controller._closeRequested) {
          return false;
        }
        if (!controller._started) {
          return false;
        }
        if (ReadableStreamHasDefaultReader(stream) && ReadableStreamGetNumReadRequests(stream) > 0) {
          return true;
        }
        if (ReadableStreamHasBYOBReader(stream) && ReadableStreamGetNumReadIntoRequests(stream) > 0) {
          return true;
        }
        const desiredSize = ReadableByteStreamControllerGetDesiredSize(controller);
        if (desiredSize > 0) {
          return true;
        }
        return false;
      }
      function ReadableByteStreamControllerClearAlgorithms(controller) {
        controller._pullAlgorithm = void 0;
        controller._cancelAlgorithm = void 0;
      }
      function ReadableByteStreamControllerClose(controller) {
        const stream = controller._controlledReadableByteStream;
        if (controller._closeRequested || stream._state !== "readable") {
          return;
        }
        if (controller._queueTotalSize > 0) {
          controller._closeRequested = true;
          return;
        }
        if (controller._pendingPullIntos.length > 0) {
          const firstPendingPullInto = controller._pendingPullIntos.peek();
          if (firstPendingPullInto.bytesFilled % firstPendingPullInto.elementSize !== 0) {
            const e2 = new TypeError("Insufficient bytes to fill elements in the given buffer");
            ReadableByteStreamControllerError(controller, e2);
            throw e2;
          }
        }
        ReadableByteStreamControllerClearAlgorithms(controller);
        ReadableStreamClose(stream);
      }
      function ReadableByteStreamControllerEnqueue(controller, chunk) {
        const stream = controller._controlledReadableByteStream;
        if (controller._closeRequested || stream._state !== "readable") {
          return;
        }
        const { buffer, byteOffset, byteLength } = chunk;
        if (IsDetachedBuffer(buffer)) {
          throw new TypeError("chunk's buffer is detached and so cannot be enqueued");
        }
        const transferredBuffer = TransferArrayBuffer(buffer);
        if (controller._pendingPullIntos.length > 0) {
          const firstPendingPullInto = controller._pendingPullIntos.peek();
          if (IsDetachedBuffer(firstPendingPullInto.buffer)) {
            throw new TypeError("The BYOB request's buffer has been detached and so cannot be filled with an enqueued chunk");
          }
          ReadableByteStreamControllerInvalidateBYOBRequest(controller);
          firstPendingPullInto.buffer = TransferArrayBuffer(firstPendingPullInto.buffer);
          if (firstPendingPullInto.readerType === "none") {
            ReadableByteStreamControllerEnqueueDetachedPullIntoToQueue(controller, firstPendingPullInto);
          }
        }
        if (ReadableStreamHasDefaultReader(stream)) {
          ReadableByteStreamControllerProcessReadRequestsUsingQueue(controller);
          if (ReadableStreamGetNumReadRequests(stream) === 0) {
            ReadableByteStreamControllerEnqueueChunkToQueue(controller, transferredBuffer, byteOffset, byteLength);
          } else {
            if (controller._pendingPullIntos.length > 0) {
              ReadableByteStreamControllerShiftPendingPullInto(controller);
            }
            const transferredView = new Uint8Array(transferredBuffer, byteOffset, byteLength);
            ReadableStreamFulfillReadRequest(stream, transferredView, false);
          }
        } else if (ReadableStreamHasBYOBReader(stream)) {
          ReadableByteStreamControllerEnqueueChunkToQueue(controller, transferredBuffer, byteOffset, byteLength);
          ReadableByteStreamControllerProcessPullIntoDescriptorsUsingQueue(controller);
        } else {
          ReadableByteStreamControllerEnqueueChunkToQueue(controller, transferredBuffer, byteOffset, byteLength);
        }
        ReadableByteStreamControllerCallPullIfNeeded(controller);
      }
      function ReadableByteStreamControllerError(controller, e2) {
        const stream = controller._controlledReadableByteStream;
        if (stream._state !== "readable") {
          return;
        }
        ReadableByteStreamControllerClearPendingPullIntos(controller);
        ResetQueue(controller);
        ReadableByteStreamControllerClearAlgorithms(controller);
        ReadableStreamError(stream, e2);
      }
      function ReadableByteStreamControllerFillReadRequestFromQueue(controller, readRequest) {
        const entry = controller._queue.shift();
        controller._queueTotalSize -= entry.byteLength;
        ReadableByteStreamControllerHandleQueueDrain(controller);
        const view = new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength);
        readRequest._chunkSteps(view);
      }
      function ReadableByteStreamControllerGetBYOBRequest(controller) {
        if (controller._byobRequest === null && controller._pendingPullIntos.length > 0) {
          const firstDescriptor = controller._pendingPullIntos.peek();
          const view = new Uint8Array(firstDescriptor.buffer, firstDescriptor.byteOffset + firstDescriptor.bytesFilled, firstDescriptor.byteLength - firstDescriptor.bytesFilled);
          const byobRequest = Object.create(ReadableStreamBYOBRequest.prototype);
          SetUpReadableStreamBYOBRequest(byobRequest, controller, view);
          controller._byobRequest = byobRequest;
        }
        return controller._byobRequest;
      }
      function ReadableByteStreamControllerGetDesiredSize(controller) {
        const state = controller._controlledReadableByteStream._state;
        if (state === "errored") {
          return null;
        }
        if (state === "closed") {
          return 0;
        }
        return controller._strategyHWM - controller._queueTotalSize;
      }
      function ReadableByteStreamControllerRespond(controller, bytesWritten) {
        const firstDescriptor = controller._pendingPullIntos.peek();
        const state = controller._controlledReadableByteStream._state;
        if (state === "closed") {
          if (bytesWritten !== 0) {
            throw new TypeError("bytesWritten must be 0 when calling respond() on a closed stream");
          }
        } else {
          if (bytesWritten === 0) {
            throw new TypeError("bytesWritten must be greater than 0 when calling respond() on a readable stream");
          }
          if (firstDescriptor.bytesFilled + bytesWritten > firstDescriptor.byteLength) {
            throw new RangeError("bytesWritten out of range");
          }
        }
        firstDescriptor.buffer = TransferArrayBuffer(firstDescriptor.buffer);
        ReadableByteStreamControllerRespondInternal(controller, bytesWritten);
      }
      function ReadableByteStreamControllerRespondWithNewView(controller, view) {
        const firstDescriptor = controller._pendingPullIntos.peek();
        const state = controller._controlledReadableByteStream._state;
        if (state === "closed") {
          if (view.byteLength !== 0) {
            throw new TypeError("The view's length must be 0 when calling respondWithNewView() on a closed stream");
          }
        } else {
          if (view.byteLength === 0) {
            throw new TypeError("The view's length must be greater than 0 when calling respondWithNewView() on a readable stream");
          }
        }
        if (firstDescriptor.byteOffset + firstDescriptor.bytesFilled !== view.byteOffset) {
          throw new RangeError("The region specified by view does not match byobRequest");
        }
        if (firstDescriptor.bufferByteLength !== view.buffer.byteLength) {
          throw new RangeError("The buffer of view has different capacity than byobRequest");
        }
        if (firstDescriptor.bytesFilled + view.byteLength > firstDescriptor.byteLength) {
          throw new RangeError("The region specified by view is larger than byobRequest");
        }
        const viewByteLength = view.byteLength;
        firstDescriptor.buffer = TransferArrayBuffer(view.buffer);
        ReadableByteStreamControllerRespondInternal(controller, viewByteLength);
      }
      function SetUpReadableByteStreamController(stream, controller, startAlgorithm, pullAlgorithm, cancelAlgorithm, highWaterMark, autoAllocateChunkSize) {
        controller._controlledReadableByteStream = stream;
        controller._pullAgain = false;
        controller._pulling = false;
        controller._byobRequest = null;
        controller._queue = controller._queueTotalSize = void 0;
        ResetQueue(controller);
        controller._closeRequested = false;
        controller._started = false;
        controller._strategyHWM = highWaterMark;
        controller._pullAlgorithm = pullAlgorithm;
        controller._cancelAlgorithm = cancelAlgorithm;
        controller._autoAllocateChunkSize = autoAllocateChunkSize;
        controller._pendingPullIntos = new SimpleQueue();
        stream._readableStreamController = controller;
        const startResult = startAlgorithm();
        uponPromise(promiseResolvedWith(startResult), () => {
          controller._started = true;
          ReadableByteStreamControllerCallPullIfNeeded(controller);
          return null;
        }, (r2) => {
          ReadableByteStreamControllerError(controller, r2);
          return null;
        });
      }
      function SetUpReadableByteStreamControllerFromUnderlyingSource(stream, underlyingByteSource, highWaterMark) {
        const controller = Object.create(ReadableByteStreamController.prototype);
        let startAlgorithm;
        let pullAlgorithm;
        let cancelAlgorithm;
        if (underlyingByteSource.start !== void 0) {
          startAlgorithm = () => underlyingByteSource.start(controller);
        } else {
          startAlgorithm = () => void 0;
        }
        if (underlyingByteSource.pull !== void 0) {
          pullAlgorithm = () => underlyingByteSource.pull(controller);
        } else {
          pullAlgorithm = () => promiseResolvedWith(void 0);
        }
        if (underlyingByteSource.cancel !== void 0) {
          cancelAlgorithm = (reason) => underlyingByteSource.cancel(reason);
        } else {
          cancelAlgorithm = () => promiseResolvedWith(void 0);
        }
        const autoAllocateChunkSize = underlyingByteSource.autoAllocateChunkSize;
        if (autoAllocateChunkSize === 0) {
          throw new TypeError("autoAllocateChunkSize must be greater than 0");
        }
        SetUpReadableByteStreamController(stream, controller, startAlgorithm, pullAlgorithm, cancelAlgorithm, highWaterMark, autoAllocateChunkSize);
      }
      function SetUpReadableStreamBYOBRequest(request2, controller, view) {
        request2._associatedReadableByteStreamController = controller;
        request2._view = view;
      }
      function byobRequestBrandCheckException(name) {
        return new TypeError(`ReadableStreamBYOBRequest.prototype.${name} can only be used on a ReadableStreamBYOBRequest`);
      }
      function byteStreamControllerBrandCheckException(name) {
        return new TypeError(`ReadableByteStreamController.prototype.${name} can only be used on a ReadableByteStreamController`);
      }
      function convertReaderOptions(options, context) {
        assertDictionary(options, context);
        const mode = options === null || options === void 0 ? void 0 : options.mode;
        return {
          mode: mode === void 0 ? void 0 : convertReadableStreamReaderMode(mode, `${context} has member 'mode' that`)
        };
      }
      function convertReadableStreamReaderMode(mode, context) {
        mode = `${mode}`;
        if (mode !== "byob") {
          throw new TypeError(`${context} '${mode}' is not a valid enumeration value for ReadableStreamReaderMode`);
        }
        return mode;
      }
      function convertByobReadOptions(options, context) {
        var _a3;
        assertDictionary(options, context);
        const min = (_a3 = options === null || options === void 0 ? void 0 : options.min) !== null && _a3 !== void 0 ? _a3 : 1;
        return {
          min: convertUnsignedLongLongWithEnforceRange(min, `${context} has member 'min' that`)
        };
      }
      function AcquireReadableStreamBYOBReader(stream) {
        return new ReadableStreamBYOBReader(stream);
      }
      function ReadableStreamAddReadIntoRequest(stream, readIntoRequest) {
        stream._reader._readIntoRequests.push(readIntoRequest);
      }
      function ReadableStreamFulfillReadIntoRequest(stream, chunk, done) {
        const reader = stream._reader;
        const readIntoRequest = reader._readIntoRequests.shift();
        if (done) {
          readIntoRequest._closeSteps(chunk);
        } else {
          readIntoRequest._chunkSteps(chunk);
        }
      }
      function ReadableStreamGetNumReadIntoRequests(stream) {
        return stream._reader._readIntoRequests.length;
      }
      function ReadableStreamHasBYOBReader(stream) {
        const reader = stream._reader;
        if (reader === void 0) {
          return false;
        }
        if (!IsReadableStreamBYOBReader(reader)) {
          return false;
        }
        return true;
      }
      class ReadableStreamBYOBReader {
        constructor(stream) {
          assertRequiredArgument(stream, 1, "ReadableStreamBYOBReader");
          assertReadableStream(stream, "First parameter");
          if (IsReadableStreamLocked(stream)) {
            throw new TypeError("This stream has already been locked for exclusive reading by another reader");
          }
          if (!IsReadableByteStreamController(stream._readableStreamController)) {
            throw new TypeError("Cannot construct a ReadableStreamBYOBReader for a stream not constructed with a byte source");
          }
          ReadableStreamReaderGenericInitialize(this, stream);
          this._readIntoRequests = new SimpleQueue();
        }
        /**
         * Returns a promise that will be fulfilled when the stream becomes closed, or rejected if the stream ever errors or
         * the reader's lock is released before the stream finishes closing.
         */
        get closed() {
          if (!IsReadableStreamBYOBReader(this)) {
            return promiseRejectedWith(byobReaderBrandCheckException("closed"));
          }
          return this._closedPromise;
        }
        /**
         * If the reader is active, behaves the same as {@link ReadableStream.cancel | stream.cancel(reason)}.
         */
        cancel(reason = void 0) {
          if (!IsReadableStreamBYOBReader(this)) {
            return promiseRejectedWith(byobReaderBrandCheckException("cancel"));
          }
          if (this._ownerReadableStream === void 0) {
            return promiseRejectedWith(readerLockException("cancel"));
          }
          return ReadableStreamReaderGenericCancel(this, reason);
        }
        read(view, rawOptions = {}) {
          if (!IsReadableStreamBYOBReader(this)) {
            return promiseRejectedWith(byobReaderBrandCheckException("read"));
          }
          if (!ArrayBuffer.isView(view)) {
            return promiseRejectedWith(new TypeError("view must be an array buffer view"));
          }
          if (view.byteLength === 0) {
            return promiseRejectedWith(new TypeError("view must have non-zero byteLength"));
          }
          if (view.buffer.byteLength === 0) {
            return promiseRejectedWith(new TypeError(`view's buffer must have non-zero byteLength`));
          }
          if (IsDetachedBuffer(view.buffer)) {
            return promiseRejectedWith(new TypeError("view's buffer has been detached"));
          }
          let options;
          try {
            options = convertByobReadOptions(rawOptions, "options");
          } catch (e2) {
            return promiseRejectedWith(e2);
          }
          const min = options.min;
          if (min === 0) {
            return promiseRejectedWith(new TypeError("options.min must be greater than 0"));
          }
          if (!isDataView(view)) {
            if (min > view.length) {
              return promiseRejectedWith(new RangeError("options.min must be less than or equal to view's length"));
            }
          } else if (min > view.byteLength) {
            return promiseRejectedWith(new RangeError("options.min must be less than or equal to view's byteLength"));
          }
          if (this._ownerReadableStream === void 0) {
            return promiseRejectedWith(readerLockException("read from"));
          }
          let resolvePromise;
          let rejectPromise;
          const promise = newPromise((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
          });
          const readIntoRequest = {
            _chunkSteps: (chunk) => resolvePromise({ value: chunk, done: false }),
            _closeSteps: (chunk) => resolvePromise({ value: chunk, done: true }),
            _errorSteps: (e2) => rejectPromise(e2)
          };
          ReadableStreamBYOBReaderRead(this, view, min, readIntoRequest);
          return promise;
        }
        /**
         * Releases the reader's lock on the corresponding stream. After the lock is released, the reader is no longer active.
         * If the associated stream is errored when the lock is released, the reader will appear errored in the same way
         * from now on; otherwise, the reader will appear closed.
         *
         * A reader's lock cannot be released while it still has a pending read request, i.e., if a promise returned by
         * the reader's {@link ReadableStreamBYOBReader.read | read()} method has not yet been settled. Attempting to
         * do so will throw a `TypeError` and leave the reader locked to the stream.
         */
        releaseLock() {
          if (!IsReadableStreamBYOBReader(this)) {
            throw byobReaderBrandCheckException("releaseLock");
          }
          if (this._ownerReadableStream === void 0) {
            return;
          }
          ReadableStreamBYOBReaderRelease(this);
        }
      }
      Object.defineProperties(ReadableStreamBYOBReader.prototype, {
        cancel: { enumerable: true },
        read: { enumerable: true },
        releaseLock: { enumerable: true },
        closed: { enumerable: true }
      });
      setFunctionName(ReadableStreamBYOBReader.prototype.cancel, "cancel");
      setFunctionName(ReadableStreamBYOBReader.prototype.read, "read");
      setFunctionName(ReadableStreamBYOBReader.prototype.releaseLock, "releaseLock");
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(ReadableStreamBYOBReader.prototype, Symbol.toStringTag, {
          value: "ReadableStreamBYOBReader",
          configurable: true
        });
      }
      function IsReadableStreamBYOBReader(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_readIntoRequests")) {
          return false;
        }
        return x2 instanceof ReadableStreamBYOBReader;
      }
      function ReadableStreamBYOBReaderRead(reader, view, min, readIntoRequest) {
        const stream = reader._ownerReadableStream;
        stream._disturbed = true;
        if (stream._state === "errored") {
          readIntoRequest._errorSteps(stream._storedError);
        } else {
          ReadableByteStreamControllerPullInto(stream._readableStreamController, view, min, readIntoRequest);
        }
      }
      function ReadableStreamBYOBReaderRelease(reader) {
        ReadableStreamReaderGenericRelease(reader);
        const e2 = new TypeError("Reader was released");
        ReadableStreamBYOBReaderErrorReadIntoRequests(reader, e2);
      }
      function ReadableStreamBYOBReaderErrorReadIntoRequests(reader, e2) {
        const readIntoRequests = reader._readIntoRequests;
        reader._readIntoRequests = new SimpleQueue();
        readIntoRequests.forEach((readIntoRequest) => {
          readIntoRequest._errorSteps(e2);
        });
      }
      function byobReaderBrandCheckException(name) {
        return new TypeError(`ReadableStreamBYOBReader.prototype.${name} can only be used on a ReadableStreamBYOBReader`);
      }
      function ExtractHighWaterMark(strategy, defaultHWM) {
        const { highWaterMark } = strategy;
        if (highWaterMark === void 0) {
          return defaultHWM;
        }
        if (NumberIsNaN(highWaterMark) || highWaterMark < 0) {
          throw new RangeError("Invalid highWaterMark");
        }
        return highWaterMark;
      }
      function ExtractSizeAlgorithm(strategy) {
        const { size } = strategy;
        if (!size) {
          return () => 1;
        }
        return size;
      }
      function convertQueuingStrategy(init, context) {
        assertDictionary(init, context);
        const highWaterMark = init === null || init === void 0 ? void 0 : init.highWaterMark;
        const size = init === null || init === void 0 ? void 0 : init.size;
        return {
          highWaterMark: highWaterMark === void 0 ? void 0 : convertUnrestrictedDouble(highWaterMark),
          size: size === void 0 ? void 0 : convertQueuingStrategySize(size, `${context} has member 'size' that`)
        };
      }
      function convertQueuingStrategySize(fn, context) {
        assertFunction(fn, context);
        return (chunk) => convertUnrestrictedDouble(fn(chunk));
      }
      function convertUnderlyingSink(original, context) {
        assertDictionary(original, context);
        const abort = original === null || original === void 0 ? void 0 : original.abort;
        const close = original === null || original === void 0 ? void 0 : original.close;
        const start = original === null || original === void 0 ? void 0 : original.start;
        const type = original === null || original === void 0 ? void 0 : original.type;
        const write = original === null || original === void 0 ? void 0 : original.write;
        return {
          abort: abort === void 0 ? void 0 : convertUnderlyingSinkAbortCallback(abort, original, `${context} has member 'abort' that`),
          close: close === void 0 ? void 0 : convertUnderlyingSinkCloseCallback(close, original, `${context} has member 'close' that`),
          start: start === void 0 ? void 0 : convertUnderlyingSinkStartCallback(start, original, `${context} has member 'start' that`),
          write: write === void 0 ? void 0 : convertUnderlyingSinkWriteCallback(write, original, `${context} has member 'write' that`),
          type
        };
      }
      function convertUnderlyingSinkAbortCallback(fn, original, context) {
        assertFunction(fn, context);
        return (reason) => promiseCall(fn, original, [reason]);
      }
      function convertUnderlyingSinkCloseCallback(fn, original, context) {
        assertFunction(fn, context);
        return () => promiseCall(fn, original, []);
      }
      function convertUnderlyingSinkStartCallback(fn, original, context) {
        assertFunction(fn, context);
        return (controller) => reflectCall(fn, original, [controller]);
      }
      function convertUnderlyingSinkWriteCallback(fn, original, context) {
        assertFunction(fn, context);
        return (chunk, controller) => promiseCall(fn, original, [chunk, controller]);
      }
      function assertWritableStream(x2, context) {
        if (!IsWritableStream(x2)) {
          throw new TypeError(`${context} is not a WritableStream.`);
        }
      }
      function isAbortSignal2(value) {
        if (typeof value !== "object" || value === null) {
          return false;
        }
        try {
          return typeof value.aborted === "boolean";
        } catch (_a3) {
          return false;
        }
      }
      const supportsAbortController = typeof AbortController === "function";
      function createAbortController() {
        if (supportsAbortController) {
          return new AbortController();
        }
        return void 0;
      }
      class WritableStream {
        constructor(rawUnderlyingSink = {}, rawStrategy = {}) {
          if (rawUnderlyingSink === void 0) {
            rawUnderlyingSink = null;
          } else {
            assertObject(rawUnderlyingSink, "First parameter");
          }
          const strategy = convertQueuingStrategy(rawStrategy, "Second parameter");
          const underlyingSink = convertUnderlyingSink(rawUnderlyingSink, "First parameter");
          InitializeWritableStream(this);
          const type = underlyingSink.type;
          if (type !== void 0) {
            throw new RangeError("Invalid type is specified");
          }
          const sizeAlgorithm = ExtractSizeAlgorithm(strategy);
          const highWaterMark = ExtractHighWaterMark(strategy, 1);
          SetUpWritableStreamDefaultControllerFromUnderlyingSink(this, underlyingSink, highWaterMark, sizeAlgorithm);
        }
        /**
         * Returns whether or not the writable stream is locked to a writer.
         */
        get locked() {
          if (!IsWritableStream(this)) {
            throw streamBrandCheckException$2("locked");
          }
          return IsWritableStreamLocked(this);
        }
        /**
         * Aborts the stream, signaling that the producer can no longer successfully write to the stream and it is to be
         * immediately moved to an errored state, with any queued-up writes discarded. This will also execute any abort
         * mechanism of the underlying sink.
         *
         * The returned promise will fulfill if the stream shuts down successfully, or reject if the underlying sink signaled
         * that there was an error doing so. Additionally, it will reject with a `TypeError` (without attempting to cancel
         * the stream) if the stream is currently locked.
         */
        abort(reason = void 0) {
          if (!IsWritableStream(this)) {
            return promiseRejectedWith(streamBrandCheckException$2("abort"));
          }
          if (IsWritableStreamLocked(this)) {
            return promiseRejectedWith(new TypeError("Cannot abort a stream that already has a writer"));
          }
          return WritableStreamAbort(this, reason);
        }
        /**
         * Closes the stream. The underlying sink will finish processing any previously-written chunks, before invoking its
         * close behavior. During this time any further attempts to write will fail (without erroring the stream).
         *
         * The method returns a promise that will fulfill if all remaining chunks are successfully written and the stream
         * successfully closes, or rejects if an error is encountered during this process. Additionally, it will reject with
         * a `TypeError` (without attempting to cancel the stream) if the stream is currently locked.
         */
        close() {
          if (!IsWritableStream(this)) {
            return promiseRejectedWith(streamBrandCheckException$2("close"));
          }
          if (IsWritableStreamLocked(this)) {
            return promiseRejectedWith(new TypeError("Cannot close a stream that already has a writer"));
          }
          if (WritableStreamCloseQueuedOrInFlight(this)) {
            return promiseRejectedWith(new TypeError("Cannot close an already-closing stream"));
          }
          return WritableStreamClose(this);
        }
        /**
         * Creates a {@link WritableStreamDefaultWriter | writer} and locks the stream to the new writer. While the stream
         * is locked, no other writer can be acquired until this one is released.
         *
         * This functionality is especially useful for creating abstractions that desire the ability to write to a stream
         * without interruption or interleaving. By getting a writer for the stream, you can ensure nobody else can write at
         * the same time, which would cause the resulting written data to be unpredictable and probably useless.
         */
        getWriter() {
          if (!IsWritableStream(this)) {
            throw streamBrandCheckException$2("getWriter");
          }
          return AcquireWritableStreamDefaultWriter(this);
        }
      }
      Object.defineProperties(WritableStream.prototype, {
        abort: { enumerable: true },
        close: { enumerable: true },
        getWriter: { enumerable: true },
        locked: { enumerable: true }
      });
      setFunctionName(WritableStream.prototype.abort, "abort");
      setFunctionName(WritableStream.prototype.close, "close");
      setFunctionName(WritableStream.prototype.getWriter, "getWriter");
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(WritableStream.prototype, Symbol.toStringTag, {
          value: "WritableStream",
          configurable: true
        });
      }
      function AcquireWritableStreamDefaultWriter(stream) {
        return new WritableStreamDefaultWriter(stream);
      }
      function CreateWritableStream(startAlgorithm, writeAlgorithm, closeAlgorithm, abortAlgorithm, highWaterMark = 1, sizeAlgorithm = () => 1) {
        const stream = Object.create(WritableStream.prototype);
        InitializeWritableStream(stream);
        const controller = Object.create(WritableStreamDefaultController.prototype);
        SetUpWritableStreamDefaultController(stream, controller, startAlgorithm, writeAlgorithm, closeAlgorithm, abortAlgorithm, highWaterMark, sizeAlgorithm);
        return stream;
      }
      function InitializeWritableStream(stream) {
        stream._state = "writable";
        stream._storedError = void 0;
        stream._writer = void 0;
        stream._writableStreamController = void 0;
        stream._writeRequests = new SimpleQueue();
        stream._inFlightWriteRequest = void 0;
        stream._closeRequest = void 0;
        stream._inFlightCloseRequest = void 0;
        stream._pendingAbortRequest = void 0;
        stream._backpressure = false;
      }
      function IsWritableStream(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_writableStreamController")) {
          return false;
        }
        return x2 instanceof WritableStream;
      }
      function IsWritableStreamLocked(stream) {
        if (stream._writer === void 0) {
          return false;
        }
        return true;
      }
      function WritableStreamAbort(stream, reason) {
        var _a3;
        if (stream._state === "closed" || stream._state === "errored") {
          return promiseResolvedWith(void 0);
        }
        stream._writableStreamController._abortReason = reason;
        (_a3 = stream._writableStreamController._abortController) === null || _a3 === void 0 ? void 0 : _a3.abort(reason);
        const state = stream._state;
        if (state === "closed" || state === "errored") {
          return promiseResolvedWith(void 0);
        }
        if (stream._pendingAbortRequest !== void 0) {
          return stream._pendingAbortRequest._promise;
        }
        let wasAlreadyErroring = false;
        if (state === "erroring") {
          wasAlreadyErroring = true;
          reason = void 0;
        }
        const promise = newPromise((resolve, reject) => {
          stream._pendingAbortRequest = {
            _promise: void 0,
            _resolve: resolve,
            _reject: reject,
            _reason: reason,
            _wasAlreadyErroring: wasAlreadyErroring
          };
        });
        stream._pendingAbortRequest._promise = promise;
        if (!wasAlreadyErroring) {
          WritableStreamStartErroring(stream, reason);
        }
        return promise;
      }
      function WritableStreamClose(stream) {
        const state = stream._state;
        if (state === "closed" || state === "errored") {
          return promiseRejectedWith(new TypeError(`The stream (in ${state} state) is not in the writable state and cannot be closed`));
        }
        const promise = newPromise((resolve, reject) => {
          const closeRequest = {
            _resolve: resolve,
            _reject: reject
          };
          stream._closeRequest = closeRequest;
        });
        const writer = stream._writer;
        if (writer !== void 0 && stream._backpressure && state === "writable") {
          defaultWriterReadyPromiseResolve(writer);
        }
        WritableStreamDefaultControllerClose(stream._writableStreamController);
        return promise;
      }
      function WritableStreamAddWriteRequest(stream) {
        const promise = newPromise((resolve, reject) => {
          const writeRequest = {
            _resolve: resolve,
            _reject: reject
          };
          stream._writeRequests.push(writeRequest);
        });
        return promise;
      }
      function WritableStreamDealWithRejection(stream, error) {
        const state = stream._state;
        if (state === "writable") {
          WritableStreamStartErroring(stream, error);
          return;
        }
        WritableStreamFinishErroring(stream);
      }
      function WritableStreamStartErroring(stream, reason) {
        const controller = stream._writableStreamController;
        stream._state = "erroring";
        stream._storedError = reason;
        const writer = stream._writer;
        if (writer !== void 0) {
          WritableStreamDefaultWriterEnsureReadyPromiseRejected(writer, reason);
        }
        if (!WritableStreamHasOperationMarkedInFlight(stream) && controller._started) {
          WritableStreamFinishErroring(stream);
        }
      }
      function WritableStreamFinishErroring(stream) {
        stream._state = "errored";
        stream._writableStreamController[ErrorSteps]();
        const storedError = stream._storedError;
        stream._writeRequests.forEach((writeRequest) => {
          writeRequest._reject(storedError);
        });
        stream._writeRequests = new SimpleQueue();
        if (stream._pendingAbortRequest === void 0) {
          WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
          return;
        }
        const abortRequest = stream._pendingAbortRequest;
        stream._pendingAbortRequest = void 0;
        if (abortRequest._wasAlreadyErroring) {
          abortRequest._reject(storedError);
          WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
          return;
        }
        const promise = stream._writableStreamController[AbortSteps](abortRequest._reason);
        uponPromise(promise, () => {
          abortRequest._resolve();
          WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
          return null;
        }, (reason) => {
          abortRequest._reject(reason);
          WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
          return null;
        });
      }
      function WritableStreamFinishInFlightWrite(stream) {
        stream._inFlightWriteRequest._resolve(void 0);
        stream._inFlightWriteRequest = void 0;
      }
      function WritableStreamFinishInFlightWriteWithError(stream, error) {
        stream._inFlightWriteRequest._reject(error);
        stream._inFlightWriteRequest = void 0;
        WritableStreamDealWithRejection(stream, error);
      }
      function WritableStreamFinishInFlightClose(stream) {
        stream._inFlightCloseRequest._resolve(void 0);
        stream._inFlightCloseRequest = void 0;
        const state = stream._state;
        if (state === "erroring") {
          stream._storedError = void 0;
          if (stream._pendingAbortRequest !== void 0) {
            stream._pendingAbortRequest._resolve();
            stream._pendingAbortRequest = void 0;
          }
        }
        stream._state = "closed";
        const writer = stream._writer;
        if (writer !== void 0) {
          defaultWriterClosedPromiseResolve(writer);
        }
      }
      function WritableStreamFinishInFlightCloseWithError(stream, error) {
        stream._inFlightCloseRequest._reject(error);
        stream._inFlightCloseRequest = void 0;
        if (stream._pendingAbortRequest !== void 0) {
          stream._pendingAbortRequest._reject(error);
          stream._pendingAbortRequest = void 0;
        }
        WritableStreamDealWithRejection(stream, error);
      }
      function WritableStreamCloseQueuedOrInFlight(stream) {
        if (stream._closeRequest === void 0 && stream._inFlightCloseRequest === void 0) {
          return false;
        }
        return true;
      }
      function WritableStreamHasOperationMarkedInFlight(stream) {
        if (stream._inFlightWriteRequest === void 0 && stream._inFlightCloseRequest === void 0) {
          return false;
        }
        return true;
      }
      function WritableStreamMarkCloseRequestInFlight(stream) {
        stream._inFlightCloseRequest = stream._closeRequest;
        stream._closeRequest = void 0;
      }
      function WritableStreamMarkFirstWriteRequestInFlight(stream) {
        stream._inFlightWriteRequest = stream._writeRequests.shift();
      }
      function WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream) {
        if (stream._closeRequest !== void 0) {
          stream._closeRequest._reject(stream._storedError);
          stream._closeRequest = void 0;
        }
        const writer = stream._writer;
        if (writer !== void 0) {
          defaultWriterClosedPromiseReject(writer, stream._storedError);
        }
      }
      function WritableStreamUpdateBackpressure(stream, backpressure) {
        const writer = stream._writer;
        if (writer !== void 0 && backpressure !== stream._backpressure) {
          if (backpressure) {
            defaultWriterReadyPromiseReset(writer);
          } else {
            defaultWriterReadyPromiseResolve(writer);
          }
        }
        stream._backpressure = backpressure;
      }
      class WritableStreamDefaultWriter {
        constructor(stream) {
          assertRequiredArgument(stream, 1, "WritableStreamDefaultWriter");
          assertWritableStream(stream, "First parameter");
          if (IsWritableStreamLocked(stream)) {
            throw new TypeError("This stream has already been locked for exclusive writing by another writer");
          }
          this._ownerWritableStream = stream;
          stream._writer = this;
          const state = stream._state;
          if (state === "writable") {
            if (!WritableStreamCloseQueuedOrInFlight(stream) && stream._backpressure) {
              defaultWriterReadyPromiseInitialize(this);
            } else {
              defaultWriterReadyPromiseInitializeAsResolved(this);
            }
            defaultWriterClosedPromiseInitialize(this);
          } else if (state === "erroring") {
            defaultWriterReadyPromiseInitializeAsRejected(this, stream._storedError);
            defaultWriterClosedPromiseInitialize(this);
          } else if (state === "closed") {
            defaultWriterReadyPromiseInitializeAsResolved(this);
            defaultWriterClosedPromiseInitializeAsResolved(this);
          } else {
            const storedError = stream._storedError;
            defaultWriterReadyPromiseInitializeAsRejected(this, storedError);
            defaultWriterClosedPromiseInitializeAsRejected(this, storedError);
          }
        }
        /**
         * Returns a promise that will be fulfilled when the stream becomes closed, or rejected if the stream ever errors or
         * the writer’s lock is released before the stream finishes closing.
         */
        get closed() {
          if (!IsWritableStreamDefaultWriter(this)) {
            return promiseRejectedWith(defaultWriterBrandCheckException("closed"));
          }
          return this._closedPromise;
        }
        /**
         * Returns the desired size to fill the stream’s internal queue. It can be negative, if the queue is over-full.
         * A producer can use this information to determine the right amount of data to write.
         *
         * It will be `null` if the stream cannot be successfully written to (due to either being errored, or having an abort
         * queued up). It will return zero if the stream is closed. And the getter will throw an exception if invoked when
         * the writer’s lock is released.
         */
        get desiredSize() {
          if (!IsWritableStreamDefaultWriter(this)) {
            throw defaultWriterBrandCheckException("desiredSize");
          }
          if (this._ownerWritableStream === void 0) {
            throw defaultWriterLockException("desiredSize");
          }
          return WritableStreamDefaultWriterGetDesiredSize(this);
        }
        /**
         * Returns a promise that will be fulfilled when the desired size to fill the stream’s internal queue transitions
         * from non-positive to positive, signaling that it is no longer applying backpressure. Once the desired size dips
         * back to zero or below, the getter will return a new promise that stays pending until the next transition.
         *
         * If the stream becomes errored or aborted, or the writer’s lock is released, the returned promise will become
         * rejected.
         */
        get ready() {
          if (!IsWritableStreamDefaultWriter(this)) {
            return promiseRejectedWith(defaultWriterBrandCheckException("ready"));
          }
          return this._readyPromise;
        }
        /**
         * If the reader is active, behaves the same as {@link WritableStream.abort | stream.abort(reason)}.
         */
        abort(reason = void 0) {
          if (!IsWritableStreamDefaultWriter(this)) {
            return promiseRejectedWith(defaultWriterBrandCheckException("abort"));
          }
          if (this._ownerWritableStream === void 0) {
            return promiseRejectedWith(defaultWriterLockException("abort"));
          }
          return WritableStreamDefaultWriterAbort(this, reason);
        }
        /**
         * If the reader is active, behaves the same as {@link WritableStream.close | stream.close()}.
         */
        close() {
          if (!IsWritableStreamDefaultWriter(this)) {
            return promiseRejectedWith(defaultWriterBrandCheckException("close"));
          }
          const stream = this._ownerWritableStream;
          if (stream === void 0) {
            return promiseRejectedWith(defaultWriterLockException("close"));
          }
          if (WritableStreamCloseQueuedOrInFlight(stream)) {
            return promiseRejectedWith(new TypeError("Cannot close an already-closing stream"));
          }
          return WritableStreamDefaultWriterClose(this);
        }
        /**
         * Releases the writer’s lock on the corresponding stream. After the lock is released, the writer is no longer active.
         * If the associated stream is errored when the lock is released, the writer will appear errored in the same way from
         * now on; otherwise, the writer will appear closed.
         *
         * Note that the lock can still be released even if some ongoing writes have not yet finished (i.e. even if the
         * promises returned from previous calls to {@link WritableStreamDefaultWriter.write | write()} have not yet settled).
         * It’s not necessary to hold the lock on the writer for the duration of the write; the lock instead simply prevents
         * other producers from writing in an interleaved manner.
         */
        releaseLock() {
          if (!IsWritableStreamDefaultWriter(this)) {
            throw defaultWriterBrandCheckException("releaseLock");
          }
          const stream = this._ownerWritableStream;
          if (stream === void 0) {
            return;
          }
          WritableStreamDefaultWriterRelease(this);
        }
        write(chunk = void 0) {
          if (!IsWritableStreamDefaultWriter(this)) {
            return promiseRejectedWith(defaultWriterBrandCheckException("write"));
          }
          if (this._ownerWritableStream === void 0) {
            return promiseRejectedWith(defaultWriterLockException("write to"));
          }
          return WritableStreamDefaultWriterWrite(this, chunk);
        }
      }
      Object.defineProperties(WritableStreamDefaultWriter.prototype, {
        abort: { enumerable: true },
        close: { enumerable: true },
        releaseLock: { enumerable: true },
        write: { enumerable: true },
        closed: { enumerable: true },
        desiredSize: { enumerable: true },
        ready: { enumerable: true }
      });
      setFunctionName(WritableStreamDefaultWriter.prototype.abort, "abort");
      setFunctionName(WritableStreamDefaultWriter.prototype.close, "close");
      setFunctionName(WritableStreamDefaultWriter.prototype.releaseLock, "releaseLock");
      setFunctionName(WritableStreamDefaultWriter.prototype.write, "write");
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(WritableStreamDefaultWriter.prototype, Symbol.toStringTag, {
          value: "WritableStreamDefaultWriter",
          configurable: true
        });
      }
      function IsWritableStreamDefaultWriter(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_ownerWritableStream")) {
          return false;
        }
        return x2 instanceof WritableStreamDefaultWriter;
      }
      function WritableStreamDefaultWriterAbort(writer, reason) {
        const stream = writer._ownerWritableStream;
        return WritableStreamAbort(stream, reason);
      }
      function WritableStreamDefaultWriterClose(writer) {
        const stream = writer._ownerWritableStream;
        return WritableStreamClose(stream);
      }
      function WritableStreamDefaultWriterCloseWithErrorPropagation(writer) {
        const stream = writer._ownerWritableStream;
        const state = stream._state;
        if (WritableStreamCloseQueuedOrInFlight(stream) || state === "closed") {
          return promiseResolvedWith(void 0);
        }
        if (state === "errored") {
          return promiseRejectedWith(stream._storedError);
        }
        return WritableStreamDefaultWriterClose(writer);
      }
      function WritableStreamDefaultWriterEnsureClosedPromiseRejected(writer, error) {
        if (writer._closedPromiseState === "pending") {
          defaultWriterClosedPromiseReject(writer, error);
        } else {
          defaultWriterClosedPromiseResetToRejected(writer, error);
        }
      }
      function WritableStreamDefaultWriterEnsureReadyPromiseRejected(writer, error) {
        if (writer._readyPromiseState === "pending") {
          defaultWriterReadyPromiseReject(writer, error);
        } else {
          defaultWriterReadyPromiseResetToRejected(writer, error);
        }
      }
      function WritableStreamDefaultWriterGetDesiredSize(writer) {
        const stream = writer._ownerWritableStream;
        const state = stream._state;
        if (state === "errored" || state === "erroring") {
          return null;
        }
        if (state === "closed") {
          return 0;
        }
        return WritableStreamDefaultControllerGetDesiredSize(stream._writableStreamController);
      }
      function WritableStreamDefaultWriterRelease(writer) {
        const stream = writer._ownerWritableStream;
        const releasedError = new TypeError(`Writer was released and can no longer be used to monitor the stream's closedness`);
        WritableStreamDefaultWriterEnsureReadyPromiseRejected(writer, releasedError);
        WritableStreamDefaultWriterEnsureClosedPromiseRejected(writer, releasedError);
        stream._writer = void 0;
        writer._ownerWritableStream = void 0;
      }
      function WritableStreamDefaultWriterWrite(writer, chunk) {
        const stream = writer._ownerWritableStream;
        const controller = stream._writableStreamController;
        const chunkSize = WritableStreamDefaultControllerGetChunkSize(controller, chunk);
        if (stream !== writer._ownerWritableStream) {
          return promiseRejectedWith(defaultWriterLockException("write to"));
        }
        const state = stream._state;
        if (state === "errored") {
          return promiseRejectedWith(stream._storedError);
        }
        if (WritableStreamCloseQueuedOrInFlight(stream) || state === "closed") {
          return promiseRejectedWith(new TypeError("The stream is closing or closed and cannot be written to"));
        }
        if (state === "erroring") {
          return promiseRejectedWith(stream._storedError);
        }
        const promise = WritableStreamAddWriteRequest(stream);
        WritableStreamDefaultControllerWrite(controller, chunk, chunkSize);
        return promise;
      }
      const closeSentinel = {};
      class WritableStreamDefaultController {
        constructor() {
          throw new TypeError("Illegal constructor");
        }
        /**
         * The reason which was passed to `WritableStream.abort(reason)` when the stream was aborted.
         *
         * @deprecated
         *  This property has been removed from the specification, see https://github.com/whatwg/streams/pull/1177.
         *  Use {@link WritableStreamDefaultController.signal}'s `reason` instead.
         */
        get abortReason() {
          if (!IsWritableStreamDefaultController(this)) {
            throw defaultControllerBrandCheckException$2("abortReason");
          }
          return this._abortReason;
        }
        /**
         * An `AbortSignal` that can be used to abort the pending write or close operation when the stream is aborted.
         */
        get signal() {
          if (!IsWritableStreamDefaultController(this)) {
            throw defaultControllerBrandCheckException$2("signal");
          }
          if (this._abortController === void 0) {
            throw new TypeError("WritableStreamDefaultController.prototype.signal is not supported");
          }
          return this._abortController.signal;
        }
        /**
         * Closes the controlled writable stream, making all future interactions with it fail with the given error `e`.
         *
         * This method is rarely used, since usually it suffices to return a rejected promise from one of the underlying
         * sink's methods. However, it can be useful for suddenly shutting down a stream in response to an event outside the
         * normal lifecycle of interactions with the underlying sink.
         */
        error(e2 = void 0) {
          if (!IsWritableStreamDefaultController(this)) {
            throw defaultControllerBrandCheckException$2("error");
          }
          const state = this._controlledWritableStream._state;
          if (state !== "writable") {
            return;
          }
          WritableStreamDefaultControllerError(this, e2);
        }
        /** @internal */
        [AbortSteps](reason) {
          const result = this._abortAlgorithm(reason);
          WritableStreamDefaultControllerClearAlgorithms(this);
          return result;
        }
        /** @internal */
        [ErrorSteps]() {
          ResetQueue(this);
        }
      }
      Object.defineProperties(WritableStreamDefaultController.prototype, {
        abortReason: { enumerable: true },
        signal: { enumerable: true },
        error: { enumerable: true }
      });
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(WritableStreamDefaultController.prototype, Symbol.toStringTag, {
          value: "WritableStreamDefaultController",
          configurable: true
        });
      }
      function IsWritableStreamDefaultController(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_controlledWritableStream")) {
          return false;
        }
        return x2 instanceof WritableStreamDefaultController;
      }
      function SetUpWritableStreamDefaultController(stream, controller, startAlgorithm, writeAlgorithm, closeAlgorithm, abortAlgorithm, highWaterMark, sizeAlgorithm) {
        controller._controlledWritableStream = stream;
        stream._writableStreamController = controller;
        controller._queue = void 0;
        controller._queueTotalSize = void 0;
        ResetQueue(controller);
        controller._abortReason = void 0;
        controller._abortController = createAbortController();
        controller._started = false;
        controller._strategySizeAlgorithm = sizeAlgorithm;
        controller._strategyHWM = highWaterMark;
        controller._writeAlgorithm = writeAlgorithm;
        controller._closeAlgorithm = closeAlgorithm;
        controller._abortAlgorithm = abortAlgorithm;
        const backpressure = WritableStreamDefaultControllerGetBackpressure(controller);
        WritableStreamUpdateBackpressure(stream, backpressure);
        const startResult = startAlgorithm();
        const startPromise = promiseResolvedWith(startResult);
        uponPromise(startPromise, () => {
          controller._started = true;
          WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
          return null;
        }, (r2) => {
          controller._started = true;
          WritableStreamDealWithRejection(stream, r2);
          return null;
        });
      }
      function SetUpWritableStreamDefaultControllerFromUnderlyingSink(stream, underlyingSink, highWaterMark, sizeAlgorithm) {
        const controller = Object.create(WritableStreamDefaultController.prototype);
        let startAlgorithm;
        let writeAlgorithm;
        let closeAlgorithm;
        let abortAlgorithm;
        if (underlyingSink.start !== void 0) {
          startAlgorithm = () => underlyingSink.start(controller);
        } else {
          startAlgorithm = () => void 0;
        }
        if (underlyingSink.write !== void 0) {
          writeAlgorithm = (chunk) => underlyingSink.write(chunk, controller);
        } else {
          writeAlgorithm = () => promiseResolvedWith(void 0);
        }
        if (underlyingSink.close !== void 0) {
          closeAlgorithm = () => underlyingSink.close();
        } else {
          closeAlgorithm = () => promiseResolvedWith(void 0);
        }
        if (underlyingSink.abort !== void 0) {
          abortAlgorithm = (reason) => underlyingSink.abort(reason);
        } else {
          abortAlgorithm = () => promiseResolvedWith(void 0);
        }
        SetUpWritableStreamDefaultController(stream, controller, startAlgorithm, writeAlgorithm, closeAlgorithm, abortAlgorithm, highWaterMark, sizeAlgorithm);
      }
      function WritableStreamDefaultControllerClearAlgorithms(controller) {
        controller._writeAlgorithm = void 0;
        controller._closeAlgorithm = void 0;
        controller._abortAlgorithm = void 0;
        controller._strategySizeAlgorithm = void 0;
      }
      function WritableStreamDefaultControllerClose(controller) {
        EnqueueValueWithSize(controller, closeSentinel, 0);
        WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
      }
      function WritableStreamDefaultControllerGetChunkSize(controller, chunk) {
        try {
          return controller._strategySizeAlgorithm(chunk);
        } catch (chunkSizeE) {
          WritableStreamDefaultControllerErrorIfNeeded(controller, chunkSizeE);
          return 1;
        }
      }
      function WritableStreamDefaultControllerGetDesiredSize(controller) {
        return controller._strategyHWM - controller._queueTotalSize;
      }
      function WritableStreamDefaultControllerWrite(controller, chunk, chunkSize) {
        try {
          EnqueueValueWithSize(controller, chunk, chunkSize);
        } catch (enqueueE) {
          WritableStreamDefaultControllerErrorIfNeeded(controller, enqueueE);
          return;
        }
        const stream = controller._controlledWritableStream;
        if (!WritableStreamCloseQueuedOrInFlight(stream) && stream._state === "writable") {
          const backpressure = WritableStreamDefaultControllerGetBackpressure(controller);
          WritableStreamUpdateBackpressure(stream, backpressure);
        }
        WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
      }
      function WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller) {
        const stream = controller._controlledWritableStream;
        if (!controller._started) {
          return;
        }
        if (stream._inFlightWriteRequest !== void 0) {
          return;
        }
        const state = stream._state;
        if (state === "erroring") {
          WritableStreamFinishErroring(stream);
          return;
        }
        if (controller._queue.length === 0) {
          return;
        }
        const value = PeekQueueValue(controller);
        if (value === closeSentinel) {
          WritableStreamDefaultControllerProcessClose(controller);
        } else {
          WritableStreamDefaultControllerProcessWrite(controller, value);
        }
      }
      function WritableStreamDefaultControllerErrorIfNeeded(controller, error) {
        if (controller._controlledWritableStream._state === "writable") {
          WritableStreamDefaultControllerError(controller, error);
        }
      }
      function WritableStreamDefaultControllerProcessClose(controller) {
        const stream = controller._controlledWritableStream;
        WritableStreamMarkCloseRequestInFlight(stream);
        DequeueValue(controller);
        const sinkClosePromise = controller._closeAlgorithm();
        WritableStreamDefaultControllerClearAlgorithms(controller);
        uponPromise(sinkClosePromise, () => {
          WritableStreamFinishInFlightClose(stream);
          return null;
        }, (reason) => {
          WritableStreamFinishInFlightCloseWithError(stream, reason);
          return null;
        });
      }
      function WritableStreamDefaultControllerProcessWrite(controller, chunk) {
        const stream = controller._controlledWritableStream;
        WritableStreamMarkFirstWriteRequestInFlight(stream);
        const sinkWritePromise = controller._writeAlgorithm(chunk);
        uponPromise(sinkWritePromise, () => {
          WritableStreamFinishInFlightWrite(stream);
          const state = stream._state;
          DequeueValue(controller);
          if (!WritableStreamCloseQueuedOrInFlight(stream) && state === "writable") {
            const backpressure = WritableStreamDefaultControllerGetBackpressure(controller);
            WritableStreamUpdateBackpressure(stream, backpressure);
          }
          WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
          return null;
        }, (reason) => {
          if (stream._state === "writable") {
            WritableStreamDefaultControllerClearAlgorithms(controller);
          }
          WritableStreamFinishInFlightWriteWithError(stream, reason);
          return null;
        });
      }
      function WritableStreamDefaultControllerGetBackpressure(controller) {
        const desiredSize = WritableStreamDefaultControllerGetDesiredSize(controller);
        return desiredSize <= 0;
      }
      function WritableStreamDefaultControllerError(controller, error) {
        const stream = controller._controlledWritableStream;
        WritableStreamDefaultControllerClearAlgorithms(controller);
        WritableStreamStartErroring(stream, error);
      }
      function streamBrandCheckException$2(name) {
        return new TypeError(`WritableStream.prototype.${name} can only be used on a WritableStream`);
      }
      function defaultControllerBrandCheckException$2(name) {
        return new TypeError(`WritableStreamDefaultController.prototype.${name} can only be used on a WritableStreamDefaultController`);
      }
      function defaultWriterBrandCheckException(name) {
        return new TypeError(`WritableStreamDefaultWriter.prototype.${name} can only be used on a WritableStreamDefaultWriter`);
      }
      function defaultWriterLockException(name) {
        return new TypeError("Cannot " + name + " a stream using a released writer");
      }
      function defaultWriterClosedPromiseInitialize(writer) {
        writer._closedPromise = newPromise((resolve, reject) => {
          writer._closedPromise_resolve = resolve;
          writer._closedPromise_reject = reject;
          writer._closedPromiseState = "pending";
        });
      }
      function defaultWriterClosedPromiseInitializeAsRejected(writer, reason) {
        defaultWriterClosedPromiseInitialize(writer);
        defaultWriterClosedPromiseReject(writer, reason);
      }
      function defaultWriterClosedPromiseInitializeAsResolved(writer) {
        defaultWriterClosedPromiseInitialize(writer);
        defaultWriterClosedPromiseResolve(writer);
      }
      function defaultWriterClosedPromiseReject(writer, reason) {
        if (writer._closedPromise_reject === void 0) {
          return;
        }
        setPromiseIsHandledToTrue(writer._closedPromise);
        writer._closedPromise_reject(reason);
        writer._closedPromise_resolve = void 0;
        writer._closedPromise_reject = void 0;
        writer._closedPromiseState = "rejected";
      }
      function defaultWriterClosedPromiseResetToRejected(writer, reason) {
        defaultWriterClosedPromiseInitializeAsRejected(writer, reason);
      }
      function defaultWriterClosedPromiseResolve(writer) {
        if (writer._closedPromise_resolve === void 0) {
          return;
        }
        writer._closedPromise_resolve(void 0);
        writer._closedPromise_resolve = void 0;
        writer._closedPromise_reject = void 0;
        writer._closedPromiseState = "resolved";
      }
      function defaultWriterReadyPromiseInitialize(writer) {
        writer._readyPromise = newPromise((resolve, reject) => {
          writer._readyPromise_resolve = resolve;
          writer._readyPromise_reject = reject;
        });
        writer._readyPromiseState = "pending";
      }
      function defaultWriterReadyPromiseInitializeAsRejected(writer, reason) {
        defaultWriterReadyPromiseInitialize(writer);
        defaultWriterReadyPromiseReject(writer, reason);
      }
      function defaultWriterReadyPromiseInitializeAsResolved(writer) {
        defaultWriterReadyPromiseInitialize(writer);
        defaultWriterReadyPromiseResolve(writer);
      }
      function defaultWriterReadyPromiseReject(writer, reason) {
        if (writer._readyPromise_reject === void 0) {
          return;
        }
        setPromiseIsHandledToTrue(writer._readyPromise);
        writer._readyPromise_reject(reason);
        writer._readyPromise_resolve = void 0;
        writer._readyPromise_reject = void 0;
        writer._readyPromiseState = "rejected";
      }
      function defaultWriterReadyPromiseReset(writer) {
        defaultWriterReadyPromiseInitialize(writer);
      }
      function defaultWriterReadyPromiseResetToRejected(writer, reason) {
        defaultWriterReadyPromiseInitializeAsRejected(writer, reason);
      }
      function defaultWriterReadyPromiseResolve(writer) {
        if (writer._readyPromise_resolve === void 0) {
          return;
        }
        writer._readyPromise_resolve(void 0);
        writer._readyPromise_resolve = void 0;
        writer._readyPromise_reject = void 0;
        writer._readyPromiseState = "fulfilled";
      }
      function getGlobals() {
        if (typeof globalThis !== "undefined") {
          return globalThis;
        } else if (typeof self !== "undefined") {
          return self;
        } else if (typeof commonjsGlobal !== "undefined") {
          return commonjsGlobal;
        }
        return void 0;
      }
      const globals = getGlobals();
      function isDOMExceptionConstructor(ctor) {
        if (!(typeof ctor === "function" || typeof ctor === "object")) {
          return false;
        }
        if (ctor.name !== "DOMException") {
          return false;
        }
        try {
          new ctor();
          return true;
        } catch (_a3) {
          return false;
        }
      }
      function getFromGlobal() {
        const ctor = globals === null || globals === void 0 ? void 0 : globals.DOMException;
        return isDOMExceptionConstructor(ctor) ? ctor : void 0;
      }
      function createPolyfill() {
        const ctor = function DOMException2(message, name) {
          this.message = message || "";
          this.name = name || "Error";
          if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
          }
        };
        setFunctionName(ctor, "DOMException");
        ctor.prototype = Object.create(Error.prototype);
        Object.defineProperty(ctor.prototype, "constructor", { value: ctor, writable: true, configurable: true });
        return ctor;
      }
      const DOMException = getFromGlobal() || createPolyfill();
      function ReadableStreamPipeTo(source, dest, preventClose, preventAbort, preventCancel, signal) {
        const reader = AcquireReadableStreamDefaultReader(source);
        const writer = AcquireWritableStreamDefaultWriter(dest);
        source._disturbed = true;
        let shuttingDown = false;
        let currentWrite = promiseResolvedWith(void 0);
        return newPromise((resolve, reject) => {
          let abortAlgorithm;
          if (signal !== void 0) {
            abortAlgorithm = () => {
              const error = signal.reason !== void 0 ? signal.reason : new DOMException("Aborted", "AbortError");
              const actions = [];
              if (!preventAbort) {
                actions.push(() => {
                  if (dest._state === "writable") {
                    return WritableStreamAbort(dest, error);
                  }
                  return promiseResolvedWith(void 0);
                });
              }
              if (!preventCancel) {
                actions.push(() => {
                  if (source._state === "readable") {
                    return ReadableStreamCancel(source, error);
                  }
                  return promiseResolvedWith(void 0);
                });
              }
              shutdownWithAction(() => Promise.all(actions.map((action) => action())), true, error);
            };
            if (signal.aborted) {
              abortAlgorithm();
              return;
            }
            signal.addEventListener("abort", abortAlgorithm);
          }
          function pipeLoop() {
            return newPromise((resolveLoop, rejectLoop) => {
              function next(done) {
                if (done) {
                  resolveLoop();
                } else {
                  PerformPromiseThen(pipeStep(), next, rejectLoop);
                }
              }
              next(false);
            });
          }
          function pipeStep() {
            if (shuttingDown) {
              return promiseResolvedWith(true);
            }
            return PerformPromiseThen(writer._readyPromise, () => {
              return newPromise((resolveRead, rejectRead) => {
                ReadableStreamDefaultReaderRead(reader, {
                  _chunkSteps: (chunk) => {
                    currentWrite = PerformPromiseThen(WritableStreamDefaultWriterWrite(writer, chunk), void 0, noop);
                    resolveRead(false);
                  },
                  _closeSteps: () => resolveRead(true),
                  _errorSteps: rejectRead
                });
              });
            });
          }
          isOrBecomesErrored(source, reader._closedPromise, (storedError) => {
            if (!preventAbort) {
              shutdownWithAction(() => WritableStreamAbort(dest, storedError), true, storedError);
            } else {
              shutdown(true, storedError);
            }
            return null;
          });
          isOrBecomesErrored(dest, writer._closedPromise, (storedError) => {
            if (!preventCancel) {
              shutdownWithAction(() => ReadableStreamCancel(source, storedError), true, storedError);
            } else {
              shutdown(true, storedError);
            }
            return null;
          });
          isOrBecomesClosed(source, reader._closedPromise, () => {
            if (!preventClose) {
              shutdownWithAction(() => WritableStreamDefaultWriterCloseWithErrorPropagation(writer));
            } else {
              shutdown();
            }
            return null;
          });
          if (WritableStreamCloseQueuedOrInFlight(dest) || dest._state === "closed") {
            const destClosed = new TypeError("the destination writable stream closed before all data could be piped to it");
            if (!preventCancel) {
              shutdownWithAction(() => ReadableStreamCancel(source, destClosed), true, destClosed);
            } else {
              shutdown(true, destClosed);
            }
          }
          setPromiseIsHandledToTrue(pipeLoop());
          function waitForWritesToFinish() {
            const oldCurrentWrite = currentWrite;
            return PerformPromiseThen(currentWrite, () => oldCurrentWrite !== currentWrite ? waitForWritesToFinish() : void 0);
          }
          function isOrBecomesErrored(stream, promise, action) {
            if (stream._state === "errored") {
              action(stream._storedError);
            } else {
              uponRejection(promise, action);
            }
          }
          function isOrBecomesClosed(stream, promise, action) {
            if (stream._state === "closed") {
              action();
            } else {
              uponFulfillment(promise, action);
            }
          }
          function shutdownWithAction(action, originalIsError, originalError) {
            if (shuttingDown) {
              return;
            }
            shuttingDown = true;
            if (dest._state === "writable" && !WritableStreamCloseQueuedOrInFlight(dest)) {
              uponFulfillment(waitForWritesToFinish(), doTheRest);
            } else {
              doTheRest();
            }
            function doTheRest() {
              uponPromise(action(), () => finalize(originalIsError, originalError), (newError) => finalize(true, newError));
              return null;
            }
          }
          function shutdown(isError2, error) {
            if (shuttingDown) {
              return;
            }
            shuttingDown = true;
            if (dest._state === "writable" && !WritableStreamCloseQueuedOrInFlight(dest)) {
              uponFulfillment(waitForWritesToFinish(), () => finalize(isError2, error));
            } else {
              finalize(isError2, error);
            }
          }
          function finalize(isError2, error) {
            WritableStreamDefaultWriterRelease(writer);
            ReadableStreamReaderGenericRelease(reader);
            if (signal !== void 0) {
              signal.removeEventListener("abort", abortAlgorithm);
            }
            if (isError2) {
              reject(error);
            } else {
              resolve(void 0);
            }
            return null;
          }
        });
      }
      class ReadableStreamDefaultController {
        constructor() {
          throw new TypeError("Illegal constructor");
        }
        /**
         * Returns the desired size to fill the controlled stream's internal queue. It can be negative, if the queue is
         * over-full. An underlying source ought to use this information to determine when and how to apply backpressure.
         */
        get desiredSize() {
          if (!IsReadableStreamDefaultController(this)) {
            throw defaultControllerBrandCheckException$1("desiredSize");
          }
          return ReadableStreamDefaultControllerGetDesiredSize(this);
        }
        /**
         * Closes the controlled readable stream. Consumers will still be able to read any previously-enqueued chunks from
         * the stream, but once those are read, the stream will become closed.
         */
        close() {
          if (!IsReadableStreamDefaultController(this)) {
            throw defaultControllerBrandCheckException$1("close");
          }
          if (!ReadableStreamDefaultControllerCanCloseOrEnqueue(this)) {
            throw new TypeError("The stream is not in a state that permits close");
          }
          ReadableStreamDefaultControllerClose(this);
        }
        enqueue(chunk = void 0) {
          if (!IsReadableStreamDefaultController(this)) {
            throw defaultControllerBrandCheckException$1("enqueue");
          }
          if (!ReadableStreamDefaultControllerCanCloseOrEnqueue(this)) {
            throw new TypeError("The stream is not in a state that permits enqueue");
          }
          return ReadableStreamDefaultControllerEnqueue(this, chunk);
        }
        /**
         * Errors the controlled readable stream, making all future interactions with it fail with the given error `e`.
         */
        error(e2 = void 0) {
          if (!IsReadableStreamDefaultController(this)) {
            throw defaultControllerBrandCheckException$1("error");
          }
          ReadableStreamDefaultControllerError(this, e2);
        }
        /** @internal */
        [CancelSteps](reason) {
          ResetQueue(this);
          const result = this._cancelAlgorithm(reason);
          ReadableStreamDefaultControllerClearAlgorithms(this);
          return result;
        }
        /** @internal */
        [PullSteps](readRequest) {
          const stream = this._controlledReadableStream;
          if (this._queue.length > 0) {
            const chunk = DequeueValue(this);
            if (this._closeRequested && this._queue.length === 0) {
              ReadableStreamDefaultControllerClearAlgorithms(this);
              ReadableStreamClose(stream);
            } else {
              ReadableStreamDefaultControllerCallPullIfNeeded(this);
            }
            readRequest._chunkSteps(chunk);
          } else {
            ReadableStreamAddReadRequest(stream, readRequest);
            ReadableStreamDefaultControllerCallPullIfNeeded(this);
          }
        }
        /** @internal */
        [ReleaseSteps]() {
        }
      }
      Object.defineProperties(ReadableStreamDefaultController.prototype, {
        close: { enumerable: true },
        enqueue: { enumerable: true },
        error: { enumerable: true },
        desiredSize: { enumerable: true }
      });
      setFunctionName(ReadableStreamDefaultController.prototype.close, "close");
      setFunctionName(ReadableStreamDefaultController.prototype.enqueue, "enqueue");
      setFunctionName(ReadableStreamDefaultController.prototype.error, "error");
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(ReadableStreamDefaultController.prototype, Symbol.toStringTag, {
          value: "ReadableStreamDefaultController",
          configurable: true
        });
      }
      function IsReadableStreamDefaultController(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_controlledReadableStream")) {
          return false;
        }
        return x2 instanceof ReadableStreamDefaultController;
      }
      function ReadableStreamDefaultControllerCallPullIfNeeded(controller) {
        const shouldPull = ReadableStreamDefaultControllerShouldCallPull(controller);
        if (!shouldPull) {
          return;
        }
        if (controller._pulling) {
          controller._pullAgain = true;
          return;
        }
        controller._pulling = true;
        const pullPromise = controller._pullAlgorithm();
        uponPromise(pullPromise, () => {
          controller._pulling = false;
          if (controller._pullAgain) {
            controller._pullAgain = false;
            ReadableStreamDefaultControllerCallPullIfNeeded(controller);
          }
          return null;
        }, (e2) => {
          ReadableStreamDefaultControllerError(controller, e2);
          return null;
        });
      }
      function ReadableStreamDefaultControllerShouldCallPull(controller) {
        const stream = controller._controlledReadableStream;
        if (!ReadableStreamDefaultControllerCanCloseOrEnqueue(controller)) {
          return false;
        }
        if (!controller._started) {
          return false;
        }
        if (IsReadableStreamLocked(stream) && ReadableStreamGetNumReadRequests(stream) > 0) {
          return true;
        }
        const desiredSize = ReadableStreamDefaultControllerGetDesiredSize(controller);
        if (desiredSize > 0) {
          return true;
        }
        return false;
      }
      function ReadableStreamDefaultControllerClearAlgorithms(controller) {
        controller._pullAlgorithm = void 0;
        controller._cancelAlgorithm = void 0;
        controller._strategySizeAlgorithm = void 0;
      }
      function ReadableStreamDefaultControllerClose(controller) {
        if (!ReadableStreamDefaultControllerCanCloseOrEnqueue(controller)) {
          return;
        }
        const stream = controller._controlledReadableStream;
        controller._closeRequested = true;
        if (controller._queue.length === 0) {
          ReadableStreamDefaultControllerClearAlgorithms(controller);
          ReadableStreamClose(stream);
        }
      }
      function ReadableStreamDefaultControllerEnqueue(controller, chunk) {
        if (!ReadableStreamDefaultControllerCanCloseOrEnqueue(controller)) {
          return;
        }
        const stream = controller._controlledReadableStream;
        if (IsReadableStreamLocked(stream) && ReadableStreamGetNumReadRequests(stream) > 0) {
          ReadableStreamFulfillReadRequest(stream, chunk, false);
        } else {
          let chunkSize;
          try {
            chunkSize = controller._strategySizeAlgorithm(chunk);
          } catch (chunkSizeE) {
            ReadableStreamDefaultControllerError(controller, chunkSizeE);
            throw chunkSizeE;
          }
          try {
            EnqueueValueWithSize(controller, chunk, chunkSize);
          } catch (enqueueE) {
            ReadableStreamDefaultControllerError(controller, enqueueE);
            throw enqueueE;
          }
        }
        ReadableStreamDefaultControllerCallPullIfNeeded(controller);
      }
      function ReadableStreamDefaultControllerError(controller, e2) {
        const stream = controller._controlledReadableStream;
        if (stream._state !== "readable") {
          return;
        }
        ResetQueue(controller);
        ReadableStreamDefaultControllerClearAlgorithms(controller);
        ReadableStreamError(stream, e2);
      }
      function ReadableStreamDefaultControllerGetDesiredSize(controller) {
        const state = controller._controlledReadableStream._state;
        if (state === "errored") {
          return null;
        }
        if (state === "closed") {
          return 0;
        }
        return controller._strategyHWM - controller._queueTotalSize;
      }
      function ReadableStreamDefaultControllerHasBackpressure(controller) {
        if (ReadableStreamDefaultControllerShouldCallPull(controller)) {
          return false;
        }
        return true;
      }
      function ReadableStreamDefaultControllerCanCloseOrEnqueue(controller) {
        const state = controller._controlledReadableStream._state;
        if (!controller._closeRequested && state === "readable") {
          return true;
        }
        return false;
      }
      function SetUpReadableStreamDefaultController(stream, controller, startAlgorithm, pullAlgorithm, cancelAlgorithm, highWaterMark, sizeAlgorithm) {
        controller._controlledReadableStream = stream;
        controller._queue = void 0;
        controller._queueTotalSize = void 0;
        ResetQueue(controller);
        controller._started = false;
        controller._closeRequested = false;
        controller._pullAgain = false;
        controller._pulling = false;
        controller._strategySizeAlgorithm = sizeAlgorithm;
        controller._strategyHWM = highWaterMark;
        controller._pullAlgorithm = pullAlgorithm;
        controller._cancelAlgorithm = cancelAlgorithm;
        stream._readableStreamController = controller;
        const startResult = startAlgorithm();
        uponPromise(promiseResolvedWith(startResult), () => {
          controller._started = true;
          ReadableStreamDefaultControllerCallPullIfNeeded(controller);
          return null;
        }, (r2) => {
          ReadableStreamDefaultControllerError(controller, r2);
          return null;
        });
      }
      function SetUpReadableStreamDefaultControllerFromUnderlyingSource(stream, underlyingSource, highWaterMark, sizeAlgorithm) {
        const controller = Object.create(ReadableStreamDefaultController.prototype);
        let startAlgorithm;
        let pullAlgorithm;
        let cancelAlgorithm;
        if (underlyingSource.start !== void 0) {
          startAlgorithm = () => underlyingSource.start(controller);
        } else {
          startAlgorithm = () => void 0;
        }
        if (underlyingSource.pull !== void 0) {
          pullAlgorithm = () => underlyingSource.pull(controller);
        } else {
          pullAlgorithm = () => promiseResolvedWith(void 0);
        }
        if (underlyingSource.cancel !== void 0) {
          cancelAlgorithm = (reason) => underlyingSource.cancel(reason);
        } else {
          cancelAlgorithm = () => promiseResolvedWith(void 0);
        }
        SetUpReadableStreamDefaultController(stream, controller, startAlgorithm, pullAlgorithm, cancelAlgorithm, highWaterMark, sizeAlgorithm);
      }
      function defaultControllerBrandCheckException$1(name) {
        return new TypeError(`ReadableStreamDefaultController.prototype.${name} can only be used on a ReadableStreamDefaultController`);
      }
      function ReadableStreamTee(stream, cloneForBranch2) {
        if (IsReadableByteStreamController(stream._readableStreamController)) {
          return ReadableByteStreamTee(stream);
        }
        return ReadableStreamDefaultTee(stream);
      }
      function ReadableStreamDefaultTee(stream, cloneForBranch2) {
        const reader = AcquireReadableStreamDefaultReader(stream);
        let reading = false;
        let readAgain = false;
        let canceled1 = false;
        let canceled2 = false;
        let reason1;
        let reason2;
        let branch1;
        let branch2;
        let resolveCancelPromise;
        const cancelPromise = newPromise((resolve) => {
          resolveCancelPromise = resolve;
        });
        function pullAlgorithm() {
          if (reading) {
            readAgain = true;
            return promiseResolvedWith(void 0);
          }
          reading = true;
          const readRequest = {
            _chunkSteps: (chunk) => {
              _queueMicrotask(() => {
                readAgain = false;
                const chunk1 = chunk;
                const chunk2 = chunk;
                if (!canceled1) {
                  ReadableStreamDefaultControllerEnqueue(branch1._readableStreamController, chunk1);
                }
                if (!canceled2) {
                  ReadableStreamDefaultControllerEnqueue(branch2._readableStreamController, chunk2);
                }
                reading = false;
                if (readAgain) {
                  pullAlgorithm();
                }
              });
            },
            _closeSteps: () => {
              reading = false;
              if (!canceled1) {
                ReadableStreamDefaultControllerClose(branch1._readableStreamController);
              }
              if (!canceled2) {
                ReadableStreamDefaultControllerClose(branch2._readableStreamController);
              }
              if (!canceled1 || !canceled2) {
                resolveCancelPromise(void 0);
              }
            },
            _errorSteps: () => {
              reading = false;
            }
          };
          ReadableStreamDefaultReaderRead(reader, readRequest);
          return promiseResolvedWith(void 0);
        }
        function cancel1Algorithm(reason) {
          canceled1 = true;
          reason1 = reason;
          if (canceled2) {
            const compositeReason = CreateArrayFromList([reason1, reason2]);
            const cancelResult = ReadableStreamCancel(stream, compositeReason);
            resolveCancelPromise(cancelResult);
          }
          return cancelPromise;
        }
        function cancel2Algorithm(reason) {
          canceled2 = true;
          reason2 = reason;
          if (canceled1) {
            const compositeReason = CreateArrayFromList([reason1, reason2]);
            const cancelResult = ReadableStreamCancel(stream, compositeReason);
            resolveCancelPromise(cancelResult);
          }
          return cancelPromise;
        }
        function startAlgorithm() {
        }
        branch1 = CreateReadableStream(startAlgorithm, pullAlgorithm, cancel1Algorithm);
        branch2 = CreateReadableStream(startAlgorithm, pullAlgorithm, cancel2Algorithm);
        uponRejection(reader._closedPromise, (r2) => {
          ReadableStreamDefaultControllerError(branch1._readableStreamController, r2);
          ReadableStreamDefaultControllerError(branch2._readableStreamController, r2);
          if (!canceled1 || !canceled2) {
            resolveCancelPromise(void 0);
          }
          return null;
        });
        return [branch1, branch2];
      }
      function ReadableByteStreamTee(stream) {
        let reader = AcquireReadableStreamDefaultReader(stream);
        let reading = false;
        let readAgainForBranch1 = false;
        let readAgainForBranch2 = false;
        let canceled1 = false;
        let canceled2 = false;
        let reason1;
        let reason2;
        let branch1;
        let branch2;
        let resolveCancelPromise;
        const cancelPromise = newPromise((resolve) => {
          resolveCancelPromise = resolve;
        });
        function forwardReaderError(thisReader) {
          uponRejection(thisReader._closedPromise, (r2) => {
            if (thisReader !== reader) {
              return null;
            }
            ReadableByteStreamControllerError(branch1._readableStreamController, r2);
            ReadableByteStreamControllerError(branch2._readableStreamController, r2);
            if (!canceled1 || !canceled2) {
              resolveCancelPromise(void 0);
            }
            return null;
          });
        }
        function pullWithDefaultReader() {
          if (IsReadableStreamBYOBReader(reader)) {
            ReadableStreamReaderGenericRelease(reader);
            reader = AcquireReadableStreamDefaultReader(stream);
            forwardReaderError(reader);
          }
          const readRequest = {
            _chunkSteps: (chunk) => {
              _queueMicrotask(() => {
                readAgainForBranch1 = false;
                readAgainForBranch2 = false;
                const chunk1 = chunk;
                let chunk2 = chunk;
                if (!canceled1 && !canceled2) {
                  try {
                    chunk2 = CloneAsUint8Array(chunk);
                  } catch (cloneE) {
                    ReadableByteStreamControllerError(branch1._readableStreamController, cloneE);
                    ReadableByteStreamControllerError(branch2._readableStreamController, cloneE);
                    resolveCancelPromise(ReadableStreamCancel(stream, cloneE));
                    return;
                  }
                }
                if (!canceled1) {
                  ReadableByteStreamControllerEnqueue(branch1._readableStreamController, chunk1);
                }
                if (!canceled2) {
                  ReadableByteStreamControllerEnqueue(branch2._readableStreamController, chunk2);
                }
                reading = false;
                if (readAgainForBranch1) {
                  pull1Algorithm();
                } else if (readAgainForBranch2) {
                  pull2Algorithm();
                }
              });
            },
            _closeSteps: () => {
              reading = false;
              if (!canceled1) {
                ReadableByteStreamControllerClose(branch1._readableStreamController);
              }
              if (!canceled2) {
                ReadableByteStreamControllerClose(branch2._readableStreamController);
              }
              if (branch1._readableStreamController._pendingPullIntos.length > 0) {
                ReadableByteStreamControllerRespond(branch1._readableStreamController, 0);
              }
              if (branch2._readableStreamController._pendingPullIntos.length > 0) {
                ReadableByteStreamControllerRespond(branch2._readableStreamController, 0);
              }
              if (!canceled1 || !canceled2) {
                resolveCancelPromise(void 0);
              }
            },
            _errorSteps: () => {
              reading = false;
            }
          };
          ReadableStreamDefaultReaderRead(reader, readRequest);
        }
        function pullWithBYOBReader(view, forBranch2) {
          if (IsReadableStreamDefaultReader(reader)) {
            ReadableStreamReaderGenericRelease(reader);
            reader = AcquireReadableStreamBYOBReader(stream);
            forwardReaderError(reader);
          }
          const byobBranch = forBranch2 ? branch2 : branch1;
          const otherBranch = forBranch2 ? branch1 : branch2;
          const readIntoRequest = {
            _chunkSteps: (chunk) => {
              _queueMicrotask(() => {
                readAgainForBranch1 = false;
                readAgainForBranch2 = false;
                const byobCanceled = forBranch2 ? canceled2 : canceled1;
                const otherCanceled = forBranch2 ? canceled1 : canceled2;
                if (!otherCanceled) {
                  let clonedChunk;
                  try {
                    clonedChunk = CloneAsUint8Array(chunk);
                  } catch (cloneE) {
                    ReadableByteStreamControllerError(byobBranch._readableStreamController, cloneE);
                    ReadableByteStreamControllerError(otherBranch._readableStreamController, cloneE);
                    resolveCancelPromise(ReadableStreamCancel(stream, cloneE));
                    return;
                  }
                  if (!byobCanceled) {
                    ReadableByteStreamControllerRespondWithNewView(byobBranch._readableStreamController, chunk);
                  }
                  ReadableByteStreamControllerEnqueue(otherBranch._readableStreamController, clonedChunk);
                } else if (!byobCanceled) {
                  ReadableByteStreamControllerRespondWithNewView(byobBranch._readableStreamController, chunk);
                }
                reading = false;
                if (readAgainForBranch1) {
                  pull1Algorithm();
                } else if (readAgainForBranch2) {
                  pull2Algorithm();
                }
              });
            },
            _closeSteps: (chunk) => {
              reading = false;
              const byobCanceled = forBranch2 ? canceled2 : canceled1;
              const otherCanceled = forBranch2 ? canceled1 : canceled2;
              if (!byobCanceled) {
                ReadableByteStreamControllerClose(byobBranch._readableStreamController);
              }
              if (!otherCanceled) {
                ReadableByteStreamControllerClose(otherBranch._readableStreamController);
              }
              if (chunk !== void 0) {
                if (!byobCanceled) {
                  ReadableByteStreamControllerRespondWithNewView(byobBranch._readableStreamController, chunk);
                }
                if (!otherCanceled && otherBranch._readableStreamController._pendingPullIntos.length > 0) {
                  ReadableByteStreamControllerRespond(otherBranch._readableStreamController, 0);
                }
              }
              if (!byobCanceled || !otherCanceled) {
                resolveCancelPromise(void 0);
              }
            },
            _errorSteps: () => {
              reading = false;
            }
          };
          ReadableStreamBYOBReaderRead(reader, view, 1, readIntoRequest);
        }
        function pull1Algorithm() {
          if (reading) {
            readAgainForBranch1 = true;
            return promiseResolvedWith(void 0);
          }
          reading = true;
          const byobRequest = ReadableByteStreamControllerGetBYOBRequest(branch1._readableStreamController);
          if (byobRequest === null) {
            pullWithDefaultReader();
          } else {
            pullWithBYOBReader(byobRequest._view, false);
          }
          return promiseResolvedWith(void 0);
        }
        function pull2Algorithm() {
          if (reading) {
            readAgainForBranch2 = true;
            return promiseResolvedWith(void 0);
          }
          reading = true;
          const byobRequest = ReadableByteStreamControllerGetBYOBRequest(branch2._readableStreamController);
          if (byobRequest === null) {
            pullWithDefaultReader();
          } else {
            pullWithBYOBReader(byobRequest._view, true);
          }
          return promiseResolvedWith(void 0);
        }
        function cancel1Algorithm(reason) {
          canceled1 = true;
          reason1 = reason;
          if (canceled2) {
            const compositeReason = CreateArrayFromList([reason1, reason2]);
            const cancelResult = ReadableStreamCancel(stream, compositeReason);
            resolveCancelPromise(cancelResult);
          }
          return cancelPromise;
        }
        function cancel2Algorithm(reason) {
          canceled2 = true;
          reason2 = reason;
          if (canceled1) {
            const compositeReason = CreateArrayFromList([reason1, reason2]);
            const cancelResult = ReadableStreamCancel(stream, compositeReason);
            resolveCancelPromise(cancelResult);
          }
          return cancelPromise;
        }
        function startAlgorithm() {
          return;
        }
        branch1 = CreateReadableByteStream(startAlgorithm, pull1Algorithm, cancel1Algorithm);
        branch2 = CreateReadableByteStream(startAlgorithm, pull2Algorithm, cancel2Algorithm);
        forwardReaderError(reader);
        return [branch1, branch2];
      }
      function isReadableStreamLike(stream) {
        return typeIsObject(stream) && typeof stream.getReader !== "undefined";
      }
      function ReadableStreamFrom(source) {
        if (isReadableStreamLike(source)) {
          return ReadableStreamFromDefaultReader(source.getReader());
        }
        return ReadableStreamFromIterable(source);
      }
      function ReadableStreamFromIterable(asyncIterable) {
        let stream;
        const iteratorRecord = GetIterator(asyncIterable, "async");
        const startAlgorithm = noop;
        function pullAlgorithm() {
          let nextResult;
          try {
            nextResult = IteratorNext(iteratorRecord);
          } catch (e2) {
            return promiseRejectedWith(e2);
          }
          const nextPromise = promiseResolvedWith(nextResult);
          return transformPromiseWith(nextPromise, (iterResult) => {
            if (!typeIsObject(iterResult)) {
              throw new TypeError("The promise returned by the iterator.next() method must fulfill with an object");
            }
            const done = IteratorComplete(iterResult);
            if (done) {
              ReadableStreamDefaultControllerClose(stream._readableStreamController);
            } else {
              const value = IteratorValue(iterResult);
              ReadableStreamDefaultControllerEnqueue(stream._readableStreamController, value);
            }
          });
        }
        function cancelAlgorithm(reason) {
          const iterator = iteratorRecord.iterator;
          let returnMethod;
          try {
            returnMethod = GetMethod(iterator, "return");
          } catch (e2) {
            return promiseRejectedWith(e2);
          }
          if (returnMethod === void 0) {
            return promiseResolvedWith(void 0);
          }
          let returnResult;
          try {
            returnResult = reflectCall(returnMethod, iterator, [reason]);
          } catch (e2) {
            return promiseRejectedWith(e2);
          }
          const returnPromise = promiseResolvedWith(returnResult);
          return transformPromiseWith(returnPromise, (iterResult) => {
            if (!typeIsObject(iterResult)) {
              throw new TypeError("The promise returned by the iterator.return() method must fulfill with an object");
            }
            return void 0;
          });
        }
        stream = CreateReadableStream(startAlgorithm, pullAlgorithm, cancelAlgorithm, 0);
        return stream;
      }
      function ReadableStreamFromDefaultReader(reader) {
        let stream;
        const startAlgorithm = noop;
        function pullAlgorithm() {
          let readPromise;
          try {
            readPromise = reader.read();
          } catch (e2) {
            return promiseRejectedWith(e2);
          }
          return transformPromiseWith(readPromise, (readResult) => {
            if (!typeIsObject(readResult)) {
              throw new TypeError("The promise returned by the reader.read() method must fulfill with an object");
            }
            if (readResult.done) {
              ReadableStreamDefaultControllerClose(stream._readableStreamController);
            } else {
              const value = readResult.value;
              ReadableStreamDefaultControllerEnqueue(stream._readableStreamController, value);
            }
          });
        }
        function cancelAlgorithm(reason) {
          try {
            return promiseResolvedWith(reader.cancel(reason));
          } catch (e2) {
            return promiseRejectedWith(e2);
          }
        }
        stream = CreateReadableStream(startAlgorithm, pullAlgorithm, cancelAlgorithm, 0);
        return stream;
      }
      function convertUnderlyingDefaultOrByteSource(source, context) {
        assertDictionary(source, context);
        const original = source;
        const autoAllocateChunkSize = original === null || original === void 0 ? void 0 : original.autoAllocateChunkSize;
        const cancel = original === null || original === void 0 ? void 0 : original.cancel;
        const pull = original === null || original === void 0 ? void 0 : original.pull;
        const start = original === null || original === void 0 ? void 0 : original.start;
        const type = original === null || original === void 0 ? void 0 : original.type;
        return {
          autoAllocateChunkSize: autoAllocateChunkSize === void 0 ? void 0 : convertUnsignedLongLongWithEnforceRange(autoAllocateChunkSize, `${context} has member 'autoAllocateChunkSize' that`),
          cancel: cancel === void 0 ? void 0 : convertUnderlyingSourceCancelCallback(cancel, original, `${context} has member 'cancel' that`),
          pull: pull === void 0 ? void 0 : convertUnderlyingSourcePullCallback(pull, original, `${context} has member 'pull' that`),
          start: start === void 0 ? void 0 : convertUnderlyingSourceStartCallback(start, original, `${context} has member 'start' that`),
          type: type === void 0 ? void 0 : convertReadableStreamType(type, `${context} has member 'type' that`)
        };
      }
      function convertUnderlyingSourceCancelCallback(fn, original, context) {
        assertFunction(fn, context);
        return (reason) => promiseCall(fn, original, [reason]);
      }
      function convertUnderlyingSourcePullCallback(fn, original, context) {
        assertFunction(fn, context);
        return (controller) => promiseCall(fn, original, [controller]);
      }
      function convertUnderlyingSourceStartCallback(fn, original, context) {
        assertFunction(fn, context);
        return (controller) => reflectCall(fn, original, [controller]);
      }
      function convertReadableStreamType(type, context) {
        type = `${type}`;
        if (type !== "bytes") {
          throw new TypeError(`${context} '${type}' is not a valid enumeration value for ReadableStreamType`);
        }
        return type;
      }
      function convertIteratorOptions(options, context) {
        assertDictionary(options, context);
        const preventCancel = options === null || options === void 0 ? void 0 : options.preventCancel;
        return { preventCancel: Boolean(preventCancel) };
      }
      function convertPipeOptions(options, context) {
        assertDictionary(options, context);
        const preventAbort = options === null || options === void 0 ? void 0 : options.preventAbort;
        const preventCancel = options === null || options === void 0 ? void 0 : options.preventCancel;
        const preventClose = options === null || options === void 0 ? void 0 : options.preventClose;
        const signal = options === null || options === void 0 ? void 0 : options.signal;
        if (signal !== void 0) {
          assertAbortSignal(signal, `${context} has member 'signal' that`);
        }
        return {
          preventAbort: Boolean(preventAbort),
          preventCancel: Boolean(preventCancel),
          preventClose: Boolean(preventClose),
          signal
        };
      }
      function assertAbortSignal(signal, context) {
        if (!isAbortSignal2(signal)) {
          throw new TypeError(`${context} is not an AbortSignal.`);
        }
      }
      function convertReadableWritablePair(pair, context) {
        assertDictionary(pair, context);
        const readable = pair === null || pair === void 0 ? void 0 : pair.readable;
        assertRequiredField(readable, "readable", "ReadableWritablePair");
        assertReadableStream(readable, `${context} has member 'readable' that`);
        const writable = pair === null || pair === void 0 ? void 0 : pair.writable;
        assertRequiredField(writable, "writable", "ReadableWritablePair");
        assertWritableStream(writable, `${context} has member 'writable' that`);
        return { readable, writable };
      }
      class ReadableStream2 {
        constructor(rawUnderlyingSource = {}, rawStrategy = {}) {
          if (rawUnderlyingSource === void 0) {
            rawUnderlyingSource = null;
          } else {
            assertObject(rawUnderlyingSource, "First parameter");
          }
          const strategy = convertQueuingStrategy(rawStrategy, "Second parameter");
          const underlyingSource = convertUnderlyingDefaultOrByteSource(rawUnderlyingSource, "First parameter");
          InitializeReadableStream(this);
          if (underlyingSource.type === "bytes") {
            if (strategy.size !== void 0) {
              throw new RangeError("The strategy for a byte stream cannot have a size function");
            }
            const highWaterMark = ExtractHighWaterMark(strategy, 0);
            SetUpReadableByteStreamControllerFromUnderlyingSource(this, underlyingSource, highWaterMark);
          } else {
            const sizeAlgorithm = ExtractSizeAlgorithm(strategy);
            const highWaterMark = ExtractHighWaterMark(strategy, 1);
            SetUpReadableStreamDefaultControllerFromUnderlyingSource(this, underlyingSource, highWaterMark, sizeAlgorithm);
          }
        }
        /**
         * Whether or not the readable stream is locked to a {@link ReadableStreamDefaultReader | reader}.
         */
        get locked() {
          if (!IsReadableStream(this)) {
            throw streamBrandCheckException$1("locked");
          }
          return IsReadableStreamLocked(this);
        }
        /**
         * Cancels the stream, signaling a loss of interest in the stream by a consumer.
         *
         * The supplied `reason` argument will be given to the underlying source's {@link UnderlyingSource.cancel | cancel()}
         * method, which might or might not use it.
         */
        cancel(reason = void 0) {
          if (!IsReadableStream(this)) {
            return promiseRejectedWith(streamBrandCheckException$1("cancel"));
          }
          if (IsReadableStreamLocked(this)) {
            return promiseRejectedWith(new TypeError("Cannot cancel a stream that already has a reader"));
          }
          return ReadableStreamCancel(this, reason);
        }
        getReader(rawOptions = void 0) {
          if (!IsReadableStream(this)) {
            throw streamBrandCheckException$1("getReader");
          }
          const options = convertReaderOptions(rawOptions, "First parameter");
          if (options.mode === void 0) {
            return AcquireReadableStreamDefaultReader(this);
          }
          return AcquireReadableStreamBYOBReader(this);
        }
        pipeThrough(rawTransform, rawOptions = {}) {
          if (!IsReadableStream(this)) {
            throw streamBrandCheckException$1("pipeThrough");
          }
          assertRequiredArgument(rawTransform, 1, "pipeThrough");
          const transform = convertReadableWritablePair(rawTransform, "First parameter");
          const options = convertPipeOptions(rawOptions, "Second parameter");
          if (IsReadableStreamLocked(this)) {
            throw new TypeError("ReadableStream.prototype.pipeThrough cannot be used on a locked ReadableStream");
          }
          if (IsWritableStreamLocked(transform.writable)) {
            throw new TypeError("ReadableStream.prototype.pipeThrough cannot be used on a locked WritableStream");
          }
          const promise = ReadableStreamPipeTo(this, transform.writable, options.preventClose, options.preventAbort, options.preventCancel, options.signal);
          setPromiseIsHandledToTrue(promise);
          return transform.readable;
        }
        pipeTo(destination, rawOptions = {}) {
          if (!IsReadableStream(this)) {
            return promiseRejectedWith(streamBrandCheckException$1("pipeTo"));
          }
          if (destination === void 0) {
            return promiseRejectedWith(`Parameter 1 is required in 'pipeTo'.`);
          }
          if (!IsWritableStream(destination)) {
            return promiseRejectedWith(new TypeError(`ReadableStream.prototype.pipeTo's first argument must be a WritableStream`));
          }
          let options;
          try {
            options = convertPipeOptions(rawOptions, "Second parameter");
          } catch (e2) {
            return promiseRejectedWith(e2);
          }
          if (IsReadableStreamLocked(this)) {
            return promiseRejectedWith(new TypeError("ReadableStream.prototype.pipeTo cannot be used on a locked ReadableStream"));
          }
          if (IsWritableStreamLocked(destination)) {
            return promiseRejectedWith(new TypeError("ReadableStream.prototype.pipeTo cannot be used on a locked WritableStream"));
          }
          return ReadableStreamPipeTo(this, destination, options.preventClose, options.preventAbort, options.preventCancel, options.signal);
        }
        /**
         * Tees this readable stream, returning a two-element array containing the two resulting branches as
         * new {@link ReadableStream} instances.
         *
         * Teeing a stream will lock it, preventing any other consumer from acquiring a reader.
         * To cancel the stream, cancel both of the resulting branches; a composite cancellation reason will then be
         * propagated to the stream's underlying source.
         *
         * Note that the chunks seen in each branch will be the same object. If the chunks are not immutable,
         * this could allow interference between the two branches.
         */
        tee() {
          if (!IsReadableStream(this)) {
            throw streamBrandCheckException$1("tee");
          }
          const branches = ReadableStreamTee(this);
          return CreateArrayFromList(branches);
        }
        values(rawOptions = void 0) {
          if (!IsReadableStream(this)) {
            throw streamBrandCheckException$1("values");
          }
          const options = convertIteratorOptions(rawOptions, "First parameter");
          return AcquireReadableStreamAsyncIterator(this, options.preventCancel);
        }
        [SymbolAsyncIterator](options) {
          return this.values(options);
        }
        /**
         * Creates a new ReadableStream wrapping the provided iterable or async iterable.
         *
         * This can be used to adapt various kinds of objects into a readable stream,
         * such as an array, an async generator, or a Node.js readable stream.
         */
        static from(asyncIterable) {
          return ReadableStreamFrom(asyncIterable);
        }
      }
      Object.defineProperties(ReadableStream2, {
        from: { enumerable: true }
      });
      Object.defineProperties(ReadableStream2.prototype, {
        cancel: { enumerable: true },
        getReader: { enumerable: true },
        pipeThrough: { enumerable: true },
        pipeTo: { enumerable: true },
        tee: { enumerable: true },
        values: { enumerable: true },
        locked: { enumerable: true }
      });
      setFunctionName(ReadableStream2.from, "from");
      setFunctionName(ReadableStream2.prototype.cancel, "cancel");
      setFunctionName(ReadableStream2.prototype.getReader, "getReader");
      setFunctionName(ReadableStream2.prototype.pipeThrough, "pipeThrough");
      setFunctionName(ReadableStream2.prototype.pipeTo, "pipeTo");
      setFunctionName(ReadableStream2.prototype.tee, "tee");
      setFunctionName(ReadableStream2.prototype.values, "values");
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(ReadableStream2.prototype, Symbol.toStringTag, {
          value: "ReadableStream",
          configurable: true
        });
      }
      Object.defineProperty(ReadableStream2.prototype, SymbolAsyncIterator, {
        value: ReadableStream2.prototype.values,
        writable: true,
        configurable: true
      });
      function CreateReadableStream(startAlgorithm, pullAlgorithm, cancelAlgorithm, highWaterMark = 1, sizeAlgorithm = () => 1) {
        const stream = Object.create(ReadableStream2.prototype);
        InitializeReadableStream(stream);
        const controller = Object.create(ReadableStreamDefaultController.prototype);
        SetUpReadableStreamDefaultController(stream, controller, startAlgorithm, pullAlgorithm, cancelAlgorithm, highWaterMark, sizeAlgorithm);
        return stream;
      }
      function CreateReadableByteStream(startAlgorithm, pullAlgorithm, cancelAlgorithm) {
        const stream = Object.create(ReadableStream2.prototype);
        InitializeReadableStream(stream);
        const controller = Object.create(ReadableByteStreamController.prototype);
        SetUpReadableByteStreamController(stream, controller, startAlgorithm, pullAlgorithm, cancelAlgorithm, 0, void 0);
        return stream;
      }
      function InitializeReadableStream(stream) {
        stream._state = "readable";
        stream._reader = void 0;
        stream._storedError = void 0;
        stream._disturbed = false;
      }
      function IsReadableStream(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_readableStreamController")) {
          return false;
        }
        return x2 instanceof ReadableStream2;
      }
      function IsReadableStreamLocked(stream) {
        if (stream._reader === void 0) {
          return false;
        }
        return true;
      }
      function ReadableStreamCancel(stream, reason) {
        stream._disturbed = true;
        if (stream._state === "closed") {
          return promiseResolvedWith(void 0);
        }
        if (stream._state === "errored") {
          return promiseRejectedWith(stream._storedError);
        }
        ReadableStreamClose(stream);
        const reader = stream._reader;
        if (reader !== void 0 && IsReadableStreamBYOBReader(reader)) {
          const readIntoRequests = reader._readIntoRequests;
          reader._readIntoRequests = new SimpleQueue();
          readIntoRequests.forEach((readIntoRequest) => {
            readIntoRequest._closeSteps(void 0);
          });
        }
        const sourceCancelPromise = stream._readableStreamController[CancelSteps](reason);
        return transformPromiseWith(sourceCancelPromise, noop);
      }
      function ReadableStreamClose(stream) {
        stream._state = "closed";
        const reader = stream._reader;
        if (reader === void 0) {
          return;
        }
        defaultReaderClosedPromiseResolve(reader);
        if (IsReadableStreamDefaultReader(reader)) {
          const readRequests = reader._readRequests;
          reader._readRequests = new SimpleQueue();
          readRequests.forEach((readRequest) => {
            readRequest._closeSteps();
          });
        }
      }
      function ReadableStreamError(stream, e2) {
        stream._state = "errored";
        stream._storedError = e2;
        const reader = stream._reader;
        if (reader === void 0) {
          return;
        }
        defaultReaderClosedPromiseReject(reader, e2);
        if (IsReadableStreamDefaultReader(reader)) {
          ReadableStreamDefaultReaderErrorReadRequests(reader, e2);
        } else {
          ReadableStreamBYOBReaderErrorReadIntoRequests(reader, e2);
        }
      }
      function streamBrandCheckException$1(name) {
        return new TypeError(`ReadableStream.prototype.${name} can only be used on a ReadableStream`);
      }
      function convertQueuingStrategyInit(init, context) {
        assertDictionary(init, context);
        const highWaterMark = init === null || init === void 0 ? void 0 : init.highWaterMark;
        assertRequiredField(highWaterMark, "highWaterMark", "QueuingStrategyInit");
        return {
          highWaterMark: convertUnrestrictedDouble(highWaterMark)
        };
      }
      const byteLengthSizeFunction = (chunk) => {
        return chunk.byteLength;
      };
      setFunctionName(byteLengthSizeFunction, "size");
      class ByteLengthQueuingStrategy {
        constructor(options) {
          assertRequiredArgument(options, 1, "ByteLengthQueuingStrategy");
          options = convertQueuingStrategyInit(options, "First parameter");
          this._byteLengthQueuingStrategyHighWaterMark = options.highWaterMark;
        }
        /**
         * Returns the high water mark provided to the constructor.
         */
        get highWaterMark() {
          if (!IsByteLengthQueuingStrategy(this)) {
            throw byteLengthBrandCheckException("highWaterMark");
          }
          return this._byteLengthQueuingStrategyHighWaterMark;
        }
        /**
         * Measures the size of `chunk` by returning the value of its `byteLength` property.
         */
        get size() {
          if (!IsByteLengthQueuingStrategy(this)) {
            throw byteLengthBrandCheckException("size");
          }
          return byteLengthSizeFunction;
        }
      }
      Object.defineProperties(ByteLengthQueuingStrategy.prototype, {
        highWaterMark: { enumerable: true },
        size: { enumerable: true }
      });
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(ByteLengthQueuingStrategy.prototype, Symbol.toStringTag, {
          value: "ByteLengthQueuingStrategy",
          configurable: true
        });
      }
      function byteLengthBrandCheckException(name) {
        return new TypeError(`ByteLengthQueuingStrategy.prototype.${name} can only be used on a ByteLengthQueuingStrategy`);
      }
      function IsByteLengthQueuingStrategy(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_byteLengthQueuingStrategyHighWaterMark")) {
          return false;
        }
        return x2 instanceof ByteLengthQueuingStrategy;
      }
      const countSizeFunction = () => {
        return 1;
      };
      setFunctionName(countSizeFunction, "size");
      class CountQueuingStrategy {
        constructor(options) {
          assertRequiredArgument(options, 1, "CountQueuingStrategy");
          options = convertQueuingStrategyInit(options, "First parameter");
          this._countQueuingStrategyHighWaterMark = options.highWaterMark;
        }
        /**
         * Returns the high water mark provided to the constructor.
         */
        get highWaterMark() {
          if (!IsCountQueuingStrategy(this)) {
            throw countBrandCheckException("highWaterMark");
          }
          return this._countQueuingStrategyHighWaterMark;
        }
        /**
         * Measures the size of `chunk` by always returning 1.
         * This ensures that the total queue size is a count of the number of chunks in the queue.
         */
        get size() {
          if (!IsCountQueuingStrategy(this)) {
            throw countBrandCheckException("size");
          }
          return countSizeFunction;
        }
      }
      Object.defineProperties(CountQueuingStrategy.prototype, {
        highWaterMark: { enumerable: true },
        size: { enumerable: true }
      });
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(CountQueuingStrategy.prototype, Symbol.toStringTag, {
          value: "CountQueuingStrategy",
          configurable: true
        });
      }
      function countBrandCheckException(name) {
        return new TypeError(`CountQueuingStrategy.prototype.${name} can only be used on a CountQueuingStrategy`);
      }
      function IsCountQueuingStrategy(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_countQueuingStrategyHighWaterMark")) {
          return false;
        }
        return x2 instanceof CountQueuingStrategy;
      }
      function convertTransformer(original, context) {
        assertDictionary(original, context);
        const cancel = original === null || original === void 0 ? void 0 : original.cancel;
        const flush = original === null || original === void 0 ? void 0 : original.flush;
        const readableType = original === null || original === void 0 ? void 0 : original.readableType;
        const start = original === null || original === void 0 ? void 0 : original.start;
        const transform = original === null || original === void 0 ? void 0 : original.transform;
        const writableType = original === null || original === void 0 ? void 0 : original.writableType;
        return {
          cancel: cancel === void 0 ? void 0 : convertTransformerCancelCallback(cancel, original, `${context} has member 'cancel' that`),
          flush: flush === void 0 ? void 0 : convertTransformerFlushCallback(flush, original, `${context} has member 'flush' that`),
          readableType,
          start: start === void 0 ? void 0 : convertTransformerStartCallback(start, original, `${context} has member 'start' that`),
          transform: transform === void 0 ? void 0 : convertTransformerTransformCallback(transform, original, `${context} has member 'transform' that`),
          writableType
        };
      }
      function convertTransformerFlushCallback(fn, original, context) {
        assertFunction(fn, context);
        return (controller) => promiseCall(fn, original, [controller]);
      }
      function convertTransformerStartCallback(fn, original, context) {
        assertFunction(fn, context);
        return (controller) => reflectCall(fn, original, [controller]);
      }
      function convertTransformerTransformCallback(fn, original, context) {
        assertFunction(fn, context);
        return (chunk, controller) => promiseCall(fn, original, [chunk, controller]);
      }
      function convertTransformerCancelCallback(fn, original, context) {
        assertFunction(fn, context);
        return (reason) => promiseCall(fn, original, [reason]);
      }
      class TransformStream {
        constructor(rawTransformer = {}, rawWritableStrategy = {}, rawReadableStrategy = {}) {
          if (rawTransformer === void 0) {
            rawTransformer = null;
          }
          const writableStrategy = convertQueuingStrategy(rawWritableStrategy, "Second parameter");
          const readableStrategy = convertQueuingStrategy(rawReadableStrategy, "Third parameter");
          const transformer = convertTransformer(rawTransformer, "First parameter");
          if (transformer.readableType !== void 0) {
            throw new RangeError("Invalid readableType specified");
          }
          if (transformer.writableType !== void 0) {
            throw new RangeError("Invalid writableType specified");
          }
          const readableHighWaterMark = ExtractHighWaterMark(readableStrategy, 0);
          const readableSizeAlgorithm = ExtractSizeAlgorithm(readableStrategy);
          const writableHighWaterMark = ExtractHighWaterMark(writableStrategy, 1);
          const writableSizeAlgorithm = ExtractSizeAlgorithm(writableStrategy);
          let startPromise_resolve;
          const startPromise = newPromise((resolve) => {
            startPromise_resolve = resolve;
          });
          InitializeTransformStream(this, startPromise, writableHighWaterMark, writableSizeAlgorithm, readableHighWaterMark, readableSizeAlgorithm);
          SetUpTransformStreamDefaultControllerFromTransformer(this, transformer);
          if (transformer.start !== void 0) {
            startPromise_resolve(transformer.start(this._transformStreamController));
          } else {
            startPromise_resolve(void 0);
          }
        }
        /**
         * The readable side of the transform stream.
         */
        get readable() {
          if (!IsTransformStream(this)) {
            throw streamBrandCheckException("readable");
          }
          return this._readable;
        }
        /**
         * The writable side of the transform stream.
         */
        get writable() {
          if (!IsTransformStream(this)) {
            throw streamBrandCheckException("writable");
          }
          return this._writable;
        }
      }
      Object.defineProperties(TransformStream.prototype, {
        readable: { enumerable: true },
        writable: { enumerable: true }
      });
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(TransformStream.prototype, Symbol.toStringTag, {
          value: "TransformStream",
          configurable: true
        });
      }
      function InitializeTransformStream(stream, startPromise, writableHighWaterMark, writableSizeAlgorithm, readableHighWaterMark, readableSizeAlgorithm) {
        function startAlgorithm() {
          return startPromise;
        }
        function writeAlgorithm(chunk) {
          return TransformStreamDefaultSinkWriteAlgorithm(stream, chunk);
        }
        function abortAlgorithm(reason) {
          return TransformStreamDefaultSinkAbortAlgorithm(stream, reason);
        }
        function closeAlgorithm() {
          return TransformStreamDefaultSinkCloseAlgorithm(stream);
        }
        stream._writable = CreateWritableStream(startAlgorithm, writeAlgorithm, closeAlgorithm, abortAlgorithm, writableHighWaterMark, writableSizeAlgorithm);
        function pullAlgorithm() {
          return TransformStreamDefaultSourcePullAlgorithm(stream);
        }
        function cancelAlgorithm(reason) {
          return TransformStreamDefaultSourceCancelAlgorithm(stream, reason);
        }
        stream._readable = CreateReadableStream(startAlgorithm, pullAlgorithm, cancelAlgorithm, readableHighWaterMark, readableSizeAlgorithm);
        stream._backpressure = void 0;
        stream._backpressureChangePromise = void 0;
        stream._backpressureChangePromise_resolve = void 0;
        TransformStreamSetBackpressure(stream, true);
        stream._transformStreamController = void 0;
      }
      function IsTransformStream(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_transformStreamController")) {
          return false;
        }
        return x2 instanceof TransformStream;
      }
      function TransformStreamError(stream, e2) {
        ReadableStreamDefaultControllerError(stream._readable._readableStreamController, e2);
        TransformStreamErrorWritableAndUnblockWrite(stream, e2);
      }
      function TransformStreamErrorWritableAndUnblockWrite(stream, e2) {
        TransformStreamDefaultControllerClearAlgorithms(stream._transformStreamController);
        WritableStreamDefaultControllerErrorIfNeeded(stream._writable._writableStreamController, e2);
        TransformStreamUnblockWrite(stream);
      }
      function TransformStreamUnblockWrite(stream) {
        if (stream._backpressure) {
          TransformStreamSetBackpressure(stream, false);
        }
      }
      function TransformStreamSetBackpressure(stream, backpressure) {
        if (stream._backpressureChangePromise !== void 0) {
          stream._backpressureChangePromise_resolve();
        }
        stream._backpressureChangePromise = newPromise((resolve) => {
          stream._backpressureChangePromise_resolve = resolve;
        });
        stream._backpressure = backpressure;
      }
      class TransformStreamDefaultController {
        constructor() {
          throw new TypeError("Illegal constructor");
        }
        /**
         * Returns the desired size to fill the readable side’s internal queue. It can be negative, if the queue is over-full.
         */
        get desiredSize() {
          if (!IsTransformStreamDefaultController(this)) {
            throw defaultControllerBrandCheckException("desiredSize");
          }
          const readableController = this._controlledTransformStream._readable._readableStreamController;
          return ReadableStreamDefaultControllerGetDesiredSize(readableController);
        }
        enqueue(chunk = void 0) {
          if (!IsTransformStreamDefaultController(this)) {
            throw defaultControllerBrandCheckException("enqueue");
          }
          TransformStreamDefaultControllerEnqueue(this, chunk);
        }
        /**
         * Errors both the readable side and the writable side of the controlled transform stream, making all future
         * interactions with it fail with the given error `e`. Any chunks queued for transformation will be discarded.
         */
        error(reason = void 0) {
          if (!IsTransformStreamDefaultController(this)) {
            throw defaultControllerBrandCheckException("error");
          }
          TransformStreamDefaultControllerError(this, reason);
        }
        /**
         * Closes the readable side and errors the writable side of the controlled transform stream. This is useful when the
         * transformer only needs to consume a portion of the chunks written to the writable side.
         */
        terminate() {
          if (!IsTransformStreamDefaultController(this)) {
            throw defaultControllerBrandCheckException("terminate");
          }
          TransformStreamDefaultControllerTerminate(this);
        }
      }
      Object.defineProperties(TransformStreamDefaultController.prototype, {
        enqueue: { enumerable: true },
        error: { enumerable: true },
        terminate: { enumerable: true },
        desiredSize: { enumerable: true }
      });
      setFunctionName(TransformStreamDefaultController.prototype.enqueue, "enqueue");
      setFunctionName(TransformStreamDefaultController.prototype.error, "error");
      setFunctionName(TransformStreamDefaultController.prototype.terminate, "terminate");
      if (typeof Symbol.toStringTag === "symbol") {
        Object.defineProperty(TransformStreamDefaultController.prototype, Symbol.toStringTag, {
          value: "TransformStreamDefaultController",
          configurable: true
        });
      }
      function IsTransformStreamDefaultController(x2) {
        if (!typeIsObject(x2)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(x2, "_controlledTransformStream")) {
          return false;
        }
        return x2 instanceof TransformStreamDefaultController;
      }
      function SetUpTransformStreamDefaultController(stream, controller, transformAlgorithm, flushAlgorithm, cancelAlgorithm) {
        controller._controlledTransformStream = stream;
        stream._transformStreamController = controller;
        controller._transformAlgorithm = transformAlgorithm;
        controller._flushAlgorithm = flushAlgorithm;
        controller._cancelAlgorithm = cancelAlgorithm;
        controller._finishPromise = void 0;
        controller._finishPromise_resolve = void 0;
        controller._finishPromise_reject = void 0;
      }
      function SetUpTransformStreamDefaultControllerFromTransformer(stream, transformer) {
        const controller = Object.create(TransformStreamDefaultController.prototype);
        let transformAlgorithm;
        let flushAlgorithm;
        let cancelAlgorithm;
        if (transformer.transform !== void 0) {
          transformAlgorithm = (chunk) => transformer.transform(chunk, controller);
        } else {
          transformAlgorithm = (chunk) => {
            try {
              TransformStreamDefaultControllerEnqueue(controller, chunk);
              return promiseResolvedWith(void 0);
            } catch (transformResultE) {
              return promiseRejectedWith(transformResultE);
            }
          };
        }
        if (transformer.flush !== void 0) {
          flushAlgorithm = () => transformer.flush(controller);
        } else {
          flushAlgorithm = () => promiseResolvedWith(void 0);
        }
        if (transformer.cancel !== void 0) {
          cancelAlgorithm = (reason) => transformer.cancel(reason);
        } else {
          cancelAlgorithm = () => promiseResolvedWith(void 0);
        }
        SetUpTransformStreamDefaultController(stream, controller, transformAlgorithm, flushAlgorithm, cancelAlgorithm);
      }
      function TransformStreamDefaultControllerClearAlgorithms(controller) {
        controller._transformAlgorithm = void 0;
        controller._flushAlgorithm = void 0;
        controller._cancelAlgorithm = void 0;
      }
      function TransformStreamDefaultControllerEnqueue(controller, chunk) {
        const stream = controller._controlledTransformStream;
        const readableController = stream._readable._readableStreamController;
        if (!ReadableStreamDefaultControllerCanCloseOrEnqueue(readableController)) {
          throw new TypeError("Readable side is not in a state that permits enqueue");
        }
        try {
          ReadableStreamDefaultControllerEnqueue(readableController, chunk);
        } catch (e2) {
          TransformStreamErrorWritableAndUnblockWrite(stream, e2);
          throw stream._readable._storedError;
        }
        const backpressure = ReadableStreamDefaultControllerHasBackpressure(readableController);
        if (backpressure !== stream._backpressure) {
          TransformStreamSetBackpressure(stream, true);
        }
      }
      function TransformStreamDefaultControllerError(controller, e2) {
        TransformStreamError(controller._controlledTransformStream, e2);
      }
      function TransformStreamDefaultControllerPerformTransform(controller, chunk) {
        const transformPromise = controller._transformAlgorithm(chunk);
        return transformPromiseWith(transformPromise, void 0, (r2) => {
          TransformStreamError(controller._controlledTransformStream, r2);
          throw r2;
        });
      }
      function TransformStreamDefaultControllerTerminate(controller) {
        const stream = controller._controlledTransformStream;
        const readableController = stream._readable._readableStreamController;
        ReadableStreamDefaultControllerClose(readableController);
        const error = new TypeError("TransformStream terminated");
        TransformStreamErrorWritableAndUnblockWrite(stream, error);
      }
      function TransformStreamDefaultSinkWriteAlgorithm(stream, chunk) {
        const controller = stream._transformStreamController;
        if (stream._backpressure) {
          const backpressureChangePromise = stream._backpressureChangePromise;
          return transformPromiseWith(backpressureChangePromise, () => {
            const writable = stream._writable;
            const state = writable._state;
            if (state === "erroring") {
              throw writable._storedError;
            }
            return TransformStreamDefaultControllerPerformTransform(controller, chunk);
          });
        }
        return TransformStreamDefaultControllerPerformTransform(controller, chunk);
      }
      function TransformStreamDefaultSinkAbortAlgorithm(stream, reason) {
        const controller = stream._transformStreamController;
        if (controller._finishPromise !== void 0) {
          return controller._finishPromise;
        }
        const readable = stream._readable;
        controller._finishPromise = newPromise((resolve, reject) => {
          controller._finishPromise_resolve = resolve;
          controller._finishPromise_reject = reject;
        });
        const cancelPromise = controller._cancelAlgorithm(reason);
        TransformStreamDefaultControllerClearAlgorithms(controller);
        uponPromise(cancelPromise, () => {
          if (readable._state === "errored") {
            defaultControllerFinishPromiseReject(controller, readable._storedError);
          } else {
            ReadableStreamDefaultControllerError(readable._readableStreamController, reason);
            defaultControllerFinishPromiseResolve(controller);
          }
          return null;
        }, (r2) => {
          ReadableStreamDefaultControllerError(readable._readableStreamController, r2);
          defaultControllerFinishPromiseReject(controller, r2);
          return null;
        });
        return controller._finishPromise;
      }
      function TransformStreamDefaultSinkCloseAlgorithm(stream) {
        const controller = stream._transformStreamController;
        if (controller._finishPromise !== void 0) {
          return controller._finishPromise;
        }
        const readable = stream._readable;
        controller._finishPromise = newPromise((resolve, reject) => {
          controller._finishPromise_resolve = resolve;
          controller._finishPromise_reject = reject;
        });
        const flushPromise = controller._flushAlgorithm();
        TransformStreamDefaultControllerClearAlgorithms(controller);
        uponPromise(flushPromise, () => {
          if (readable._state === "errored") {
            defaultControllerFinishPromiseReject(controller, readable._storedError);
          } else {
            ReadableStreamDefaultControllerClose(readable._readableStreamController);
            defaultControllerFinishPromiseResolve(controller);
          }
          return null;
        }, (r2) => {
          ReadableStreamDefaultControllerError(readable._readableStreamController, r2);
          defaultControllerFinishPromiseReject(controller, r2);
          return null;
        });
        return controller._finishPromise;
      }
      function TransformStreamDefaultSourcePullAlgorithm(stream) {
        TransformStreamSetBackpressure(stream, false);
        return stream._backpressureChangePromise;
      }
      function TransformStreamDefaultSourceCancelAlgorithm(stream, reason) {
        const controller = stream._transformStreamController;
        if (controller._finishPromise !== void 0) {
          return controller._finishPromise;
        }
        const writable = stream._writable;
        controller._finishPromise = newPromise((resolve, reject) => {
          controller._finishPromise_resolve = resolve;
          controller._finishPromise_reject = reject;
        });
        const cancelPromise = controller._cancelAlgorithm(reason);
        TransformStreamDefaultControllerClearAlgorithms(controller);
        uponPromise(cancelPromise, () => {
          if (writable._state === "errored") {
            defaultControllerFinishPromiseReject(controller, writable._storedError);
          } else {
            WritableStreamDefaultControllerErrorIfNeeded(writable._writableStreamController, reason);
            TransformStreamUnblockWrite(stream);
            defaultControllerFinishPromiseResolve(controller);
          }
          return null;
        }, (r2) => {
          WritableStreamDefaultControllerErrorIfNeeded(writable._writableStreamController, r2);
          TransformStreamUnblockWrite(stream);
          defaultControllerFinishPromiseReject(controller, r2);
          return null;
        });
        return controller._finishPromise;
      }
      function defaultControllerBrandCheckException(name) {
        return new TypeError(`TransformStreamDefaultController.prototype.${name} can only be used on a TransformStreamDefaultController`);
      }
      function defaultControllerFinishPromiseResolve(controller) {
        if (controller._finishPromise_resolve === void 0) {
          return;
        }
        controller._finishPromise_resolve();
        controller._finishPromise_resolve = void 0;
        controller._finishPromise_reject = void 0;
      }
      function defaultControllerFinishPromiseReject(controller, reason) {
        if (controller._finishPromise_reject === void 0) {
          return;
        }
        setPromiseIsHandledToTrue(controller._finishPromise);
        controller._finishPromise_reject(reason);
        controller._finishPromise_resolve = void 0;
        controller._finishPromise_reject = void 0;
      }
      function streamBrandCheckException(name) {
        return new TypeError(`TransformStream.prototype.${name} can only be used on a TransformStream`);
      }
      exports2.ByteLengthQueuingStrategy = ByteLengthQueuingStrategy;
      exports2.CountQueuingStrategy = CountQueuingStrategy;
      exports2.ReadableByteStreamController = ReadableByteStreamController;
      exports2.ReadableStream = ReadableStream2;
      exports2.ReadableStreamBYOBReader = ReadableStreamBYOBReader;
      exports2.ReadableStreamBYOBRequest = ReadableStreamBYOBRequest;
      exports2.ReadableStreamDefaultController = ReadableStreamDefaultController;
      exports2.ReadableStreamDefaultReader = ReadableStreamDefaultReader;
      exports2.TransformStream = TransformStream;
      exports2.TransformStreamDefaultController = TransformStreamDefaultController;
      exports2.WritableStream = WritableStream;
      exports2.WritableStreamDefaultController = WritableStreamDefaultController;
      exports2.WritableStreamDefaultWriter = WritableStreamDefaultWriter;
    }));
  })(ponyfill_es2018$1, ponyfill_es2018$1.exports);
  return ponyfill_es2018$1.exports;
}
var hasRequiredStreams;
function requireStreams() {
  if (hasRequiredStreams) return streams;
  hasRequiredStreams = 1;
  const POOL_SIZE2 = 65536;
  if (!globalThis.ReadableStream) {
    try {
      const process2 = require("node:process");
      const { emitWarning } = process2;
      try {
        process2.emitWarning = () => {
        };
        Object.assign(globalThis, require("node:stream/web"));
        process2.emitWarning = emitWarning;
      } catch (error) {
        process2.emitWarning = emitWarning;
        throw error;
      }
    } catch (error) {
      Object.assign(globalThis, requirePonyfill_es2018());
    }
  }
  try {
    const { Blob: Blob3 } = require("buffer");
    if (Blob3 && !Blob3.prototype.stream) {
      Blob3.prototype.stream = function name(params) {
        let position = 0;
        const blob = this;
        return new ReadableStream({
          type: "bytes",
          async pull(ctrl) {
            const chunk = blob.slice(position, Math.min(blob.size, position + POOL_SIZE2));
            const buffer = await chunk.arrayBuffer();
            position += buffer.byteLength;
            ctrl.enqueue(new Uint8Array(buffer));
            if (position === blob.size) {
              ctrl.close();
            }
          }
        });
      };
    }
  } catch (error) {
  }
  return streams;
}
requireStreams();
const POOL_SIZE = 65536;
async function* toIterator(parts, clone2 = true) {
  for (const part of parts) {
    if ("stream" in part) {
      yield* (
        /** @type {AsyncIterableIterator<Uint8Array>} */
        part.stream()
      );
    } else if (ArrayBuffer.isView(part)) {
      if (clone2) {
        let position = part.byteOffset;
        const end = part.byteOffset + part.byteLength;
        while (position !== end) {
          const size = Math.min(end - position, POOL_SIZE);
          const chunk = part.buffer.slice(position, position + size);
          position += chunk.byteLength;
          yield new Uint8Array(chunk);
        }
      } else {
        yield part;
      }
    } else {
      let position = 0, b = (
        /** @type {Blob} */
        part
      );
      while (position !== b.size) {
        const chunk = b.slice(position, Math.min(b.size, position + POOL_SIZE));
        const buffer = await chunk.arrayBuffer();
        position += buffer.byteLength;
        yield new Uint8Array(buffer);
      }
    }
  }
}
const _Blob = class Blob {
  /** @type {Array.<(Blob|Uint8Array)>} */
  #parts = [];
  #type = "";
  #size = 0;
  #endings = "transparent";
  /**
   * The Blob() constructor returns a new Blob object. The content
   * of the blob consists of the concatenation of the values given
   * in the parameter array.
   *
   * @param {*} blobParts
   * @param {{ type?: string, endings?: string }} [options]
   */
  constructor(blobParts = [], options = {}) {
    if (typeof blobParts !== "object" || blobParts === null) {
      throw new TypeError("Failed to construct 'Blob': The provided value cannot be converted to a sequence.");
    }
    if (typeof blobParts[Symbol.iterator] !== "function") {
      throw new TypeError("Failed to construct 'Blob': The object must have a callable @@iterator property.");
    }
    if (typeof options !== "object" && typeof options !== "function") {
      throw new TypeError("Failed to construct 'Blob': parameter 2 cannot convert to dictionary.");
    }
    if (options === null) options = {};
    const encoder = new TextEncoder();
    for (const element of blobParts) {
      let part;
      if (ArrayBuffer.isView(element)) {
        part = new Uint8Array(element.buffer.slice(element.byteOffset, element.byteOffset + element.byteLength));
      } else if (element instanceof ArrayBuffer) {
        part = new Uint8Array(element.slice(0));
      } else if (element instanceof Blob) {
        part = element;
      } else {
        part = encoder.encode(`${element}`);
      }
      this.#size += ArrayBuffer.isView(part) ? part.byteLength : part.size;
      this.#parts.push(part);
    }
    this.#endings = `${options.endings === void 0 ? "transparent" : options.endings}`;
    const type = options.type === void 0 ? "" : String(options.type);
    this.#type = /^[\x20-\x7E]*$/.test(type) ? type : "";
  }
  /**
   * The Blob interface's size property returns the
   * size of the Blob in bytes.
   */
  get size() {
    return this.#size;
  }
  /**
   * The type property of a Blob object returns the MIME type of the file.
   */
  get type() {
    return this.#type;
  }
  /**
   * The text() method in the Blob interface returns a Promise
   * that resolves with a string containing the contents of
   * the blob, interpreted as UTF-8.
   *
   * @return {Promise<string>}
   */
  async text() {
    const decoder = new TextDecoder();
    let str = "";
    for await (const part of toIterator(this.#parts, false)) {
      str += decoder.decode(part, { stream: true });
    }
    str += decoder.decode();
    return str;
  }
  /**
   * The arrayBuffer() method in the Blob interface returns a
   * Promise that resolves with the contents of the blob as
   * binary data contained in an ArrayBuffer.
   *
   * @return {Promise<ArrayBuffer>}
   */
  async arrayBuffer() {
    const data = new Uint8Array(this.size);
    let offset = 0;
    for await (const chunk of toIterator(this.#parts, false)) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return data.buffer;
  }
  stream() {
    const it = toIterator(this.#parts, true);
    return new globalThis.ReadableStream({
      // @ts-ignore
      type: "bytes",
      async pull(ctrl) {
        const chunk = await it.next();
        chunk.done ? ctrl.close() : ctrl.enqueue(chunk.value);
      },
      async cancel() {
        await it.return();
      }
    });
  }
  /**
   * The Blob interface's slice() method creates and returns a
   * new Blob object which contains data from a subset of the
   * blob on which it's called.
   *
   * @param {number} [start]
   * @param {number} [end]
   * @param {string} [type]
   */
  slice(start = 0, end = this.size, type = "") {
    const { size } = this;
    let relativeStart = start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
    let relativeEnd = end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
    const span = Math.max(relativeEnd - relativeStart, 0);
    const parts = this.#parts;
    const blobParts = [];
    let added = 0;
    for (const part of parts) {
      if (added >= span) {
        break;
      }
      const size2 = ArrayBuffer.isView(part) ? part.byteLength : part.size;
      if (relativeStart && size2 <= relativeStart) {
        relativeStart -= size2;
        relativeEnd -= size2;
      } else {
        let chunk;
        if (ArrayBuffer.isView(part)) {
          chunk = part.subarray(relativeStart, Math.min(size2, relativeEnd));
          added += chunk.byteLength;
        } else {
          chunk = part.slice(relativeStart, Math.min(size2, relativeEnd));
          added += chunk.size;
        }
        relativeEnd -= size2;
        blobParts.push(chunk);
        relativeStart = 0;
      }
    }
    const blob = new Blob([], { type: String(type).toLowerCase() });
    blob.#size = span;
    blob.#parts = blobParts;
    return blob;
  }
  get [Symbol.toStringTag]() {
    return "Blob";
  }
  static [Symbol.hasInstance](object) {
    return object && typeof object === "object" && typeof object.constructor === "function" && (typeof object.stream === "function" || typeof object.arrayBuffer === "function") && /^(Blob|File)$/.test(object[Symbol.toStringTag]);
  }
};
Object.defineProperties(_Blob.prototype, {
  size: { enumerable: true },
  type: { enumerable: true },
  slice: { enumerable: true }
});
const Blob2 = _Blob;
const _File = class File extends Blob2 {
  #lastModified = 0;
  #name = "";
  /**
   * @param {*[]} fileBits
   * @param {string} fileName
   * @param {{lastModified?: number, type?: string}} options
   */
  // @ts-ignore
  constructor(fileBits, fileName, options = {}) {
    if (arguments.length < 2) {
      throw new TypeError(`Failed to construct 'File': 2 arguments required, but only ${arguments.length} present.`);
    }
    super(fileBits, options);
    if (options === null) options = {};
    const lastModified = options.lastModified === void 0 ? Date.now() : Number(options.lastModified);
    if (!Number.isNaN(lastModified)) {
      this.#lastModified = lastModified;
    }
    this.#name = String(fileName);
  }
  get name() {
    return this.#name;
  }
  get lastModified() {
    return this.#lastModified;
  }
  get [Symbol.toStringTag]() {
    return "File";
  }
  static [Symbol.hasInstance](object) {
    return !!object && object instanceof Blob2 && /^(File)$/.test(object[Symbol.toStringTag]);
  }
};
const File2 = _File;
var { toStringTag: t, iterator: i, hasInstance: h } = Symbol, r = Math.random, m = "append,set,get,getAll,delete,keys,values,entries,forEach,constructor".split(","), f = (a, b, c) => (a += "", /^(Blob|File)$/.test(b && b[t]) ? [(c = c !== void 0 ? c + "" : b[t] == "File" ? b.name : "blob", a), b.name !== c || b[t] == "blob" ? new File2([b], c, b) : b] : [a, b + ""]), e = (c, f2) => (f2 ? c : c.replace(/\r?\n|\r/g, "\r\n")).replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/"/g, "%22"), x = (n, a, e2) => {
  if (a.length < e2) {
    throw new TypeError(`Failed to execute '${n}' on 'FormData': ${e2} arguments required, but only ${a.length} present.`);
  }
};
const FormData = class FormData2 {
  #d = [];
  constructor(...a) {
    if (a.length) throw new TypeError(`Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.`);
  }
  get [t]() {
    return "FormData";
  }
  [i]() {
    return this.entries();
  }
  static [h](o) {
    return o && typeof o === "object" && o[t] === "FormData" && !m.some((m2) => typeof o[m2] != "function");
  }
  append(...a) {
    x("append", arguments, 2);
    this.#d.push(f(...a));
  }
  delete(a) {
    x("delete", arguments, 1);
    a += "";
    this.#d = this.#d.filter(([b]) => b !== a);
  }
  get(a) {
    x("get", arguments, 1);
    a += "";
    for (var b = this.#d, l = b.length, c = 0; c < l; c++) if (b[c][0] === a) return b[c][1];
    return null;
  }
  getAll(a, b) {
    x("getAll", arguments, 1);
    b = [];
    a += "";
    this.#d.forEach((c) => c[0] === a && b.push(c[1]));
    return b;
  }
  has(a) {
    x("has", arguments, 1);
    a += "";
    return this.#d.some((b) => b[0] === a);
  }
  forEach(a, b) {
    x("forEach", arguments, 1);
    for (var [c, d] of this) a.call(b, d, c, this);
  }
  set(...a) {
    x("set", arguments, 2);
    var b = [], c = true;
    a = f(...a);
    this.#d.forEach((d) => {
      d[0] === a[0] ? c && (c = !b.push(a)) : b.push(d);
    });
    c && b.push(a);
    this.#d = b;
  }
  *entries() {
    yield* this.#d;
  }
  *keys() {
    for (var [a] of this) yield a;
  }
  *values() {
    for (var [, a] of this) yield a;
  }
};
function formDataToBlob(F, B = Blob2) {
  var b = `${r()}${r()}`.replace(/\./g, "").slice(-28).padStart(32, "-"), c = [], p = `--${b}\r
Content-Disposition: form-data; name="`;
  F.forEach((v, n) => typeof v == "string" ? c.push(p + e(n) + `"\r
\r
${v.replace(/\r(?!\n)|(?<!\r)\n/g, "\r\n")}\r
`) : c.push(p + e(n) + `"; filename="${e(v.name, 1)}"\r
Content-Type: ${v.type || "application/octet-stream"}\r
\r
`, v, "\r\n"));
  c.push(`--${b}--`);
  return new B(c, { type: "multipart/form-data; boundary=" + b });
}
class FetchBaseError extends Error {
  constructor(message, type) {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.type = type;
  }
  get name() {
    return this.constructor.name;
  }
  get [Symbol.toStringTag]() {
    return this.constructor.name;
  }
}
class FetchError extends FetchBaseError {
  /**
   * @param  {string} message -      Error message for human
   * @param  {string} [type] -        Error type for machine
   * @param  {SystemError} [systemError] - For Node.js system error
   */
  constructor(message, type, systemError) {
    super(message, type);
    if (systemError) {
      this.code = this.errno = systemError.code;
      this.erroredSysCall = systemError.syscall;
    }
  }
}
const NAME = Symbol.toStringTag;
const isURLSearchParameters = (object) => {
  return typeof object === "object" && typeof object.append === "function" && typeof object.delete === "function" && typeof object.get === "function" && typeof object.getAll === "function" && typeof object.has === "function" && typeof object.set === "function" && typeof object.sort === "function" && object[NAME] === "URLSearchParams";
};
const isBlob = (object) => {
  return object && typeof object === "object" && typeof object.arrayBuffer === "function" && typeof object.type === "string" && typeof object.stream === "function" && typeof object.constructor === "function" && /^(Blob|File)$/.test(object[NAME]);
};
const isAbortSignal = (object) => {
  return typeof object === "object" && (object[NAME] === "AbortSignal" || object[NAME] === "EventTarget");
};
const isDomainOrSubdomain = (destination, original) => {
  const orig = new URL(original).hostname;
  const dest = new URL(destination).hostname;
  return orig === dest || orig.endsWith(`.${dest}`);
};
const isSameProtocol = (destination, original) => {
  const orig = new URL(original).protocol;
  const dest = new URL(destination).protocol;
  return orig === dest;
};
const pipeline = promisify(Stream.pipeline);
const INTERNALS$2 = /* @__PURE__ */ Symbol("Body internals");
class Body {
  constructor(body, {
    size = 0
  } = {}) {
    let boundary = null;
    if (body === null) {
      body = null;
    } else if (isURLSearchParameters(body)) {
      body = Buffer$1.from(body.toString());
    } else if (isBlob(body)) ;
    else if (Buffer$1.isBuffer(body)) ;
    else if (types$1.isAnyArrayBuffer(body)) {
      body = Buffer$1.from(body);
    } else if (ArrayBuffer.isView(body)) {
      body = Buffer$1.from(body.buffer, body.byteOffset, body.byteLength);
    } else if (body instanceof Stream) ;
    else if (body instanceof FormData) {
      body = formDataToBlob(body);
      boundary = body.type.split("=")[1];
    } else {
      body = Buffer$1.from(String(body));
    }
    let stream = body;
    if (Buffer$1.isBuffer(body)) {
      stream = Stream.Readable.from(body);
    } else if (isBlob(body)) {
      stream = Stream.Readable.from(body.stream());
    }
    this[INTERNALS$2] = {
      body,
      stream,
      boundary,
      disturbed: false,
      error: null
    };
    this.size = size;
    if (body instanceof Stream) {
      body.on("error", (error_) => {
        const error = error_ instanceof FetchBaseError ? error_ : new FetchError(`Invalid response body while trying to fetch ${this.url}: ${error_.message}`, "system", error_);
        this[INTERNALS$2].error = error;
      });
    }
  }
  get body() {
    return this[INTERNALS$2].stream;
  }
  get bodyUsed() {
    return this[INTERNALS$2].disturbed;
  }
  /**
   * Decode response as ArrayBuffer
   *
   * @return  Promise
   */
  async arrayBuffer() {
    const { buffer, byteOffset, byteLength } = await consumeBody(this);
    return buffer.slice(byteOffset, byteOffset + byteLength);
  }
  async formData() {
    const ct = this.headers.get("content-type");
    if (ct.startsWith("application/x-www-form-urlencoded")) {
      const formData = new FormData();
      const parameters = new URLSearchParams(await this.text());
      for (const [name, value] of parameters) {
        formData.append(name, value);
      }
      return formData;
    }
    const { toFormData } = await import("./chunks/multipart-parser-DbzMRhG1.js");
    return toFormData(this.body, ct);
  }
  /**
   * Return raw response as Blob
   *
   * @return Promise
   */
  async blob() {
    const ct = this.headers && this.headers.get("content-type") || this[INTERNALS$2].body && this[INTERNALS$2].body.type || "";
    const buf = await this.arrayBuffer();
    return new Blob2([buf], {
      type: ct
    });
  }
  /**
   * Decode response as json
   *
   * @return  Promise
   */
  async json() {
    const text = await this.text();
    return JSON.parse(text);
  }
  /**
   * Decode response as text
   *
   * @return  Promise
   */
  async text() {
    const buffer = await consumeBody(this);
    return new TextDecoder().decode(buffer);
  }
  /**
   * Decode response as buffer (non-spec api)
   *
   * @return  Promise
   */
  buffer() {
    return consumeBody(this);
  }
}
Body.prototype.buffer = deprecate(Body.prototype.buffer, "Please use 'response.arrayBuffer()' instead of 'response.buffer()'", "node-fetch#buffer");
Object.defineProperties(Body.prototype, {
  body: { enumerable: true },
  bodyUsed: { enumerable: true },
  arrayBuffer: { enumerable: true },
  blob: { enumerable: true },
  json: { enumerable: true },
  text: { enumerable: true },
  data: { get: deprecate(
    () => {
    },
    "data doesn't exist, use json(), text(), arrayBuffer(), or body instead",
    "https://github.com/node-fetch/node-fetch/issues/1000 (response)"
  ) }
});
async function consumeBody(data) {
  if (data[INTERNALS$2].disturbed) {
    throw new TypeError(`body used already for: ${data.url}`);
  }
  data[INTERNALS$2].disturbed = true;
  if (data[INTERNALS$2].error) {
    throw data[INTERNALS$2].error;
  }
  const { body } = data;
  if (body === null) {
    return Buffer$1.alloc(0);
  }
  if (!(body instanceof Stream)) {
    return Buffer$1.alloc(0);
  }
  const accum = [];
  let accumBytes = 0;
  try {
    for await (const chunk of body) {
      if (data.size > 0 && accumBytes + chunk.length > data.size) {
        const error = new FetchError(`content size at ${data.url} over limit: ${data.size}`, "max-size");
        body.destroy(error);
        throw error;
      }
      accumBytes += chunk.length;
      accum.push(chunk);
    }
  } catch (error) {
    const error_ = error instanceof FetchBaseError ? error : new FetchError(`Invalid response body while trying to fetch ${data.url}: ${error.message}`, "system", error);
    throw error_;
  }
  if (body.readableEnded === true || body._readableState.ended === true) {
    try {
      if (accum.every((c) => typeof c === "string")) {
        return Buffer$1.from(accum.join(""));
      }
      return Buffer$1.concat(accum, accumBytes);
    } catch (error) {
      throw new FetchError(`Could not create Buffer from response body for ${data.url}: ${error.message}`, "system", error);
    }
  } else {
    throw new FetchError(`Premature close of server response while trying to fetch ${data.url}`);
  }
}
const clone = (instance, highWaterMark) => {
  let p1;
  let p2;
  let { body } = instance[INTERNALS$2];
  if (instance.bodyUsed) {
    throw new Error("cannot clone body after it is used");
  }
  if (body instanceof Stream && typeof body.getBoundary !== "function") {
    p1 = new PassThrough({ highWaterMark });
    p2 = new PassThrough({ highWaterMark });
    body.pipe(p1);
    body.pipe(p2);
    instance[INTERNALS$2].stream = p1;
    body = p2;
  }
  return body;
};
const getNonSpecFormDataBoundary = deprecate(
  (body) => body.getBoundary(),
  "form-data doesn't follow the spec and requires special treatment. Use alternative package",
  "https://github.com/node-fetch/node-fetch/issues/1167"
);
const extractContentType = (body, request2) => {
  if (body === null) {
    return null;
  }
  if (typeof body === "string") {
    return "text/plain;charset=UTF-8";
  }
  if (isURLSearchParameters(body)) {
    return "application/x-www-form-urlencoded;charset=UTF-8";
  }
  if (isBlob(body)) {
    return body.type || null;
  }
  if (Buffer$1.isBuffer(body) || types$1.isAnyArrayBuffer(body) || ArrayBuffer.isView(body)) {
    return null;
  }
  if (body instanceof FormData) {
    return `multipart/form-data; boundary=${request2[INTERNALS$2].boundary}`;
  }
  if (body && typeof body.getBoundary === "function") {
    return `multipart/form-data;boundary=${getNonSpecFormDataBoundary(body)}`;
  }
  if (body instanceof Stream) {
    return null;
  }
  return "text/plain;charset=UTF-8";
};
const getTotalBytes = (request2) => {
  const { body } = request2[INTERNALS$2];
  if (body === null) {
    return 0;
  }
  if (isBlob(body)) {
    return body.size;
  }
  if (Buffer$1.isBuffer(body)) {
    return body.length;
  }
  if (body && typeof body.getLengthSync === "function") {
    return body.hasKnownLength && body.hasKnownLength() ? body.getLengthSync() : null;
  }
  return null;
};
const writeToStream = async (dest, { body }) => {
  if (body === null) {
    dest.end();
  } else {
    await pipeline(body, dest);
  }
};
const validateHeaderName = typeof http.validateHeaderName === "function" ? http.validateHeaderName : (name) => {
  if (!/^[\^`\-\w!#$%&'*+.|~]+$/.test(name)) {
    const error = new TypeError(`Header name must be a valid HTTP token [${name}]`);
    Object.defineProperty(error, "code", { value: "ERR_INVALID_HTTP_TOKEN" });
    throw error;
  }
};
const validateHeaderValue = typeof http.validateHeaderValue === "function" ? http.validateHeaderValue : (name, value) => {
  if (/[^\t\u0020-\u007E\u0080-\u00FF]/.test(value)) {
    const error = new TypeError(`Invalid character in header content ["${name}"]`);
    Object.defineProperty(error, "code", { value: "ERR_INVALID_CHAR" });
    throw error;
  }
};
class Headers extends URLSearchParams {
  /**
   * Headers class
   *
   * @constructor
   * @param {HeadersInit} [init] - Response headers
   */
  constructor(init) {
    let result = [];
    if (init instanceof Headers) {
      const raw = init.raw();
      for (const [name, values] of Object.entries(raw)) {
        result.push(...values.map((value) => [name, value]));
      }
    } else if (init == null) ;
    else if (typeof init === "object" && !types$1.isBoxedPrimitive(init)) {
      const method = init[Symbol.iterator];
      if (method == null) {
        result.push(...Object.entries(init));
      } else {
        if (typeof method !== "function") {
          throw new TypeError("Header pairs must be iterable");
        }
        result = [...init].map((pair) => {
          if (typeof pair !== "object" || types$1.isBoxedPrimitive(pair)) {
            throw new TypeError("Each header pair must be an iterable object");
          }
          return [...pair];
        }).map((pair) => {
          if (pair.length !== 2) {
            throw new TypeError("Each header pair must be a name/value tuple");
          }
          return [...pair];
        });
      }
    } else {
      throw new TypeError("Failed to construct 'Headers': The provided value is not of type '(sequence<sequence<ByteString>> or record<ByteString, ByteString>)");
    }
    result = result.length > 0 ? result.map(([name, value]) => {
      validateHeaderName(name);
      validateHeaderValue(name, String(value));
      return [String(name).toLowerCase(), String(value)];
    }) : void 0;
    super(result);
    return new Proxy(this, {
      get(target, p, receiver) {
        switch (p) {
          case "append":
          case "set":
            return (name, value) => {
              validateHeaderName(name);
              validateHeaderValue(name, String(value));
              return URLSearchParams.prototype[p].call(
                target,
                String(name).toLowerCase(),
                String(value)
              );
            };
          case "delete":
          case "has":
          case "getAll":
            return (name) => {
              validateHeaderName(name);
              return URLSearchParams.prototype[p].call(
                target,
                String(name).toLowerCase()
              );
            };
          case "keys":
            return () => {
              target.sort();
              return new Set(URLSearchParams.prototype.keys.call(target)).keys();
            };
          default:
            return Reflect.get(target, p, receiver);
        }
      }
    });
  }
  get [Symbol.toStringTag]() {
    return this.constructor.name;
  }
  toString() {
    return Object.prototype.toString.call(this);
  }
  get(name) {
    const values = this.getAll(name);
    if (values.length === 0) {
      return null;
    }
    let value = values.join(", ");
    if (/^content-encoding$/i.test(name)) {
      value = value.toLowerCase();
    }
    return value;
  }
  forEach(callback, thisArg = void 0) {
    for (const name of this.keys()) {
      Reflect.apply(callback, thisArg, [this.get(name), name, this]);
    }
  }
  *values() {
    for (const name of this.keys()) {
      yield this.get(name);
    }
  }
  /**
   * @type {() => IterableIterator<[string, string]>}
   */
  *entries() {
    for (const name of this.keys()) {
      yield [name, this.get(name)];
    }
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  /**
   * Node-fetch non-spec method
   * returning all headers and their values as array
   * @returns {Record<string, string[]>}
   */
  raw() {
    return [...this.keys()].reduce((result, key) => {
      result[key] = this.getAll(key);
      return result;
    }, {});
  }
  /**
   * For better console.log(headers) and also to convert Headers into Node.js Request compatible format
   */
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return [...this.keys()].reduce((result, key) => {
      const values = this.getAll(key);
      if (key === "host") {
        result[key] = values[0];
      } else {
        result[key] = values.length > 1 ? values : values[0];
      }
      return result;
    }, {});
  }
}
Object.defineProperties(
  Headers.prototype,
  ["get", "entries", "forEach", "values"].reduce((result, property) => {
    result[property] = { enumerable: true };
    return result;
  }, {})
);
function fromRawHeaders(headers = []) {
  return new Headers(
    headers.reduce((result, value, index, array) => {
      if (index % 2 === 0) {
        result.push(array.slice(index, index + 2));
      }
      return result;
    }, []).filter(([name, value]) => {
      try {
        validateHeaderName(name);
        validateHeaderValue(name, String(value));
        return true;
      } catch {
        return false;
      }
    })
  );
}
const redirectStatus = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
const isRedirect = (code) => {
  return redirectStatus.has(code);
};
const INTERNALS$1 = /* @__PURE__ */ Symbol("Response internals");
class Response extends Body {
  constructor(body = null, options = {}) {
    super(body, options);
    const status = options.status != null ? options.status : 200;
    const headers = new Headers(options.headers);
    if (body !== null && !headers.has("Content-Type")) {
      const contentType = extractContentType(body, this);
      if (contentType) {
        headers.append("Content-Type", contentType);
      }
    }
    this[INTERNALS$1] = {
      type: "default",
      url: options.url,
      status,
      statusText: options.statusText || "",
      headers,
      counter: options.counter,
      highWaterMark: options.highWaterMark
    };
  }
  get type() {
    return this[INTERNALS$1].type;
  }
  get url() {
    return this[INTERNALS$1].url || "";
  }
  get status() {
    return this[INTERNALS$1].status;
  }
  /**
   * Convenience property representing if the request ended normally
   */
  get ok() {
    return this[INTERNALS$1].status >= 200 && this[INTERNALS$1].status < 300;
  }
  get redirected() {
    return this[INTERNALS$1].counter > 0;
  }
  get statusText() {
    return this[INTERNALS$1].statusText;
  }
  get headers() {
    return this[INTERNALS$1].headers;
  }
  get highWaterMark() {
    return this[INTERNALS$1].highWaterMark;
  }
  /**
   * Clone this response
   *
   * @return  Response
   */
  clone() {
    return new Response(clone(this, this.highWaterMark), {
      type: this.type,
      url: this.url,
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
      ok: this.ok,
      redirected: this.redirected,
      size: this.size,
      highWaterMark: this.highWaterMark
    });
  }
  /**
   * @param {string} url    The URL that the new response is to originate from.
   * @param {number} status An optional status code for the response (e.g., 302.)
   * @returns {Response}    A Response object.
   */
  static redirect(url, status = 302) {
    if (!isRedirect(status)) {
      throw new RangeError('Failed to execute "redirect" on "response": Invalid status code');
    }
    return new Response(null, {
      headers: {
        location: new URL(url).toString()
      },
      status
    });
  }
  static error() {
    const response = new Response(null, { status: 0, statusText: "" });
    response[INTERNALS$1].type = "error";
    return response;
  }
  static json(data = void 0, init = {}) {
    const body = JSON.stringify(data);
    if (body === void 0) {
      throw new TypeError("data is not JSON serializable");
    }
    const headers = new Headers(init && init.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return new Response(body, {
      ...init,
      headers
    });
  }
  get [Symbol.toStringTag]() {
    return "Response";
  }
}
Object.defineProperties(Response.prototype, {
  type: { enumerable: true },
  url: { enumerable: true },
  status: { enumerable: true },
  ok: { enumerable: true },
  redirected: { enumerable: true },
  statusText: { enumerable: true },
  headers: { enumerable: true },
  clone: { enumerable: true }
});
const getSearch$1 = (parsedURL) => {
  if (parsedURL.search) {
    return parsedURL.search;
  }
  const lastOffset = parsedURL.href.length - 1;
  const hash = parsedURL.hash || (parsedURL.href[lastOffset] === "#" ? "#" : "");
  return parsedURL.href[lastOffset - hash.length] === "?" ? "?" : "";
};
function stripURLForUseAsAReferrer(url, originOnly = false) {
  if (url == null) {
    return "no-referrer";
  }
  url = new URL(url);
  if (/^(about|blob|data):$/.test(url.protocol)) {
    return "no-referrer";
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  if (originOnly) {
    url.pathname = "";
    url.search = "";
  }
  return url;
}
const ReferrerPolicy = /* @__PURE__ */ new Set([
  "",
  "no-referrer",
  "no-referrer-when-downgrade",
  "same-origin",
  "origin",
  "strict-origin",
  "origin-when-cross-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url"
]);
const DEFAULT_REFERRER_POLICY = "strict-origin-when-cross-origin";
function validateReferrerPolicy(referrerPolicy) {
  if (!ReferrerPolicy.has(referrerPolicy)) {
    throw new TypeError(`Invalid referrerPolicy: ${referrerPolicy}`);
  }
  return referrerPolicy;
}
function isOriginPotentiallyTrustworthy(url) {
  if (/^(http|ws)s:$/.test(url.protocol)) {
    return true;
  }
  const hostIp = url.host.replace(/(^\[)|(]$)/g, "");
  const hostIPVersion = isIP(hostIp);
  if (hostIPVersion === 4 && /^127\./.test(hostIp)) {
    return true;
  }
  if (hostIPVersion === 6 && /^(((0+:){7})|(::(0+:){0,6}))0*1$/.test(hostIp)) {
    return true;
  }
  if (url.host === "localhost" || url.host.endsWith(".localhost")) {
    return false;
  }
  if (url.protocol === "file:") {
    return true;
  }
  return false;
}
function isUrlPotentiallyTrustworthy(url) {
  if (/^about:(blank|srcdoc)$/.test(url)) {
    return true;
  }
  if (url.protocol === "data:") {
    return true;
  }
  if (/^(blob|filesystem):$/.test(url.protocol)) {
    return true;
  }
  return isOriginPotentiallyTrustworthy(url);
}
function determineRequestsReferrer(request2, { referrerURLCallback, referrerOriginCallback } = {}) {
  if (request2.referrer === "no-referrer" || request2.referrerPolicy === "") {
    return null;
  }
  const policy = request2.referrerPolicy;
  if (request2.referrer === "about:client") {
    return "no-referrer";
  }
  const referrerSource = request2.referrer;
  let referrerURL = stripURLForUseAsAReferrer(referrerSource);
  let referrerOrigin = stripURLForUseAsAReferrer(referrerSource, true);
  if (referrerURL.toString().length > 4096) {
    referrerURL = referrerOrigin;
  }
  if (referrerURLCallback) {
    referrerURL = referrerURLCallback(referrerURL);
  }
  if (referrerOriginCallback) {
    referrerOrigin = referrerOriginCallback(referrerOrigin);
  }
  const currentURL = new URL(request2.url);
  switch (policy) {
    case "no-referrer":
      return "no-referrer";
    case "origin":
      return referrerOrigin;
    case "unsafe-url":
      return referrerURL;
    case "strict-origin":
      if (isUrlPotentiallyTrustworthy(referrerURL) && !isUrlPotentiallyTrustworthy(currentURL)) {
        return "no-referrer";
      }
      return referrerOrigin.toString();
    case "strict-origin-when-cross-origin":
      if (referrerURL.origin === currentURL.origin) {
        return referrerURL;
      }
      if (isUrlPotentiallyTrustworthy(referrerURL) && !isUrlPotentiallyTrustworthy(currentURL)) {
        return "no-referrer";
      }
      return referrerOrigin;
    case "same-origin":
      if (referrerURL.origin === currentURL.origin) {
        return referrerURL;
      }
      return "no-referrer";
    case "origin-when-cross-origin":
      if (referrerURL.origin === currentURL.origin) {
        return referrerURL;
      }
      return referrerOrigin;
    case "no-referrer-when-downgrade":
      if (isUrlPotentiallyTrustworthy(referrerURL) && !isUrlPotentiallyTrustworthy(currentURL)) {
        return "no-referrer";
      }
      return referrerURL;
    default:
      throw new TypeError(`Invalid referrerPolicy: ${policy}`);
  }
}
function parseReferrerPolicyFromHeader(headers) {
  const policyTokens = (headers.get("referrer-policy") || "").split(/[,\s]+/);
  let policy = "";
  for (const token of policyTokens) {
    if (token && ReferrerPolicy.has(token)) {
      policy = token;
    }
  }
  return policy;
}
const INTERNALS = /* @__PURE__ */ Symbol("Request internals");
const isRequest = (object) => {
  return typeof object === "object" && typeof object[INTERNALS] === "object";
};
const doBadDataWarn = deprecate(
  () => {
  },
  ".data is not a valid RequestInit property, use .body instead",
  "https://github.com/node-fetch/node-fetch/issues/1000 (request)"
);
class Request extends Body {
  constructor(input, init = {}) {
    let parsedURL;
    if (isRequest(input)) {
      parsedURL = new URL(input.url);
    } else {
      parsedURL = new URL(input);
      input = {};
    }
    if (parsedURL.username !== "" || parsedURL.password !== "") {
      throw new TypeError(`${parsedURL} is an url with embedded credentials.`);
    }
    let method = init.method || input.method || "GET";
    if (/^(delete|get|head|options|post|put)$/i.test(method)) {
      method = method.toUpperCase();
    }
    if (!isRequest(init) && "data" in init) {
      doBadDataWarn();
    }
    if ((init.body != null || isRequest(input) && input.body !== null) && (method === "GET" || method === "HEAD")) {
      throw new TypeError("Request with GET/HEAD method cannot have body");
    }
    const inputBody = init.body ? init.body : isRequest(input) && input.body !== null ? clone(input) : null;
    super(inputBody, {
      size: init.size || input.size || 0
    });
    const headers = new Headers(init.headers || input.headers || {});
    if (inputBody !== null && !headers.has("Content-Type")) {
      const contentType = extractContentType(inputBody, this);
      if (contentType) {
        headers.set("Content-Type", contentType);
      }
    }
    let signal = isRequest(input) ? input.signal : null;
    if ("signal" in init) {
      signal = init.signal;
    }
    if (signal != null && !isAbortSignal(signal)) {
      throw new TypeError("Expected signal to be an instanceof AbortSignal or EventTarget");
    }
    let referrer = init.referrer == null ? input.referrer : init.referrer;
    if (referrer === "") {
      referrer = "no-referrer";
    } else if (referrer) {
      const parsedReferrer = new URL(referrer);
      referrer = /^about:(\/\/)?client$/.test(parsedReferrer) ? "client" : parsedReferrer;
    } else {
      referrer = void 0;
    }
    this[INTERNALS] = {
      method,
      redirect: init.redirect || input.redirect || "follow",
      headers,
      parsedURL,
      signal,
      referrer
    };
    this.follow = init.follow === void 0 ? input.follow === void 0 ? 20 : input.follow : init.follow;
    this.compress = init.compress === void 0 ? input.compress === void 0 ? true : input.compress : init.compress;
    this.counter = init.counter || input.counter || 0;
    this.agent = init.agent || input.agent;
    this.highWaterMark = init.highWaterMark || input.highWaterMark || 16384;
    this.insecureHTTPParser = init.insecureHTTPParser || input.insecureHTTPParser || false;
    this.referrerPolicy = init.referrerPolicy || input.referrerPolicy || "";
  }
  /** @returns {string} */
  get method() {
    return this[INTERNALS].method;
  }
  /** @returns {string} */
  get url() {
    return format(this[INTERNALS].parsedURL);
  }
  /** @returns {Headers} */
  get headers() {
    return this[INTERNALS].headers;
  }
  get redirect() {
    return this[INTERNALS].redirect;
  }
  /** @returns {AbortSignal} */
  get signal() {
    return this[INTERNALS].signal;
  }
  // https://fetch.spec.whatwg.org/#dom-request-referrer
  get referrer() {
    if (this[INTERNALS].referrer === "no-referrer") {
      return "";
    }
    if (this[INTERNALS].referrer === "client") {
      return "about:client";
    }
    if (this[INTERNALS].referrer) {
      return this[INTERNALS].referrer.toString();
    }
    return void 0;
  }
  get referrerPolicy() {
    return this[INTERNALS].referrerPolicy;
  }
  set referrerPolicy(referrerPolicy) {
    this[INTERNALS].referrerPolicy = validateReferrerPolicy(referrerPolicy);
  }
  /**
   * Clone this request
   *
   * @return  Request
   */
  clone() {
    return new Request(this);
  }
  get [Symbol.toStringTag]() {
    return "Request";
  }
}
Object.defineProperties(Request.prototype, {
  method: { enumerable: true },
  url: { enumerable: true },
  headers: { enumerable: true },
  redirect: { enumerable: true },
  clone: { enumerable: true },
  signal: { enumerable: true },
  referrer: { enumerable: true },
  referrerPolicy: { enumerable: true }
});
const getNodeRequestOptions = (request2) => {
  const { parsedURL } = request2[INTERNALS];
  const headers = new Headers(request2[INTERNALS].headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "*/*");
  }
  let contentLengthValue = null;
  if (request2.body === null && /^(post|put)$/i.test(request2.method)) {
    contentLengthValue = "0";
  }
  if (request2.body !== null) {
    const totalBytes = getTotalBytes(request2);
    if (typeof totalBytes === "number" && !Number.isNaN(totalBytes)) {
      contentLengthValue = String(totalBytes);
    }
  }
  if (contentLengthValue) {
    headers.set("Content-Length", contentLengthValue);
  }
  if (request2.referrerPolicy === "") {
    request2.referrerPolicy = DEFAULT_REFERRER_POLICY;
  }
  if (request2.referrer && request2.referrer !== "no-referrer") {
    request2[INTERNALS].referrer = determineRequestsReferrer(request2);
  } else {
    request2[INTERNALS].referrer = "no-referrer";
  }
  if (request2[INTERNALS].referrer instanceof URL) {
    headers.set("Referer", request2.referrer);
  }
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", "node-fetch");
  }
  if (request2.compress && !headers.has("Accept-Encoding")) {
    headers.set("Accept-Encoding", "gzip, deflate, br");
  }
  let { agent } = request2;
  if (typeof agent === "function") {
    agent = agent(parsedURL);
  }
  const search = getSearch$1(parsedURL);
  const options = {
    // Overwrite search to retain trailing ? (issue #776)
    path: parsedURL.pathname + search,
    // The following options are not expressed in the URL
    method: request2.method,
    headers: headers[/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")](),
    insecureHTTPParser: request2.insecureHTTPParser,
    agent
  };
  return {
    /** @type {URL} */
    parsedURL,
    options
  };
};
class AbortError extends FetchBaseError {
  constructor(message, type = "aborted") {
    super(message, type);
  }
}
var nodeDomexception;
var hasRequiredNodeDomexception;
function requireNodeDomexception() {
  if (hasRequiredNodeDomexception) return nodeDomexception;
  hasRequiredNodeDomexception = 1;
  if (!globalThis.DOMException) {
    try {
      const { MessageChannel } = require("worker_threads"), port = new MessageChannel().port1, ab = new ArrayBuffer();
      port.postMessage(ab, [ab, ab]);
    } catch (err) {
      err.constructor.name === "DOMException" && (globalThis.DOMException = err.constructor);
    }
  }
  nodeDomexception = globalThis.DOMException;
  return nodeDomexception;
}
requireNodeDomexception();
const { stat } = promises;
const supportedSchemas = /* @__PURE__ */ new Set(["data:", "http:", "https:"]);
async function fetch$1(url, options_) {
  return new Promise((resolve, reject) => {
    const request2 = new Request(url, options_);
    const { parsedURL, options } = getNodeRequestOptions(request2);
    if (!supportedSchemas.has(parsedURL.protocol)) {
      throw new TypeError(`node-fetch cannot load ${url}. URL scheme "${parsedURL.protocol.replace(/:$/, "")}" is not supported.`);
    }
    if (parsedURL.protocol === "data:") {
      const data = dataUriToBuffer(request2.url);
      const response2 = new Response(data, { headers: { "Content-Type": data.typeFull } });
      resolve(response2);
      return;
    }
    const send = (parsedURL.protocol === "https:" ? https : http).request;
    const { signal } = request2;
    let response = null;
    const abort = () => {
      const error = new AbortError("The operation was aborted.");
      reject(error);
      if (request2.body && request2.body instanceof Stream.Readable) {
        request2.body.destroy(error);
      }
      if (!response || !response.body) {
        return;
      }
      response.body.emit("error", error);
    };
    if (signal && signal.aborted) {
      abort();
      return;
    }
    const abortAndFinalize = () => {
      abort();
      finalize();
    };
    const request_ = send(parsedURL.toString(), options);
    if (signal) {
      signal.addEventListener("abort", abortAndFinalize);
    }
    const finalize = () => {
      request_.abort();
      if (signal) {
        signal.removeEventListener("abort", abortAndFinalize);
      }
    };
    request_.on("error", (error) => {
      reject(new FetchError(`request to ${request2.url} failed, reason: ${error.message}`, "system", error));
      finalize();
    });
    fixResponseChunkedTransferBadEnding(request_, (error) => {
      if (response && response.body) {
        response.body.destroy(error);
      }
    });
    if (process.version < "v14") {
      request_.on("socket", (s) => {
        let endedWithEventsCount;
        s.prependListener("end", () => {
          endedWithEventsCount = s._eventsCount;
        });
        s.prependListener("close", (hadError) => {
          if (response && endedWithEventsCount < s._eventsCount && !hadError) {
            const error = new Error("Premature close");
            error.code = "ERR_STREAM_PREMATURE_CLOSE";
            response.body.emit("error", error);
          }
        });
      });
    }
    request_.on("response", (response_) => {
      request_.setTimeout(0);
      const headers = fromRawHeaders(response_.rawHeaders);
      if (isRedirect(response_.statusCode)) {
        const location = headers.get("Location");
        let locationURL = null;
        try {
          locationURL = location === null ? null : new URL(location, request2.url);
        } catch {
          if (request2.redirect !== "manual") {
            reject(new FetchError(`uri requested responds with an invalid redirect URL: ${location}`, "invalid-redirect"));
            finalize();
            return;
          }
        }
        switch (request2.redirect) {
          case "error":
            reject(new FetchError(`uri requested responds with a redirect, redirect mode is set to error: ${request2.url}`, "no-redirect"));
            finalize();
            return;
          case "manual":
            break;
          case "follow": {
            if (locationURL === null) {
              break;
            }
            if (request2.counter >= request2.follow) {
              reject(new FetchError(`maximum redirect reached at: ${request2.url}`, "max-redirect"));
              finalize();
              return;
            }
            const requestOptions = {
              headers: new Headers(request2.headers),
              follow: request2.follow,
              counter: request2.counter + 1,
              agent: request2.agent,
              compress: request2.compress,
              method: request2.method,
              body: clone(request2),
              signal: request2.signal,
              size: request2.size,
              referrer: request2.referrer,
              referrerPolicy: request2.referrerPolicy
            };
            if (!isDomainOrSubdomain(request2.url, locationURL) || !isSameProtocol(request2.url, locationURL)) {
              for (const name of ["authorization", "www-authenticate", "cookie", "cookie2"]) {
                requestOptions.headers.delete(name);
              }
            }
            if (response_.statusCode !== 303 && request2.body && options_.body instanceof Stream.Readable) {
              reject(new FetchError("Cannot follow redirect with body being a readable stream", "unsupported-redirect"));
              finalize();
              return;
            }
            if (response_.statusCode === 303 || (response_.statusCode === 301 || response_.statusCode === 302) && request2.method === "POST") {
              requestOptions.method = "GET";
              requestOptions.body = void 0;
              requestOptions.headers.delete("content-length");
            }
            const responseReferrerPolicy = parseReferrerPolicyFromHeader(headers);
            if (responseReferrerPolicy) {
              requestOptions.referrerPolicy = responseReferrerPolicy;
            }
            resolve(fetch$1(new Request(locationURL, requestOptions)));
            finalize();
            return;
          }
          default:
            return reject(new TypeError(`Redirect option '${request2.redirect}' is not a valid value of RequestRedirect`));
        }
      }
      if (signal) {
        response_.once("end", () => {
          signal.removeEventListener("abort", abortAndFinalize);
        });
      }
      let body = pipeline$1(response_, new PassThrough(), (error) => {
        if (error) {
          reject(error);
        }
      });
      if (process.version < "v12.10") {
        response_.on("aborted", abortAndFinalize);
      }
      const responseOptions = {
        url: request2.url,
        status: response_.statusCode,
        statusText: response_.statusMessage,
        headers,
        size: request2.size,
        counter: request2.counter,
        highWaterMark: request2.highWaterMark
      };
      const codings = headers.get("Content-Encoding");
      if (!request2.compress || request2.method === "HEAD" || codings === null || response_.statusCode === 204 || response_.statusCode === 304) {
        response = new Response(body, responseOptions);
        resolve(response);
        return;
      }
      const zlibOptions = {
        flush: zlib.Z_SYNC_FLUSH,
        finishFlush: zlib.Z_SYNC_FLUSH
      };
      if (codings === "gzip" || codings === "x-gzip") {
        body = pipeline$1(body, zlib.createGunzip(zlibOptions), (error) => {
          if (error) {
            reject(error);
          }
        });
        response = new Response(body, responseOptions);
        resolve(response);
        return;
      }
      if (codings === "deflate" || codings === "x-deflate") {
        const raw = pipeline$1(response_, new PassThrough(), (error) => {
          if (error) {
            reject(error);
          }
        });
        raw.once("data", (chunk) => {
          if ((chunk[0] & 15) === 8) {
            body = pipeline$1(body, zlib.createInflate(), (error) => {
              if (error) {
                reject(error);
              }
            });
          } else {
            body = pipeline$1(body, zlib.createInflateRaw(), (error) => {
              if (error) {
                reject(error);
              }
            });
          }
          response = new Response(body, responseOptions);
          resolve(response);
        });
        raw.once("end", () => {
          if (!response) {
            response = new Response(body, responseOptions);
            resolve(response);
          }
        });
        return;
      }
      if (codings === "br") {
        body = pipeline$1(body, zlib.createBrotliDecompress(), (error) => {
          if (error) {
            reject(error);
          }
        });
        response = new Response(body, responseOptions);
        resolve(response);
        return;
      }
      response = new Response(body, responseOptions);
      resolve(response);
    });
    writeToStream(request_, request2).catch(reject);
  });
}
function fixResponseChunkedTransferBadEnding(request2, errorCallback) {
  const LAST_CHUNK = Buffer$1.from("0\r\n\r\n");
  let isChunkedTransfer = false;
  let properLastChunkReceived = false;
  let previousChunk;
  request2.on("response", (response) => {
    const { headers } = response;
    isChunkedTransfer = headers["transfer-encoding"] === "chunked" && !headers["content-length"];
  });
  request2.on("socket", (socket) => {
    const onSocketClose = () => {
      if (isChunkedTransfer && !properLastChunkReceived) {
        const error = new Error("Premature close");
        error.code = "ERR_STREAM_PREMATURE_CLOSE";
        errorCallback(error);
      }
    };
    const onData = (buf) => {
      properLastChunkReceived = Buffer$1.compare(buf.slice(-5), LAST_CHUNK) === 0;
      if (!properLastChunkReceived && previousChunk) {
        properLastChunkReceived = Buffer$1.compare(previousChunk.slice(-3), LAST_CHUNK.slice(0, 3)) === 0 && Buffer$1.compare(buf.slice(-2), LAST_CHUNK.slice(3)) === 0;
      }
      previousChunk = buf;
    };
    socket.prependListener("close", onSocketClose);
    socket.on("data", onData);
    request2.on("close", () => {
      socket.removeListener("close", onSocketClose);
      socket.removeListener("data", onData);
    });
  });
}
var AuthType;
(function(AuthType2) {
  AuthType2["Auto"] = "auto";
  AuthType2["Digest"] = "digest";
  AuthType2["None"] = "none";
  AuthType2["Password"] = "password";
  AuthType2["Token"] = "token";
})(AuthType || (AuthType = {}));
var ErrorCode;
(function(ErrorCode2) {
  ErrorCode2["DataTypeNoLength"] = "data-type-no-length";
  ErrorCode2["InvalidAuthType"] = "invalid-auth-type";
  ErrorCode2["InvalidOutputFormat"] = "invalid-output-format";
  ErrorCode2["LinkUnsupportedAuthType"] = "link-unsupported-auth";
  ErrorCode2["InvalidUpdateRange"] = "invalid-update-range";
  ErrorCode2["NotSupported"] = "not-supported";
})(ErrorCode || (ErrorCode = {}));
function setupAuth(context, username, password, oauthToken, ha1) {
  switch (context.authType) {
    case AuthType.Auto:
      if (username && password) {
        context.headers.Authorization = generateBasicAuthHeader(username, password);
      }
      break;
    case AuthType.Digest:
      context.digest = createDigestContext(username, password, ha1);
      break;
    case AuthType.None:
      break;
    case AuthType.Password:
      context.headers.Authorization = generateBasicAuthHeader(username, password);
      break;
    case AuthType.Token:
      context.headers.Authorization = generateTokenAuthHeader(oauthToken);
      break;
    default:
      throw new Layerr({
        info: {
          code: ErrorCode.InvalidAuthType
        }
      }, `Invalid auth type: ${context.authType}`);
  }
}
function sequence(...methods) {
  if (methods.length === 0) {
    throw new Error("Failed creating sequence: No functions provided");
  }
  return function __executeSequence(...args) {
    let result = args;
    const _this = this;
    while (methods.length > 0) {
      const method = methods.shift();
      result = [method.apply(_this, result)];
    }
    return result[0];
  };
}
const HOT_PATCHER_TYPE = "@@HOTPATCHER";
const NOOP$1 = () => {
};
function createNewItem(method) {
  return {
    original: method,
    methods: [method],
    final: false
  };
}
class HotPatcher {
  constructor() {
    this._configuration = {
      registry: {},
      getEmptyAction: "null"
    };
    this.__type__ = HOT_PATCHER_TYPE;
  }
  /**
   * Configuration object reference
   * @readonly
   */
  get configuration() {
    return this._configuration;
  }
  /**
   * The action to take when a non-set method is requested
   * Possible values: null/throw
   */
  get getEmptyAction() {
    return this.configuration.getEmptyAction;
  }
  set getEmptyAction(newAction) {
    this.configuration.getEmptyAction = newAction;
  }
  /**
   * Control another hot-patcher instance
   * Force the remote instance to use patched methods from calling instance
   * @param target The target instance to control
   * @param allowTargetOverrides Allow the target to override patched methods on
   * the controller (default is false)
   * @returns Returns self
   * @throws {Error} Throws if the target is invalid
   */
  control(target, allowTargetOverrides = false) {
    if (!target || target.__type__ !== HOT_PATCHER_TYPE) {
      throw new Error("Failed taking control of target HotPatcher instance: Invalid type or object");
    }
    Object.keys(target.configuration.registry).forEach((foreignKey) => {
      if (this.configuration.registry.hasOwnProperty(foreignKey)) {
        if (allowTargetOverrides) {
          this.configuration.registry[foreignKey] = Object.assign({}, target.configuration.registry[foreignKey]);
        }
      } else {
        this.configuration.registry[foreignKey] = Object.assign({}, target.configuration.registry[foreignKey]);
      }
    });
    target._configuration = this.configuration;
    return this;
  }
  /**
   * Execute a patched method
   * @param key The method key
   * @param args Arguments to pass to the method (optional)
   * @see HotPatcher#get
   * @returns The output of the called method
   */
  execute(key, ...args) {
    const method = this.get(key) || NOOP$1;
    return method(...args);
  }
  /**
   * Get a method for a key
   * @param key The method key
   * @returns Returns the requested function or null if the function
   * does not exist and the host is configured to return null (and not throw)
   * @throws {Error} Throws if the configuration specifies to throw and the method
   * does not exist
   * @throws {Error} Throws if the `getEmptyAction` value is invalid
   */
  get(key) {
    const item = this.configuration.registry[key];
    if (!item) {
      switch (this.getEmptyAction) {
        case "null":
          return null;
        case "throw":
          throw new Error(`Failed handling method request: No method provided for override: ${key}`);
        default:
          throw new Error(`Failed handling request which resulted in an empty method: Invalid empty-action specified: ${this.getEmptyAction}`);
      }
    }
    return sequence(...item.methods);
  }
  /**
   * Check if a method has been patched
   * @param key The function key
   * @returns True if already patched
   */
  isPatched(key) {
    return !!this.configuration.registry[key];
  }
  /**
   * Patch a method name
   * @param key The method key to patch
   * @param method The function to set
   * @param opts Patch options
   * @returns Returns self
   */
  patch(key, method, opts = {}) {
    const { chain = false } = opts;
    if (this.configuration.registry[key] && this.configuration.registry[key].final) {
      throw new Error(`Failed patching '${key}': Method marked as being final`);
    }
    if (typeof method !== "function") {
      throw new Error(`Failed patching '${key}': Provided method is not a function`);
    }
    if (chain) {
      if (!this.configuration.registry[key]) {
        this.configuration.registry[key] = createNewItem(method);
      } else {
        this.configuration.registry[key].methods.push(method);
      }
    } else {
      if (this.isPatched(key)) {
        const { original } = this.configuration.registry[key];
        this.configuration.registry[key] = Object.assign(createNewItem(method), {
          original
        });
      } else {
        this.configuration.registry[key] = createNewItem(method);
      }
    }
    return this;
  }
  /**
   * Patch a method inline, execute it and return the value
   * Used for patching contents of functions. This method will not apply a patched
   * function if it has already been patched, allowing for external overrides to
   * function. It also means that the function is cached so that it is not
   * instantiated every time the outer function is invoked.
   * @param key The function key to use
   * @param method The function to patch (once, only if not patched)
   * @param args Arguments to pass to the function
   * @returns The output of the patched function
   * @example
   *  function mySpecialFunction(a, b) {
   *      return hotPatcher.patchInline("func", (a, b) => {
   *          return a + b;
   *      }, a, b);
   *  }
   */
  patchInline(key, method, ...args) {
    if (!this.isPatched(key)) {
      this.patch(key, method);
    }
    return this.execute(key, ...args);
  }
  /**
   * Patch a method (or methods) in sequential-mode
   * See `patch()` with the option `chain: true`
   * @see patch
   * @param key The key to patch
   * @param methods The methods to patch
   * @returns Returns self
   */
  plugin(key, ...methods) {
    methods.forEach((method) => {
      this.patch(key, method, { chain: true });
    });
    return this;
  }
  /**
   * Restore a patched method if it has been overridden
   * @param key The method key
   * @returns Returns self
   */
  restore(key) {
    if (!this.isPatched(key)) {
      throw new Error(`Failed restoring method: No method present for key: ${key}`);
    } else if (typeof this.configuration.registry[key].original !== "function") {
      throw new Error(`Failed restoring method: Original method not found or of invalid type for key: ${key}`);
    }
    this.configuration.registry[key].methods = [this.configuration.registry[key].original];
    return this;
  }
  /**
   * Set a method as being final
   * This sets a method as having been finally overridden. Attempts at overriding
   * again will fail with an error.
   * @param key The key to make final
   * @returns Returns self
   */
  setFinal(key) {
    if (!this.configuration.registry.hasOwnProperty(key)) {
      throw new Error(`Failed marking '${key}' as final: No method found for key`);
    }
    this.configuration.registry[key].final = true;
    return this;
  }
}
let __patcher = null;
function getPatcher() {
  if (!__patcher) {
    __patcher = new HotPatcher();
  }
  return __patcher;
}
function cloneShallow(obj) {
  return isPlainObject(obj) ? Object.assign({}, obj) : Object.setPrototypeOf(Object.assign({}, obj), Object.getPrototypeOf(obj));
}
function isPlainObject(obj) {
  if (typeof obj !== "object" || obj === null || Object.prototype.toString.call(obj) != "[object Object]") {
    return false;
  }
  if (Object.getPrototypeOf(obj) === null) {
    return true;
  }
  let proto = obj;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }
  return Object.getPrototypeOf(obj) === proto;
}
function merge(...args) {
  let output = null, items = [...args];
  while (items.length > 0) {
    const nextItem = items.shift();
    if (!output) {
      output = cloneShallow(nextItem);
    } else {
      output = mergeObjects(output, nextItem);
    }
  }
  return output;
}
function mergeObjects(obj1, obj2) {
  const output = cloneShallow(obj1);
  Object.keys(obj2).forEach((key) => {
    if (!output.hasOwnProperty(key)) {
      output[key] = obj2[key];
      return;
    }
    if (Array.isArray(obj2[key])) {
      output[key] = Array.isArray(output[key]) ? [...output[key], ...obj2[key]] : [...obj2[key]];
    } else if (typeof obj2[key] === "object" && !!obj2[key]) {
      output[key] = typeof output[key] === "object" && !!output[key] ? mergeObjects(output[key], obj2[key]) : cloneShallow(obj2[key]);
    } else {
      output[key] = obj2[key];
    }
  });
  return output;
}
function convertResponseHeaders(headers) {
  const output = {};
  for (const key of headers.keys()) {
    output[key] = headers.get(key);
  }
  return output;
}
function mergeHeaders(...headerPayloads) {
  if (headerPayloads.length === 0)
    return {};
  const headerKeys = {};
  return headerPayloads.reduce((output, headers) => {
    Object.keys(headers).forEach((header) => {
      const lowerHeader = header.toLowerCase();
      if (headerKeys.hasOwnProperty(lowerHeader)) {
        output[headerKeys[lowerHeader]] = headers[header];
      } else {
        headerKeys[lowerHeader] = header;
        output[header] = headers[header];
      }
    });
    return output;
  }, {});
}
const hasArrayBuffer = typeof ArrayBuffer === "function";
const { toString: objToString } = Object.prototype;
function isArrayBuffer(value) {
  return hasArrayBuffer && (value instanceof ArrayBuffer || objToString.call(value) === "[object ArrayBuffer]");
}
function isBuffer(value) {
  return value != null && value.constructor != null && typeof value.constructor.isBuffer === "function" && value.constructor.isBuffer(value);
}
function requestDataToFetchBody(data) {
  if (!isWeb() && !isReactNative() && data instanceof Stream$1.Readable) {
    return [data, {}];
  }
  if (typeof data === "string") {
    return [data, {}];
  } else if (isBuffer(data)) {
    return [data, {}];
  } else if (isArrayBuffer(data)) {
    return [data, {}];
  } else if (data && typeof data === "object") {
    return [
      JSON.stringify(data),
      {
        "content-type": "application/json"
      }
    ];
  }
  throw new Error(`Unable to convert request body: Unexpected body type: ${typeof data}`);
}
function getFetchOptions(requestOptions) {
  let headers = {};
  const opts = {
    method: requestOptions.method
  };
  if (requestOptions.headers) {
    headers = mergeHeaders(headers, requestOptions.headers);
  }
  if (typeof requestOptions.data !== "undefined") {
    const [body, newHeaders] = requestDataToFetchBody(requestOptions.data);
    opts.body = body;
    headers = mergeHeaders(headers, newHeaders);
  }
  if (requestOptions.signal) {
    opts.signal = requestOptions.signal;
  }
  if (requestOptions.withCredentials) {
    opts.credentials = "include";
  }
  if (!isWeb() && !isReactNative()) {
    if (requestOptions.httpAgent || requestOptions.httpsAgent) {
      opts.agent = (parsedURL) => {
        if (parsedURL.protocol === "http:") {
          return requestOptions.httpAgent || new Agent();
        }
        return requestOptions.httpsAgent || new Agent$1();
      };
    }
  }
  opts.headers = headers;
  return opts;
}
function prepareRequestOptions(requestOptions, context, userOptions) {
  const finalOptions = cloneShallow(requestOptions);
  finalOptions.headers = mergeHeaders(context.headers, finalOptions.headers || {}, userOptions.headers || {});
  if (typeof userOptions.data !== "undefined") {
    finalOptions.data = userOptions.data;
  }
  if (userOptions.signal) {
    finalOptions.signal = userOptions.signal;
  }
  if (context.httpAgent) {
    finalOptions.httpAgent = context.httpAgent;
  }
  if (context.httpsAgent) {
    finalOptions.httpsAgent = context.httpsAgent;
  }
  if (context.digest) {
    finalOptions._digest = context.digest;
  }
  if (typeof context.withCredentials === "boolean") {
    finalOptions.withCredentials = context.withCredentials;
  }
  return finalOptions;
}
async function request(requestOptions, context) {
  if (context.authType === AuthType.Auto) {
    return requestAuto(requestOptions, context);
  }
  if (requestOptions._digest) {
    return requestDigest(requestOptions);
  }
  return requestStandard(requestOptions);
}
async function requestAuto(requestOptions, context) {
  const response = await requestStandard(requestOptions);
  if (response.ok) {
    context.authType = AuthType.Password;
    return response;
  }
  if (response.status == 401 && responseIndicatesDigestAuth(response)) {
    context.authType = AuthType.Digest;
    setupAuth(context, context.username, context.password, void 0, void 0);
    requestOptions._digest = context.digest;
    return requestDigest(requestOptions);
  }
  return response;
}
async function requestDigest(requestOptions) {
  const _digest = requestOptions._digest;
  delete requestOptions._digest;
  if (_digest.hasDigestAuth) {
    requestOptions = merge(requestOptions, {
      headers: {
        Authorization: generateDigestAuthHeader(requestOptions, _digest)
      }
    });
  }
  const response = await requestStandard(requestOptions);
  if (response.status == 401) {
    _digest.hasDigestAuth = parseDigestAuth(response, _digest);
    if (_digest.hasDigestAuth) {
      requestOptions = merge(requestOptions, {
        headers: {
          Authorization: generateDigestAuthHeader(requestOptions, _digest)
        }
      });
      const response2 = await requestStandard(requestOptions);
      if (response2.status == 401) {
        _digest.hasDigestAuth = false;
      } else {
        _digest.nc++;
      }
      return response2;
    }
  } else {
    _digest.nc++;
  }
  return response;
}
function requestStandard(requestOptions) {
  const patcher = getPatcher();
  return patcher.patchInline("request", (options) => patcher.patchInline("fetch", fetch$1, options.url, getFetchOptions(options)), requestOptions);
}
var balancedMatch;
var hasRequiredBalancedMatch;
function requireBalancedMatch() {
  if (hasRequiredBalancedMatch) return balancedMatch;
  hasRequiredBalancedMatch = 1;
  balancedMatch = balanced;
  function balanced(a, b, str) {
    if (a instanceof RegExp) a = maybeMatch(a, str);
    if (b instanceof RegExp) b = maybeMatch(b, str);
    var r2 = range(a, b, str);
    return r2 && {
      start: r2[0],
      end: r2[1],
      pre: str.slice(0, r2[0]),
      body: str.slice(r2[0] + a.length, r2[1]),
      post: str.slice(r2[1] + b.length)
    };
  }
  function maybeMatch(reg, str) {
    var m2 = str.match(reg);
    return m2 ? m2[0] : null;
  }
  balanced.range = range;
  function range(a, b, str) {
    var begs, beg, left, right, result;
    var ai = str.indexOf(a);
    var bi = str.indexOf(b, ai + 1);
    var i2 = ai;
    if (ai >= 0 && bi > 0) {
      if (a === b) {
        return [ai, bi];
      }
      begs = [];
      left = str.length;
      while (i2 >= 0 && !result) {
        if (i2 == ai) {
          begs.push(i2);
          ai = str.indexOf(a, i2 + 1);
        } else if (begs.length == 1) {
          result = [begs.pop(), bi];
        } else {
          beg = begs.pop();
          if (beg < left) {
            left = beg;
            right = bi;
          }
          bi = str.indexOf(b, i2 + 1);
        }
        i2 = ai < bi && ai >= 0 ? ai : bi;
      }
      if (begs.length) {
        result = [left, right];
      }
    }
    return result;
  }
  return balancedMatch;
}
var braceExpansion;
var hasRequiredBraceExpansion;
function requireBraceExpansion() {
  if (hasRequiredBraceExpansion) return braceExpansion;
  hasRequiredBraceExpansion = 1;
  var balanced = requireBalancedMatch();
  braceExpansion = expandTop;
  var escSlash = "\0SLASH" + Math.random() + "\0";
  var escOpen = "\0OPEN" + Math.random() + "\0";
  var escClose = "\0CLOSE" + Math.random() + "\0";
  var escComma = "\0COMMA" + Math.random() + "\0";
  var escPeriod = "\0PERIOD" + Math.random() + "\0";
  var EXPANSION_MAX = 1e5;
  var EXPANSION_MAX_LENGTH = 4e6;
  function numeric(str) {
    return parseInt(str, 10) == str ? parseInt(str, 10) : str.charCodeAt(0);
  }
  function escapeBraces(str) {
    return str.split("\\\\").join(escSlash).split("\\{").join(escOpen).split("\\}").join(escClose).split("\\,").join(escComma).split("\\.").join(escPeriod);
  }
  function unescapeBraces(str) {
    return str.split(escSlash).join("\\").split(escOpen).join("{").split(escClose).join("}").split(escComma).join(",").split(escPeriod).join(".");
  }
  function parseCommaParts(str) {
    if (!str)
      return [""];
    var parts = [];
    var m2 = balanced("{", "}", str);
    if (!m2)
      return str.split(",");
    var pre = m2.pre;
    var body = m2.body;
    var post = m2.post;
    var p = pre.split(",");
    p[p.length - 1] += "{" + body + "}";
    var postParts = parseCommaParts(post);
    if (post.length) {
      p[p.length - 1] += postParts.shift();
      p.push.apply(p, postParts);
    }
    parts.push.apply(parts, p);
    return parts;
  }
  function expandTop(str, options) {
    if (!str)
      return [];
    options = options || {};
    var max = options.max == null ? EXPANSION_MAX : options.max;
    var maxLength = options.maxLength == null ? EXPANSION_MAX_LENGTH : options.maxLength;
    if (str.substr(0, 2) === "{}") {
      str = "\\{\\}" + str.substr(2);
    }
    return expand2(escapeBraces(str), max, maxLength, true).map(unescapeBraces);
  }
  function embrace(str) {
    return "{" + str + "}";
  }
  function isPadded(el) {
    return /^-?0\d/.test(el);
  }
  function lte(i2, y) {
    return i2 <= y;
  }
  function gte(i2, y) {
    return i2 >= y;
  }
  function combine(acc, pre, values, max, maxLength, dropEmpties) {
    var out = [];
    var length = 0;
    for (var a = 0; a < acc.length; a++) {
      for (var v = 0; v < values.length; v++) {
        if (out.length >= max) return out;
        var expansion = acc[a] + pre + values[v];
        if (dropEmpties && !expansion) continue;
        if (length + expansion.length > maxLength) return out;
        out.push(expansion);
        length += expansion.length;
      }
    }
    return out;
  }
  function expandSequence(body, isAlphaSequence, max, maxLength) {
    var n = body.split(/\.\./);
    var N = [];
    if (n[0] === void 0 || n[1] === void 0) {
      return N;
    }
    var x2 = numeric(n[0]);
    var y = numeric(n[1]);
    var width = Math.max(n[0].length, n[1].length);
    var incr = n.length === 3 && n[2] !== void 0 ? Math.max(Math.abs(numeric(n[2])), 1) : 1;
    var test = lte;
    var reverse = y < x2;
    if (reverse) {
      incr *= -1;
      test = gte;
    }
    var pad = n.some(isPadded);
    var length = 0;
    for (var i2 = x2; test(i2, y) && N.length < max; i2 += incr) {
      var c;
      if (isAlphaSequence) {
        c = String.fromCharCode(i2);
        if (c === "\\") {
          c = "";
        }
      } else {
        c = String(i2);
        if (pad) {
          var need = width - c.length;
          if (need > 0) {
            var z = new Array(need + 1).join("0");
            if (i2 < 0) {
              c = "-" + z + c.slice(1);
            } else {
              c = z + c;
            }
          }
        }
      }
      if (length + c.length > maxLength) break;
      N.push(c);
      length += c.length;
    }
    return N;
  }
  function expand2(str, max, maxLength, isTop) {
    var acc = [""];
    var dropEmpties = false;
    var firstGroup = true;
    for (; ; ) {
      const m2 = balanced("{", "}", str);
      if (!m2) {
        return combine(acc, str, [""], max, maxLength, dropEmpties);
      }
      const pre = m2.pre;
      if (/\$$/.test(pre)) {
        acc = combine(
          acc,
          pre + "{" + m2.body + "}",
          [""],
          max,
          maxLength,
          dropEmpties && !m2.post.length
        );
        firstGroup = false;
        if (!m2.post.length) break;
        str = m2.post;
        continue;
      }
      var isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m2.body);
      var isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m2.body);
      var isSequence = isNumericSequence || isAlphaSequence;
      var isOptions = m2.body.indexOf(",") >= 0;
      if (!isSequence && !isOptions) {
        if (m2.post.match(/,(?!,).*\}/)) {
          str = m2.pre + "{" + m2.body + escClose + m2.post;
          isTop = true;
          continue;
        }
        return combine(
          acc,
          pre + "{" + m2.body + "}" + m2.post,
          [""],
          max,
          maxLength,
          dropEmpties
        );
      }
      if (firstGroup) {
        dropEmpties = isTop && !isSequence;
        firstGroup = false;
      }
      var values;
      if (isSequence) {
        values = expandSequence(m2.body, isAlphaSequence, max, maxLength);
      } else {
        var n = parseCommaParts(m2.body);
        if (n.length === 1 && n[0] !== void 0) {
          n = expand2(n[0], max, maxLength, false).map(embrace);
          if (n.length === 1) {
            acc = combine(
              acc,
              pre + n[0],
              [""],
              max,
              maxLength,
              dropEmpties && !m2.post.length
            );
            if (!m2.post.length) break;
            str = m2.post;
            continue;
          }
        }
        var dropsEmpties = dropEmpties && !m2.post.length && !pre;
        for (var d = 0; dropsEmpties && d < acc.length; d++) {
          if (acc[d]) {
            dropsEmpties = false;
          }
        }
        values = [];
        var valuesLength = 0;
        outer: for (var j = 0; j < n.length; j++) {
          var expanded = expand2(n[j], max, maxLength, false);
          for (var k = 0; k < expanded.length; k++) {
            var v = expanded[k];
            if (dropsEmpties && !v) continue;
            if (values.length >= max || valuesLength + v.length > maxLength) {
              break outer;
            }
            values.push(v);
            valuesLength += v.length;
          }
        }
      }
      acc = combine(acc, pre, values, max, maxLength, dropEmpties && !m2.post.length);
      if (!m2.post.length) break;
      str = m2.post;
    }
    return acc;
  }
  return braceExpansion;
}
var braceExpansionExports = requireBraceExpansion();
const expand = /* @__PURE__ */ getDefaultExportFromCjs(braceExpansionExports);
const MAX_PATTERN_LENGTH = 1024 * 64;
const assertValidPattern = (pattern) => {
  if (typeof pattern !== "string") {
    throw new TypeError("invalid pattern");
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new TypeError("pattern is too long");
  }
};
const posixClasses = {
  "[:alnum:]": ["\\p{L}\\p{Nl}\\p{Nd}", true],
  "[:alpha:]": ["\\p{L}\\p{Nl}", true],
  "[:ascii:]": ["\\x00-\\x7f", false],
  "[:blank:]": ["\\p{Zs}\\t", true],
  "[:cntrl:]": ["\\p{Cc}", true],
  "[:digit:]": ["\\p{Nd}", true],
  "[:graph:]": ["\\p{Z}\\p{C}", true, true],
  "[:lower:]": ["\\p{Ll}", true],
  "[:print:]": ["\\p{C}", true],
  "[:punct:]": ["\\p{P}", true],
  "[:space:]": ["\\p{Z}\\t\\r\\n\\v\\f", true],
  "[:upper:]": ["\\p{Lu}", true],
  "[:word:]": ["\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}", true],
  "[:xdigit:]": ["A-Fa-f0-9", false]
};
const braceEscape = (s) => s.replace(/[[\]\\-]/g, "\\$&");
const regexpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
const rangesToString = (ranges) => ranges.join("");
const parseClass = (glob, position) => {
  const pos = position;
  if (glob.charAt(pos) !== "[") {
    throw new Error("not in a brace expression");
  }
  const ranges = [];
  const negs = [];
  let i2 = pos + 1;
  let sawStart = false;
  let uflag = false;
  let escaping = false;
  let negate = false;
  let endPos = pos;
  let rangeStart = "";
  WHILE: while (i2 < glob.length) {
    const c = glob.charAt(i2);
    if ((c === "!" || c === "^") && i2 === pos + 1) {
      negate = true;
      i2++;
      continue;
    }
    if (c === "]" && sawStart && !escaping) {
      endPos = i2 + 1;
      break;
    }
    sawStart = true;
    if (c === "\\") {
      if (!escaping) {
        escaping = true;
        i2++;
        continue;
      }
    }
    if (c === "[" && !escaping) {
      for (const [cls, [unip, u, neg]] of Object.entries(posixClasses)) {
        if (glob.startsWith(cls, i2)) {
          if (rangeStart) {
            return ["$.", false, glob.length - pos, true];
          }
          i2 += cls.length;
          if (neg)
            negs.push(unip);
          else
            ranges.push(unip);
          uflag = uflag || u;
          continue WHILE;
        }
      }
    }
    escaping = false;
    if (rangeStart) {
      if (c > rangeStart) {
        ranges.push(braceEscape(rangeStart) + "-" + braceEscape(c));
      } else if (c === rangeStart) {
        ranges.push(braceEscape(c));
      }
      rangeStart = "";
      i2++;
      continue;
    }
    if (glob.startsWith("-]", i2 + 1)) {
      ranges.push(braceEscape(c + "-"));
      i2 += 2;
      continue;
    }
    if (glob.startsWith("-", i2 + 1)) {
      rangeStart = c;
      i2 += 2;
      continue;
    }
    ranges.push(braceEscape(c));
    i2++;
  }
  if (endPos < i2) {
    return ["", false, 0, false];
  }
  if (!ranges.length && !negs.length) {
    return ["$.", false, glob.length - pos, true];
  }
  if (negs.length === 0 && ranges.length === 1 && /^\\?.$/.test(ranges[0]) && !negate) {
    const r2 = ranges[0].length === 2 ? ranges[0].slice(-1) : ranges[0];
    return [regexpEscape(r2), false, endPos - pos, false];
  }
  const sranges = "[" + (negate ? "^" : "") + rangesToString(ranges) + "]";
  const snegs = "[" + (negate ? "" : "^") + rangesToString(negs) + "]";
  const comb = ranges.length && negs.length ? "(" + sranges + "|" + snegs + ")" : ranges.length ? sranges : snegs;
  return [comb, uflag, endPos - pos, true];
};
const unescape$1 = (s, { windowsPathsNoEscape = false } = {}) => {
  return windowsPathsNoEscape ? s.replace(/\[([^\/\\])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^\/\\])\]/g, "$1$2").replace(/\\([^\/])/g, "$1");
};
var _a;
const types = /* @__PURE__ */ new Set(["!", "?", "+", "*", "@"]);
const isExtglobType = (c) => types.has(c);
const isExtglobAST = (c) => isExtglobType(c.type);
const adoptionMap = /* @__PURE__ */ new Map([
  ["!", ["@"]],
  ["?", ["?", "@"]],
  ["@", ["@"]],
  ["*", ["*", "+", "?", "@"]],
  ["+", ["+", "@"]]
]);
const adoptionWithSpaceMap = /* @__PURE__ */ new Map([
  ["!", ["?"]],
  ["@", ["?"]],
  ["+", ["?", "*"]]
]);
const adoptionAnyMap = /* @__PURE__ */ new Map([
  ["!", ["?", "@"]],
  ["?", ["?", "@"]],
  ["@", ["?", "@"]],
  ["*", ["*", "+", "?", "@"]],
  ["+", ["+", "@", "?", "*"]]
]);
const usurpMap = /* @__PURE__ */ new Map([
  ["!", /* @__PURE__ */ new Map([["!", "@"]])],
  ["?", /* @__PURE__ */ new Map([["*", "*"], ["+", "*"]])],
  ["@", /* @__PURE__ */ new Map([["!", "!"], ["?", "?"], ["@", "@"], ["*", "*"], ["+", "+"]])],
  ["+", /* @__PURE__ */ new Map([["?", "*"], ["*", "*"]])]
]);
const startNoTraversal = "(?!(?:^|/)\\.\\.?(?:$|/))";
const startNoDot = "(?!\\.)";
const addPatternStart = /* @__PURE__ */ new Set(["[", "."]);
const justDots = /* @__PURE__ */ new Set(["..", "."]);
const reSpecials = new Set("().*{}+?[]^$\\!");
const regExpEscape$1 = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
const qmark$1 = "[^/]";
const star$1 = qmark$1 + "*?";
const starNoEmpty = qmark$1 + "+?";
class AST {
  type;
  #root;
  #hasMagic;
  #uflag = false;
  #parts = [];
  #parent;
  #parentIndex;
  #negs;
  #filledNegs = false;
  #options;
  #toString;
  // set to true if it's an extglob with no children
  // (which really means one child of '')
  #emptyExt = false;
  constructor(type, parent, options = {}) {
    this.type = type;
    if (type)
      this.#hasMagic = true;
    this.#parent = parent;
    this.#root = this.#parent ? this.#parent.#root : this;
    this.#options = this.#root === this ? options : this.#root.#options;
    this.#negs = this.#root === this ? [] : this.#root.#negs;
    if (type === "!" && !this.#root.#filledNegs)
      this.#negs.push(this);
    this.#parentIndex = this.#parent ? this.#parent.#parts.length : 0;
  }
  get hasMagic() {
    if (this.#hasMagic !== void 0)
      return this.#hasMagic;
    for (const p of this.#parts) {
      if (typeof p === "string")
        continue;
      if (p.type || p.hasMagic)
        return this.#hasMagic = true;
    }
    return this.#hasMagic;
  }
  // reconstructs the pattern
  toString() {
    if (this.#toString !== void 0)
      return this.#toString;
    if (!this.type) {
      return this.#toString = this.#parts.map((p) => String(p)).join("");
    } else {
      return this.#toString = this.type + "(" + this.#parts.map((p) => String(p)).join("|") + ")";
    }
  }
  #fillNegs() {
    if (this !== this.#root)
      throw new Error("should only call on root");
    if (this.#filledNegs)
      return this;
    this.toString();
    this.#filledNegs = true;
    let n;
    while (n = this.#negs.pop()) {
      if (n.type !== "!")
        continue;
      let p = n;
      let pp = p.#parent;
      while (pp) {
        for (let i2 = p.#parentIndex + 1; !pp.type && i2 < pp.#parts.length; i2++) {
          for (const part of n.#parts) {
            if (typeof part === "string") {
              throw new Error("string part in extglob AST??");
            }
            part.copyIn(pp.#parts[i2]);
          }
        }
        p = pp;
        pp = p.#parent;
      }
    }
    return this;
  }
  push(...parts) {
    for (const p of parts) {
      if (p === "")
        continue;
      if (typeof p !== "string" && !(p instanceof _a && p.#parent === this)) {
        throw new Error("invalid part: " + p);
      }
      this.#parts.push(p);
    }
  }
  toJSON() {
    const ret = this.type === null ? this.#parts.slice().map((p) => typeof p === "string" ? p : p.toJSON()) : [this.type, ...this.#parts.map((p) => p.toJSON())];
    if (this.isStart() && !this.type)
      ret.unshift([]);
    if (this.isEnd() && (this === this.#root || this.#root.#filledNegs && this.#parent?.type === "!")) {
      ret.push({});
    }
    return ret;
  }
  isStart() {
    if (this.#root === this)
      return true;
    if (!this.#parent?.isStart())
      return false;
    if (this.#parentIndex === 0)
      return true;
    const p = this.#parent;
    for (let i2 = 0; i2 < this.#parentIndex; i2++) {
      const pp = p.#parts[i2];
      if (!(pp instanceof _a && pp.type === "!")) {
        return false;
      }
    }
    return true;
  }
  isEnd() {
    if (this.#root === this)
      return true;
    if (this.#parent?.type === "!")
      return true;
    if (!this.#parent?.isEnd())
      return false;
    if (!this.type)
      return this.#parent?.isEnd();
    const pl = this.#parent ? this.#parent.#parts.length : 0;
    return this.#parentIndex === pl - 1;
  }
  copyIn(part) {
    if (typeof part === "string")
      this.push(part);
    else
      this.push(part.clone(this));
  }
  clone(parent) {
    const c = new _a(this.type, parent);
    for (const p of this.#parts) {
      c.copyIn(p);
    }
    return c;
  }
  static #parseAST(str, ast, pos, opt, extDepth) {
    const maxDepth = opt.maxExtglobRecursion ?? 2;
    let escaping = false;
    let inBrace = false;
    let braceStart = -1;
    let braceNeg = false;
    if (ast.type === null) {
      let i3 = pos;
      let acc2 = "";
      while (i3 < str.length) {
        const c = str.charAt(i3++);
        if (escaping || c === "\\") {
          escaping = !escaping;
          acc2 += c;
          continue;
        }
        if (inBrace) {
          if (i3 === braceStart + 1) {
            if (c === "^" || c === "!") {
              braceNeg = true;
            }
          } else if (c === "]" && !(i3 === braceStart + 2 && braceNeg)) {
            inBrace = false;
          }
          acc2 += c;
          continue;
        } else if (c === "[") {
          inBrace = true;
          braceStart = i3;
          braceNeg = false;
          acc2 += c;
          continue;
        }
        const doRecurse = !opt.noext && isExtglobType(c) && str.charAt(i3) === "(" && extDepth <= maxDepth;
        if (doRecurse) {
          ast.push(acc2);
          acc2 = "";
          const ext2 = new _a(c, ast);
          i3 = _a.#parseAST(str, ext2, i3, opt, extDepth + 1);
          ast.push(ext2);
          continue;
        }
        acc2 += c;
      }
      ast.push(acc2);
      return i3;
    }
    let i2 = pos + 1;
    let part = new _a(null, ast);
    const parts = [];
    let acc = "";
    while (i2 < str.length) {
      const c = str.charAt(i2++);
      if (escaping || c === "\\") {
        escaping = !escaping;
        acc += c;
        continue;
      }
      if (inBrace) {
        if (i2 === braceStart + 1) {
          if (c === "^" || c === "!") {
            braceNeg = true;
          }
        } else if (c === "]" && !(i2 === braceStart + 2 && braceNeg)) {
          inBrace = false;
        }
        acc += c;
        continue;
      } else if (c === "[") {
        inBrace = true;
        braceStart = i2;
        braceNeg = false;
        acc += c;
        continue;
      }
      const doRecurse = isExtglobType(c) && str.charAt(i2) === "(" && /* c8 ignore start - the maxDepth is sufficient here */
      (extDepth <= maxDepth || ast && ast.#canAdoptType(c));
      if (doRecurse) {
        const depthAdd = ast && ast.#canAdoptType(c) ? 0 : 1;
        part.push(acc);
        acc = "";
        const ext2 = new _a(c, part);
        part.push(ext2);
        i2 = _a.#parseAST(str, ext2, i2, opt, extDepth + depthAdd);
        continue;
      }
      if (c === "|") {
        part.push(acc);
        acc = "";
        parts.push(part);
        part = new _a(null, ast);
        continue;
      }
      if (c === ")") {
        if (acc === "" && ast.#parts.length === 0) {
          ast.#emptyExt = true;
        }
        part.push(acc);
        acc = "";
        ast.push(...parts, part);
        return i2;
      }
      acc += c;
    }
    ast.type = null;
    ast.#hasMagic = void 0;
    ast.#parts = [str.substring(pos - 1)];
    return i2;
  }
  #canAdoptWithSpace(child) {
    return this.#canAdopt(child, adoptionWithSpaceMap);
  }
  #canAdopt(child, map = adoptionMap) {
    if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null) {
      return false;
    }
    const gc = child.#parts[0];
    if (!gc || typeof gc !== "object" || gc.type === null) {
      return false;
    }
    return this.#canAdoptType(gc.type, map);
  }
  #canAdoptType(c, map = adoptionAnyMap) {
    return !!map.get(this.type)?.includes(c);
  }
  #adoptWithSpace(child, index) {
    const gc = child.#parts[0];
    const blank = new _a(null, gc, this.options);
    blank.#parts.push("");
    gc.push(blank);
    this.#adopt(child, index);
  }
  #adopt(child, index) {
    const gc = child.#parts[0];
    this.#parts.splice(index, 1, ...gc.#parts);
    for (const p of gc.#parts) {
      if (typeof p === "object")
        p.#parent = this;
    }
    this.#toString = void 0;
  }
  #canUsurpType(c) {
    const m2 = usurpMap.get(this.type);
    return !!m2?.has(c);
  }
  #canUsurp(child) {
    if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null || this.#parts.length !== 1) {
      return false;
    }
    const gc = child.#parts[0];
    if (!gc || typeof gc !== "object" || gc.type === null) {
      return false;
    }
    return this.#canUsurpType(gc.type);
  }
  #usurp(child) {
    const m2 = usurpMap.get(this.type);
    const gc = child.#parts[0];
    const nt = m2?.get(gc.type);
    if (!nt)
      return false;
    this.#parts = gc.#parts;
    for (const p of this.#parts) {
      if (typeof p === "object")
        p.#parent = this;
    }
    this.type = nt;
    this.#toString = void 0;
    this.#emptyExt = false;
  }
  #flatten() {
    if (!isExtglobAST(this)) {
      for (const p of this.#parts) {
        if (typeof p === "object")
          p.#flatten();
      }
    } else {
      let iterations = 0;
      let done = false;
      do {
        done = true;
        for (let i2 = 0; i2 < this.#parts.length; i2++) {
          const c = this.#parts[i2];
          if (typeof c === "object") {
            c.#flatten();
            if (this.#canAdopt(c)) {
              done = false;
              this.#adopt(c, i2);
            } else if (this.#canAdoptWithSpace(c)) {
              done = false;
              this.#adoptWithSpace(c, i2);
            } else if (this.#canUsurp(c)) {
              done = false;
              this.#usurp(c);
            }
          }
        }
      } while (!done && ++iterations < 10);
    }
    this.#toString = void 0;
  }
  static fromGlob(pattern, options = {}) {
    const ast = new _a(null, void 0, options);
    _a.#parseAST(pattern, ast, 0, options, 0);
    return ast;
  }
  // returns the regular expression if there's magic, or the unescaped
  // string if not.
  toMMPattern() {
    if (this !== this.#root)
      return this.#root.toMMPattern();
    const glob = this.toString();
    const [re, body, hasMagic, uflag] = this.toRegExpSource();
    const anyMagic = hasMagic || this.#hasMagic || this.#options.nocase && !this.#options.nocaseMagicOnly && glob.toUpperCase() !== glob.toLowerCase();
    if (!anyMagic) {
      return body;
    }
    const flags = (this.#options.nocase ? "i" : "") + (uflag ? "u" : "");
    return Object.assign(new RegExp(`^${re}$`, flags), {
      _src: re,
      _glob: glob
    });
  }
  get options() {
    return this.#options;
  }
  // returns the string match, the regexp source, whether there's magic
  // in the regexp (so a regular expression is required) and whether or
  // not the uflag is needed for the regular expression (for posix classes)
  // TODO: instead of injecting the start/end at this point, just return
  // the BODY of the regexp, along with the start/end portions suitable
  // for binding the start/end in either a joined full-path makeRe context
  // (where we bind to (^|/), or a standalone matchPart context (where
  // we bind to ^, and not /).  Otherwise slashes get duped!
  //
  // In part-matching mode, the start is:
  // - if not isStart: nothing
  // - if traversal possible, but not allowed: ^(?!\.\.?$)
  // - if dots allowed or not possible: ^
  // - if dots possible and not allowed: ^(?!\.)
  // end is:
  // - if not isEnd(): nothing
  // - else: $
  //
  // In full-path matching mode, we put the slash at the START of the
  // pattern, so start is:
  // - if first pattern: same as part-matching mode
  // - if not isStart(): nothing
  // - if traversal possible, but not allowed: /(?!\.\.?(?:$|/))
  // - if dots allowed or not possible: /
  // - if dots possible and not allowed: /(?!\.)
  // end is:
  // - if last pattern, same as part-matching mode
  // - else nothing
  //
  // Always put the (?:$|/) on negated tails, though, because that has to be
  // there to bind the end of the negated pattern portion, and it's easier to
  // just stick it in now rather than try to inject it later in the middle of
  // the pattern.
  //
  // We can just always return the same end, and leave it up to the caller
  // to know whether it's going to be used joined or in parts.
  // And, if the start is adjusted slightly, can do the same there:
  // - if not isStart: nothing
  // - if traversal possible, but not allowed: (?:/|^)(?!\.\.?$)
  // - if dots allowed or not possible: (?:/|^)
  // - if dots possible and not allowed: (?:/|^)(?!\.)
  //
  // But it's better to have a simpler binding without a conditional, for
  // performance, so probably better to return both start options.
  //
  // Then the caller just ignores the end if it's not the first pattern,
  // and the start always gets applied.
  //
  // But that's always going to be $ if it's the ending pattern, or nothing,
  // so the caller can just attach $ at the end of the pattern when building.
  //
  // So the todo is:
  // - better detect what kind of start is needed
  // - return both flavors of starting pattern
  // - attach $ at the end of the pattern when creating the actual RegExp
  //
  // Ah, but wait, no, that all only applies to the root when the first pattern
  // is not an extglob. If the first pattern IS an extglob, then we need all
  // that dot prevention biz to live in the extglob portions, because eg
  // +(*|.x*) can match .xy but not .yx.
  //
  // So, return the two flavors if it's #root and the first child is not an
  // AST, otherwise leave it to the child AST to handle it, and there,
  // use the (?:^|/) style of start binding.
  //
  // Even simplified further:
  // - Since the start for a join is eg /(?!\.) and the start for a part
  // is ^(?!\.), we can just prepend (?!\.) to the pattern (either root
  // or start or whatever) and prepend ^ or / at the Regexp construction.
  toRegExpSource(allowDot) {
    const dot = allowDot ?? !!this.#options.dot;
    if (this.#root === this) {
      this.#flatten();
      this.#fillNegs();
    }
    if (!isExtglobAST(this)) {
      const noEmpty = this.isStart() && this.isEnd();
      const src = this.#parts.map((p) => {
        const [re, _, hasMagic, uflag] = typeof p === "string" ? _a.#parseGlob(p, this.#hasMagic, noEmpty) : p.toRegExpSource(allowDot);
        this.#hasMagic = this.#hasMagic || hasMagic;
        this.#uflag = this.#uflag || uflag;
        return re;
      }).join("");
      let start2 = "";
      if (this.isStart()) {
        if (typeof this.#parts[0] === "string") {
          const dotTravAllowed = this.#parts.length === 1 && justDots.has(this.#parts[0]);
          if (!dotTravAllowed) {
            const aps = addPatternStart;
            const needNoTrav = (
              // dots are allowed, and the pattern starts with [ or .
              dot && aps.has(src.charAt(0)) || // the pattern starts with \., and then [ or .
              src.startsWith("\\.") && aps.has(src.charAt(2)) || // the pattern starts with \.\., and then [ or .
              src.startsWith("\\.\\.") && aps.has(src.charAt(4))
            );
            const needNoDot = !dot && !allowDot && aps.has(src.charAt(0));
            start2 = needNoTrav ? startNoTraversal : needNoDot ? startNoDot : "";
          }
        }
      }
      let end = "";
      if (this.isEnd() && this.#root.#filledNegs && this.#parent?.type === "!") {
        end = "(?:$|\\/)";
      }
      const final2 = start2 + src + end;
      return [
        final2,
        unescape$1(src),
        this.#hasMagic = !!this.#hasMagic,
        this.#uflag
      ];
    }
    const repeated = this.type === "*" || this.type === "+";
    const start = this.type === "!" ? "(?:(?!(?:" : "(?:";
    let body = this.#partsToRegExp(dot);
    if (this.isStart() && this.isEnd() && !body && this.type !== "!") {
      const s = this.toString();
      const me = this;
      me.#parts = [s];
      me.type = null;
      me.#hasMagic = void 0;
      return [s, unescape$1(this.toString()), false, false];
    }
    let bodyDotAllowed = !repeated || allowDot || dot || !startNoDot ? "" : this.#partsToRegExp(true);
    if (bodyDotAllowed === body) {
      bodyDotAllowed = "";
    }
    if (bodyDotAllowed) {
      body = `(?:${body})(?:${bodyDotAllowed})*?`;
    }
    let final = "";
    if (this.type === "!" && this.#emptyExt) {
      final = (this.isStart() && !dot ? startNoDot : "") + starNoEmpty;
    } else {
      const close = this.type === "!" ? (
        // !() must match something,but !(x) can match ''
        "))" + (this.isStart() && !dot && !allowDot ? startNoDot : "") + star$1 + ")"
      ) : this.type === "@" ? ")" : this.type === "?" ? ")?" : this.type === "+" && bodyDotAllowed ? ")" : this.type === "*" && bodyDotAllowed ? `)?` : `)${this.type}`;
      final = start + body + close;
    }
    return [
      final,
      unescape$1(body),
      this.#hasMagic = !!this.#hasMagic,
      this.#uflag
    ];
  }
  #partsToRegExp(dot) {
    return this.#parts.map((p) => {
      if (typeof p === "string") {
        throw new Error("string type in extglob ast??");
      }
      const [re, _, _hasMagic, uflag] = p.toRegExpSource(dot);
      this.#uflag = this.#uflag || uflag;
      return re;
    }).filter((p) => !(this.isStart() && this.isEnd()) || !!p).join("|");
  }
  static #parseGlob(glob, hasMagic, noEmpty = false) {
    let escaping = false;
    let re = "";
    let uflag = false;
    let inStar = false;
    for (let i2 = 0; i2 < glob.length; i2++) {
      const c = glob.charAt(i2);
      if (escaping) {
        escaping = false;
        re += (reSpecials.has(c) ? "\\" : "") + c;
        inStar = false;
        continue;
      }
      if (c === "\\") {
        if (i2 === glob.length - 1) {
          re += "\\\\";
        } else {
          escaping = true;
        }
        continue;
      }
      if (c === "[") {
        const [src, needUflag, consumed, magic] = parseClass(glob, i2);
        if (consumed) {
          re += src;
          uflag = uflag || needUflag;
          i2 += consumed - 1;
          hasMagic = hasMagic || magic;
          inStar = false;
          continue;
        }
      }
      if (c === "*") {
        if (inStar)
          continue;
        inStar = true;
        re += noEmpty && /^[*]+$/.test(glob) ? starNoEmpty : star$1;
        hasMagic = true;
        continue;
      } else {
        inStar = false;
      }
      if (c === "?") {
        re += qmark$1;
        hasMagic = true;
        continue;
      }
      re += regExpEscape$1(c);
    }
    return [re, unescape$1(glob), !!hasMagic, uflag];
  }
}
_a = AST;
const escape$1 = (s, { windowsPathsNoEscape = false } = {}) => {
  return windowsPathsNoEscape ? s.replace(/[?*()[\]]/g, "[$&]") : s.replace(/[?*()[\]\\]/g, "\\$&");
};
const minimatch = (p, pattern, options = {}) => {
  assertValidPattern(pattern);
  if (!options.nocomment && pattern.charAt(0) === "#") {
    return false;
  }
  return new Minimatch(pattern, options).match(p);
};
const starDotExtRE = /^\*+([^+@!?\*\[\(]*)$/;
const starDotExtTest = (ext2) => (f2) => !f2.startsWith(".") && f2.endsWith(ext2);
const starDotExtTestDot = (ext2) => (f2) => f2.endsWith(ext2);
const starDotExtTestNocase = (ext2) => {
  ext2 = ext2.toLowerCase();
  return (f2) => !f2.startsWith(".") && f2.toLowerCase().endsWith(ext2);
};
const starDotExtTestNocaseDot = (ext2) => {
  ext2 = ext2.toLowerCase();
  return (f2) => f2.toLowerCase().endsWith(ext2);
};
const starDotStarRE = /^\*+\.\*+$/;
const starDotStarTest = (f2) => !f2.startsWith(".") && f2.includes(".");
const starDotStarTestDot = (f2) => f2 !== "." && f2 !== ".." && f2.includes(".");
const dotStarRE = /^\.\*+$/;
const dotStarTest = (f2) => f2 !== "." && f2 !== ".." && f2.startsWith(".");
const starRE = /^\*+$/;
const starTest = (f2) => f2.length !== 0 && !f2.startsWith(".");
const starTestDot = (f2) => f2.length !== 0 && f2 !== "." && f2 !== "..";
const qmarksRE = /^\?+([^+@!?\*\[\(]*)?$/;
const qmarksTestNocase = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExt([$0]);
  if (!ext2)
    return noext;
  ext2 = ext2.toLowerCase();
  return (f2) => noext(f2) && f2.toLowerCase().endsWith(ext2);
};
const qmarksTestNocaseDot = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExtDot([$0]);
  if (!ext2)
    return noext;
  ext2 = ext2.toLowerCase();
  return (f2) => noext(f2) && f2.toLowerCase().endsWith(ext2);
};
const qmarksTestDot = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExtDot([$0]);
  return !ext2 ? noext : (f2) => noext(f2) && f2.endsWith(ext2);
};
const qmarksTest = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExt([$0]);
  return !ext2 ? noext : (f2) => noext(f2) && f2.endsWith(ext2);
};
const qmarksTestNoExt = ([$0]) => {
  const len = $0.length;
  return (f2) => f2.length === len && !f2.startsWith(".");
};
const qmarksTestNoExtDot = ([$0]) => {
  const len = $0.length;
  return (f2) => f2.length === len && f2 !== "." && f2 !== "..";
};
const defaultPlatform = typeof process === "object" && process ? typeof process.env === "object" && process.env && process.env.__MINIMATCH_TESTING_PLATFORM__ || process.platform : "posix";
const path = {
  win32: { sep: "\\" },
  posix: { sep: "/" }
};
const sep$1 = defaultPlatform === "win32" ? path.win32.sep : path.posix.sep;
minimatch.sep = sep$1;
const GLOBSTAR = /* @__PURE__ */ Symbol("globstar **");
minimatch.GLOBSTAR = GLOBSTAR;
const qmark = "[^/]";
const star = qmark + "*?";
const twoStarDot = "(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?";
const twoStarNoDot = "(?:(?!(?:\\/|^)\\.).)*?";
const filter = (pattern, options = {}) => (p) => minimatch(p, pattern, options);
minimatch.filter = filter;
const ext = (a, b = {}) => Object.assign({}, a, b);
const defaults = (def) => {
  if (!def || typeof def !== "object" || !Object.keys(def).length) {
    return minimatch;
  }
  const orig = minimatch;
  const m2 = (p, pattern, options = {}) => orig(p, pattern, ext(def, options));
  return Object.assign(m2, {
    Minimatch: class Minimatch extends orig.Minimatch {
      constructor(pattern, options = {}) {
        super(pattern, ext(def, options));
      }
      static defaults(options) {
        return orig.defaults(ext(def, options)).Minimatch;
      }
    },
    AST: class AST extends orig.AST {
      /* c8 ignore start */
      constructor(type, parent, options = {}) {
        super(type, parent, ext(def, options));
      }
      /* c8 ignore stop */
      static fromGlob(pattern, options = {}) {
        return orig.AST.fromGlob(pattern, ext(def, options));
      }
    },
    unescape: (s, options = {}) => orig.unescape(s, ext(def, options)),
    escape: (s, options = {}) => orig.escape(s, ext(def, options)),
    filter: (pattern, options = {}) => orig.filter(pattern, ext(def, options)),
    defaults: (options) => orig.defaults(ext(def, options)),
    makeRe: (pattern, options = {}) => orig.makeRe(pattern, ext(def, options)),
    braceExpand: (pattern, options = {}) => orig.braceExpand(pattern, ext(def, options)),
    match: (list, pattern, options = {}) => orig.match(list, pattern, ext(def, options)),
    sep: orig.sep,
    GLOBSTAR
  });
};
minimatch.defaults = defaults;
const braceExpand = (pattern, options = {}) => {
  assertValidPattern(pattern);
  if (options.nobrace || !/\{(?:(?!\{).)*\}/.test(pattern)) {
    return [pattern];
  }
  return expand(pattern);
};
minimatch.braceExpand = braceExpand;
const makeRe = (pattern, options = {}) => new Minimatch(pattern, options).makeRe();
minimatch.makeRe = makeRe;
const match = (list, pattern, options = {}) => {
  const mm = new Minimatch(pattern, options);
  list = list.filter((f2) => mm.match(f2));
  if (mm.options.nonull && !list.length) {
    list.push(pattern);
  }
  return list;
};
minimatch.match = match;
const globMagic = /[?*]|[+@!]\(.*?\)|\[|\]/;
const regExpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
class Minimatch {
  options;
  set;
  pattern;
  windowsPathsNoEscape;
  nonegate;
  negate;
  comment;
  empty;
  preserveMultipleSlashes;
  partial;
  globSet;
  globParts;
  nocase;
  isWindows;
  platform;
  windowsNoMagicRoot;
  maxGlobstarRecursion;
  regexp;
  constructor(pattern, options = {}) {
    assertValidPattern(pattern);
    options = options || {};
    this.options = options;
    this.maxGlobstarRecursion = options.maxGlobstarRecursion ?? 200;
    this.pattern = pattern;
    this.platform = options.platform || defaultPlatform;
    this.isWindows = this.platform === "win32";
    this.windowsPathsNoEscape = !!options.windowsPathsNoEscape || options.allowWindowsEscape === false;
    if (this.windowsPathsNoEscape) {
      this.pattern = this.pattern.replace(/\\/g, "/");
    }
    this.preserveMultipleSlashes = !!options.preserveMultipleSlashes;
    this.regexp = null;
    this.negate = false;
    this.nonegate = !!options.nonegate;
    this.comment = false;
    this.empty = false;
    this.partial = !!options.partial;
    this.nocase = !!this.options.nocase;
    this.windowsNoMagicRoot = options.windowsNoMagicRoot !== void 0 ? options.windowsNoMagicRoot : !!(this.isWindows && this.nocase);
    this.globSet = [];
    this.globParts = [];
    this.set = [];
    this.make();
  }
  hasMagic() {
    if (this.options.magicalBraces && this.set.length > 1) {
      return true;
    }
    for (const pattern of this.set) {
      for (const part of pattern) {
        if (typeof part !== "string")
          return true;
      }
    }
    return false;
  }
  debug(..._) {
  }
  make() {
    const pattern = this.pattern;
    const options = this.options;
    if (!options.nocomment && pattern.charAt(0) === "#") {
      this.comment = true;
      return;
    }
    if (!pattern) {
      this.empty = true;
      return;
    }
    this.parseNegate();
    this.globSet = [...new Set(this.braceExpand())];
    if (options.debug) {
      this.debug = (...args) => console.error(...args);
    }
    this.debug(this.pattern, this.globSet);
    const rawGlobParts = this.globSet.map((s) => this.slashSplit(s));
    this.globParts = this.preprocess(rawGlobParts);
    this.debug(this.pattern, this.globParts);
    let set = this.globParts.map((s, _, __) => {
      if (this.isWindows && this.windowsNoMagicRoot) {
        const isUNC = s[0] === "" && s[1] === "" && (s[2] === "?" || !globMagic.test(s[2])) && !globMagic.test(s[3]);
        const isDrive = /^[a-z]:/i.test(s[0]);
        if (isUNC) {
          return [...s.slice(0, 4), ...s.slice(4).map((ss) => this.parse(ss))];
        } else if (isDrive) {
          return [s[0], ...s.slice(1).map((ss) => this.parse(ss))];
        }
      }
      return s.map((ss) => this.parse(ss));
    });
    this.debug(this.pattern, set);
    this.set = set.filter((s) => s.indexOf(false) === -1);
    if (this.isWindows) {
      for (let i2 = 0; i2 < this.set.length; i2++) {
        const p = this.set[i2];
        if (p[0] === "" && p[1] === "" && this.globParts[i2][2] === "?" && typeof p[3] === "string" && /^[a-z]:$/i.test(p[3])) {
          p[2] = "?";
        }
      }
    }
    this.debug(this.pattern, this.set);
  }
  // various transforms to equivalent pattern sets that are
  // faster to process in a filesystem walk.  The goal is to
  // eliminate what we can, and push all ** patterns as far
  // to the right as possible, even if it increases the number
  // of patterns that we have to process.
  preprocess(globParts) {
    if (this.options.noglobstar) {
      for (let i2 = 0; i2 < globParts.length; i2++) {
        for (let j = 0; j < globParts[i2].length; j++) {
          if (globParts[i2][j] === "**") {
            globParts[i2][j] = "*";
          }
        }
      }
    }
    const { optimizationLevel = 1 } = this.options;
    if (optimizationLevel >= 2) {
      globParts = this.firstPhasePreProcess(globParts);
      globParts = this.secondPhasePreProcess(globParts);
    } else if (optimizationLevel >= 1) {
      globParts = this.levelOneOptimize(globParts);
    } else {
      globParts = this.adjascentGlobstarOptimize(globParts);
    }
    return globParts;
  }
  // just get rid of adjascent ** portions
  adjascentGlobstarOptimize(globParts) {
    return globParts.map((parts) => {
      let gs = -1;
      while (-1 !== (gs = parts.indexOf("**", gs + 1))) {
        let i2 = gs;
        while (parts[i2 + 1] === "**") {
          i2++;
        }
        if (i2 !== gs) {
          parts.splice(gs, i2 - gs);
        }
      }
      return parts;
    });
  }
  // get rid of adjascent ** and resolve .. portions
  levelOneOptimize(globParts) {
    return globParts.map((parts) => {
      parts = parts.reduce((set, part) => {
        const prev = set[set.length - 1];
        if (part === "**" && prev === "**") {
          return set;
        }
        if (part === "..") {
          if (prev && prev !== ".." && prev !== "." && prev !== "**") {
            set.pop();
            return set;
          }
        }
        set.push(part);
        return set;
      }, []);
      return parts.length === 0 ? [""] : parts;
    });
  }
  levelTwoFileOptimize(parts) {
    if (!Array.isArray(parts)) {
      parts = this.slashSplit(parts);
    }
    let didSomething = false;
    do {
      didSomething = false;
      if (!this.preserveMultipleSlashes) {
        for (let i2 = 1; i2 < parts.length - 1; i2++) {
          const p = parts[i2];
          if (i2 === 1 && p === "" && parts[0] === "")
            continue;
          if (p === "." || p === "") {
            didSomething = true;
            parts.splice(i2, 1);
            i2--;
          }
        }
        if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
          didSomething = true;
          parts.pop();
        }
      }
      let dd = 0;
      while (-1 !== (dd = parts.indexOf("..", dd + 1))) {
        const p = parts[dd - 1];
        if (p && p !== "." && p !== ".." && p !== "**") {
          didSomething = true;
          parts.splice(dd - 1, 2);
          dd -= 2;
        }
      }
    } while (didSomething);
    return parts.length === 0 ? [""] : parts;
  }
  // First phase: single-pattern processing
  // <pre> is 1 or more portions
  // <rest> is 1 or more portions
  // <p> is any portion other than ., .., '', or **
  // <e> is . or ''
  //
  // **/.. is *brutal* for filesystem walking performance, because
  // it effectively resets the recursive walk each time it occurs,
  // and ** cannot be reduced out by a .. pattern part like a regexp
  // or most strings (other than .., ., and '') can be.
  //
  // <pre>/**/../<p>/<p>/<rest> -> {<pre>/../<p>/<p>/<rest>,<pre>/**/<p>/<p>/<rest>}
  // <pre>/<e>/<rest> -> <pre>/<rest>
  // <pre>/<p>/../<rest> -> <pre>/<rest>
  // **/**/<rest> -> **/<rest>
  //
  // **/*/<rest> -> */**/<rest> <== not valid because ** doesn't follow
  // this WOULD be allowed if ** did follow symlinks, or * didn't
  firstPhasePreProcess(globParts) {
    let didSomething = false;
    do {
      didSomething = false;
      for (let parts of globParts) {
        let gs = -1;
        while (-1 !== (gs = parts.indexOf("**", gs + 1))) {
          let gss = gs;
          while (parts[gss + 1] === "**") {
            gss++;
          }
          if (gss > gs) {
            parts.splice(gs + 1, gss - gs);
          }
          let next = parts[gs + 1];
          const p = parts[gs + 2];
          const p2 = parts[gs + 3];
          if (next !== "..")
            continue;
          if (!p || p === "." || p === ".." || !p2 || p2 === "." || p2 === "..") {
            continue;
          }
          didSomething = true;
          parts.splice(gs, 1);
          const other = parts.slice(0);
          other[gs] = "**";
          globParts.push(other);
          gs--;
        }
        if (!this.preserveMultipleSlashes) {
          for (let i2 = 1; i2 < parts.length - 1; i2++) {
            const p = parts[i2];
            if (i2 === 1 && p === "" && parts[0] === "")
              continue;
            if (p === "." || p === "") {
              didSomething = true;
              parts.splice(i2, 1);
              i2--;
            }
          }
          if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
            didSomething = true;
            parts.pop();
          }
        }
        let dd = 0;
        while (-1 !== (dd = parts.indexOf("..", dd + 1))) {
          const p = parts[dd - 1];
          if (p && p !== "." && p !== ".." && p !== "**") {
            didSomething = true;
            const needDot = dd === 1 && parts[dd + 1] === "**";
            const splin = needDot ? ["."] : [];
            parts.splice(dd - 1, 2, ...splin);
            if (parts.length === 0)
              parts.push("");
            dd -= 2;
          }
        }
      }
    } while (didSomething);
    return globParts;
  }
  // second phase: multi-pattern dedupes
  // {<pre>/*/<rest>,<pre>/<p>/<rest>} -> <pre>/*/<rest>
  // {<pre>/<rest>,<pre>/<rest>} -> <pre>/<rest>
  // {<pre>/**/<rest>,<pre>/<rest>} -> <pre>/**/<rest>
  //
  // {<pre>/**/<rest>,<pre>/**/<p>/<rest>} -> <pre>/**/<rest>
  // ^-- not valid because ** doens't follow symlinks
  secondPhasePreProcess(globParts) {
    for (let i2 = 0; i2 < globParts.length - 1; i2++) {
      for (let j = i2 + 1; j < globParts.length; j++) {
        const matched = this.partsMatch(globParts[i2], globParts[j], !this.preserveMultipleSlashes);
        if (matched) {
          globParts[i2] = [];
          globParts[j] = matched;
          break;
        }
      }
    }
    return globParts.filter((gs) => gs.length);
  }
  partsMatch(a, b, emptyGSMatch = false) {
    let ai = 0;
    let bi = 0;
    let result = [];
    let which = "";
    while (ai < a.length && bi < b.length) {
      if (a[ai] === b[bi]) {
        result.push(which === "b" ? b[bi] : a[ai]);
        ai++;
        bi++;
      } else if (emptyGSMatch && a[ai] === "**" && b[bi] === a[ai + 1]) {
        result.push(a[ai]);
        ai++;
      } else if (emptyGSMatch && b[bi] === "**" && a[ai] === b[bi + 1]) {
        result.push(b[bi]);
        bi++;
      } else if (a[ai] === "*" && b[bi] && (this.options.dot || !b[bi].startsWith(".")) && b[bi] !== "**") {
        if (which === "b")
          return false;
        which = "a";
        result.push(a[ai]);
        ai++;
        bi++;
      } else if (b[bi] === "*" && a[ai] && (this.options.dot || !a[ai].startsWith(".")) && a[ai] !== "**") {
        if (which === "a")
          return false;
        which = "b";
        result.push(b[bi]);
        ai++;
        bi++;
      } else {
        return false;
      }
    }
    return a.length === b.length && result;
  }
  parseNegate() {
    if (this.nonegate)
      return;
    const pattern = this.pattern;
    let negate = false;
    let negateOffset = 0;
    for (let i2 = 0; i2 < pattern.length && pattern.charAt(i2) === "!"; i2++) {
      negate = !negate;
      negateOffset++;
    }
    if (negateOffset)
      this.pattern = pattern.slice(negateOffset);
    this.negate = negate;
  }
  // set partial to true to test if, for example,
  // "/a/b" matches the start of "/*/b/*/d"
  // Partial means, if you run out of file before you run
  // out of pattern, then that's fine, as long as all
  // the parts match.
  matchOne(file, pattern, partial = false) {
    let fileStartIndex = 0;
    let patternStartIndex = 0;
    if (this.isWindows) {
      const fileDrive = typeof file[0] === "string" && /^[a-z]:$/i.test(file[0]);
      const fileUNC = !fileDrive && file[0] === "" && file[1] === "" && file[2] === "?" && /^[a-z]:$/i.test(file[3]);
      const patternDrive = typeof pattern[0] === "string" && /^[a-z]:$/i.test(pattern[0]);
      const patternUNC = !patternDrive && pattern[0] === "" && pattern[1] === "" && pattern[2] === "?" && typeof pattern[3] === "string" && /^[a-z]:$/i.test(pattern[3]);
      const fdi = fileUNC ? 3 : fileDrive ? 0 : void 0;
      const pdi = patternUNC ? 3 : patternDrive ? 0 : void 0;
      if (typeof fdi === "number" && typeof pdi === "number") {
        const [fd, pd] = [
          file[fdi],
          pattern[pdi]
        ];
        if (fd.toLowerCase() === pd.toLowerCase()) {
          pattern[pdi] = fd;
          patternStartIndex = pdi;
          fileStartIndex = fdi;
        }
      }
    }
    const { optimizationLevel = 1 } = this.options;
    if (optimizationLevel >= 2) {
      file = this.levelTwoFileOptimize(file);
    }
    if (pattern.includes(GLOBSTAR)) {
      return this.#matchGlobstar(file, pattern, partial, fileStartIndex, patternStartIndex);
    }
    return this.#matchOne(file, pattern, partial, fileStartIndex, patternStartIndex);
  }
  #matchGlobstar(file, pattern, partial, fileIndex, patternIndex) {
    const firstgs = pattern.indexOf(GLOBSTAR, patternIndex);
    const lastgs = pattern.lastIndexOf(GLOBSTAR);
    const [head, body, tail] = partial ? [
      pattern.slice(patternIndex, firstgs),
      pattern.slice(firstgs + 1),
      []
    ] : [
      pattern.slice(patternIndex, firstgs),
      pattern.slice(firstgs + 1, lastgs),
      pattern.slice(lastgs + 1)
    ];
    if (head.length) {
      const fileHead = file.slice(fileIndex, fileIndex + head.length);
      if (!this.#matchOne(fileHead, head, partial, 0, 0))
        return false;
      fileIndex += head.length;
    }
    let fileTailMatch = 0;
    if (tail.length) {
      if (tail.length + fileIndex > file.length)
        return false;
      let tailStart = file.length - tail.length;
      if (this.#matchOne(file, tail, partial, tailStart, 0)) {
        fileTailMatch = tail.length;
      } else {
        if (file[file.length - 1] !== "" || fileIndex + tail.length === file.length) {
          return false;
        }
        tailStart--;
        if (!this.#matchOne(file, tail, partial, tailStart, 0))
          return false;
        fileTailMatch = tail.length + 1;
      }
    }
    if (!body.length) {
      let sawSome = !!fileTailMatch;
      for (let i22 = fileIndex; i22 < file.length - fileTailMatch; i22++) {
        const f2 = String(file[i22]);
        sawSome = true;
        if (f2 === "." || f2 === ".." || !this.options.dot && f2.startsWith(".")) {
          return false;
        }
      }
      return partial || sawSome;
    }
    const bodySegments = [[[], 0]];
    let currentBody = bodySegments[0];
    let nonGsParts = 0;
    const nonGsPartsSums = [0];
    for (const b of body) {
      if (b === GLOBSTAR) {
        nonGsPartsSums.push(nonGsParts);
        currentBody = [[], 0];
        bodySegments.push(currentBody);
      } else {
        currentBody[0].push(b);
        nonGsParts++;
      }
    }
    let i2 = bodySegments.length - 1;
    const fileLength = file.length - fileTailMatch;
    for (const b of bodySegments) {
      b[1] = fileLength - (nonGsPartsSums[i2--] + b[0].length);
    }
    return !!this.#matchGlobStarBodySections(file, bodySegments, fileIndex, 0, partial, 0, !!fileTailMatch);
  }
  #matchGlobStarBodySections(file, bodySegments, fileIndex, bodyIndex, partial, globStarDepth, sawTail) {
    const bs = bodySegments[bodyIndex];
    if (!bs) {
      for (let i2 = fileIndex; i2 < file.length; i2++) {
        sawTail = true;
        const f2 = file[i2];
        if (f2 === "." || f2 === ".." || !this.options.dot && f2.startsWith(".")) {
          return false;
        }
      }
      return sawTail;
    }
    const [body, after] = bs;
    while (fileIndex <= after) {
      const m2 = this.#matchOne(file.slice(0, fileIndex + body.length), body, partial, fileIndex, 0);
      if (m2 && globStarDepth < this.maxGlobstarRecursion) {
        const sub = this.#matchGlobStarBodySections(file, bodySegments, fileIndex + body.length, bodyIndex + 1, partial, globStarDepth + 1, sawTail);
        if (sub !== false)
          return sub;
      }
      const f2 = file[fileIndex];
      if (f2 === "." || f2 === ".." || !this.options.dot && f2.startsWith(".")) {
        return false;
      }
      fileIndex++;
    }
    return partial || null;
  }
  #matchOne(file, pattern, partial, fileIndex, patternIndex) {
    let fi;
    let pi;
    let pl;
    let fl;
    for (fi = fileIndex, pi = patternIndex, fl = file.length, pl = pattern.length; fi < fl && pi < pl; fi++, pi++) {
      this.debug("matchOne loop");
      let p = pattern[pi];
      let f2 = file[fi];
      this.debug(pattern, p, f2);
      if (p === false || p === GLOBSTAR)
        return false;
      let hit;
      if (typeof p === "string") {
        hit = f2 === p;
        this.debug("string match", p, f2, hit);
      } else {
        hit = p.test(f2);
        this.debug("pattern match", p, f2, hit);
      }
      if (!hit)
        return false;
    }
    if (fi === fl && pi === pl) {
      return true;
    } else if (fi === fl) {
      return partial;
    } else if (pi === pl) {
      return fi === fl - 1 && file[fi] === "";
    } else {
      throw new Error("wtf?");
    }
  }
  braceExpand() {
    return braceExpand(this.pattern, this.options);
  }
  parse(pattern) {
    assertValidPattern(pattern);
    const options = this.options;
    if (pattern === "**")
      return GLOBSTAR;
    if (pattern === "")
      return "";
    let m2;
    let fastTest = null;
    if (m2 = pattern.match(starRE)) {
      fastTest = options.dot ? starTestDot : starTest;
    } else if (m2 = pattern.match(starDotExtRE)) {
      fastTest = (options.nocase ? options.dot ? starDotExtTestNocaseDot : starDotExtTestNocase : options.dot ? starDotExtTestDot : starDotExtTest)(m2[1]);
    } else if (m2 = pattern.match(qmarksRE)) {
      fastTest = (options.nocase ? options.dot ? qmarksTestNocaseDot : qmarksTestNocase : options.dot ? qmarksTestDot : qmarksTest)(m2);
    } else if (m2 = pattern.match(starDotStarRE)) {
      fastTest = options.dot ? starDotStarTestDot : starDotStarTest;
    } else if (m2 = pattern.match(dotStarRE)) {
      fastTest = dotStarTest;
    }
    const re = AST.fromGlob(pattern, this.options).toMMPattern();
    if (fastTest && typeof re === "object") {
      Reflect.defineProperty(re, "test", { value: fastTest });
    }
    return re;
  }
  makeRe() {
    if (this.regexp || this.regexp === false)
      return this.regexp;
    const set = this.set;
    if (!set.length) {
      this.regexp = false;
      return this.regexp;
    }
    const options = this.options;
    const twoStar = options.noglobstar ? star : options.dot ? twoStarDot : twoStarNoDot;
    const flags = new Set(options.nocase ? ["i"] : []);
    let re = set.map((pattern) => {
      const pp = pattern.map((p) => {
        if (p instanceof RegExp) {
          for (const f2 of p.flags.split(""))
            flags.add(f2);
        }
        return typeof p === "string" ? regExpEscape(p) : p === GLOBSTAR ? GLOBSTAR : p._src;
      });
      pp.forEach((p, i2) => {
        const next = pp[i2 + 1];
        const prev = pp[i2 - 1];
        if (p !== GLOBSTAR || prev === GLOBSTAR) {
          return;
        }
        if (prev === void 0) {
          if (next !== void 0 && next !== GLOBSTAR) {
            pp[i2 + 1] = "(?:\\/|" + twoStar + "\\/)?" + next;
          } else {
            pp[i2] = twoStar;
          }
        } else if (next === void 0) {
          pp[i2 - 1] = prev + "(?:\\/|" + twoStar + ")?";
        } else if (next !== GLOBSTAR) {
          pp[i2 - 1] = prev + "(?:\\/|\\/" + twoStar + "\\/)" + next;
          pp[i2 + 1] = GLOBSTAR;
        }
      });
      return pp.filter((p) => p !== GLOBSTAR).join("/");
    }).join("|");
    const [open, close] = set.length > 1 ? ["(?:", ")"] : ["", ""];
    re = "^" + open + re + close + "$";
    if (this.negate)
      re = "^(?!" + re + ").+$";
    try {
      this.regexp = new RegExp(re, [...flags].join(""));
    } catch (ex) {
      this.regexp = false;
    }
    return this.regexp;
  }
  slashSplit(p) {
    if (this.preserveMultipleSlashes) {
      return p.split("/");
    } else if (this.isWindows && /^\/\/[^\/]+/.test(p)) {
      return ["", ...p.split(/\/+/)];
    } else {
      return p.split(/\/+/);
    }
  }
  match(f2, partial = this.partial) {
    this.debug("match", f2, this.pattern);
    if (this.comment) {
      return false;
    }
    if (this.empty) {
      return f2 === "";
    }
    if (f2 === "/" && partial) {
      return true;
    }
    const options = this.options;
    if (this.isWindows) {
      f2 = f2.split("\\").join("/");
    }
    const ff = this.slashSplit(f2);
    this.debug(this.pattern, "split", ff);
    const set = this.set;
    this.debug(this.pattern, "set", set);
    let filename = ff[ff.length - 1];
    if (!filename) {
      for (let i2 = ff.length - 2; !filename && i2 >= 0; i2--) {
        filename = ff[i2];
      }
    }
    for (let i2 = 0; i2 < set.length; i2++) {
      const pattern = set[i2];
      let file = ff;
      if (options.matchBase && pattern.length === 1) {
        file = [filename];
      }
      const hit = this.matchOne(file, pattern, partial);
      if (hit) {
        if (options.flipNegate) {
          return true;
        }
        return !this.negate;
      }
    }
    if (options.flipNegate) {
      return false;
    }
    return this.negate;
  }
  static defaults(def) {
    return minimatch.defaults(def).Minimatch;
  }
}
minimatch.AST = AST;
minimatch.Minimatch = Minimatch;
minimatch.escape = escape$1;
minimatch.unescape = unescape$1;
function createErrorFromResponse(response, prefix = "") {
  const err = new Error(`${prefix}Invalid response: ${response.status} ${response.statusText}`);
  err.status = response.status;
  err.response = response;
  return err;
}
function handleResponseCode(context, response) {
  const { status } = response;
  if (status === 401 && context.digest)
    return response;
  if (status >= 400) {
    const err = createErrorFromResponse(response);
    throw err;
  }
  return response;
}
function processGlobFilter(files, glob) {
  return files.filter((file) => minimatch(file.filename, glob, { matchBase: true }));
}
function processResponsePayload(response, data, isDetailed = false) {
  return isDetailed ? {
    data,
    headers: response.headers ? convertResponseHeaders(response.headers) : {},
    status: response.status,
    statusText: response.statusText
  } : data;
}
async function copyFile(context, filename, destination, options = {}) {
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filename)),
    method: "COPY",
    headers: {
      Destination: joinURL(context.remoteURL, encodePath(destination)),
      /**
       * From RFC4918 section 10.6: If the overwrite header is not included in a COPY or MOVE request,
       * then the resource MUST treat the request as if it has an overwrite header of value "T".
       *
       * Meaning the overwrite header is always set to "T" EXCEPT the option is explicitly set to false.
       */
      Overwrite: options.overwrite === false ? "F" : "T",
      /**
       * From RFC4918 section 9.8.3: A client may submit a Depth header on a COPY on a collection with a value of "0"
       * or "infinity". The COPY method on a collection without a Depth header MUST act as if
       * a Depth header with value "infinity" was included.
       */
      Depth: options.shallow ? "0" : "infinity"
    }
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
}
const nameStartChar = ":A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD";
const nameChar = nameStartChar + "\\-.\\d\\u00B7\\u0300-\\u036F\\u203F-\\u2040";
const nameRegexp = "[" + nameStartChar + "][" + nameChar + "]*";
const regexName = new RegExp("^" + nameRegexp + "$");
function getAllMatches(string, regex) {
  const matches = [];
  let match2 = regex.exec(string);
  while (match2) {
    const allmatches = [];
    allmatches.startIndex = regex.lastIndex - match2[0].length;
    const len = match2.length;
    for (let index = 0; index < len; index++) {
      allmatches.push(match2[index]);
    }
    matches.push(allmatches);
    match2 = regex.exec(string);
  }
  return matches;
}
const isName = function(string) {
  const match2 = regexName.exec(string);
  return !(match2 === null || typeof match2 === "undefined");
};
function isExist(v) {
  return typeof v !== "undefined";
}
const DANGEROUS_PROPERTY_NAMES = [
  // '__proto__',
  // 'constructor',
  // 'prototype',
  "hasOwnProperty",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__"
];
const criticalProperties = ["__proto__", "constructor", "prototype"];
const defaultOptions$2 = {
  allowBooleanAttributes: false,
  //A tag can have attributes without any value
  unpairedTags: []
};
function validate(xmlData, options) {
  options = Object.assign({}, defaultOptions$2, options);
  const tags = [];
  let tagFound = false;
  let reachedRoot = false;
  if (xmlData[0] === "\uFEFF") {
    xmlData = xmlData.substr(1);
  }
  for (let i2 = 0; i2 < xmlData.length; i2++) {
    if (xmlData[i2] === "<" && xmlData[i2 + 1] === "?") {
      i2 += 2;
      i2 = readPI(xmlData, i2);
      if (i2.err) return i2;
    } else if (xmlData[i2] === "<") {
      let tagStartPos = i2;
      i2++;
      if (xmlData[i2] === "!") {
        i2 = readCommentAndCDATA(xmlData, i2);
        continue;
      } else {
        let closingTag = false;
        if (xmlData[i2] === "/") {
          closingTag = true;
          i2++;
        }
        let tagName = "";
        for (; i2 < xmlData.length && xmlData[i2] !== ">" && xmlData[i2] !== " " && xmlData[i2] !== "	" && xmlData[i2] !== "\n" && xmlData[i2] !== "\r"; i2++) {
          tagName += xmlData[i2];
        }
        tagName = tagName.trim();
        if (tagName[tagName.length - 1] === "/") {
          tagName = tagName.substring(0, tagName.length - 1);
          i2--;
        }
        if (!validateTagName(tagName)) {
          let msg;
          if (tagName.trim().length === 0) {
            msg = "Invalid space after '<'.";
          } else {
            msg = "Tag '" + tagName + "' is an invalid name.";
          }
          return getErrorObject("InvalidTag", msg, getLineNumberForPosition(xmlData, i2));
        }
        const result = readAttributeStr(xmlData, i2);
        if (result === false) {
          return getErrorObject("InvalidAttr", "Attributes for '" + tagName + "' have open quote.", getLineNumberForPosition(xmlData, i2));
        }
        let attrStr = result.value;
        i2 = result.index;
        if (attrStr[attrStr.length - 1] === "/") {
          const attrStrStart = i2 - attrStr.length;
          attrStr = attrStr.substring(0, attrStr.length - 1);
          const isValid = validateAttributeString(attrStr, options);
          if (isValid === true) {
            tagFound = true;
          } else {
            return getErrorObject(isValid.err.code, isValid.err.msg, getLineNumberForPosition(xmlData, attrStrStart + isValid.err.line));
          }
        } else if (closingTag) {
          if (!result.tagClosed) {
            return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' doesn't have proper closing.", getLineNumberForPosition(xmlData, i2));
          } else if (attrStr.trim().length > 0) {
            return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' can't have attributes or invalid starting.", getLineNumberForPosition(xmlData, tagStartPos));
          } else if (tags.length === 0) {
            return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' has not been opened.", getLineNumberForPosition(xmlData, tagStartPos));
          } else {
            const otg = tags.pop();
            if (tagName !== otg.tagName) {
              let openPos = getLineNumberForPosition(xmlData, otg.tagStartPos);
              return getErrorObject(
                "InvalidTag",
                "Expected closing tag '" + otg.tagName + "' (opened in line " + openPos.line + ", col " + openPos.col + ") instead of closing tag '" + tagName + "'.",
                getLineNumberForPosition(xmlData, tagStartPos)
              );
            }
            if (tags.length == 0) {
              reachedRoot = true;
            }
          }
        } else {
          const isValid = validateAttributeString(attrStr, options);
          if (isValid !== true) {
            return getErrorObject(isValid.err.code, isValid.err.msg, getLineNumberForPosition(xmlData, i2 - attrStr.length + isValid.err.line));
          }
          if (reachedRoot === true) {
            return getErrorObject("InvalidXml", "Multiple possible root nodes found.", getLineNumberForPosition(xmlData, i2));
          } else if (options.unpairedTags.indexOf(tagName) !== -1) ;
          else {
            tags.push({ tagName, tagStartPos });
          }
          tagFound = true;
        }
        for (i2++; i2 < xmlData.length; i2++) {
          if (xmlData[i2] === "<") {
            if (xmlData[i2 + 1] === "!") {
              i2++;
              i2 = readCommentAndCDATA(xmlData, i2);
              continue;
            } else if (xmlData[i2 + 1] === "?") {
              i2 = readPI(xmlData, ++i2);
              if (i2.err) return i2;
            } else {
              break;
            }
          } else if (xmlData[i2] === "&") {
            const afterAmp = validateAmpersand(xmlData, i2);
            if (afterAmp == -1)
              return getErrorObject("InvalidChar", "char '&' is not expected.", getLineNumberForPosition(xmlData, i2));
            i2 = afterAmp;
          } else {
            if (reachedRoot === true && !isWhiteSpace(xmlData[i2])) {
              return getErrorObject("InvalidXml", "Extra text at the end", getLineNumberForPosition(xmlData, i2));
            }
          }
        }
        if (xmlData[i2] === "<") {
          i2--;
        }
      }
    } else {
      if (isWhiteSpace(xmlData[i2])) {
        continue;
      }
      return getErrorObject("InvalidChar", "char '" + xmlData[i2] + "' is not expected.", getLineNumberForPosition(xmlData, i2));
    }
  }
  if (!tagFound) {
    return getErrorObject("InvalidXml", "Start tag expected.", 1);
  } else if (tags.length == 1) {
    return getErrorObject("InvalidTag", "Unclosed tag '" + tags[0].tagName + "'.", getLineNumberForPosition(xmlData, tags[0].tagStartPos));
  } else if (tags.length > 0) {
    return getErrorObject("InvalidXml", "Invalid '" + JSON.stringify(tags.map((t2) => t2.tagName), null, 4).replace(/\r?\n/g, "") + "' found.", { line: 1, col: 1 });
  }
  return true;
}
function isWhiteSpace(char) {
  return char === " " || char === "	" || char === "\n" || char === "\r";
}
function readPI(xmlData, i2) {
  const start = i2;
  for (; i2 < xmlData.length; i2++) {
    if (xmlData[i2] == "?" || xmlData[i2] == " ") {
      const tagname = xmlData.substr(start, i2 - start);
      if (i2 > 5 && tagname === "xml") {
        return getErrorObject("InvalidXml", "XML declaration allowed only at the start of the document.", getLineNumberForPosition(xmlData, i2));
      } else if (xmlData[i2] == "?" && xmlData[i2 + 1] == ">") {
        i2++;
        break;
      } else {
        continue;
      }
    }
  }
  return i2;
}
function readCommentAndCDATA(xmlData, i2) {
  if (xmlData.length > i2 + 5 && xmlData[i2 + 1] === "-" && xmlData[i2 + 2] === "-") {
    for (i2 += 3; i2 < xmlData.length; i2++) {
      if (xmlData[i2] === "-" && xmlData[i2 + 1] === "-" && xmlData[i2 + 2] === ">") {
        i2 += 2;
        break;
      }
    }
  } else if (xmlData.length > i2 + 8 && xmlData[i2 + 1] === "D" && xmlData[i2 + 2] === "O" && xmlData[i2 + 3] === "C" && xmlData[i2 + 4] === "T" && xmlData[i2 + 5] === "Y" && xmlData[i2 + 6] === "P" && xmlData[i2 + 7] === "E") {
    let angleBracketsCount = 1;
    for (i2 += 8; i2 < xmlData.length; i2++) {
      if (xmlData[i2] === "<") {
        angleBracketsCount++;
      } else if (xmlData[i2] === ">") {
        angleBracketsCount--;
        if (angleBracketsCount === 0) {
          break;
        }
      }
    }
  } else if (xmlData.length > i2 + 9 && xmlData[i2 + 1] === "[" && xmlData[i2 + 2] === "C" && xmlData[i2 + 3] === "D" && xmlData[i2 + 4] === "A" && xmlData[i2 + 5] === "T" && xmlData[i2 + 6] === "A" && xmlData[i2 + 7] === "[") {
    for (i2 += 8; i2 < xmlData.length; i2++) {
      if (xmlData[i2] === "]" && xmlData[i2 + 1] === "]" && xmlData[i2 + 2] === ">") {
        i2 += 2;
        break;
      }
    }
  }
  return i2;
}
const doubleQuote = '"';
const singleQuote = "'";
function readAttributeStr(xmlData, i2) {
  let attrStr = "";
  let startChar = "";
  let tagClosed = false;
  for (; i2 < xmlData.length; i2++) {
    if (xmlData[i2] === doubleQuote || xmlData[i2] === singleQuote) {
      if (startChar === "") {
        startChar = xmlData[i2];
      } else if (startChar !== xmlData[i2]) ;
      else {
        startChar = "";
      }
    } else if (xmlData[i2] === ">") {
      if (startChar === "") {
        tagClosed = true;
        break;
      }
    }
    attrStr += xmlData[i2];
  }
  if (startChar !== "") {
    return false;
  }
  return {
    value: attrStr,
    index: i2,
    tagClosed
  };
}
function scanAttributeTokens(attrStr) {
  const tokens = [];
  const len = attrStr.length;
  let i2 = 0;
  while (i2 < len) {
    const tokenStart = i2;
    while (i2 < len && isWhiteSpace(attrStr[i2])) i2++;
    if (i2 >= len) break;
    if (attrStr[i2] === "=") {
      i2 = tokenStart + 1;
      continue;
    }
    const leadingWs = attrStr.slice(tokenStart, i2);
    const nameStart = i2;
    while (i2 < len && !isWhiteSpace(attrStr[i2]) && attrStr[i2] !== "=") i2++;
    const name = attrStr.slice(nameStart, i2);
    let equalsGroup;
    let j = i2;
    while (j < len && isWhiteSpace(attrStr[j])) j++;
    if (j < len && attrStr[j] === "=") {
      equalsGroup = attrStr.slice(i2, j + 1);
      i2 = j + 1;
    }
    let quoteChar;
    let value;
    let k = i2;
    while (k < len && isWhiteSpace(attrStr[k])) k++;
    if (k < len && (attrStr[k] === '"' || attrStr[k] === "'")) {
      const valueStart = k + 1;
      const closeIdx = attrStr.indexOf(attrStr[k], valueStart);
      if (closeIdx !== -1) {
        quoteChar = attrStr[k];
        value = attrStr.slice(valueStart, closeIdx);
        i2 = closeIdx + 1;
      }
    }
    const token = { startIndex: tokenStart };
    token[1] = leadingWs;
    token[2] = name;
    token[3] = equalsGroup;
    token[4] = quoteChar !== void 0 ? true : void 0;
    token[5] = quoteChar;
    token[6] = value;
    tokens.push(token);
  }
  return tokens;
}
function validateAttributeString(attrStr, options) {
  const matches = scanAttributeTokens(attrStr);
  const attrNames = {};
  for (let i2 = 0; i2 < matches.length; i2++) {
    if (matches[i2][1].length === 0) {
      return getErrorObject("InvalidAttr", "Attribute '" + matches[i2][2] + "' has no space in starting.", getPositionFromMatch(matches[i2]));
    } else if (matches[i2][3] !== void 0 && matches[i2][4] === void 0) {
      return getErrorObject("InvalidAttr", "Attribute '" + matches[i2][2] + "' is without value.", getPositionFromMatch(matches[i2]));
    } else if (matches[i2][3] === void 0 && !options.allowBooleanAttributes) {
      return getErrorObject("InvalidAttr", "boolean attribute '" + matches[i2][2] + "' is not allowed.", getPositionFromMatch(matches[i2]));
    }
    const attrName = matches[i2][2];
    if (!validateAttrName(attrName)) {
      return getErrorObject("InvalidAttr", "Attribute '" + attrName + "' is an invalid name.", getPositionFromMatch(matches[i2]));
    }
    if (!Object.prototype.hasOwnProperty.call(attrNames, attrName)) {
      attrNames[attrName] = 1;
    } else {
      return getErrorObject("InvalidAttr", "Attribute '" + attrName + "' is repeated.", getPositionFromMatch(matches[i2]));
    }
  }
  return true;
}
function validateNumberAmpersand(xmlData, i2) {
  let re = /\d/;
  if (xmlData[i2] === "x") {
    i2++;
    re = /[\da-fA-F]/;
  }
  for (; i2 < xmlData.length; i2++) {
    if (xmlData[i2] === ";")
      return i2;
    if (!xmlData[i2].match(re))
      break;
  }
  return -1;
}
function validateAmpersand(xmlData, i2) {
  i2++;
  if (xmlData[i2] === ";")
    return -1;
  if (xmlData[i2] === "#") {
    i2++;
    return validateNumberAmpersand(xmlData, i2);
  }
  let count = 0;
  for (; i2 < xmlData.length; i2++, count++) {
    if (xmlData[i2].match(/\w/) && count < 20)
      continue;
    if (xmlData[i2] === ";")
      break;
    return -1;
  }
  return i2;
}
function getErrorObject(code, message, lineNumber) {
  return {
    err: {
      code,
      msg: message,
      line: lineNumber.line || lineNumber,
      col: lineNumber.col
    }
  };
}
function validateAttrName(attrName) {
  return isName(attrName);
}
function validateTagName(tagname) {
  return isName(tagname);
}
function getLineNumberForPosition(xmlData, index) {
  const lines = xmlData.substring(0, index).split(/\r?\n/);
  return {
    line: lines.length,
    // column number is last line's length + 1, because column numbering starts at 1:
    col: lines[lines.length - 1].length + 1
  };
}
function getPositionFromMatch(match2) {
  return match2.startIndex + match2[1].length;
}
const CURRENCY = {
  cent: "¢",
  pound: "£",
  curren: "¤",
  yen: "¥",
  euro: "€",
  dollar: "$",
  fnof: "ƒ",
  inr: "₹",
  af: "؋",
  birr: "ብር",
  peso: "₱",
  rub: "₽",
  won: "₩",
  yuan: "¥",
  cedil: "¸"
};
const XML = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"'
};
const COMMON_HTML = {
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  para: "¶",
  sect: "§",
  deg: "°",
  frac12: "½",
  frac14: "¼",
  frac34: "¾"
};
const ENTITY_ACTION = Object.freeze({
  /** Resolve and expand the entity normally. */
  ALLOW: "allow",
  /** Silently skip this entity — it will not be registered. */
  BLOCK: "block",
  /** Throw an error, aborting entity registration entirely. */
  THROW: "throw"
});
const SPECIAL_CHARS = new Set("!?\\\\/[]$%{}^&*()<>|+");
function validateEntityName$1(name) {
  if (name[0] === "#") {
    throw new Error(`[EntityReplacer] Invalid character '#' in entity name: "${name}"`);
  }
  for (const ch of name) {
    if (SPECIAL_CHARS.has(ch)) {
      throw new Error(`[EntityReplacer] Invalid character '${ch}' in entity name: "${name}"`);
    }
  }
  return name;
}
function mergeEntityMaps(...maps) {
  const out = /* @__PURE__ */ Object.create(null);
  for (const map of maps) {
    if (!map) continue;
    for (const key of Object.keys(map)) {
      const raw = map[key];
      if (typeof raw === "string") {
        out[key] = raw;
      } else if (raw && typeof raw === "object" && raw.val !== void 0) {
        const val = raw.val;
        if (typeof val === "string") {
          out[key] = val;
        }
      }
    }
  }
  return out;
}
const LIMIT_TIER_EXTERNAL = "external";
const LIMIT_TIER_BASE = "base";
const LIMIT_TIER_ALL = "all";
function parseLimitTiers(raw) {
  if (!raw || raw === LIMIT_TIER_EXTERNAL) return /* @__PURE__ */ new Set([LIMIT_TIER_EXTERNAL]);
  if (raw === LIMIT_TIER_ALL) return /* @__PURE__ */ new Set([LIMIT_TIER_ALL]);
  if (raw === LIMIT_TIER_BASE) return /* @__PURE__ */ new Set([LIMIT_TIER_BASE]);
  if (Array.isArray(raw)) return new Set(raw);
  return /* @__PURE__ */ new Set([LIMIT_TIER_EXTERNAL]);
}
const NCR_LEVEL = Object.freeze({ allow: 0, leave: 1, remove: 2, throw: 3 });
const XML10_ALLOWED_C0 = /* @__PURE__ */ new Set([9, 10, 13]);
function parseNCRConfig(ncr) {
  if (!ncr) {
    return { xmlVersion: 1, onLevel: NCR_LEVEL.allow, nullLevel: NCR_LEVEL.remove };
  }
  const xmlVersion = ncr.xmlVersion === 1.1 ? 1.1 : 1;
  const onLevel = NCR_LEVEL[ncr.onNCR] ?? NCR_LEVEL.allow;
  const nullLevel = NCR_LEVEL[ncr.nullNCR] ?? NCR_LEVEL.remove;
  const clampedNull = Math.max(nullLevel, NCR_LEVEL.remove);
  return { xmlVersion, onLevel, nullLevel: clampedNull };
}
class EntityDecoder {
  /**
   * @param {object} [options]
   * @param {object|null}  [options.namedEntities]        — extra named entities merged into base map
   * @param {object}  [options.limit]                 — security limits
   * @param {number}       [options.limit.maxTotalExpansions=0]  — 0 = unlimited
   * @param {number}       [options.limit.maxExpandedLength=0]   — 0 = unlimited
   * @param {'external'|'base'|'all'|string[]} [options.limit.applyLimitsTo='external']
   *   Which entity tiers count against the security limits:
   *   - 'external' (default) — only input/runtime + persistent external entities
   *   - 'base'               — only DEFAULT_XML_ENTITIES + namedEntities
   *   - 'all'                — every entity regardless of tier
   *   - string[]             — explicit combination, e.g. ['external', 'base']
   * @param {((resolved: string, original: string) => string)|null} [options.postCheck=null]
   * @param {string[]} [options.remove=[]] — entity names (e.g. ['nbsp', '#13']) to delete (replace with empty string)
   * @param {string[]} [options.leave=[]]  — entity names to keep as literal (unchanged in output)
   * @param {object}   [options.ncr]       — Numeric Character Reference controls
   * @param {1.0|1.1}  [options.ncr.xmlVersion=1.0]
   *   XML version governing which codepoint ranges are restricted:
   *   - 1.0 — C0 controls U+0001–U+001F (except U+0009/000A/000D) are prohibited
   *   - 1.1 — C0 controls are allowed when written as NCRs; C1 (U+007F–U+009F) decoded as-is
   * @param {'allow'|'leave'|'remove'|'throw'} [options.ncr.onNCR='allow']
   *   Base action for numeric references. Severity order: allow < leave < remove < throw.
   *   For codepoint ranges that carry a minimum level (surrogates → remove, XML 1.0 C0 → remove),
   *   the effective action is max(onNCR, rangeMinimum).
   * @param {'remove'|'throw'} [options.ncr.nullNCR='remove']
   *   Action for U+0000 (null). 'allow' and 'leave' are clamped to 'remove' since null is never safe.
   * @param {((name: string, value: string) => 'allow'|'block'|'throw')|null} [options.onExternalEntity=null]
   *   Hook called when an external entity is registered via `setExternalEntities()` or
   *   `addExternalEntity()`. Return `ENTITY_ACTION.ALLOW` to accept the entity,
   *   `ENTITY_ACTION.BLOCK` to silently skip it, or `ENTITY_ACTION.THROW` to abort with an error.
   * @param {((name: string, value: string) => 'allow'|'block'|'throw')|null} [options.onInputEntity=null]
   *   Hook called when an input entity is registered via `addInputEntities()`. Return
   *   `ENTITY_ACTION.ALLOW` to accept, `ENTITY_ACTION.BLOCK` to silently skip, or
   *   `ENTITY_ACTION.THROW` to abort with an error.
   */
  constructor(options = {}) {
    this._limit = options.limit || {};
    this._maxTotalExpansions = this._limit.maxTotalExpansions || 0;
    this._maxExpandedLength = this._limit.maxExpandedLength || 0;
    this._postCheck = typeof options.postCheck === "function" ? options.postCheck : (r2) => r2;
    this._limitTiers = parseLimitTiers(this._limit.applyLimitsTo ?? LIMIT_TIER_EXTERNAL);
    this._numericAllowed = options.numericAllowed ?? true;
    this._baseMap = mergeEntityMaps(XML, options.namedEntities || null);
    this._externalMap = /* @__PURE__ */ Object.create(null);
    this._inputMap = /* @__PURE__ */ Object.create(null);
    this._totalExpansions = 0;
    this._expandedLength = 0;
    this._removeSet = new Set(options.remove && Array.isArray(options.remove) ? options.remove : []);
    this._leaveSet = new Set(options.leave && Array.isArray(options.leave) ? options.leave : []);
    const ncrCfg = parseNCRConfig(options.ncr);
    this._ncrXmlVersion = ncrCfg.xmlVersion;
    this._ncrOnLevel = ncrCfg.onLevel;
    this._ncrNullLevel = ncrCfg.nullLevel;
    this._onExternalEntity = typeof options.onExternalEntity === "function" ? options.onExternalEntity : null;
    this._onInputEntity = typeof options.onInputEntity === "function" ? options.onInputEntity : null;
  }
  // -------------------------------------------------------------------------
  // Private: registration hook dispatch
  // -------------------------------------------------------------------------
  /**
   * Invoke a registration hook for a single entity name/value pair.
   * Returns true when the entity should be accepted, false when it should be
   * silently skipped (BLOCK), and throws when the hook returns THROW.
   *
   * @param {((name: string, value: string) => 'allow'|'block'|'throw')|null} hook
   * @param {string} name
   * @param {string} value
   * @param {string} context  — used in error messages ('external' | 'input')
   * @returns {boolean}  true = accept, false = skip
   */
  _applyRegistrationHook(hook, name, value, context) {
    if (!hook) return true;
    const action = hook(name, value);
    if (action === ENTITY_ACTION.BLOCK) return false;
    if (action === ENTITY_ACTION.THROW) {
      throw new Error(
        `[EntityDecoder] Registration of ${context} entity "&${name};" was rejected by hook`
      );
    }
    return true;
  }
  // -------------------------------------------------------------------------
  // Persistent external entity registration
  // -------------------------------------------------------------------------
  /**
   * Replace the full set of persistent external entities.
   * All keys are validated — throws on invalid characters.
   * If `onExternalEntity` is set, it is called once per entry; entries that
   * return `ENTITY_ACTION.BLOCK` are silently omitted, `ENTITY_ACTION.THROW`
   * aborts the whole call.
   * @param {Record<string, string | { regex?: RegExp, val: string }>} map
   */
  setExternalEntities(map) {
    if (map) {
      for (const key of Object.keys(map)) {
        validateEntityName$1(key);
      }
    }
    if (!this._onExternalEntity) {
      this._externalMap = mergeEntityMaps(map);
      return;
    }
    const flat = mergeEntityMaps(map);
    const filtered = /* @__PURE__ */ Object.create(null);
    for (const [name, value] of Object.entries(flat)) {
      if (this._applyRegistrationHook(this._onExternalEntity, name, value, "external")) {
        filtered[name] = value;
      }
    }
    this._externalMap = filtered;
  }
  /**
   * Add a single persistent external entity.
   * If `onExternalEntity` is set it is called before the entity is stored;
   * `ENTITY_ACTION.BLOCK` silently skips storage, `ENTITY_ACTION.THROW` raises.
   * @param {string} key
   * @param {string} value
   */
  addExternalEntity(key, value) {
    validateEntityName$1(key);
    if (typeof value === "string" && value.indexOf("&") === -1) {
      if (this._applyRegistrationHook(this._onExternalEntity, key, value, "external")) {
        this._externalMap[key] = value;
      }
    }
  }
  // -------------------------------------------------------------------------
  // Input / runtime entity registration (per document)
  // -------------------------------------------------------------------------
  /**
   * Inject DOCTYPE entities for the current document.
   * Also resets per-document expansion counters.
   * If `onInputEntity` is set it is called once per entry; entries returning
   * `ENTITY_ACTION.BLOCK` are silently omitted, `ENTITY_ACTION.THROW` aborts.
   * @param {Record<string, string | { regx?: RegExp, regex?: RegExp, val: string }>} map
   */
  addInputEntities(map) {
    this._totalExpansions = 0;
    this._expandedLength = 0;
    if (!this._onInputEntity) {
      this._inputMap = mergeEntityMaps(map);
      return;
    }
    const flat = mergeEntityMaps(map);
    const filtered = /* @__PURE__ */ Object.create(null);
    for (const [name, value] of Object.entries(flat)) {
      if (this._applyRegistrationHook(this._onInputEntity, name, value, "input")) {
        filtered[name] = value;
      }
    }
    this._inputMap = filtered;
  }
  // -------------------------------------------------------------------------
  // Per-document reset
  // -------------------------------------------------------------------------
  /**
   * Wipe input/runtime entities and reset counters.
   * Call this before processing each new document.
   * @returns {this}
   */
  reset() {
    this._inputMap = /* @__PURE__ */ Object.create(null);
    this._totalExpansions = 0;
    this._expandedLength = 0;
    return this;
  }
  // -------------------------------------------------------------------------
  // XML version (can be set after construction, e.g. once parser reads <?xml?>)
  // -------------------------------------------------------------------------
  /**
   * Update the XML version used for NCR classification.
   * Call this as soon as the document's `<?xml version="...">` declaration is parsed.
   * @param {1.0|1.1|number} version
   */
  setXmlVersion(version) {
    this._ncrXmlVersion = version === 1.1 ? 1.1 : 1;
  }
  // -------------------------------------------------------------------------
  // Primary API
  // -------------------------------------------------------------------------
  /**
   * Replace all entity references in `str` in a single pass.
   *
   * @param {string} str
   * @returns {string}
   */
  decode(str) {
    if (typeof str !== "string" || str.length === 0) return str;
    if (str.indexOf("&") === -1) return str;
    const original = str;
    const chunks = [];
    const len = str.length;
    let last = 0;
    let i2 = 0;
    const limitExpansions = this._maxTotalExpansions > 0;
    const limitLength = this._maxExpandedLength > 0;
    const checkLimits = limitExpansions || limitLength;
    while (i2 < len) {
      if (str.charCodeAt(i2) !== 38) {
        i2++;
        continue;
      }
      let j = i2 + 1;
      while (j < len && str.charCodeAt(j) !== 59 && j - i2 <= 32) j++;
      if (j >= len || str.charCodeAt(j) !== 59) {
        i2++;
        continue;
      }
      const token = str.slice(i2 + 1, j);
      if (token.length === 0) {
        i2++;
        continue;
      }
      let replacement;
      let tier;
      if (this._removeSet.has(token)) {
        replacement = "";
        if (tier === void 0) {
          tier = LIMIT_TIER_EXTERNAL;
        }
      } else if (this._leaveSet.has(token)) {
        i2++;
        continue;
      } else if (token.charCodeAt(0) === 35) {
        const ncrResult = this._resolveNCR(token);
        if (ncrResult === void 0) {
          i2++;
          continue;
        }
        replacement = ncrResult;
        tier = LIMIT_TIER_BASE;
      } else {
        const resolved = this._resolveName(token);
        replacement = resolved?.value;
        tier = resolved?.tier;
      }
      if (replacement === void 0) {
        i2++;
        continue;
      }
      if (i2 > last) chunks.push(str.slice(last, i2));
      chunks.push(replacement);
      last = j + 1;
      i2 = last;
      if (checkLimits && this._tierCounts(tier)) {
        if (limitExpansions) {
          this._totalExpansions++;
          if (this._totalExpansions > this._maxTotalExpansions) {
            throw new Error(
              `[EntityReplacer] Entity expansion count limit exceeded: ${this._totalExpansions} > ${this._maxTotalExpansions}`
            );
          }
        }
        if (limitLength) {
          const delta = replacement.length - (token.length + 2);
          if (delta > 0) {
            this._expandedLength += delta;
            if (this._expandedLength > this._maxExpandedLength) {
              throw new Error(
                `[EntityReplacer] Expanded content length limit exceeded: ${this._expandedLength} > ${this._maxExpandedLength}`
              );
            }
          }
        }
      }
    }
    if (last < len) chunks.push(str.slice(last));
    const result = chunks.length === 0 ? str : chunks.join("");
    return this._postCheck(result, original);
  }
  // -------------------------------------------------------------------------
  // Private: limit tier check
  // -------------------------------------------------------------------------
  /**
   * Returns true if a resolved entity of the given tier should count
   * against the expansion/length limits.
   * @param {string} tier  — LIMIT_TIER_EXTERNAL | LIMIT_TIER_BASE
   * @returns {boolean}
   */
  _tierCounts(tier) {
    if (this._limitTiers.has(LIMIT_TIER_ALL)) return true;
    return this._limitTiers.has(tier);
  }
  // -------------------------------------------------------------------------
  // Private: entity resolution
  // -------------------------------------------------------------------------
  /**
   * Resolve a named entity token (without & and ;).
   * Priority: inputMap > externalMap > baseMap
   * Returns the resolved value tagged with its limit tier.
   *
   * @param {string} name
   * @returns {{ value: string, tier: string }|undefined}
   */
  _resolveName(name) {
    if (name in this._inputMap) return { value: this._inputMap[name], tier: LIMIT_TIER_EXTERNAL };
    if (name in this._externalMap) return { value: this._externalMap[name], tier: LIMIT_TIER_EXTERNAL };
    if (name in this._baseMap) return { value: this._baseMap[name], tier: LIMIT_TIER_BASE };
    return void 0;
  }
  /**
   * Classify a codepoint and return the minimum action level that must be applied.
   * Returns -1 when no minimum is imposed (normal allow path).
   *
   * Ranges checked (in priority order):
   *   1. U+0000            — null, governed by nullNCR (always ≥ remove)
   *   2. U+D800–U+DFFF     — surrogates, always prohibited (min: remove)
   *   3. U+0001–U+001F \ {0x09,0x0A,0x0D}  — XML 1.0 restricted C0 (min: remove)
   *      (skipped in XML 1.1 — C0 controls are allowed when written as NCRs)
   *
   * @param {number} cp  — codepoint
   * @returns {number}   — minimum NCR_LEVEL value, or -1 for no restriction
   */
  _classifyNCR(cp) {
    if (cp === 0) return this._ncrNullLevel;
    if (cp >= 55296 && cp <= 57343) return NCR_LEVEL.remove;
    if (this._ncrXmlVersion === 1) {
      if (cp >= 1 && cp <= 31 && !XML10_ALLOWED_C0.has(cp)) return NCR_LEVEL.remove;
    }
    return -1;
  }
  /**
   * Execute a resolved NCR action.
   *
   * @param {number} action   — NCR_LEVEL value
   * @param {string} token    — raw token (e.g. '#38') for error messages
   * @param {number} cp       — codepoint, used only for error messages
   * @returns {string|undefined}
   *   - decoded character string  → 'allow'
   *   - ''                        → 'remove'
   *   - undefined                 → 'leave' (caller must skip past '&' only)
   *   - throws Error              → 'throw'
   */
  _applyNCRAction(action, token, cp) {
    switch (action) {
      case NCR_LEVEL.allow:
        return String.fromCodePoint(cp);
      case NCR_LEVEL.remove:
        return "";
      case NCR_LEVEL.leave:
        return void 0;
      // signal: keep literal
      case NCR_LEVEL.throw:
        throw new Error(
          `[EntityDecoder] Prohibited numeric character reference &${token}; (U+${cp.toString(16).toUpperCase().padStart(4, "0")})`
        );
      default:
        return String.fromCodePoint(cp);
    }
  }
  /**
   * Full NCR resolution pipeline for a numeric token.
   *
   * Steps:
   *   1. Parse the codepoint (decimal or hex).
   *   2. Validate the raw codepoint range (NaN, <0, >0x10FFFF).
   *   3. If numericAllowed is false and no minimum restriction applies → leave as-is.
   *   4. Classify the codepoint to find the minimum required action level.
   *   5. Resolve effective action = max(onNCR, minimum).
   *   6. Apply and return.
   *
   * @param {string} token  — e.g. '#38', '#x26', '#X26'
   * @returns {string|undefined}
   *   - string (incl. '')  — replacement ('' = remove)
   *   - undefined          — leave original &token; as-is
   */
  _resolveNCR(token) {
    const second = token.charCodeAt(1);
    let cp;
    if (second === 120 || second === 88) {
      cp = parseInt(token.slice(2), 16);
    } else {
      cp = parseInt(token.slice(1), 10);
    }
    if (Number.isNaN(cp) || cp < 0 || cp > 1114111) return void 0;
    const minimum = this._classifyNCR(cp);
    if (!this._numericAllowed && minimum < NCR_LEVEL.remove) return void 0;
    const effective = minimum === -1 ? this._ncrOnLevel : Math.max(this._ncrOnLevel, minimum);
    return this._applyNCRAction(effective, token, cp);
  }
}
const defaultOnDangerousProperty = (name) => {
  if (DANGEROUS_PROPERTY_NAMES.includes(name)) {
    return "__" + name;
  }
  return name;
};
const defaultOptions$1 = {
  preserveOrder: false,
  attributeNamePrefix: "@_",
  attributesGroupName: false,
  textNodeName: "#text",
  ignoreAttributes: true,
  removeNSPrefix: false,
  // remove NS from tag name or attribute name if true
  allowBooleanAttributes: false,
  //a tag can have attributes without any value
  //ignoreRootElement : false,
  parseTagValue: true,
  parseAttributeValue: false,
  trimValues: true,
  //Trim string values of tag and attributes
  cdataPropName: false,
  numberParseOptions: {
    hex: true,
    leadingZeros: true,
    eNotation: true,
    unicode: false
  },
  tagValueProcessor: function(tagName, val) {
    return val;
  },
  attributeValueProcessor: function(attrName, val) {
    return val;
  },
  stopNodes: [],
  //nested tags will not be parsed even for errors
  alwaysCreateTextNode: false,
  isArray: () => false,
  commentPropName: false,
  unpairedTags: [],
  processEntities: true,
  htmlEntities: false,
  entityDecoder: null,
  ignoreDeclaration: false,
  ignorePiTags: false,
  transformTagName: false,
  transformAttributeName: false,
  updateTag: function(tagName, jPath, attrs) {
    return tagName;
  },
  // skipEmptyListItem: false
  captureMetaData: false,
  maxNestedTags: 100,
  strictReservedNames: true,
  jPath: true,
  // if true, pass jPath string to callbacks; if false, pass matcher instance
  onDangerousProperty: defaultOnDangerousProperty
};
function validatePropertyName(propertyName, optionName) {
  if (typeof propertyName !== "string") {
    return;
  }
  const normalized = propertyName.toLowerCase();
  if (DANGEROUS_PROPERTY_NAMES.some((dangerous) => normalized === dangerous.toLowerCase())) {
    throw new Error(
      `[SECURITY] Invalid ${optionName}: "${propertyName}" is a reserved JavaScript keyword that could cause prototype pollution`
    );
  }
  if (criticalProperties.some((dangerous) => normalized === dangerous.toLowerCase())) {
    throw new Error(
      `[SECURITY] Invalid ${optionName}: "${propertyName}" is a reserved JavaScript keyword that could cause prototype pollution`
    );
  }
}
function normalizeProcessEntities(value, htmlEntities) {
  if (typeof value === "boolean") {
    return {
      enabled: value,
      // true or false
      maxEntitySize: 1e4,
      maxExpansionDepth: 1e4,
      maxTotalExpansions: Infinity,
      maxExpandedLength: 1e5,
      maxEntityCount: 1e3,
      allowedTags: null,
      tagFilter: null,
      appliesTo: "all"
    };
  }
  if (typeof value === "object" && value !== null) {
    return {
      enabled: value.enabled !== false,
      maxEntitySize: Math.max(1, value.maxEntitySize ?? 1e4),
      maxExpansionDepth: Math.max(1, value.maxExpansionDepth ?? 1e4),
      maxTotalExpansions: Math.max(1, value.maxTotalExpansions ?? Infinity),
      maxExpandedLength: Math.max(1, value.maxExpandedLength ?? 1e5),
      maxEntityCount: Math.max(1, value.maxEntityCount ?? 1e3),
      allowedTags: value.allowedTags ?? null,
      tagFilter: value.tagFilter ?? null,
      appliesTo: value.appliesTo ?? "all"
    };
  }
  return normalizeProcessEntities(true);
}
const buildOptions = function(options) {
  const built = Object.assign({}, defaultOptions$1, options);
  const propertyNameOptions = [
    { value: built.attributeNamePrefix, name: "attributeNamePrefix" },
    { value: built.attributesGroupName, name: "attributesGroupName" },
    { value: built.textNodeName, name: "textNodeName" },
    { value: built.cdataPropName, name: "cdataPropName" },
    { value: built.commentPropName, name: "commentPropName" }
  ];
  for (const { value, name } of propertyNameOptions) {
    if (value) {
      validatePropertyName(value, name);
    }
  }
  if (built.onDangerousProperty === null) {
    built.onDangerousProperty = defaultOnDangerousProperty;
  }
  built.processEntities = normalizeProcessEntities(built.processEntities, built.htmlEntities);
  built.unpairedTagsSet = new Set(built.unpairedTags);
  if (built.stopNodes && Array.isArray(built.stopNodes)) {
    built.stopNodes = built.stopNodes.map((node) => {
      if (typeof node === "string" && node.startsWith("*.")) {
        return ".." + node.substring(2);
      }
      return node;
    });
  }
  return built;
};
let METADATA_SYMBOL$1;
if (typeof Symbol !== "function") {
  METADATA_SYMBOL$1 = "@@xmlMetadata";
} else {
  METADATA_SYMBOL$1 = /* @__PURE__ */ Symbol("XML Node Metadata");
}
class XmlNode {
  constructor(tagname) {
    this.tagname = tagname;
    this.child = [];
    this[":@"] = /* @__PURE__ */ Object.create(null);
  }
  add(key, val) {
    if (key === "__proto__") key = "#__proto__";
    this.child.push({ [key]: val });
  }
  addChild(node, startIndex) {
    if (node.tagname === "__proto__") node.tagname = "#__proto__";
    if (node[":@"] && Object.keys(node[":@"]).length > 0) {
      this.child.push({ [node.tagname]: node.child, [":@"]: node[":@"] });
    } else {
      this.child.push({ [node.tagname]: node.child });
    }
    this.addStartIndex(startIndex);
  }
  addStartIndex(startIndex) {
    if (startIndex !== void 0) {
      this.child[this.child.length - 1][METADATA_SYMBOL$1] = { startIndex };
    }
  }
  addEndIndex(endIndex) {
    const lastChild = this.child[this.child.length - 1];
    if (lastChild !== void 0 && lastChild[METADATA_SYMBOL$1] !== void 0 && lastChild[METADATA_SYMBOL$1].endIndex === void 0) {
      lastChild[METADATA_SYMBOL$1].endIndex = endIndex;
    }
  }
  /** symbol used for metadata */
  static getMetaDataSymbol() {
    return METADATA_SYMBOL$1;
  }
}
const nameStartChar10 = ":A-Za-z_À-ÖØ-öø-˿Ͱ-ͽͿ-҆҈-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�";
const nameChar10 = nameStartChar10 + "\\-\\.\\d·̀-ͯ‿-⁀";
const nameStartChar11 = ":A-Za-z_À-˿Ͱ-ͽͿ-҆҈-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�𐀀-󯿿";
const nameChar11 = nameStartChar11 + "\\-\\.\\d·̀-ͯ҇‿-⁀";
const buildRegexes = (startChar, char, flags = "") => {
  const ncStart = startChar.replace(":", "");
  const ncChar = char.replace(":", "");
  const ncNamePat = `[${ncStart}][${ncChar}]*`;
  return {
    name: new RegExp(`^[${startChar}][${char}]*$`, flags),
    ncName: new RegExp(`^${ncNamePat}$`, flags),
    qName: new RegExp(`^${ncNamePat}(?::${ncNamePat})?$`, flags),
    nmToken: new RegExp(`^[${char}]+$`, flags),
    nmTokens: new RegExp(`^[${char}]+(?:\\s+[${char}]+)*$`, flags)
  };
};
const regexes10 = buildRegexes(nameStartChar10, nameChar10);
const regexes11 = buildRegexes(nameStartChar11, nameChar11, "u");
const nameStartCharAscii = ":A-Za-z_";
const nameCharAscii = nameStartCharAscii + "\\-\\.\\d";
const regexesAscii = buildRegexes(nameStartCharAscii, nameCharAscii);
const getRegexes = (xmlVersion = "1.0", asciiOnly = false) => {
  if (asciiOnly) return regexesAscii;
  return xmlVersion === "1.1" ? regexes11 : regexes10;
};
const qName = (str, { xmlVersion = "1.0", asciiOnly = false } = {}) => getRegexes(xmlVersion, asciiOnly).qName.test(str);
const PRODUCTIONS = ["name", "ncName", "qName", "nmToken", "nmTokens"];
const createValidator = (production, { xmlVersion = "1.0", asciiOnly = false, maxCacheSize = 2048 } = {}) => {
  if (!PRODUCTIONS.includes(production)) {
    throw new TypeError(
      `Unknown production "${production}". Must be one of: ${PRODUCTIONS.join(", ")}`
    );
  }
  const regex = getRegexes(xmlVersion, asciiOnly)[production];
  let cache = /* @__PURE__ */ new Map();
  const validator = (str) => {
    const cached = cache.get(str);
    if (cached !== void 0) return cached;
    const result = regex.test(str);
    if (cache.size < maxCacheSize) cache.set(str, result);
    return result;
  };
  validator.reset = () => {
    cache = /* @__PURE__ */ new Map();
  };
  return validator;
};
class DocTypeReader {
  constructor(options, xmlVersion) {
    this.suppressValidationErr = !options;
    this.options = options;
    this.xmlVersion = xmlVersion || 1;
  }
  setXmlVersion(xmlVersion = 1) {
    this.xmlVersion = xmlVersion;
  }
  readDocType(xmlData, i2) {
    const entities = /* @__PURE__ */ Object.create(null);
    let entityCount = 0;
    if (xmlData[i2 + 3] === "O" && xmlData[i2 + 4] === "C" && xmlData[i2 + 5] === "T" && xmlData[i2 + 6] === "Y" && xmlData[i2 + 7] === "P" && xmlData[i2 + 8] === "E") {
      i2 = i2 + 9;
      let angleBracketsCount = 1;
      let hasBody = false, comment = false;
      let quoteChar = null;
      let exp = "";
      for (; i2 < xmlData.length; i2++) {
        if (quoteChar !== null) {
          if (xmlData[i2] === quoteChar) quoteChar = null;
          exp += xmlData[i2];
          continue;
        }
        if (!hasBody && !comment && (xmlData[i2] === '"' || xmlData[i2] === "'")) {
          quoteChar = xmlData[i2];
          exp += xmlData[i2];
          continue;
        }
        if (xmlData[i2] === "<" && !comment) {
          if (hasBody && hasSeq(xmlData, "!ENTITY", i2)) {
            i2 += 7;
            let entityName, val;
            [entityName, val, i2] = this.readEntityExp(xmlData, i2 + 1, this.suppressValidationErr);
            if (val.indexOf("&") === -1) {
              if (this.options.enabled !== false && this.options.maxEntityCount != null && entityCount >= this.options.maxEntityCount) {
                throw new Error(
                  `Entity count (${entityCount + 1}) exceeds maximum allowed (${this.options.maxEntityCount})`
                );
              }
              entities[entityName] = val;
              entityCount++;
            }
          } else if (hasBody && hasSeq(xmlData, "!ELEMENT", i2)) {
            i2 += 8;
            const { index } = this.readElementExp(xmlData, i2 + 1);
            i2 = index;
          } else if (hasBody && hasSeq(xmlData, "!ATTLIST", i2)) {
            i2 += 8;
          } else if (hasBody && hasSeq(xmlData, "!NOTATION", i2)) {
            i2 += 9;
            const { index } = this.readNotationExp(xmlData, i2 + 1, this.suppressValidationErr);
            i2 = index;
          } else if (hasSeq(xmlData, "!--", i2)) comment = true;
          else throw new Error(`Invalid DOCTYPE`);
          angleBracketsCount++;
          exp = "";
        } else if (xmlData[i2] === ">") {
          if (comment) {
            if (xmlData[i2 - 1] === "-" && xmlData[i2 - 2] === "-") {
              comment = false;
              angleBracketsCount--;
            }
          } else {
            angleBracketsCount--;
          }
          if (angleBracketsCount === 0) {
            break;
          }
        } else if (xmlData[i2] === "[") {
          hasBody = true;
        } else {
          exp += xmlData[i2];
        }
      }
      if (quoteChar !== null || angleBracketsCount !== 0) {
        throw new Error(`Unclosed DOCTYPE`);
      }
    } else {
      throw new Error(`Invalid Tag instead of DOCTYPE`);
    }
    return { entities, i: i2 };
  }
  readEntityExp(xmlData, i2) {
    i2 = skipWhitespace(xmlData, i2);
    const startIndex = i2;
    while (i2 < xmlData.length && !/\s/.test(xmlData[i2]) && xmlData[i2] !== '"' && xmlData[i2] !== "'") {
      i2++;
    }
    let entityName = xmlData.substring(startIndex, i2);
    validateEntityName(entityName, { xmlVersion: this.xmlVersion });
    i2 = skipWhitespace(xmlData, i2);
    if (!this.suppressValidationErr) {
      if (xmlData.substring(i2, i2 + 6).toUpperCase() === "SYSTEM") {
        throw new Error("External entities are not supported");
      } else if (xmlData[i2] === "%") {
        throw new Error("Parameter entities are not supported");
      }
    }
    let entityValue = "";
    [i2, entityValue] = this.readIdentifierVal(xmlData, i2, "entity");
    if (this.options.enabled !== false && this.options.maxEntitySize != null && entityValue.length > this.options.maxEntitySize) {
      throw new Error(
        `Entity "${entityName}" size (${entityValue.length}) exceeds maximum allowed size (${this.options.maxEntitySize})`
      );
    }
    i2--;
    return [entityName, entityValue, i2];
  }
  readNotationExp(xmlData, i2) {
    i2 = skipWhitespace(xmlData, i2);
    const startIndex = i2;
    while (i2 < xmlData.length && !/\s/.test(xmlData[i2])) {
      i2++;
    }
    let notationName = xmlData.substring(startIndex, i2);
    !this.suppressValidationErr && validateEntityName(notationName, { xmlVersion: this.xmlVersion });
    i2 = skipWhitespace(xmlData, i2);
    const identifierType = xmlData.substring(i2, i2 + 6).toUpperCase();
    if (!this.suppressValidationErr && identifierType !== "SYSTEM" && identifierType !== "PUBLIC") {
      throw new Error(`Expected SYSTEM or PUBLIC, found "${identifierType}"`);
    }
    i2 += identifierType.length;
    i2 = skipWhitespace(xmlData, i2);
    let publicIdentifier = null;
    let systemIdentifier = null;
    if (identifierType === "PUBLIC") {
      [i2, publicIdentifier] = this.readIdentifierVal(xmlData, i2, "publicIdentifier");
      i2 = skipWhitespace(xmlData, i2);
      if (xmlData[i2] === '"' || xmlData[i2] === "'") {
        [i2, systemIdentifier] = this.readIdentifierVal(xmlData, i2, "systemIdentifier");
      }
    } else if (identifierType === "SYSTEM") {
      [i2, systemIdentifier] = this.readIdentifierVal(xmlData, i2, "systemIdentifier");
      if (!this.suppressValidationErr && !systemIdentifier) {
        throw new Error("Missing mandatory system identifier for SYSTEM notation");
      }
    }
    return { notationName, publicIdentifier, systemIdentifier, index: --i2 };
  }
  readIdentifierVal(xmlData, i2, type) {
    let identifierVal = "";
    const startChar = xmlData[i2];
    if (startChar !== '"' && startChar !== "'") {
      throw new Error(`Expected quoted string, found "${startChar}"`);
    }
    i2++;
    const startIndex = i2;
    while (i2 < xmlData.length && xmlData[i2] !== startChar) {
      i2++;
    }
    identifierVal = xmlData.substring(startIndex, i2);
    if (xmlData[i2] !== startChar) {
      throw new Error(`Unterminated ${type} value`);
    }
    i2++;
    return [i2, identifierVal];
  }
  readElementExp(xmlData, i2) {
    i2 = skipWhitespace(xmlData, i2);
    const startIndex = i2;
    while (i2 < xmlData.length && !/\s/.test(xmlData[i2])) {
      i2++;
    }
    let elementName = xmlData.substring(startIndex, i2);
    if (!this.suppressValidationErr && !qName(elementName, { xmlVersion: this.xmlVersion })) {
      throw new Error(`Invalid element name: "${elementName}"`);
    }
    i2 = skipWhitespace(xmlData, i2);
    let contentModel = "";
    if (xmlData[i2] === "E" && hasSeq(xmlData, "MPTY", i2)) i2 += 4;
    else if (xmlData[i2] === "A" && hasSeq(xmlData, "NY", i2)) i2 += 2;
    else if (xmlData[i2] === "(") {
      i2++;
      const startIndex2 = i2;
      while (i2 < xmlData.length && xmlData[i2] !== ")") {
        i2++;
      }
      contentModel = xmlData.substring(startIndex2, i2);
      if (xmlData[i2] !== ")") {
        throw new Error("Unterminated content model");
      }
    } else if (!this.suppressValidationErr) {
      throw new Error(`Invalid Element Expression, found "${xmlData[i2]}"`);
    }
    return {
      elementName,
      contentModel: contentModel.trim(),
      index: i2
    };
  }
  readAttlistExp(xmlData, i2) {
    i2 = skipWhitespace(xmlData, i2);
    let startIndex = i2;
    while (i2 < xmlData.length && !/\s/.test(xmlData[i2])) {
      i2++;
    }
    let elementName = xmlData.substring(startIndex, i2);
    validateEntityName(elementName, { xmlVersion: this.xmlVersion });
    i2 = skipWhitespace(xmlData, i2);
    startIndex = i2;
    while (i2 < xmlData.length && !/\s/.test(xmlData[i2])) {
      i2++;
    }
    let attributeName = xmlData.substring(startIndex, i2);
    if (!validateEntityName(attributeName, { xmlVersion: this.xmlVersion })) {
      throw new Error(`Invalid attribute name: "${attributeName}"`);
    }
    i2 = skipWhitespace(xmlData, i2);
    let attributeType = "";
    if (xmlData.substring(i2, i2 + 8).toUpperCase() === "NOTATION") {
      attributeType = "NOTATION";
      i2 += 8;
      i2 = skipWhitespace(xmlData, i2);
      if (xmlData[i2] !== "(") {
        throw new Error(`Expected '(', found "${xmlData[i2]}"`);
      }
      i2++;
      let allowedNotations = [];
      while (i2 < xmlData.length && xmlData[i2] !== ")") {
        const startIndex2 = i2;
        while (i2 < xmlData.length && xmlData[i2] !== "|" && xmlData[i2] !== ")") {
          i2++;
        }
        let notation = xmlData.substring(startIndex2, i2);
        notation = notation.trim();
        if (!validateEntityName(notation, { xmlVersion: this.xmlVersion })) {
          throw new Error(`Invalid notation name: "${notation}"`);
        }
        allowedNotations.push(notation);
        if (xmlData[i2] === "|") {
          i2++;
          i2 = skipWhitespace(xmlData, i2);
        }
      }
      if (xmlData[i2] !== ")") {
        throw new Error("Unterminated list of notations");
      }
      i2++;
      attributeType += " (" + allowedNotations.join("|") + ")";
    } else {
      const startIndex2 = i2;
      while (i2 < xmlData.length && !/\s/.test(xmlData[i2])) {
        i2++;
      }
      attributeType += xmlData.substring(startIndex2, i2);
      const validTypes = ["CDATA", "ID", "IDREF", "IDREFS", "ENTITY", "ENTITIES", "NMTOKEN", "NMTOKENS"];
      if (!this.suppressValidationErr && !validTypes.includes(attributeType.toUpperCase())) {
        throw new Error(`Invalid attribute type: "${attributeType}"`);
      }
    }
    i2 = skipWhitespace(xmlData, i2);
    let defaultValue = "";
    if (xmlData.substring(i2, i2 + 8).toUpperCase() === "#REQUIRED") {
      defaultValue = "#REQUIRED";
      i2 += 8;
    } else if (xmlData.substring(i2, i2 + 7).toUpperCase() === "#IMPLIED") {
      defaultValue = "#IMPLIED";
      i2 += 7;
    } else {
      [i2, defaultValue] = this.readIdentifierVal(xmlData, i2, "ATTLIST");
    }
    return {
      elementName,
      attributeName,
      attributeType,
      defaultValue,
      index: i2
    };
  }
}
const skipWhitespace = (data, index) => {
  while (index < data.length && /\s/.test(data[index])) {
    index++;
  }
  return index;
};
function hasSeq(data, seq, i2) {
  for (let j = 0; j < seq.length; j++) {
    if (seq[j] !== data[i2 + j + 1]) return false;
  }
  return true;
}
function validateEntityName(name, xmlVersion) {
  if (qName(name, { xmlVersion }))
    return name;
  else
    throw new Error(`Invalid entity name ${name}`);
}
const SCRIPT_ZEROS = [
  // Basic Latin (ASCII) — included for completeness / pass-through
  48,
  // 0-9
  // Arabic scripts
  1632,
  // Arabic-Indic ٠١٢٣٤٥٦٧٨٩
  1776,
  // Extended Arabic-Indic (Urdu/Persian/Sindhi) ۰۱۲۳
  // Indic scripts
  2406,
  // Devanagari ०१२३४५६७८९
  2534,
  // Bengali ০১২৩৪৫৬৭৮৯
  2662,
  // Gurmukhi ੦੧੨੩੪੫੬੭੮੯
  2790,
  // Gujarati ૦૧૨૩૪૫૬૭૮૯
  2918,
  // Odia ୦୧୨୩୪୫୬୭୮୯
  3046,
  // Tamil ௦௧௨௩௪௫௬௭௮௯
  3174,
  // Telugu ౦౧౨౩౪౫౬౭౮౯
  3302,
  // Kannada ೦೧೨೩೪೫೬೭೮೯
  3430,
  // Malayalam ൦൧൨൩൪൫൬൭൮൯
  3558,
  // Sinhala Archaic ෦෧෨෩෪෫෬෭෮෯
  // Southeast Asian scripts
  3664,
  // Thai ๐๑๒๓๔๕๖๗๘๙
  3792,
  // Lao ໐໑໒໓໔໕໖໗໘໙
  3872,
  // Tibetan ༠༡༢༣༤༥༦༧༨༩
  4160,
  // Myanmar ၀၁၂၃၄၅၆၇၈၉
  4240,
  // Myanmar Shan ႐႑႒႓႔႕႖႗႘႙
  6112,
  // Khmer ០១២៣៤៥៦៧៨៩
  6160,
  // Mongolian ᠐᠑᠒᠓᠔᠕᠖᠗᠘᠙
  6470,
  // Limbu ᥆᥇᥈᥉᥊᥋᥌᥍᥎᥏
  6608,
  // New Tai Lue ᧐᧑᧒᧓᧔᧕᧖᧗᧘᧙
  6784,
  // Tai Tham Hora ᪀᪁᪂᪃᪄᪅᪆᪇᪈᪉
  6800,
  // Tai Tham Tham ᪐᪑᪒᪓᪔᪕᪖᪗᪘᪙
  6992,
  // Balinese ᭐᭑᭒᭓᭔᭕᭖᭗᭘᭙
  7088,
  // Sundanese ᮰᮱᮲᮳᮴᮵᮶᮷᮸᮹
  7232,
  // Lepcha ᱀᱁᱂᱃᱄᱅᱆᱇᱈᱉
  7248,
  // Ol Chiki ᱐᱑᱒᱓᱔᱕᱖᱗᱘᱙
  // Fullwidth (CJK context)
  65296,
  // Fullwidth ０１２３４５６７８９
  // Mathematical digit variants (Unicode math block)
  120782,
  // Mathematical Bold
  120792,
  // Mathematical Double-Struck
  120802,
  // Mathematical Sans-Serif
  120812,
  // Mathematical Sans-Serif Bold
  120822,
  // Mathematical Monospace
  // Other scripts
  66720,
  // Osmanya 𐒠𐒡𐒢𐒣𐒤𐒥𐒦𐒧𐒨𐒩
  68912,
  // Hanifi Rohingya 𐴰𐴱𐴲𐴳𐴴𐴵𐴶𐴷𐴸𐴹
  69734,
  // Brahmi 𑁦𑁧𑁨𑁩𑁪𑁫𑁬𑁭𑁮𑁯
  69872,
  // Sora Sompeng 𑃰𑃱𑃲𑃳𑃴𑃵𑃶𑃷𑃸𑃹
  69942,
  // Chakma 𑄶𑄷𑄸𑄹𑄺𑄻𑄼𑄽𑄾𑄿
  70096,
  // Sharada 𑇐𑇑𑇒𑇓𑇔𑇕𑇖𑇗𑇘𑇙
  70384,
  // Khudawadi 𑋰𑋱𑋲𑋳𑋴𑋵𑋶𑋷𑋸𑋹
  70736,
  // Newa 𑑐𑑑𑑒𑑓𑑔𑑕𑑖𑑗𑑘𑑙
  70864,
  // Tirhuta 𑓐𑓑𑓒𑓓𑓔𑓕𑓖𑓗𑓘𑓙
  71248,
  // Modi 𑙐𑙑𑙒𑙓𑙔𑙕𑙖𑙗𑙘𑙙
  71360,
  // Takri 𑛀𑛁𑛂𑛃𑛄𑛅𑛆𑛇𑛈𑛉
  71472,
  // Ahom 𑜰𑜱𑜲𑜳𑜴𑜵𑜶𑜷𑜸𑜹
  71904,
  // Warang Citi 𑣠𑣡𑣢𑣣𑣤𑣥𑣦𑣧𑣨𑣩
  72016,
  // Dives Akuru 𑥐𑥑𑥒𑥓𑥔𑥕𑥖𑥗𑥘𑥙
  72688,
  // Khitan Small Script 𑯰𑯱𑯲𑯳𑯴𑯵𑯶𑯷𑯸𑯹
  72784,
  // Bhaiksuki 𑱐𑱑𑱒𑱓𑱔𑱕𑱖𑱗𑱘𑱙
  73040,
  // Masaram Gondi 𑵐𑵑𑵒𑵓𑵔𑵕𑵖𑵗𑵘𑵙
  73120,
  // Gunjala Gondi 𑶠𑶡𑶢𑶣𑶤𑶥𑶦𑶧𑶨𑶩
  73552,
  // Kawi 𑽐𑽑𑽒𑽓𑽔𑽕𑽖𑽗𑽘𑽙
  92768,
  // Mro 𖩠𖩡𖩢𖩣𖩤𖩥𖩦𖩧𖩨𖩩
  92864,
  // Tangsa 𖫀𖫁𖫂𖫃𖫄𖫅𖫆𖫇𖫈𖫉
  93008,
  // Pahawh Hmong 𖭐𖭑𖭒𖭓𖭔𖭕𖭖𖭗𖭘𖭙
  123200,
  // Nyiakeng Puachue Hmong 𞅀𞅁𞅂𞅃𞅄𞅅𞅆𞅇𞅈𞅉
  123632,
  // Wancho 𞋰𞋱𞋲𞋳𞋴𞋵𞋶𞋷𞋸𞋹
  124144,
  // Nag Mundari 𞓰𞓱𞓲𞓳𞓴𞓵𞓶𞓷𞓸𞓹
  125264,
  // Adlam 𞥐𞥑𞥒𞥓𞥔𞥕𞥖𞥗𞥘𞥙
  130032
  // Segmented digit symbols 🯰🯱🯲🯳🯴🯵🯶🯷🯸🯹
];
const NOT_DIGIT = 255;
const HIGH_MAP = /* @__PURE__ */ new Map();
const LOW_MAX = 65535;
const LOW_MIN = 1632;
const TABLE_OFFSET = LOW_MIN;
const TABLE_SIZE = LOW_MAX - LOW_MIN + 1;
const TABLE = new Uint8Array(TABLE_SIZE).fill(NOT_DIGIT);
for (const zero of SCRIPT_ZEROS) {
  for (let d = 0; d < 10; d++) {
    const cp = zero + d;
    if (cp <= LOW_MAX) {
      TABLE[cp - TABLE_OFFSET] = d;
    } else {
      HIGH_MAP.set(cp, d);
    }
  }
}
const CHAR_0 = 48;
const CHAR_9 = 57;
const CHAR_MINUS = 45;
const MINUS_SET = /* @__PURE__ */ new Set([8722, 65293, 65123]);
function anynum(str) {
  if (typeof str !== "string") return str;
  const len = str.length;
  if (len === 0) return str;
  let firstHit = -1;
  for (let i2 = 0; i2 < len; i2++) {
    const cc = str.charCodeAt(i2);
    if (cc >= CHAR_0 && cc <= CHAR_9 || cc === CHAR_MINUS) continue;
    if (cc < TABLE_OFFSET) {
      if (MINUS_SET.has(cc)) {
        firstHit = i2;
        break;
      }
      continue;
    }
    if (cc >= 55296 && cc <= 56319) {
      if (i2 + 1 < len) {
        const low = str.charCodeAt(i2 + 1);
        if (low >= 56320 && low <= 57343) {
          const cp = 65536 + (cc - 55296 << 10) + (low - 56320);
          if (HIGH_MAP.has(cp)) {
            firstHit = i2;
            break;
          }
        }
      }
      continue;
    }
    if (TABLE[cc - TABLE_OFFSET] !== NOT_DIGIT || MINUS_SET.has(cc)) {
      firstHit = i2;
      break;
    }
  }
  if (firstHit === -1) return str;
  const chars = [];
  if (firstHit > 0) chars.push(str.slice(0, firstHit));
  for (let i2 = firstHit; i2 < len; i2++) {
    const cc = str.charCodeAt(i2);
    if (cc >= CHAR_0 && cc <= CHAR_9 || cc === CHAR_MINUS) {
      chars.push(str[i2]);
      continue;
    }
    if (cc < TABLE_OFFSET) {
      chars.push(MINUS_SET.has(cc) ? "-" : str[i2]);
      continue;
    }
    if (cc >= 55296 && cc <= 56319) {
      if (i2 + 1 < len) {
        const low = str.charCodeAt(i2 + 1);
        if (low >= 56320 && low <= 57343) {
          const cp = 65536 + (cc - 55296 << 10) + (low - 56320);
          const d2 = HIGH_MAP.get(cp);
          if (d2 !== void 0) {
            chars.push(String.fromCharCode(d2 + 48));
            i2++;
            continue;
          }
        }
      }
      chars.push(str[i2]);
      continue;
    }
    if (MINUS_SET.has(cc)) {
      chars.push("-");
      continue;
    }
    const d = TABLE[cc - TABLE_OFFSET];
    chars.push(d !== NOT_DIGIT ? String.fromCharCode(d + 48) : str[i2]);
  }
  return chars.join("");
}
const hexRegex = /^[-+]?0x[a-fA-F0-9]+$/;
const binRegex = /^0b[01]+$/;
const octRegex = /^0o[0-7]+$/;
const numRegex = /^([\-\+])?(0*)([0-9]*(\.[0-9]*)?)$/;
const consider = {
  hex: true,
  binary: false,
  octal: false,
  leadingZeros: true,
  decimalPoint: ".",
  eNotation: true,
  //skipLike: /regex/,
  infinity: "original",
  // "null", "infinity" (Infinity type), "string" ("Infinity" (the string literal))
  unicode: false
};
function toNumber(str, options = {}) {
  options = Object.assign({}, consider, options);
  if (!str || typeof str !== "string") return str;
  let trimmedStr = str.trim();
  if (trimmedStr.length === 0) return str;
  else if (options.skipLike !== void 0 && options.skipLike.test(trimmedStr)) return str;
  else if (trimmedStr === "0") return 0;
  if (options.unicode) {
    trimmedStr = anynum(trimmedStr);
    if (trimmedStr === "0") return 0;
  }
  if (options.hex && hexRegex.test(trimmedStr)) {
    return parse_int(trimmedStr, 16);
  } else if (options.binary && binRegex.test(trimmedStr)) {
    return parse_int(trimmedStr, 2);
  } else if (options.octal && octRegex.test(trimmedStr)) {
    return parse_int(trimmedStr, 8);
  } else if (!isFinite(trimmedStr)) {
    return handleInfinity(str, Number(trimmedStr), options);
  } else if (trimmedStr.includes("e") || trimmedStr.includes("E")) {
    return resolveEnotation(str, trimmedStr, options);
  } else {
    const match2 = numRegex.exec(trimmedStr);
    if (match2) {
      const sign = match2[1] || "";
      const leadingZeros = match2[2];
      let numTrimmedByZeros = trimZeros(match2[3]);
      const decimalAdjacentToLeadingZeros = sign ? (
        // 0., -00., 000.
        str[leadingZeros.length + 1] === "."
      ) : str[leadingZeros.length] === ".";
      if (!options.leadingZeros && (leadingZeros.length > 1 || leadingZeros.length === 1 && !decimalAdjacentToLeadingZeros)) {
        return str;
      } else {
        const num = Number(trimmedStr);
        const parsedStr = String(num);
        if (num === 0) return num;
        if (parsedStr.search(/[eE]/) !== -1) {
          if (options.eNotation) return num;
          else return str;
        } else if (trimmedStr.indexOf(".") !== -1) {
          if (parsedStr === "0") return num;
          else if (parsedStr === numTrimmedByZeros) return num;
          else if (parsedStr === `${sign}${numTrimmedByZeros}`) return num;
          else return str;
        }
        let n = leadingZeros ? numTrimmedByZeros : trimmedStr;
        if (leadingZeros) {
          return n === parsedStr || sign + n === parsedStr ? num : str;
        } else {
          return n === parsedStr || n === sign + parsedStr ? num : str;
        }
      }
    } else {
      return str;
    }
  }
}
const eNotationRegx = /^([-+])?(0*)(\d*(\.\d*)?[eE][-\+]?\d+)$/;
function resolveEnotation(str, trimmedStr, options) {
  if (!options.eNotation) return str;
  const notation = trimmedStr.match(eNotationRegx);
  if (notation) {
    let sign = notation[1] || "";
    const eChar = notation[3].indexOf("e") === -1 ? "E" : "e";
    const leadingZeros = notation[2];
    const eAdjacentToLeadingZeros = sign ? (
      // 0E.
      str[leadingZeros.length + 1] === eChar
    ) : str[leadingZeros.length] === eChar;
    if (leadingZeros.length > 1 && eAdjacentToLeadingZeros) return str;
    else if (leadingZeros.length === 1 && (notation[3].startsWith(`.${eChar}`) || notation[3][0] === eChar)) {
      return Number(trimmedStr);
    } else if (leadingZeros.length > 0) {
      if (options.leadingZeros && !eAdjacentToLeadingZeros) {
        trimmedStr = (notation[1] || "") + notation[3];
        return Number(trimmedStr);
      } else return str;
    } else {
      return Number(trimmedStr);
    }
  } else {
    return str;
  }
}
function trimZeros(numStr) {
  if (numStr && numStr.indexOf(".") !== -1) {
    let end = numStr.length;
    while (end > 0 && numStr.charCodeAt(end - 1) === 48) end--;
    numStr = numStr.slice(0, end);
    if (numStr === ".") numStr = "0";
    else if (numStr[0] === ".") numStr = "0" + numStr;
    else if (numStr[numStr.length - 1] === ".") numStr = numStr.substring(0, numStr.length - 1);
    return numStr;
  }
  return numStr;
}
function parse_int(numStr, base) {
  const str = numStr.trim();
  if (base === 2 || base === 8) numStr = str.substring(2);
  if (parseInt) return parseInt(numStr, base);
  else if (Number.parseInt) return Number.parseInt(numStr, base);
  else if (window && window.parseInt) return window.parseInt(numStr, base);
  else throw new Error("parseInt, Number.parseInt, window.parseInt are not supported");
}
function handleInfinity(str, num, options) {
  const isPositive = num === Infinity;
  switch (options.infinity.toLowerCase()) {
    case "null":
      return null;
    case "infinity":
      return num;
    // Return Infinity or -Infinity
    case "string":
      return isPositive ? "Infinity" : "-Infinity";
    case "original":
    default:
      return str;
  }
}
function getIgnoreAttributesFn$1(ignoreAttributes) {
  if (typeof ignoreAttributes === "function") {
    return ignoreAttributes;
  }
  if (Array.isArray(ignoreAttributes)) {
    return (attrName) => {
      for (const pattern of ignoreAttributes) {
        if (typeof pattern === "string" && attrName === pattern) {
          return true;
        }
        if (pattern instanceof RegExp && pattern.test(attrName)) {
          return true;
        }
      }
    };
  }
  return () => false;
}
class Expression {
  /**
   * Create a new Expression
   * @param {string} pattern - Pattern string (e.g., "root.users.user", "..user[id]")
   * @param {Object} options - Configuration options
   * @param {string} options.separator - Path separator (default: '.')
   */
  constructor(pattern, options = {}, data) {
    this.pattern = pattern;
    this.separator = options.separator || ".";
    this.segments = this._parse(pattern);
    this.data = data;
    this._hasDeepWildcard = this.segments.some((seg) => seg.type === "deep-wildcard");
    this._hasAttributeCondition = this.segments.some((seg) => seg.attrName !== void 0);
    this._hasPositionSelector = this.segments.some((seg) => seg.position !== void 0);
  }
  /**
   * Parse pattern string into segments
   * @private
   * @param {string} pattern - Pattern to parse
   * @returns {Array} Array of segment objects
   */
  _parse(pattern) {
    const segments = [];
    let i2 = 0;
    let currentPart = "";
    while (i2 < pattern.length) {
      if (pattern[i2] === this.separator) {
        if (i2 + 1 < pattern.length && pattern[i2 + 1] === this.separator) {
          if (currentPart.trim()) {
            segments.push(this._parseSegment(currentPart.trim()));
            currentPart = "";
          }
          segments.push({ type: "deep-wildcard" });
          i2 += 2;
        } else {
          if (currentPart.trim()) {
            segments.push(this._parseSegment(currentPart.trim()));
          }
          currentPart = "";
          i2++;
        }
      } else {
        currentPart += pattern[i2];
        i2++;
      }
    }
    if (currentPart.trim()) {
      segments.push(this._parseSegment(currentPart.trim()));
    }
    return segments;
  }
  /**
   * Parse a single segment
   * @private
   * @param {string} part - Segment string (e.g., "user", "ns::user", "user[id]", "ns::user:first")
   * @returns {Object} Segment object
   */
  _parseSegment(part) {
    const segment = { type: "tag" };
    let bracketContent = null;
    let withoutBrackets = part;
    const bracketMatch = part.match(/^([^\[]+)(\[[^\]]*\])(.*)$/);
    if (bracketMatch) {
      withoutBrackets = bracketMatch[1] + bracketMatch[3];
      if (bracketMatch[2]) {
        const content = bracketMatch[2].slice(1, -1);
        if (content) {
          bracketContent = content;
        }
      }
    }
    let namespace2 = void 0;
    let tagAndPosition = withoutBrackets;
    if (withoutBrackets.includes("::")) {
      const nsIndex = withoutBrackets.indexOf("::");
      namespace2 = withoutBrackets.substring(0, nsIndex).trim();
      tagAndPosition = withoutBrackets.substring(nsIndex + 2).trim();
      if (!namespace2) {
        throw new Error(`Invalid namespace in pattern: ${part}`);
      }
    }
    let tag = void 0;
    let positionMatch = null;
    if (tagAndPosition.includes(":")) {
      const colonIndex = tagAndPosition.lastIndexOf(":");
      const tagPart = tagAndPosition.substring(0, colonIndex).trim();
      const posPart = tagAndPosition.substring(colonIndex + 1).trim();
      const isPositionKeyword = ["first", "last", "odd", "even"].includes(posPart) || /^nth\(\d+\)$/.test(posPart);
      if (isPositionKeyword) {
        tag = tagPart;
        positionMatch = posPart;
      } else {
        tag = tagAndPosition;
      }
    } else {
      tag = tagAndPosition;
    }
    if (!tag) {
      throw new Error(`Invalid segment pattern: ${part}`);
    }
    segment.tag = tag;
    if (namespace2) {
      segment.namespace = namespace2;
    }
    if (bracketContent) {
      if (bracketContent.includes("=")) {
        const eqIndex = bracketContent.indexOf("=");
        segment.attrName = bracketContent.substring(0, eqIndex).trim();
        segment.attrValue = bracketContent.substring(eqIndex + 1).trim();
      } else {
        segment.attrName = bracketContent.trim();
      }
    }
    if (positionMatch) {
      const nthMatch = positionMatch.match(/^nth\((\d+)\)$/);
      if (nthMatch) {
        segment.position = "nth";
        segment.positionValue = parseInt(nthMatch[1], 10);
      } else {
        segment.position = positionMatch;
      }
    }
    return segment;
  }
  /**
   * Get the number of segments
   * @returns {number}
   */
  get length() {
    return this.segments.length;
  }
  /**
   * Check if expression contains deep wildcard
   * @returns {boolean}
   */
  hasDeepWildcard() {
    return this._hasDeepWildcard;
  }
  /**
   * Check if expression has attribute conditions
   * @returns {boolean}
   */
  hasAttributeCondition() {
    return this._hasAttributeCondition;
  }
  /**
   * Check if expression has position selectors
   * @returns {boolean}
   */
  hasPositionSelector() {
    return this._hasPositionSelector;
  }
  /**
   * Get string representation
   * @returns {string}
   */
  toString() {
    return this.pattern;
  }
}
class ExpressionSet {
  constructor() {
    this._byDepthAndTag = /* @__PURE__ */ new Map();
    this._wildcardByDepth = /* @__PURE__ */ new Map();
    this._deepWildcards = [];
    this._deepByTerminalTag = /* @__PURE__ */ new Map();
    this._patterns = /* @__PURE__ */ new Set();
    this._sealed = false;
  }
  /**
   * Add an Expression to the set.
   * Duplicate patterns (same pattern string) are silently ignored.
   *
   * @param {import('./Expression.js').default} expression - A pre-constructed Expression instance
   * @returns {this} for chaining
   * @throws {TypeError} if called after seal()
   *
   * @example
   * set.add(new Expression('root.users.user'));
   * set.add(new Expression('..script'));
   */
  add(expression) {
    if (this._sealed) {
      throw new TypeError(
        "ExpressionSet is sealed. Create a new ExpressionSet to add more expressions."
      );
    }
    if (this._patterns.has(expression.pattern)) return this;
    this._patterns.add(expression.pattern);
    if (expression.hasDeepWildcard()) {
      const lastSeg2 = expression.segments[expression.segments.length - 1];
      if (lastSeg2 && lastSeg2.type !== "deep-wildcard" && lastSeg2.tag !== "*") {
        const tag2 = lastSeg2.tag;
        if (!this._deepByTerminalTag.has(tag2)) this._deepByTerminalTag.set(tag2, []);
        this._deepByTerminalTag.get(tag2).push(expression);
      } else {
        this._deepWildcards.push(expression);
      }
      return this;
    }
    const depth = expression.length;
    const lastSeg = expression.segments[expression.segments.length - 1];
    const tag = lastSeg?.tag;
    if (!tag || tag === "*") {
      if (!this._wildcardByDepth.has(depth)) this._wildcardByDepth.set(depth, []);
      this._wildcardByDepth.get(depth).push(expression);
    } else {
      const key = `${depth}:${tag}`;
      if (!this._byDepthAndTag.has(key)) this._byDepthAndTag.set(key, []);
      this._byDepthAndTag.get(key).push(expression);
    }
    return this;
  }
  /**
   * Add multiple expressions at once.
   *
   * @param {import('./Expression.js').default[]} expressions - Array of Expression instances
   * @returns {this} for chaining
   *
   * @example
   * set.addAll([
   *   new Expression('root.users.user'),
   *   new Expression('root.config.setting'),
   * ]);
   */
  addAll(expressions) {
    for (const expr of expressions) this.add(expr);
    return this;
  }
  /**
   * Check whether a pattern string is already present in the set.
   *
   * @param {import('./Expression.js').default} expression
   * @returns {boolean}
   */
  has(expression) {
    return this._patterns.has(expression.pattern);
  }
  /**
   * Number of expressions in the set.
   * @type {number}
   */
  get size() {
    return this._patterns.size;
  }
  /**
   * Seal the set against further modifications.
   * Useful to prevent accidental mutations after config is built.
   * Calling add() or addAll() on a sealed set throws a TypeError.
   *
   * @returns {this}
   */
  seal() {
    this._sealed = true;
    return this;
  }
  /**
   * Whether the set has been sealed.
   * @type {boolean}
   */
  get isSealed() {
    return this._sealed;
  }
  /**
   * Test whether the matcher's current path matches any expression in the set.
   *
   * Evaluation order (cheapest → most expensive):
   *  1. Exact depth + tag bucket  — O(1) lookup, typically 0–2 expressions
   *  2. Depth-only wildcard bucket — O(1) lookup, rare
   *  3. Deep-wildcard list         — always checked, but usually small
   *
   * @param {import('./Matcher.js').default} matcher - Matcher instance (or readOnly view)
   * @returns {boolean} true if any expression matches the current path
   *
   * @example
   * if (stopNodes.matchesAny(matcher)) {
   *   // handle stop node
   * }
   */
  matchesAny(matcher) {
    return this.findMatch(matcher) !== null;
  }
  /**
  * Find and return the first Expression that matches the matcher's current path.
  *
  * Uses the same evaluation order as matchesAny (cheapest → most expensive):
  *  1. Exact depth + tag bucket
  *  2. Depth-only wildcard bucket
  *  3. Deep-wildcard list
  *
  * @param {import('./Matcher.js').default} matcher - Matcher instance (or readOnly view)
  * @returns {import('./Expression.js').default | null} the first matching Expression, or null
  *
  * @example
  * const expr = stopNodes.findMatch(matcher);
  * if (expr) {
  *   // access expr.config, expr.pattern, etc.
  * }
  */
  findMatch(matcher) {
    const depth = matcher.getDepth();
    const tag = matcher.getCurrentTag();
    const exactKey = `${depth}:${tag}`;
    const exactBucket = this._byDepthAndTag.get(exactKey);
    if (exactBucket) {
      for (let i2 = 0; i2 < exactBucket.length; i2++) {
        if (matcher.matches(exactBucket[i2])) return exactBucket[i2];
      }
    }
    const wildcardBucket = this._wildcardByDepth.get(depth);
    if (wildcardBucket) {
      for (let i2 = 0; i2 < wildcardBucket.length; i2++) {
        if (matcher.matches(wildcardBucket[i2])) return wildcardBucket[i2];
      }
    }
    const deepBucket = this._deepByTerminalTag.get(tag);
    if (deepBucket) {
      for (let i2 = 0; i2 < deepBucket.length; i2++) {
        if (matcher.matches(deepBucket[i2])) return deepBucket[i2];
      }
    }
    for (let i2 = 0; i2 < this._deepWildcards.length; i2++) {
      if (matcher.matches(this._deepWildcards[i2])) return this._deepWildcards[i2];
    }
    return null;
  }
}
class MatcherView {
  /**
   * @param {Matcher} matcher - The parent Matcher instance to read from.
   */
  constructor(matcher) {
    this._matcher = matcher;
  }
  /**
   * Get the path separator used by the parent matcher.
   * @returns {string}
   */
  get separator() {
    return this._matcher.separator;
  }
  /**
   * Get current tag name.
   * @returns {string|undefined}
   */
  getCurrentTag() {
    const path2 = this._matcher.path;
    return path2.length > 0 ? path2[path2.length - 1].tag : void 0;
  }
  /**
   * Get current namespace.
   * @returns {string|undefined}
   */
  getCurrentNamespace() {
    const path2 = this._matcher.path;
    return path2.length > 0 ? path2[path2.length - 1].namespace : void 0;
  }
  /**
   * Get current node's attribute value.
   * @param {string} attrName
   * @returns {*}
   */
  getAttrValue(attrName) {
    const path2 = this._matcher.path;
    if (path2.length === 0) return void 0;
    return path2[path2.length - 1].values?.[attrName];
  }
  /**
   * Check if current node has an attribute.
   * @param {string} attrName
   * @returns {boolean}
   */
  hasAttr(attrName) {
    const path2 = this._matcher.path;
    if (path2.length === 0) return false;
    const current = path2[path2.length - 1];
    return current.values !== void 0 && attrName in current.values;
  }
  /**
   * Get the value of a "kept" attribute from the nearest ancestor (or
   * current node) that declared it via `push(tag, attrs, ns, { keep: [...] })`.
   * @param {string} attrName
   * @returns {*}
   */
  getAnyParentAttr(attrName) {
    return this._matcher.getAnyParentAttr(attrName);
  }
  /**
   * Check whether any ancestor (or the current node) kept the given
   * attribute via `push(tag, attrs, ns, { keep: [...] })`.
   * @param {string} attrName
   * @returns {boolean}
   */
  hasAnyParentAttr(attrName) {
    return this._matcher.hasAnyParentAttr(attrName);
  }
  /**
   * Get current node's sibling position (child index in parent).
   * @returns {number}
   */
  getPosition() {
    const path2 = this._matcher.path;
    if (path2.length === 0) return -1;
    return path2[path2.length - 1].position ?? 0;
  }
  /**
   * Get current node's repeat counter (occurrence count of this tag name).
   * @returns {number}
   */
  getCounter() {
    const path2 = this._matcher.path;
    if (path2.length === 0) return -1;
    return path2[path2.length - 1].counter ?? 0;
  }
  /**
   * Get current node's sibling index (alias for getPosition).
   * @returns {number}
   * @deprecated Use getPosition() or getCounter() instead
   */
  getIndex() {
    return this.getPosition();
  }
  /**
   * Get current path depth.
   * @returns {number}
   */
  getDepth() {
    return this._matcher.path.length;
  }
  /**
   * Get path as string.
   * @param {string} [separator] - Optional separator (uses default if not provided)
   * @param {boolean} [includeNamespace=true]
   * @returns {string}
   */
  toString(separator, includeNamespace = true) {
    return this._matcher.toString(separator, includeNamespace);
  }
  /**
   * Get path as array of tag names.
   * @returns {string[]}
   */
  toArray() {
    return this._matcher.path.map((n) => n.tag);
  }
  /**
   * Match current path against an Expression.
   * @param {Expression} expression
   * @returns {boolean}
   */
  matches(expression) {
    return this._matcher.matches(expression);
  }
  /**
   * Match any expression in the given set against the current path.
   * @param {ExpressionSet} exprSet
   * @returns {boolean}
   */
  matchesAny(exprSet) {
    return exprSet.matchesAny(this._matcher);
  }
}
class Matcher {
  /**
   * Create a new Matcher.
   * @param {Object} [options={}]
   * @param {string} [options.separator='.'] - Default path separator
   */
  constructor(options = {}) {
    this.separator = options.separator || ".";
    this.path = [];
    this.siblingStacks = [];
    this._pathStringCache = null;
    this._view = new MatcherView(this);
    this._keptAttrs = [];
  }
  /**
   * Push a new tag onto the path.
   * @param {string} tagName
   * @param {Object|null} [attrValues=null]
   * @param {string|null} [namespace=null]
   * @param {Object|null} [options=null]
   * @param {string[]} [options.keep] - Names of attributes (from attrValues)
   */
  push(tagName, attrValues = null, namespace2 = null, options = null) {
    this._pathStringCache = null;
    if (this.path.length > 0) {
      this.path[this.path.length - 1].values = void 0;
    }
    const currentLevel = this.path.length;
    let level = this.siblingStacks[currentLevel];
    if (!level) {
      level = { counts: /* @__PURE__ */ new Map(), total: 0 };
      this.siblingStacks[currentLevel] = level;
    }
    const siblingKey = namespace2 ? `${namespace2}:${tagName}` : tagName;
    const counter = level.counts.get(siblingKey) || 0;
    const position = level.total;
    level.counts.set(siblingKey, counter + 1);
    level.total++;
    const node = {
      tag: tagName,
      position,
      counter
    };
    if (namespace2 !== null && namespace2 !== void 0) {
      node.namespace = namespace2;
    }
    if (attrValues !== null && attrValues !== void 0) {
      node.values = attrValues;
    }
    this.path.push(node);
    const depth = this.path.length;
    const keep = options !== null ? options.keep : null;
    if (keep !== null && keep !== void 0 && keep.length > 0 && attrValues) {
      for (let i2 = 0; i2 < keep.length; i2++) {
        const name = keep[i2];
        if (attrValues[name] !== void 0) {
          this._keptAttrs.push({ depth, name, value: attrValues[name] });
        }
      }
    }
  }
  /**
   * Pop the last tag from the path.
   * @returns {Object|undefined} The popped node
   */
  pop() {
    if (this.path.length === 0) return void 0;
    this._pathStringCache = null;
    const node = this.path.pop();
    if (this.siblingStacks.length > this.path.length + 1) {
      this.siblingStacks.length = this.path.length + 1;
    }
    const poppedDepth = this.path.length + 1;
    while (this._keptAttrs.length > 0 && this._keptAttrs[this._keptAttrs.length - 1].depth >= poppedDepth) {
      this._keptAttrs.pop();
    }
    return node;
  }
  /**
   * Update current node's attribute values.
   * Useful when attributes are parsed after push.
   * @param {Object} attrValues
   */
  updateCurrent(attrValues) {
    if (this.path.length > 0) {
      const current = this.path[this.path.length - 1];
      if (attrValues !== null && attrValues !== void 0) {
        current.values = attrValues;
      }
    }
  }
  /**
   * Get current tag name.
   * @returns {string|undefined}
   */
  getCurrentTag() {
    return this.path.length > 0 ? this.path[this.path.length - 1].tag : void 0;
  }
  /**
   * Get current namespace.
   * @returns {string|undefined}
   */
  getCurrentNamespace() {
    return this.path.length > 0 ? this.path[this.path.length - 1].namespace : void 0;
  }
  /**
   * Get current node's attribute value.
   * @param {string} attrName
   * @returns {*}
   */
  getAttrValue(attrName) {
    if (this.path.length === 0) return void 0;
    return this.path[this.path.length - 1].values?.[attrName];
  }
  /**
   * Check if current node has an attribute.
   * @param {string} attrName
   * @returns {boolean}
   */
  hasAttr(attrName) {
    if (this.path.length === 0) return false;
    const current = this.path[this.path.length - 1];
    return current.values !== void 0 && attrName in current.values;
  }
  /**
   * Get the value of a "kept" attribute from the nearest ancestor (or
   * current node) that declared it via `push(tag, attrs, ns, { keep: [...] })`.
   * Unlike getAttrValue(), this works regardless of how deep the path has
   * gone since the attribute was pushed — but only for attribute names that
   * were explicitly marked with `keep` at push time. Cost is proportional to
   * the number of currently-kept attributes (typically 0-3), not path depth.
   * @param {string} attrName
   * @returns {*} the value, or undefined if no ancestor kept this attribute
   */
  getAnyParentAttr(attrName) {
    const kept = this._keptAttrs;
    for (let i2 = kept.length - 1; i2 >= 0; i2--) {
      if (kept[i2].name === attrName) return kept[i2].value;
    }
    return void 0;
  }
  /**
   * Check whether any ancestor (or the current node) kept the given
   * attribute via `push(tag, attrs, ns, { keep: [...] })`.
   * @param {string} attrName
   * @returns {boolean}
   */
  hasAnyParentAttr(attrName) {
    const kept = this._keptAttrs;
    for (let i2 = kept.length - 1; i2 >= 0; i2--) {
      if (kept[i2].name === attrName) return true;
    }
    return false;
  }
  /**
   * Get current node's sibling position (child index in parent).
   * @returns {number}
   */
  getPosition() {
    if (this.path.length === 0) return -1;
    return this.path[this.path.length - 1].position ?? 0;
  }
  /**
   * Get current node's repeat counter (occurrence count of this tag name).
   * @returns {number}
   */
  getCounter() {
    if (this.path.length === 0) return -1;
    return this.path[this.path.length - 1].counter ?? 0;
  }
  /**
   * Get current node's sibling index (alias for getPosition).
   * @returns {number}
   * @deprecated Use getPosition() or getCounter() instead
   */
  getIndex() {
    return this.getPosition();
  }
  /**
   * Get current path depth.
   * @returns {number}
   */
  getDepth() {
    return this.path.length;
  }
  /**
   * Get path as string.
   * @param {string} [separator] - Optional separator (uses default if not provided)
   * @param {boolean} [includeNamespace=true]
   * @returns {string}
   */
  toString(separator, includeNamespace = true) {
    const sep2 = separator || this.separator;
    const isDefault = sep2 === this.separator && includeNamespace === true;
    if (isDefault) {
      if (this._pathStringCache !== null) {
        return this._pathStringCache;
      }
      const result = this.path.map(
        (n) => n.namespace ? `${n.namespace}:${n.tag}` : n.tag
      ).join(sep2);
      this._pathStringCache = result;
      return result;
    }
    return this.path.map(
      (n) => includeNamespace && n.namespace ? `${n.namespace}:${n.tag}` : n.tag
    ).join(sep2);
  }
  /**
   * Get path as array of tag names.
   * @returns {string[]}
   */
  toArray() {
    return this.path.map((n) => n.tag);
  }
  /**
   * Reset the path to empty.
   */
  reset() {
    this._pathStringCache = null;
    this.path = [];
    this.siblingStacks = [];
    this._keptAttrs = [];
  }
  /**
   * Match current path against an Expression.
   * @param {Expression} expression
   * @returns {boolean}
   */
  matches(expression) {
    const segments = expression.segments;
    if (segments.length === 0) {
      return false;
    }
    if (expression.hasDeepWildcard()) {
      return this._matchWithDeepWildcard(segments);
    }
    return this._matchSimple(segments);
  }
  /**
   * @private
   */
  _matchSimple(segments) {
    if (this.path.length !== segments.length) {
      return false;
    }
    for (let i2 = 0; i2 < segments.length; i2++) {
      if (!this._matchSegment(segments[i2], this.path[i2], i2 === this.path.length - 1)) {
        return false;
      }
    }
    return true;
  }
  /**
   * @private
   */
  _matchWithDeepWildcard(segments) {
    let pathIdx = this.path.length - 1;
    let segIdx = segments.length - 1;
    while (segIdx >= 0 && pathIdx >= 0) {
      const segment = segments[segIdx];
      if (segment.type === "deep-wildcard") {
        segIdx--;
        if (segIdx < 0) {
          return true;
        }
        const nextSeg = segments[segIdx];
        let found = false;
        for (let i2 = pathIdx; i2 >= 0; i2--) {
          if (this._matchSegment(nextSeg, this.path[i2], i2 === this.path.length - 1)) {
            pathIdx = i2 - 1;
            segIdx--;
            found = true;
            break;
          }
        }
        if (!found) {
          return false;
        }
      } else {
        if (!this._matchSegment(segment, this.path[pathIdx], pathIdx === this.path.length - 1)) {
          return false;
        }
        pathIdx--;
        segIdx--;
      }
    }
    return segIdx < 0;
  }
  /**
   * @private
   */
  _matchSegment(segment, node, isCurrentNode) {
    if (segment.tag !== "*" && segment.tag !== node.tag) {
      return false;
    }
    if (segment.namespace !== void 0) {
      if (segment.namespace !== "*" && segment.namespace !== node.namespace) {
        return false;
      }
    }
    if (segment.attrName !== void 0) {
      if (!isCurrentNode) {
        return false;
      }
      if (!node.values || !(segment.attrName in node.values)) {
        return false;
      }
      if (segment.attrValue !== void 0) {
        if (String(node.values[segment.attrName]) !== String(segment.attrValue)) {
          return false;
        }
      }
    }
    if (segment.position !== void 0) {
      if (!isCurrentNode) {
        return false;
      }
      const counter = node.counter ?? 0;
      if (segment.position === "first" && counter !== 0) {
        return false;
      } else if (segment.position === "odd" && counter % 2 !== 1) {
        return false;
      } else if (segment.position === "even" && counter % 2 !== 0) {
        return false;
      } else if (segment.position === "nth" && counter !== segment.positionValue) {
        return false;
      }
    }
    return true;
  }
  /**
   * Match any expression in the given set against the current path.
   * @param {ExpressionSet} exprSet
   * @returns {boolean}
   */
  matchesAny(exprSet) {
    return exprSet.matchesAny(this);
  }
  /**
   * Create a snapshot of current state.
   * @returns {Object}
   */
  snapshot() {
    return {
      path: this.path.map((node) => ({ ...node })),
      siblingStacks: this.siblingStacks.map((level) => level ? { counts: new Map(level.counts), total: level.total } : level),
      keptAttrs: this._keptAttrs.map((entry) => ({ ...entry }))
    };
  }
  /**
   * Restore state from snapshot.
   * @param {Object} snapshot
   */
  restore(snapshot) {
    this._pathStringCache = null;
    this.path = snapshot.path.map((node) => ({ ...node }));
    this.siblingStacks = snapshot.siblingStacks.map((level) => level ? { counts: new Map(level.counts), total: level.total } : level);
    this._keptAttrs = (snapshot.keptAttrs || []).map((entry) => ({ ...entry }));
  }
  /**
   * Return the read-only {@link MatcherView} for this matcher.
   *
   * The same instance is returned on every call — no allocation occurs.
   * It always reflects the current parser state and is safe to pass to
   * user callbacks without risk of accidental mutation.
   *
   * @returns {MatcherView}
   *
   * @example
   * const view = matcher.readOnly();
   * // pass view to callbacks — it stays in sync automatically
   * view.matches(expr);       // ✓
   * view.getCurrentTag();     // ✓
   * // view.push(...)         // ✗ method does not exist — caught by TypeScript
   */
  readOnly() {
    return this._view;
  }
}
const HTML_PATTERNS = [
  {
    id: "html-script-open",
    description: "<script opening tag",
    pattern: /<script[\s>/]/i
  },
  {
    id: "html-script-close",
    description: "<\/script closing tag",
    pattern: /<\/script[\s>]/i
  },
  {
    id: "html-javascript-protocol",
    description: "javascript: URI scheme (with optional whitespace/encoding)",
    // Handles j&#x61;vascript:, j\u0061vascript:, and whitespace variants
    pattern: /j[\t\n\r ]*a[\t\n\r ]*v[\t\n\r ]*a[\t\n\r ]*s[\t\n\r ]*c[\t\n\r ]*r[\t\n\r ]*i[\t\n\r ]*p[\t\n\r ]*t[\t\n\r ]*:/i
  },
  {
    id: "html-vbscript-protocol",
    description: "vbscript: URI scheme",
    pattern: /vbscript[\t\n\r ]*:/i
  },
  {
    id: "html-data-html",
    description: "data:text/html URI — can execute scripts in browsers",
    pattern: /data[\t\n\r ]*:[\t\n\r ]*text\/html/i
  },
  {
    id: "html-data-xhtml",
    description: "data:application/xhtml+xml URI",
    pattern: /data[\t\n\r ]*:[\t\n\r ]*application\/xhtml/i
  },
  {
    id: "html-data-svg",
    description: "data:image/svg+xml URI — can execute scripts",
    pattern: /data[\t\n\r ]*:[\t\n\r ]*image\/svg\+xml/i
  },
  {
    id: "html-inline-event-handler",
    description: "Inline event handler attributes: onclick=, onerror=, onload=, etc.",
    // \bon ensures we match a word boundary so "phonetic=" is not caught
    pattern: /\bon\w{1,30}\s*=/i
  },
  {
    id: "html-entity-obfuscated-script",
    description: "HTML-entity-encoded <script (e.g. &#x3C;script or &lt;script)",
    // Entities include optional trailing semicolon: &#x3C; or &#x3C (both valid in HTML5)
    pattern: /(?:&#x0*3[Cc];?|&#0*60;?|&lt;)\s*script/i
  },
  {
    id: "html-entity-obfuscated-javascript",
    description: 'HTML-entity-encoded javascript: (partial — catches common &#106; or &#x6a; for "j")',
    pattern: /(?:&#x0*6[Aa];?|&#0*106;?)\s*(?:&#x0*61;?|a)[\s\S]{0,80}script\s*:/i
  },
  {
    id: "html-style-expression",
    description: "CSS expression() — IE-era code execution in style attributes",
    pattern: /style[\s\S]{0,20}expression\s*\(/i
  },
  {
    id: "html-object-embed",
    description: "<object or <embed tags that can load active content",
    pattern: /<(?:object|embed)[\s>/]/i
  },
  {
    id: "html-base-tag",
    description: "<base href= — can hijack all relative URLs on a page",
    pattern: /<base[\s>]/i
  },
  {
    id: "html-meta-refresh",
    description: '<meta http-equiv="refresh" — can redirect users',
    pattern: /<meta[\s\S]{0,40}http-equiv[\s\S]{0,20}refresh/i
  },
  {
    id: "html-srcdoc",
    description: "srcdoc= attribute on iframes — embeds HTML that can run scripts",
    pattern: /srcdoc\s*=/i
  },
  {
    id: "html-iframe",
    description: "<iframe tag",
    pattern: /<iframe[\s>/]/i
  },
  {
    id: "html-form",
    description: "<form tag — can be used for phishing / credential harvesting injection",
    pattern: /<form[\s>/]/i
  }
];
const XML_PATTERNS = [
  {
    id: "xml-cdata-injection",
    description: "CDATA section injection: <![CDATA[ breaks out of text node context",
    pattern: /<!\[CDATA\[/i
  },
  {
    id: "xml-cdata-close",
    description: "CDATA close sequence: ]]> can terminate an enclosing CDATA section",
    pattern: /\]\]>/
  },
  {
    id: "xml-processing-instruction",
    description: "XML processing instruction: <?xml-stylesheet or <?php etc.",
    pattern: /<\?(?:xml[\- ]|php|asp)/i
  },
  {
    id: "xml-doctype-injection",
    description: "DOCTYPE declaration embedded in content — can define entities",
    // Match <!DOCTYPE followed by end-of-string, whitespace, or [ (internal subset)
    pattern: /<!DOCTYPE(?:[\s[]|$)/i
  },
  {
    id: "xml-entity-system",
    description: "SYSTEM keyword — used in external entity declarations (XXE)",
    pattern: /\bSYSTEM\s+["']/i
  },
  {
    id: "xml-entity-public",
    description: "PUBLIC keyword — used in external entity declarations (XXE)",
    pattern: /\bPUBLIC\s+["']/i
  },
  {
    id: "xml-entity-declaration",
    description: "<!ENTITY declaration — defines entities, potential XXE or entity expansion",
    pattern: /<!ENTITY[\s%]/i
  },
  {
    id: "xml-billion-laughs",
    description: "Entity reference chaining / billion laughs: repeated &eX; style references",
    // Heuristic: 3+ consecutive entity refs suggests expansion attack
    pattern: /(?:&\w{1,20};){3,}/
  },
  {
    id: "xml-namespace-confusion",
    description: "xmlns: attribute injection — can redefine namespaces to confuse parsers",
    // pattern: /\bxmlns\s*(?::\w{1,40})?\s*=/i,
    pattern: /\bxmlns(?::\w{1,40})?\s*=/i
  },
  {
    id: "xml-comment-injection",
    description: "<!-- comment injection — can hide content from some parsers",
    pattern: /<!--/
  },
  {
    id: "xml-comment-close",
    description: "--> closes an enclosing XML comment",
    pattern: /-->/
  },
  {
    id: "xml-pi-close",
    description: "?> closes an enclosing processing instruction",
    pattern: /\?>/
  }
];
const SVG_PATTERNS = [
  {
    id: "svg-script-element",
    description: "<script element inside SVG executes JavaScript",
    pattern: /<script[\s>/]/i
  },
  {
    id: "svg-xlink-href-javascript",
    description: "xlink:href with javascript: — classic SVG XSS via <a> or <use>",
    pattern: /xlink\s*:\s*href\s*=\s*["']?\s*javascript\s*:/i
  },
  {
    id: "svg-href-javascript",
    description: "href= with javascript: in SVG context (<a>, <animate>, etc.)",
    pattern: /href\s*=\s*["']?\s*javascript\s*:/i
  },
  {
    id: "svg-foreignobject",
    description: "<foreignObject embeds HTML inside SVG — can execute scripts",
    pattern: /<foreignObject[\s>/]/i
  },
  {
    id: "svg-use-external",
    description: "<use xlink:href or href pointing to external resource (non-fragment URL)",
    // Match <use with href= where the value starts with a non-# character (external URL)
    // [\"'][^#] catches quoted values not starting with #; [^\"'#\s>] catches unquoted
    pattern: /<use[\s\S]{0,60}(?:xlink\s*:\s*)?href\s*=\s*(?:["'][^#]|[^"'#\s>])/i
  },
  {
    id: "svg-animate-href",
    description: '<animate attributeName="href" — can dynamically change href to javascript:',
    pattern: /<animate[\s\S]{0,80}attributeName\s*=\s*["'][\s]*href["']/i
  },
  {
    id: "svg-animate-xlinkhref",
    description: '<animate attributeName="xlink:href"',
    pattern: /<animate[\s\S]{0,80}attributeName\s*=\s*["'][\s]*xlink\s*:\s*href["']/i
  },
  {
    id: "svg-set-javascript",
    description: '<set to="javascript:..." — sets an attribute to a javascript: URI',
    pattern: /<set[\s\S]{0,80}to\s*=\s*["']?\s*javascript\s*:/i
  },
  {
    id: "svg-event-handler",
    description: "SVG-specific event handler attributes: onload=, onerror=, onactivate=, etc.",
    pattern: /\bon(?:load|error|activate|begin|end|repeat|focus|blur|click|mouse\w{1,20}|key\w{1,20})\s*=/i
  },
  {
    id: "svg-handler-generic",
    description: "Generic on* handler catch-all for SVG attributes",
    pattern: /\bon\w{1,30}\s*=/i
  },
  {
    id: "svg-filter-feimage",
    description: "<feImage href= — filter primitive that can load external resources",
    pattern: /<feImage[\s\S]{0,80}(?:xlink\s*:\s*)?href\s*=/i
  },
  {
    id: "svg-image-external",
    description: "<image xlink:href with http/https or javascript protocol",
    pattern: /<image[\s\S]{0,80}(?:xlink\s*:\s*)?href\s*=\s*["']?\s*(?:https?|javascript)\s*:/i
  },
  {
    id: "svg-style-javascript",
    description: "style= attribute containing javascript: (e.g. background:url(javascript:...))",
    pattern: /style\s*=[\s\S]{0,60}javascript\s*:/i
  }
];
const SQL_PATTERNS = [
  {
    id: "sql-block-comment-open",
    description: "SQL block comment open: /* ... */ — unusual in legitimate user text",
    pattern: /\/\*/
  },
  {
    id: "sql-union-select",
    description: "UNION SELECT — most common SQL injection aggregation attack",
    pattern: /\bUNION\s{1,20}(?:ALL\s{1,20})?SELECT\b/i
  },
  {
    id: "sql-drop-table",
    description: "DROP TABLE — destructive DDL injection",
    pattern: /\bDROP\s{1,20}TABLE\b/i
  },
  {
    id: "sql-drop-database",
    description: "DROP DATABASE — destructive DDL injection",
    pattern: /\bDROP\s{1,20}DATABASE\b/i
  },
  {
    id: "sql-insert-into",
    description: "INSERT INTO — data injection",
    pattern: /\bINSERT\s{1,20}INTO\b/i
  },
  {
    id: "sql-delete-from",
    description: "DELETE FROM — data deletion injection",
    pattern: /\bDELETE\s{1,20}FROM\b/i
  },
  {
    id: "sql-update-set",
    description: "UPDATE ... SET — data modification injection",
    // Allows arbitrary content between UPDATE and SET (table name, alias, etc.)
    pattern: /\bUPDATE\b[\s\S]{1,60}\bSET\b/i
  },
  {
    id: "sql-exec-xp",
    description: "EXEC xp_ — MSSQL extended stored procedure execution",
    pattern: /\bEXEC(?:UTE)?\s{1,20}xp_/i
  },
  {
    id: "sql-tautology-string",
    description: `Classic string tautology: ' OR '1'='1 or " OR "1"="1"`,
    // Last quote is optional — injection may truncate it: ' OR '1'='1--
    pattern: /'\s{0,10}OR\s{0,10}'[^']{0,20}'\s*=\s*'[^']{0,20}/i
  },
  {
    id: "sql-tautology-numeric",
    description: "Numeric tautology: OR 1=1",
    pattern: /\bOR\s{1,10}1\s*=\s*1\b/i
  },
  {
    id: "sql-always-true-zero",
    description: "Numeric tautology: OR 0=0",
    pattern: /\bOR\s{1,10}0\s*=\s*0\b/i
  },
  {
    id: "sql-sleep-benchmark",
    description: "Time-based blind injection: SLEEP() or BENCHMARK()",
    pattern: /\b(?:SLEEP|BENCHMARK)\s*\(/i
  },
  {
    id: "sql-waitfor-delay",
    description: "MSSQL time-based blind injection: WAITFOR DELAY",
    pattern: /\bWAITFOR\s{1,20}DELAY\b/i
  },
  {
    id: "sql-char-function",
    description: "CHAR() function — used to obfuscate injected strings",
    pattern: /\bCHAR\s*\(\s*\d{1,3}/i
  },
  {
    id: "sql-information-schema",
    description: "INFORMATION_SCHEMA — reconnaissance query for table/column enumeration",
    pattern: /\bINFORMATION_SCHEMA\b/i
  }
];
const SHELL_PATTERNS = [
  {
    id: "shell-path-traversal-unix",
    description: "Unix path traversal: ../  — climbing the directory tree",
    pattern: /\.\.\//
  },
  {
    id: "shell-path-traversal-windows",
    description: "Windows path traversal: ..\\ — climbing the directory tree",
    pattern: /\.\.\\/
  },
  {
    id: "shell-path-traversal-encoded",
    description: "URL-encoded path traversal: %2e%2e or %2f variants",
    pattern: /%2e%2e|%2f\.\.|\.\.%2f/i
  },
  {
    id: "shell-null-byte",
    description: "Null byte injection: \\x00 or %00 — truncates strings in C-backed functions",
    pattern: /\x00|%00/
  },
  {
    id: "shell-semicolon",
    description: "Semicolon command separator: cmd1; cmd2",
    pattern: /;/
  },
  {
    id: "shell-pipe",
    description: "Pipe operator: cmd1 | cmd2",
    pattern: /\|/
  },
  {
    id: "shell-and-operator",
    description: "AND operator: cmd1 && cmd2",
    pattern: /&&/
  },
  {
    id: "shell-or-operator",
    description: "OR operator: cmd1 || cmd2",
    pattern: /\|\|/
  },
  {
    id: "shell-backtick",
    description: "Backtick command substitution: `cmd`",
    pattern: /`/
  },
  {
    id: "shell-dollar-paren",
    description: "Dollar-paren command substitution: $(cmd)",
    pattern: /\$\(/
  },
  {
    id: "shell-dollar-brace",
    description: "Dollar-brace variable expansion: ${var} — can be abused for injection",
    pattern: /\$\{/
  },
  {
    id: "shell-redirect-out",
    description: "Output redirection: cmd > file or cmd >> file",
    pattern: />{1,2}/
  },
  {
    id: "shell-redirect-in",
    description: "Input redirection: cmd < file",
    pattern: /</
  },
  {
    id: "shell-newline-injection",
    description: "Newline injection: \\n or \\r — can inject new shell commands",
    pattern: /[\n\r]/
  },
  {
    id: "shell-glob-star",
    description: "Glob expansion: * or ? — can expand to unintended files",
    // Only flag when combined with path separators to reduce false positives
    pattern: /[/\\][*?]/
  },
  {
    id: "shell-absolute-root",
    description: "Absolute root path injection: string starting with / or \\ (Windows UNC)",
    pattern: /^(?:\/|\\\\)/
  },
  {
    id: "shell-windows-drive",
    description: "Windows drive letter path injection: C:\\ or D:/",
    pattern: /^[a-zA-Z]:[/\\]/
  },
  {
    id: "shell-curl-wget",
    description: "curl/wget with URL or flags — can exfiltrate data or download payloads",
    // Require a URL scheme (http/https/ftp) or a flag (-) to reduce false positives
    // "curl is a tool" won't match; "curl http://..." or "curl -s ..." will
    pattern: /\b(?:curl|wget)\s+(?:https?:\/\/|ftp:\/\/|-)/i
  }
];
const REDOS_PATTERNS = [
  {
    id: "redos-nested-quantifier-plus",
    description: "Nested + quantifier inside a group with outer quantifier: (a+)+, (.+b)*, etc.",
    // Matches any group containing a + quantifier, with an outer * or + — catches (a+)+, (.+b)*, etc.
    pattern: /\([^)]*\+[^)]*\)[+*]/
  },
  {
    id: "redos-nested-quantifier-star",
    description: "Nested * quantifier: (a*)* or (a*)+ — catastrophic backtracking",
    pattern: /\([^)]*\*[^)]*\)[*+]/
  },
  {
    id: "redos-nested-groups",
    description: "Doubly nested quantified groups: ((a+)+) — guaranteed catastrophic",
    pattern: /\(\([^)]{0,40}\)[+*]\)[+*]/
  },
  {
    id: "redos-alternation-overlap",
    description: "Overlapping alternation under quantifier: (a|a)+ — ambiguous NFA paths",
    // Detect repeated identical alternatives under a quantifier
    pattern: /\(([^|()]{1,20})\|(?:\1)(?:\|[^|()]{1,20}){0,5}\)[+*?]{1,2}/
  },
  {
    id: "redos-star-plus-concat",
    description: "(x*x)+ pattern — triggers super-linear backtracking",
    pattern: /\([^)]{0,10}\*[^)]{0,10}\)[+*]/
  },
  {
    id: "redos-dot-star-greedy",
    description: "(.*){n,} or (.+){n,} — repeated greedy dot quantifiers",
    pattern: /\(\.[*+]\)\{?\d/
  },
  {
    id: "redos-large-repetition",
    description: "Very large fixed or range repetition count {1000,} or {1000,n} — denial of service via backtracking",
    // Matches { followed by 4+ digits (≥1000), then optional ,digits }
    pattern: /\{\d{4,}(?:,\d*)?\}/
  },
  {
    id: "redos-catastrophic-alternation",
    description: "Long alternation with many similar branches — polynomial backtracking risk",
    // Heuristic: 10+ pipe-separated alternatives in a single group
    pattern: /\([^)]{0,200}(?:\|[^|)]{0,50}){9,}\)/
  }
];
const sep = `["'\\s]*:`;
const NOSQL_PATTERNS = [
  // ─── MongoDB $ operator injection ────────────────────────────────────────
  {
    id: "nosql-where-operator",
    description: "$where — executes arbitrary JavaScript server-side in MongoDB",
    pattern: new RegExp(`\\$where${sep}`, "i")
  },
  {
    id: "nosql-ne-operator",
    description: '$ne — "not equal" operator used to bypass equality checks',
    pattern: new RegExp(`\\$ne${sep}`, "i")
  },
  {
    id: "nosql-gt-operator",
    description: '$gt — "greater than" used to bypass password/value checks',
    pattern: new RegExp(`\\$gte?${sep}`, "i")
  },
  {
    id: "nosql-lt-operator",
    description: '$lt / $lte — "less than" bypass variants',
    pattern: new RegExp(`\\$lte?${sep}`, "i")
  },
  {
    id: "nosql-regex-operator",
    description: "$regex — can be used to extract data character by character (blind injection)",
    pattern: new RegExp(`\\$regex${sep}`, "i")
  },
  {
    id: "nosql-or-operator",
    description: "$or — logical OR; used to create always-true conditions",
    pattern: new RegExp(`\\$or${sep}\\s*\\[`, "i")
  },
  {
    id: "nosql-and-operator",
    description: "$and — logical AND operator injection",
    pattern: new RegExp(`\\$and${sep}\\s*\\[`, "i")
  },
  {
    id: "nosql-nor-operator",
    description: "$nor — logical NOR operator injection",
    pattern: new RegExp(`\\$nor${sep}\\s*\\[`, "i")
  },
  {
    id: "nosql-exists-operator",
    description: "$exists — can enumerate fields to determine schema",
    pattern: new RegExp(`\\$exists${sep}`, "i")
  },
  {
    id: "nosql-in-operator",
    description: "$in — matches any value in a list; can enumerate values",
    pattern: new RegExp(`\\$in${sep}\\s*\\[`, "i")
  },
  {
    id: "nosql-expr-operator",
    description: "$expr — allows aggregation expressions in queries (MongoDB 3.6+)",
    pattern: new RegExp(`\\$expr${sep}`, "i")
  },
  {
    id: "nosql-function-operator",
    description: "$function — executes arbitrary JavaScript in MongoDB 4.4+",
    pattern: new RegExp(`\\$function${sep}`, "i")
  },
  {
    id: "nosql-accumulator-operator",
    description: "$accumulator — custom aggregation with arbitrary JS execution",
    pattern: new RegExp(`\\$accumulator${sep}`, "i")
  },
  // ─── Prototype pollution ─────────────────────────────────────────────────
  {
    id: "nosql-proto-pollution",
    description: "__proto__ — prototype pollution via object key injection",
    pattern: /__proto__/
  },
  {
    id: "nosql-constructor-prototype",
    description: "constructor.prototype — alternative prototype pollution vector (dot notation or JSON key)",
    // Matches dot-notation (obj.constructor.prototype) and JSON key adjacency
    // ("constructor": {"prototype": ...})
    pattern: /constructor[\s"':.,{\[]*prototype/i
  },
  {
    id: "nosql-proto-bracket",
    description: '["__proto__"] — bracket-notation prototype pollution',
    pattern: /\[["']__proto__["']\]/
  }
];
const LOG_PATTERNS = [
  // ─── CRLF / newline injection ─────────────────────────────────────────────
  {
    id: "log-crlf-injection",
    description: "CRLF injection: literal \\r or \\n embeds fake log lines",
    pattern: /[\r\n]/
  },
  {
    id: "log-url-encoded-crlf",
    description: "URL-encoded CRLF: %0d, %0a, %0D, %0A — decoded by some log parsers",
    pattern: /%0[dDaA]/
  },
  {
    id: "log-unicode-newline",
    description: "Unicode newline variants: U+2028 (line separator), U+2029 (paragraph separator)",
    pattern: /[\u2028\u2029]/
  },
  // ─── Log4Shell / JNDI injection (CVE-2021-44228) ─────────────────────────
  {
    id: "log-log4shell-jndi",
    description: "Log4Shell: ${jndi:...} triggers remote code execution in Apache Log4j",
    pattern: /\$\{jndi\s*:/i
  },
  {
    id: "log-log4shell-obfuscated",
    description: "Obfuscated Log4Shell: ${::-j}... lookup-bypass prefix used to evade WAF detection",
    // ${::- is the Log4j lookup-bypass escape sequence; presence alone is suspicious
    pattern: /\$\{::-/
  },
  {
    id: "log-log4j-lookup",
    description: "Log4j lookup syntax: ${env:...}, ${sys:...}, ${ctx:...} — data exfiltration",
    pattern: /\$\{(?:env|sys|ctx|main|map|sd|web|docker|k8s|spring)\s*:/i
  },
  // ─── Server-Side Template Injection (SSTI) in log messages ───────────────
  {
    id: "log-ssti-double-brace",
    description: "SSTI double-brace: {{expression}} — Jinja2, Twig, Handlebars, etc.",
    pattern: /\{\{[\s\S]{0,80}\}\}/
  },
  {
    id: "log-ssti-hash-brace",
    description: "SSTI hash-brace: #{expression} — Thymeleaf, Velocity, Ruby ERB",
    pattern: /#\{[\s\S]{0,80}\}/
  },
  {
    id: "log-ssti-dollar-brace",
    description: "SSTI/EL injection: ${expression with operators or method calls} — JSP EL, Freemarker, SpEL",
    // Require that the ${...} content looks like an expression, not a plain variable name.
    // Flags if the content contains: . ( * + operators, or known SSTI keywords.
    // This avoids flagging ${PATH}, ${HOME} etc. (plain shell variables).
    pattern: /\$\{[^}]*(?:\.|\(|\*|\+|\bclass\b|\bruntime\b|\bprocess\b|\bexec\b)[^}]{0,80}\}/i
  },
  {
    id: "log-ssti-percent-tag",
    description: "SSTI ERB/ASP tag: <%= expression %> — Ruby ERB, ASP",
    pattern: /<%=[\s\S]{0,80}%>/
  },
  // ─── Null byte ────────────────────────────────────────────────────────────
  {
    id: "log-null-byte",
    description: "Null byte: \\x00 or %00 — can truncate log entries in C-backed loggers",
    pattern: /\x00|%00/
  },
  // ─── ANSI escape injection ────────────────────────────────────────────────
  {
    id: "log-ansi-escape",
    description: "ANSI escape sequence: ESC[ — can manipulate terminal output when logs are tailed",
    pattern: /\x1b\[/
  }
];
const SQL_STRICT_EXTRA = [
  {
    id: "sql-line-comment",
    description: "SQL line comment: -- followed by whitespace or end of string",
    pattern: /--(?:\s|$)/
  },
  {
    id: "sql-stacked-query",
    description: "Stacked queries: semicolon immediately followed by a SQL keyword",
    pattern: /;\s{0,10}(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC)\b/i
  },
  {
    id: "sql-hex-encoding",
    description: "Hex-encoded string injection: 0x41414141 style (MySQL)",
    pattern: /\b0x[0-9a-f]{4,}/i
  }
];
const SQL_STRICT_PATTERNS = [...SQL_PATTERNS, ...SQL_STRICT_EXTRA];
HTML_PATTERNS.label = "HTML";
XML_PATTERNS.label = "XML";
SVG_PATTERNS.label = "SVG";
SQL_PATTERNS.label = "SQL";
SQL_STRICT_PATTERNS.label = "SQL-STRICT";
SHELL_PATTERNS.label = "SHELL";
REDOS_PATTERNS.label = "REDOS";
NOSQL_PATTERNS.label = "NOSQL";
LOG_PATTERNS.label = "LOG";
function assertString(value) {
  if (typeof value !== "string") {
    throw new TypeError(
      `is-unsafe: first argument must be a string, got ${typeof value}`
    );
  }
}
function assertContext(context) {
  if (context instanceof RegExp) return;
  if (Array.isArray(context)) {
    if (context.length === 0) {
      throw new TypeError("is-unsafe: context must not be an empty array");
    }
    if (Array.isArray(context[0])) {
      for (const list of context) {
        if (!Array.isArray(list) || list.length === 0) {
          throw new TypeError(
            "is-unsafe: each context in the array must be a non-empty pattern array (PatternList)"
          );
        }
      }
    }
    return;
  }
  throw new TypeError(
    `is-unsafe: second argument must be a PatternList (e.g. HTML), an array of PatternLists (e.g. [HTML, XML]), or a RegExp. Got: ${typeof context}`
  );
}
function normalise(context) {
  if (context instanceof RegExp) return { lists: null, regex: context };
  if (Array.isArray(context[0])) return { lists: context, regex: null };
  return { lists: [context], regex: null };
}
function matchList(value, list) {
  const label = list.label ?? "CUSTOM";
  for (const rule of list) {
    if (rule.pattern.test(value)) {
      return { context: label, id: rule.id, description: rule.description, pattern: rule.pattern };
    }
  }
  return null;
}
function isUnsafe(value, context) {
  assertString(value);
  assertContext(context);
  const { lists, regex } = normalise(context);
  if (regex) return regex.test(value);
  for (const list of lists) {
    if (matchList(value, list) !== null) return true;
  }
  return false;
}
function extractRawAttributes(prefixedAttrs, options) {
  if (!prefixedAttrs) return {};
  const attrs = options.attributesGroupName ? prefixedAttrs[options.attributesGroupName] : prefixedAttrs;
  if (!attrs) return {};
  const rawAttrs = {};
  for (const key in attrs) {
    if (key.startsWith(options.attributeNamePrefix)) {
      const rawName = key.substring(options.attributeNamePrefix.length);
      rawAttrs[rawName] = attrs[key];
    } else {
      rawAttrs[key] = attrs[key];
    }
  }
  return rawAttrs;
}
function extractNamespace(rawTagName) {
  if (!rawTagName || typeof rawTagName !== "string") return void 0;
  const colonIndex = rawTagName.indexOf(":");
  if (colonIndex !== -1 && colonIndex > 0) {
    const ns = rawTagName.substring(0, colonIndex);
    if (ns !== "xmlns") {
      return ns;
    }
  }
  return void 0;
}
class OrderedObjParser {
  constructor(options, externalEntities) {
    this.options = options;
    this.currentNode = null;
    this.tagsNodeStack = [];
    this.parseXml = parseXml;
    this.parseTextData = parseTextData;
    this.resolveNameSpace = resolveNameSpace;
    this.buildAttributesMap = buildAttributesMap;
    this.isItStopNode = isItStopNode;
    this.replaceEntitiesValue = replaceEntitiesValue$1;
    this.readStopNodeData = readStopNodeData;
    this.saveTextToParentTag = saveTextToParentTag;
    this.addChild = addChild;
    this.ignoreAttributesFn = getIgnoreAttributesFn$1(this.options.ignoreAttributes);
    this.entityExpansionCount = 0;
    this.currentExpandedLength = 0;
    this.doctypefound = false;
    let namedEntities = { ...XML };
    if (this.options.entityDecoder) {
      this.entityDecoder = this.options.entityDecoder;
    } else {
      if (typeof this.options.htmlEntities === "object") namedEntities = this.options.htmlEntities;
      else if (this.options.htmlEntities === true) namedEntities = { ...COMMON_HTML, ...CURRENCY };
      this.entityDecoder = new EntityDecoder({
        namedEntities: { ...namedEntities, ...externalEntities },
        numericAllowed: this.options.htmlEntities,
        limit: {
          maxTotalExpansions: this.options.processEntities.maxTotalExpansions,
          maxExpandedLength: this.options.processEntities.maxExpandedLength,
          applyLimitsTo: this.options.processEntities.appliesTo
        },
        // onExternalEntity: (name, value) => isUnsafe(value) ? 'block' : 'allow',
        onInputEntity: (name, value) => (
          //TODO: VALID_CONTEXTS.HTML should be set only if this.options.htmlEntities
          isUnsafe(value, [HTML_PATTERNS, XML_PATTERNS]) ? ENTITY_ACTION.BLOCK : ENTITY_ACTION.ALLOW
        )
        //postCheck: resolved => resolved
      });
    }
    this.matcher = new Matcher();
    this.readonlyMatcher = this.matcher.readOnly();
    this.isCurrentNodeStopNode = false;
    this.stopNodeExpressionsSet = new ExpressionSet();
    const stopNodesOpts = this.options.stopNodes;
    if (stopNodesOpts && stopNodesOpts.length > 0) {
      for (let i2 = 0; i2 < stopNodesOpts.length; i2++) {
        const stopNodeExp = stopNodesOpts[i2];
        if (typeof stopNodeExp === "string") {
          this.stopNodeExpressionsSet.add(new Expression(stopNodeExp));
        } else if (stopNodeExp instanceof Expression) {
          this.stopNodeExpressionsSet.add(stopNodeExp);
        }
      }
      this.stopNodeExpressionsSet.seal();
    }
  }
}
function parseTextData(val, tagName, jPath, dontTrim, hasAttributes, isLeafNode, escapeEntities) {
  const options = this.options;
  if (val !== void 0) {
    if (options.trimValues && !dontTrim) {
      val = val.trim();
    }
    if (val.length > 0) {
      if (!escapeEntities) val = this.replaceEntitiesValue(val, tagName, jPath);
      const jPathOrMatcher = options.jPath ? jPath.toString() : jPath;
      const newval = options.tagValueProcessor(tagName, val, jPathOrMatcher, hasAttributes, isLeafNode);
      if (newval === null || newval === void 0) {
        return val;
      } else if (typeof newval !== typeof val || newval !== val) {
        return newval;
      } else if (options.trimValues) {
        return parseValue(val, options.parseTagValue, options.numberParseOptions);
      } else {
        const trimmedVal = val.trim();
        if (trimmedVal === val) {
          return parseValue(val, options.parseTagValue, options.numberParseOptions);
        } else {
          return val;
        }
      }
    }
  }
}
function resolveNameSpace(tagname) {
  if (this.options.removeNSPrefix) {
    const tags = tagname.split(":");
    const prefix = tagname.charAt(0) === "/" ? "/" : "";
    if (tags[0] === "xmlns") {
      return "";
    }
    if (tags.length === 2) {
      tagname = prefix + tags[1];
    }
  }
  return tagname;
}
const attrsRegx = new RegExp(`([^\\s=]+)\\s*(=\\s*(['"])([\\s\\S]*?)\\3)?`, "gm");
function buildAttributesMap(attrStr, jPath, tagName, force = false) {
  const options = this.options;
  if (force === true || options.ignoreAttributes !== true && typeof attrStr === "string") {
    const matches = getAllMatches(attrStr, attrsRegx);
    const len = matches.length;
    const attrs = {};
    const processedVals = new Array(len);
    let hasRawAttrs = false;
    const rawAttrsForMatcher = {};
    for (let i2 = 0; i2 < len; i2++) {
      const attrName = this.resolveNameSpace(matches[i2][1]);
      const oldVal = matches[i2][4];
      if (attrName.length && oldVal !== void 0) {
        let val = oldVal;
        if (options.trimValues) val = val.trim();
        val = this.replaceEntitiesValue(val, tagName, this.readonlyMatcher);
        processedVals[i2] = val;
        rawAttrsForMatcher[attrName] = val;
        hasRawAttrs = true;
      }
    }
    if (hasRawAttrs && typeof jPath === "object" && jPath.updateCurrent) {
      jPath.updateCurrent(rawAttrsForMatcher);
    }
    const jPathStr = options.jPath ? jPath.toString() : this.readonlyMatcher;
    let hasAttrs = false;
    for (let i2 = 0; i2 < len; i2++) {
      const attrName = this.resolveNameSpace(matches[i2][1]);
      if (this.ignoreAttributesFn(attrName, jPathStr)) continue;
      let aName = options.attributeNamePrefix + attrName;
      if (attrName.length) {
        if (options.transformAttributeName) {
          aName = options.transformAttributeName(aName);
        }
        aName = sanitizeName(aName, options);
        if (matches[i2][4] !== void 0) {
          const oldVal = processedVals[i2];
          const newVal = options.attributeValueProcessor(attrName, oldVal, jPathStr);
          if (newVal === null || newVal === void 0) {
            attrs[aName] = oldVal;
          } else if (typeof newVal !== typeof oldVal || newVal !== oldVal) {
            attrs[aName] = newVal;
          } else {
            attrs[aName] = parseValue(oldVal, options.parseAttributeValue, options.numberParseOptions);
          }
          hasAttrs = true;
        } else if (options.allowBooleanAttributes) {
          attrs[aName] = true;
          hasAttrs = true;
        }
      }
    }
    if (!hasAttrs) return;
    if (options.attributesGroupName && !options.preserveOrder) {
      const attrCollection = {};
      attrCollection[options.attributesGroupName] = attrs;
      return attrCollection;
    }
    return attrs;
  }
}
const parseXml = function(xmlData) {
  xmlData = xmlData.replace(/\r\n?/g, "\n");
  const xmlObj = new XmlNode("!xml");
  let currentNode = xmlObj;
  let textData = "";
  this.matcher.reset();
  this.entityDecoder.reset();
  this.entityExpansionCount = 0;
  this.currentExpandedLength = 0;
  this.doctypefound = false;
  const options = this.options;
  const docTypeReader = new DocTypeReader(options.processEntities);
  const xmlLen = xmlData.length;
  for (let i2 = 0; i2 < xmlLen; i2++) {
    const ch = xmlData[i2];
    if (ch === "<") {
      const c1 = xmlData.charCodeAt(i2 + 1);
      if (c1 === 47) {
        const closeIndex = findClosingIndex(xmlData, ">", i2, "Closing Tag is not closed.");
        let tagName = xmlData.substring(i2 + 2, closeIndex).trim();
        if (options.removeNSPrefix) {
          const colonIndex = tagName.indexOf(":");
          if (colonIndex !== -1) {
            tagName = tagName.substr(colonIndex + 1);
          }
        }
        tagName = transformTagName(options.transformTagName, tagName, "", options).tagName;
        if (currentNode) {
          textData = this.saveTextToParentTag(textData, currentNode, this.readonlyMatcher);
        }
        const lastTagName = this.matcher.getCurrentTag();
        if (tagName && options.unpairedTagsSet.has(tagName)) {
          throw new Error(`Unpaired tag can not be used as closing tag: </${tagName}>`);
        }
        if (lastTagName && options.unpairedTagsSet.has(lastTagName)) {
          this.matcher.pop();
          this.tagsNodeStack.pop();
        }
        this.matcher.pop();
        this.isCurrentNodeStopNode = false;
        currentNode = this.tagsNodeStack.pop() || xmlObj;
        if (options.captureMetaData && currentNode) {
          currentNode.addEndIndex(closeIndex + 1);
        }
        textData = "";
        i2 = closeIndex;
      } else if (c1 === 63) {
        let tagData = readTagExp(xmlData, i2, false, "?>");
        if (!tagData) throw new Error("Pi Tag is not closed.");
        textData = this.saveTextToParentTag(textData, currentNode, this.readonlyMatcher);
        const attsMap = this.buildAttributesMap(tagData.tagExp, this.matcher, tagData.tagName, true);
        if (attsMap) {
          const ver = attsMap[this.options.attributeNamePrefix + "version"];
          this.entityDecoder.setXmlVersion(Number(ver) || 1);
          docTypeReader.setXmlVersion(Number(ver) || 1);
        }
        if (options.ignoreDeclaration && tagData.tagName === "?xml" || options.ignorePiTags) ;
        else {
          const childNode = new XmlNode(tagData.tagName);
          childNode.add(options.textNodeName, "");
          if (tagData.tagName !== tagData.tagExp && tagData.attrExpPresent && options.ignoreAttributes !== true) {
            childNode[":@"] = attsMap;
          }
          this.addChild(currentNode, childNode, this.readonlyMatcher, i2);
          if (options.captureMetaData) {
            currentNode.addEndIndex(tagData.closeIndex + 2);
          }
        }
        i2 = tagData.closeIndex + 1;
      } else if (c1 === 33 && xmlData.charCodeAt(i2 + 2) === 45 && xmlData.charCodeAt(i2 + 3) === 45) {
        const endIndex = findClosingIndex(xmlData, "-->", i2 + 4, "Comment is not closed.");
        if (options.commentPropName) {
          const comment = xmlData.substring(i2 + 4, endIndex - 2);
          textData = this.saveTextToParentTag(textData, currentNode, this.readonlyMatcher);
          currentNode.add(options.commentPropName, [{ [options.textNodeName]: comment }]);
        }
        i2 = endIndex;
      } else if (c1 === 33 && xmlData.charCodeAt(i2 + 2) === 68) {
        if (this.doctypefound) throw new Error("Multiple DOCTYPE declarations found.");
        this.doctypefound = true;
        const result = docTypeReader.readDocType(xmlData, i2);
        this.entityDecoder.addInputEntities(result.entities);
        i2 = result.i;
      } else if (c1 === 33 && xmlData.charCodeAt(i2 + 2) === 91) {
        const closeIndex = findClosingIndex(xmlData, "]]>", i2, "CDATA is not closed.") - 2;
        const tagExp = xmlData.substring(i2 + 9, closeIndex);
        textData = this.saveTextToParentTag(textData, currentNode, this.readonlyMatcher);
        let val = this.parseTextData(tagExp, currentNode.tagname, this.readonlyMatcher, true, false, true, true);
        if (val == void 0) val = "";
        if (options.cdataPropName) {
          currentNode.add(options.cdataPropName, [{ [options.textNodeName]: tagExp }]);
        } else {
          currentNode.add(options.textNodeName, val);
        }
        i2 = closeIndex + 2;
      } else {
        let result = readTagExp(xmlData, i2, options.removeNSPrefix);
        if (!result) {
          const context = xmlData.substring(Math.max(0, i2 - 50), Math.min(xmlLen, i2 + 50));
          throw new Error(`readTagExp returned undefined at position ${i2}. Context: "${context}"`);
        }
        let tagName = result.tagName;
        const rawTagName = result.rawTagName;
        let tagExp = result.tagExp;
        let attrExpPresent = result.attrExpPresent;
        let closeIndex = result.closeIndex;
        ({ tagName, tagExp } = transformTagName(options.transformTagName, tagName, tagExp, options));
        if (options.strictReservedNames && (tagName === options.commentPropName || tagName === options.cdataPropName || tagName === options.textNodeName || tagName === options.attributesGroupName)) {
          throw new Error(`Invalid tag name: ${tagName}`);
        }
        if (currentNode && textData) {
          if (currentNode.tagname !== "!xml") {
            textData = this.saveTextToParentTag(textData, currentNode, this.readonlyMatcher, false);
          }
        }
        const lastTag = currentNode;
        if (lastTag && options.unpairedTagsSet.has(lastTag.tagname)) {
          currentNode = this.tagsNodeStack.pop();
          this.matcher.pop();
        }
        let isSelfClosing = false;
        if (tagExp.length > 0 && tagExp.lastIndexOf("/") === tagExp.length - 1) {
          isSelfClosing = true;
          if (tagName[tagName.length - 1] === "/") {
            tagName = tagName.substr(0, tagName.length - 1);
            tagExp = tagName;
          } else {
            tagExp = tagExp.substr(0, tagExp.length - 1);
          }
          attrExpPresent = tagName !== tagExp;
        }
        let prefixedAttrs = null;
        let namespace2 = void 0;
        namespace2 = extractNamespace(rawTagName);
        if (tagName !== xmlObj.tagname) {
          this.matcher.push(tagName, {}, namespace2);
        }
        if (tagName !== tagExp && attrExpPresent) {
          prefixedAttrs = this.buildAttributesMap(tagExp, this.matcher, tagName);
          if (prefixedAttrs) {
            extractRawAttributes(prefixedAttrs, options);
          }
        }
        if (tagName !== xmlObj.tagname) {
          this.isCurrentNodeStopNode = this.isItStopNode();
        }
        const startIndex = i2;
        if (this.isCurrentNodeStopNode) {
          let tagContent = "";
          if (isSelfClosing) {
            i2 = result.closeIndex;
          } else if (options.unpairedTagsSet.has(tagName)) {
            i2 = result.closeIndex;
          } else {
            const result2 = this.readStopNodeData(xmlData, rawTagName, closeIndex + 1);
            if (!result2) throw new Error(`Unexpected end of ${rawTagName}`);
            i2 = result2.i;
            tagContent = result2.tagContent;
          }
          const childNode = new XmlNode(tagName);
          if (prefixedAttrs) {
            childNode[":@"] = prefixedAttrs;
          }
          childNode.add(options.textNodeName, tagContent);
          this.matcher.pop();
          this.isCurrentNodeStopNode = false;
          this.addChild(currentNode, childNode, this.readonlyMatcher, startIndex);
          if (options.captureMetaData) {
            currentNode.addEndIndex(i2 + 1);
          }
        } else {
          if (isSelfClosing) {
            ({ tagName, tagExp } = transformTagName(options.transformTagName, tagName, tagExp, options));
            const childNode = new XmlNode(tagName);
            if (prefixedAttrs) {
              childNode[":@"] = prefixedAttrs;
            }
            this.addChild(currentNode, childNode, this.readonlyMatcher, startIndex);
            if (options.captureMetaData) {
              currentNode.addEndIndex(closeIndex + 1);
            }
            this.matcher.pop();
            this.isCurrentNodeStopNode = false;
          } else if (options.unpairedTagsSet.has(tagName)) {
            const childNode = new XmlNode(tagName);
            if (prefixedAttrs) {
              childNode[":@"] = prefixedAttrs;
            }
            this.addChild(currentNode, childNode, this.readonlyMatcher, startIndex);
            if (options.captureMetaData) {
              currentNode.addEndIndex(result.closeIndex + 1);
            }
            this.matcher.pop();
            this.isCurrentNodeStopNode = false;
            i2 = result.closeIndex;
            continue;
          } else {
            const childNode = new XmlNode(tagName);
            if (this.tagsNodeStack.length > options.maxNestedTags) {
              throw new Error("Maximum nested tags exceeded");
            }
            this.tagsNodeStack.push(currentNode);
            if (prefixedAttrs) {
              childNode[":@"] = prefixedAttrs;
            }
            this.addChild(currentNode, childNode, this.readonlyMatcher, startIndex);
            currentNode = childNode;
          }
          textData = "";
          i2 = closeIndex;
        }
      }
    } else {
      textData += xmlData[i2];
    }
  }
  return xmlObj.child;
};
function addChild(currentNode, childNode, matcher, startIndex) {
  if (!this.options.captureMetaData) startIndex = void 0;
  const jPathOrMatcher = this.options.jPath ? matcher.toString() : matcher;
  const result = this.options.updateTag(childNode.tagname, jPathOrMatcher, childNode[":@"]);
  if (result === false) ;
  else if (typeof result === "string") {
    childNode.tagname = result;
    currentNode.addChild(childNode, startIndex);
  } else {
    currentNode.addChild(childNode, startIndex);
  }
}
function replaceEntitiesValue$1(val, tagName, jPath) {
  const entityConfig = this.options.processEntities;
  if (!entityConfig || !entityConfig.enabled) {
    return val;
  }
  if (entityConfig.allowedTags) {
    const jPathOrMatcher = this.options.jPath ? jPath.toString() : jPath;
    const allowed = Array.isArray(entityConfig.allowedTags) ? entityConfig.allowedTags.includes(tagName) : entityConfig.allowedTags(tagName, jPathOrMatcher);
    if (!allowed) {
      return val;
    }
  }
  if (entityConfig.tagFilter) {
    const jPathOrMatcher = this.options.jPath ? jPath.toString() : jPath;
    if (!entityConfig.tagFilter(tagName, jPathOrMatcher)) {
      return val;
    }
  }
  return this.entityDecoder.decode(val);
}
function saveTextToParentTag(textData, parentNode, matcher, isLeafNode) {
  if (textData) {
    if (isLeafNode === void 0) isLeafNode = parentNode.child.length === 0;
    textData = this.parseTextData(
      textData,
      parentNode.tagname,
      matcher,
      false,
      parentNode[":@"] ? Object.keys(parentNode[":@"]).length !== 0 : false,
      isLeafNode
    );
    if (textData !== void 0 && textData !== "")
      parentNode.add(this.options.textNodeName, textData);
    textData = "";
  }
  return textData;
}
function isItStopNode() {
  if (this.stopNodeExpressionsSet.size === 0) return false;
  return this.matcher.matchesAny(this.stopNodeExpressionsSet);
}
function tagExpWithClosingIndex(xmlData, i2, closingChar = ">") {
  let attrBoundary = 0;
  const len = xmlData.length;
  const closeCode0 = closingChar.charCodeAt(0);
  const closeCode1 = closingChar.length > 1 ? closingChar.charCodeAt(1) : -1;
  let result = "";
  let segmentStart = i2;
  for (let index = i2; index < len; index++) {
    const code = xmlData.charCodeAt(index);
    if (attrBoundary) {
      if (code === attrBoundary) attrBoundary = 0;
    } else if (code === 34 || code === 39) {
      attrBoundary = code;
    } else if (code === closeCode0) {
      if (closeCode1 !== -1) {
        if (xmlData.charCodeAt(index + 1) === closeCode1) {
          result += xmlData.substring(segmentStart, index);
          return { data: result, index };
        }
      } else {
        result += xmlData.substring(segmentStart, index);
        return { data: result, index };
      }
    } else if (code === 9 && !attrBoundary) {
      result += xmlData.substring(segmentStart, index) + " ";
      segmentStart = index + 1;
    }
  }
}
function findClosingIndex(xmlData, str, i2, errMsg) {
  const closingIndex = xmlData.indexOf(str, i2);
  if (closingIndex === -1) {
    throw new Error(errMsg);
  } else {
    return closingIndex + str.length - 1;
  }
}
function findClosingChar(xmlData, char, i2, errMsg) {
  const closingIndex = xmlData.indexOf(char, i2);
  if (closingIndex === -1) throw new Error(errMsg);
  return closingIndex;
}
function readTagExp(xmlData, i2, removeNSPrefix, closingChar = ">") {
  const result = tagExpWithClosingIndex(xmlData, i2 + 1, closingChar);
  if (!result) return;
  let tagExp = result.data;
  const closeIndex = result.index;
  const separatorIndex = tagExp.search(/\s/);
  let tagName = tagExp;
  let attrExpPresent = true;
  if (separatorIndex !== -1) {
    tagName = tagExp.substring(0, separatorIndex);
    tagExp = tagExp.substring(separatorIndex + 1).trimStart();
  }
  const rawTagName = tagName;
  if (removeNSPrefix) {
    const colonIndex = tagName.indexOf(":");
    if (colonIndex !== -1) {
      tagName = tagName.substr(colonIndex + 1);
      attrExpPresent = tagName !== result.data.substr(colonIndex + 1);
    }
  }
  return {
    tagName,
    tagExp,
    closeIndex,
    attrExpPresent,
    rawTagName
  };
}
function readStopNodeData(xmlData, tagName, i2) {
  const startIndex = i2;
  let openTagCount = 1;
  const xmllen = xmlData.length;
  for (; i2 < xmllen; i2++) {
    if (xmlData[i2] === "<") {
      const c1 = xmlData.charCodeAt(i2 + 1);
      if (c1 === 47) {
        const closeIndex = findClosingChar(xmlData, ">", i2, `${tagName} is not closed`);
        let closeTagName = xmlData.substring(i2 + 2, closeIndex).trim();
        if (closeTagName === tagName) {
          openTagCount--;
          if (openTagCount === 0) {
            return {
              tagContent: xmlData.substring(startIndex, i2),
              i: closeIndex
            };
          }
        }
        i2 = closeIndex;
      } else if (c1 === 63) {
        const closeIndex = findClosingIndex(xmlData, "?>", i2 + 1, "StopNode is not closed.");
        i2 = closeIndex;
      } else if (c1 === 33 && xmlData.charCodeAt(i2 + 2) === 45 && xmlData.charCodeAt(i2 + 3) === 45) {
        const closeIndex = findClosingIndex(xmlData, "-->", i2 + 3, "StopNode is not closed.");
        i2 = closeIndex;
      } else if (c1 === 33 && xmlData.charCodeAt(i2 + 2) === 91) {
        const closeIndex = findClosingIndex(xmlData, "]]>", i2, "StopNode is not closed.") - 2;
        i2 = closeIndex;
      } else {
        const tagData = readTagExp(xmlData, i2, false);
        if (tagData) {
          const openTagName = tagData && tagData.tagName;
          if (openTagName === tagName && tagData.tagExp[tagData.tagExp.length - 1] !== "/") {
            openTagCount++;
          }
          i2 = tagData.closeIndex;
        }
      }
    }
  }
}
function parseValue(val, shouldParse, options) {
  if (shouldParse && typeof val === "string") {
    const newval = val.trim();
    if (newval === "true") return true;
    else if (newval === "false") return false;
    else return toNumber(val, options);
  } else {
    if (isExist(val)) {
      return val;
    } else {
      return "";
    }
  }
}
function transformTagName(fn, tagName, tagExp, options) {
  if (fn) {
    const newTagName = fn(tagName);
    if (tagExp === tagName) {
      tagExp = newTagName;
    }
    tagName = newTagName;
  }
  tagName = sanitizeName(tagName, options);
  return { tagName, tagExp };
}
function sanitizeName(name, options) {
  if (criticalProperties.includes(name)) {
    throw new Error(`[SECURITY] Invalid name: "${name}" is a reserved JavaScript keyword that could cause prototype pollution`);
  } else if (DANGEROUS_PROPERTY_NAMES.includes(name)) {
    return options.onDangerousProperty(name);
  }
  return name;
}
const METADATA_SYMBOL = XmlNode.getMetaDataSymbol();
function stripAttributePrefix(attrs, prefix) {
  if (!attrs || typeof attrs !== "object") return {};
  if (!prefix) return attrs;
  const rawAttrs = {};
  for (const key in attrs) {
    if (key.startsWith(prefix)) {
      const rawName = key.substring(prefix.length);
      rawAttrs[rawName] = attrs[key];
    } else {
      rawAttrs[key] = attrs[key];
    }
  }
  return rawAttrs;
}
function prettify(node, options, matcher, readonlyMatcher) {
  return compress(node, options, matcher, readonlyMatcher);
}
function compress(arr, options, matcher, readonlyMatcher) {
  let text;
  const compressedObj = {};
  for (let i2 = 0; i2 < arr.length; i2++) {
    const tagObj = arr[i2];
    const property = propName$1(tagObj);
    if (property !== void 0 && property !== options.textNodeName) {
      const rawAttrs = stripAttributePrefix(
        tagObj[":@"] || {},
        options.attributeNamePrefix
      );
      matcher.push(property, rawAttrs);
    }
    if (property === options.textNodeName) {
      if (text === void 0) text = tagObj[property];
      else text += "" + tagObj[property];
    } else if (property === void 0) {
      continue;
    } else if (tagObj[property]) {
      let val = compress(tagObj[property], options, matcher, readonlyMatcher);
      const isLeaf = isLeafTag(val, options);
      if (Object.keys(val).length === 0 && options.alwaysCreateTextNode) {
        val[options.textNodeName] = "";
      }
      if (tagObj[":@"]) {
        assignAttributes(val, tagObj[":@"], readonlyMatcher, options);
      } else if (Object.keys(val).length === 1 && val[options.textNodeName] !== void 0 && !options.alwaysCreateTextNode) {
        val = val[options.textNodeName];
      } else if (Object.keys(val).length === 0) {
        if (options.alwaysCreateTextNode) val[options.textNodeName] = "";
        else val = "";
      }
      if (tagObj[METADATA_SYMBOL] !== void 0 && typeof val === "object" && val !== null) {
        val[METADATA_SYMBOL] = tagObj[METADATA_SYMBOL];
      }
      if (compressedObj[property] !== void 0 && Object.prototype.hasOwnProperty.call(compressedObj, property)) {
        if (!Array.isArray(compressedObj[property])) {
          compressedObj[property] = [compressedObj[property]];
        }
        compressedObj[property].push(val);
      } else {
        const jPathOrMatcher = options.jPath ? readonlyMatcher.toString() : readonlyMatcher;
        if (options.isArray(property, jPathOrMatcher, isLeaf)) {
          compressedObj[property] = [val];
        } else {
          compressedObj[property] = val;
        }
      }
      if (property !== void 0 && property !== options.textNodeName) {
        matcher.pop();
      }
    }
  }
  if (typeof text === "string") {
    if (text.length > 0) compressedObj[options.textNodeName] = text;
  } else if (text !== void 0) compressedObj[options.textNodeName] = text;
  return compressedObj;
}
function propName$1(obj) {
  const keys = Object.keys(obj);
  for (let i2 = 0; i2 < keys.length; i2++) {
    const key = keys[i2];
    if (key !== ":@") return key;
  }
}
function assignAttributes(obj, attrMap, readonlyMatcher, options) {
  if (attrMap) {
    const keys = Object.keys(attrMap);
    const len = keys.length;
    for (let i2 = 0; i2 < len; i2++) {
      const atrrName = keys[i2];
      const rawAttrName = atrrName.startsWith(options.attributeNamePrefix) ? atrrName.substring(options.attributeNamePrefix.length) : atrrName;
      const jPathOrMatcher = options.jPath ? readonlyMatcher.toString() + "." + rawAttrName : readonlyMatcher;
      if (options.isArray(atrrName, jPathOrMatcher, true, true)) {
        obj[atrrName] = [attrMap[atrrName]];
      } else {
        obj[atrrName] = attrMap[atrrName];
      }
    }
  }
}
function isLeafTag(obj, options) {
  const { textNodeName } = options;
  const propCount = Object.keys(obj).length;
  if (propCount === 0) {
    return true;
  }
  if (propCount === 1 && (obj[textNodeName] || typeof obj[textNodeName] === "boolean" || obj[textNodeName] === 0)) {
    return true;
  }
  return false;
}
class XMLParser {
  constructor(options) {
    this.externalEntities = {};
    this.options = buildOptions(options);
  }
  /**
   * Parse XML dats to JS object 
   * @param {string|Uint8Array} xmlData 
   * @param {boolean|Object} validationOption 
   */
  parse(xmlData, validationOption) {
    if (typeof xmlData !== "string" && xmlData.toString) {
      xmlData = xmlData.toString();
    } else if (typeof xmlData !== "string") {
      throw new Error("XML data is accepted in String or Bytes[] form.");
    }
    if (validationOption) {
      if (validationOption === true) validationOption = {};
      const result = validate(xmlData, validationOption);
      if (result !== true) {
        throw Error(`${result.err.msg}:${result.err.line}:${result.err.col}`);
      }
    }
    const orderedObjParser = new OrderedObjParser(this.options, this.externalEntities);
    const orderedResult = orderedObjParser.parseXml(xmlData);
    if (this.options.preserveOrder || orderedResult === void 0) return orderedResult;
    else return prettify(orderedResult, this.options, orderedObjParser.matcher, orderedObjParser.readonlyMatcher);
  }
  /**
   * Add Entity which is not by default supported by this library
   * @param {string} key 
   * @param {string} value 
   */
  addEntity(key, value) {
    if (value.indexOf("&") !== -1) {
      throw new Error("Entity value can't have '&'");
    } else if (key.indexOf("&") !== -1 || key.indexOf(";") !== -1) {
      throw new Error("An entity must be set without '&' and ';'. Eg. use '#xD' for '&#xD;'");
    } else if (value === "&") {
      throw new Error("An entity with value '&' is not permitted");
    } else {
      this.externalEntities[key] = value;
    }
  }
  /**
   * Returns a Symbol that can be used to access the metadata
   * property on a node.
   * 
   * If Symbol is not available in the environment, an ordinary property is used
   * and the name of the property is here returned.
   * 
   * The XMLMetaData property is only present when `captureMetaData`
   * is true in the options.
   */
  static getMetaDataSymbol() {
    return XmlNode.getMetaDataSymbol();
  }
}
function valToStr(val) {
  return typeof val === "number" && Object.is(val, -0) ? "-0" : String(val);
}
function safeComment(val) {
  return valToStr(val).replace(/--/g, "- -").replace(/--/g, "- -").replace(/-$/, "- ");
}
function safeCdata(val) {
  return valToStr(val).replace(/\]\]>/g, "]]]]><![CDATA[>");
}
function escapeAttribute(val) {
  return valToStr(val).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
const EOL = "\n";
function detectXmlVersionFromArray(jArray, options) {
  if (!Array.isArray(jArray) || jArray.length === 0) return "1.0";
  const first = jArray[0];
  const firstKey = propName(first);
  if (firstKey === "?xml") {
    const attrs = first[":@"];
    if (attrs) {
      const versionKey = options.attributeNamePrefix + "version";
      if (attrs[versionKey]) return attrs[versionKey];
    }
  }
  return "1.0";
}
function resolveTagName$1(name, isAttribute2, options, matcher, qNameValidator) {
  if (!options.sanitizeName) return name;
  if (qNameValidator(name)) return name;
  return options.sanitizeName(name, { isAttribute: isAttribute2, matcher: matcher.readOnly() });
}
function toXml(jArray, options) {
  let indentation = "";
  if (options.format) {
    indentation = EOL;
  }
  const stopNodeExpressions = [];
  if (options.stopNodes && Array.isArray(options.stopNodes)) {
    for (let i2 = 0; i2 < options.stopNodes.length; i2++) {
      const node = options.stopNodes[i2];
      if (typeof node === "string") {
        stopNodeExpressions.push(new Expression(node));
      } else if (node instanceof Expression) {
        stopNodeExpressions.push(node);
      }
    }
  }
  const xmlVersion = detectXmlVersionFromArray(jArray, options);
  const qNameValidator = createValidator("qName", { xmlVersion });
  const matcher = new Matcher();
  return arrToStr(jArray, options, indentation, matcher, stopNodeExpressions, qNameValidator);
}
function arrToStr(arr, options, indentation, matcher, stopNodeExpressions, qNameValidator) {
  let xmlStr = "";
  let isPreviousElementTag = false;
  if (options.maxNestedTags && matcher.getDepth() > options.maxNestedTags) {
    throw new Error("Maximum nested tags exceeded");
  }
  if (!Array.isArray(arr)) {
    if (arr !== void 0 && arr !== null) {
      let text = valToStr(arr);
      text = replaceEntitiesValue(text, options);
      return text;
    }
    return "";
  }
  for (let i2 = 0; i2 < arr.length; i2++) {
    const tagObj = arr[i2];
    const rawTagName = propName(tagObj);
    if (rawTagName === void 0) continue;
    const isSpecialName = rawTagName === options.textNodeName || rawTagName === options.cdataPropName || rawTagName === options.commentPropName || rawTagName[0] === "?";
    const tagName = isSpecialName ? rawTagName : resolveTagName$1(rawTagName, false, options, matcher, qNameValidator);
    const attrValues = extractAttributeValues(tagObj[":@"], options);
    matcher.push(tagName, attrValues);
    const isStopNode = checkStopNode(matcher, stopNodeExpressions);
    if (tagName === options.textNodeName) {
      let tagText = tagObj[rawTagName];
      if (!isStopNode) {
        tagText = options.tagValueProcessor(tagName, tagText);
        tagText = replaceEntitiesValue(tagText, options);
      }
      tagText = valToStr(tagText);
      if (isPreviousElementTag) {
        xmlStr += indentation;
      }
      xmlStr += tagText;
      isPreviousElementTag = false;
      matcher.pop();
      continue;
    } else if (tagName === options.cdataPropName) {
      if (isPreviousElementTag) {
        xmlStr += indentation;
      }
      const val = tagObj[rawTagName][0][options.textNodeName];
      const safeVal = safeCdata(val);
      xmlStr += `<![CDATA[${safeVal}]]>`;
      isPreviousElementTag = false;
      matcher.pop();
      continue;
    } else if (tagName === options.commentPropName) {
      const val = tagObj[rawTagName][0][options.textNodeName];
      const safeVal = safeComment(val);
      xmlStr += indentation + `<!--${safeVal}-->`;
      isPreviousElementTag = true;
      matcher.pop();
      continue;
    } else if (tagName[0] === "?") {
      const attStr2 = attr_to_str(tagObj[":@"], options, isStopNode, matcher, qNameValidator);
      const tempInd = tagName === "?xml" ? "" : indentation;
      xmlStr += tempInd + `<${tagName}${attStr2}?>`;
      isPreviousElementTag = true;
      matcher.pop();
      continue;
    }
    let newIdentation = indentation;
    if (newIdentation !== "") {
      newIdentation += options.indentBy;
    }
    const attStr = attr_to_str(tagObj[":@"], options, isStopNode, matcher, qNameValidator);
    const tagStart = indentation + `<${tagName}${attStr}`;
    let tagValue;
    if (isStopNode) {
      tagValue = getRawContent(tagObj[rawTagName], options);
    } else {
      tagValue = arrToStr(tagObj[rawTagName], options, newIdentation, matcher, stopNodeExpressions, qNameValidator);
    }
    if (options.unpairedTags.indexOf(tagName) !== -1) {
      if (options.suppressUnpairedNode) xmlStr += tagStart + ">";
      else xmlStr += tagStart + "/>";
    } else if ((!tagValue || tagValue.length === 0) && options.suppressEmptyNode) {
      xmlStr += tagStart + "/>";
    } else if (tagValue && tagValue.endsWith(">")) {
      xmlStr += tagStart + `>${tagValue}${indentation}</${tagName}>`;
    } else {
      xmlStr += tagStart + ">";
      if (tagValue && indentation !== "" && (tagValue.includes("/>") || tagValue.includes("</"))) {
        xmlStr += indentation + options.indentBy + tagValue + indentation;
      } else {
        xmlStr += tagValue;
      }
      xmlStr += `</${tagName}>`;
    }
    isPreviousElementTag = true;
    matcher.pop();
  }
  return xmlStr;
}
function extractAttributeValues(attrMap, options) {
  if (!attrMap || options.ignoreAttributes) return null;
  const attrValues = {};
  let hasAttrs = false;
  for (let attr in attrMap) {
    if (!Object.prototype.hasOwnProperty.call(attrMap, attr)) continue;
    const cleanAttrName = attr.startsWith(options.attributeNamePrefix) ? attr.substr(options.attributeNamePrefix.length) : attr;
    attrValues[cleanAttrName] = escapeAttribute(attrMap[attr]);
    hasAttrs = true;
  }
  return hasAttrs ? attrValues : null;
}
function getRawContent(arr, options) {
  if (!Array.isArray(arr)) {
    if (arr !== void 0 && arr !== null) {
      return valToStr(arr);
    }
    return "";
  }
  let content = "";
  for (let i2 = 0; i2 < arr.length; i2++) {
    const item = arr[i2];
    const tagName = propName(item);
    if (tagName === options.textNodeName) {
      content += valToStr(item[tagName]);
    } else if (tagName === options.cdataPropName) {
      content += item[tagName][0][options.textNodeName];
    } else if (tagName === options.commentPropName) {
      content += item[tagName][0][options.textNodeName];
    } else if (tagName && tagName[0] === "?") {
      continue;
    } else if (tagName) {
      const attStr = attr_to_str_raw(item[":@"], options);
      const nestedContent = getRawContent(item[tagName], options);
      if (!nestedContent || nestedContent.length === 0) {
        content += `<${tagName}${attStr}/>`;
      } else {
        content += `<${tagName}${attStr}>${nestedContent}</${tagName}>`;
      }
    }
  }
  return content;
}
function attr_to_str_raw(attrMap, options) {
  let attrStr = "";
  if (attrMap && !options.ignoreAttributes) {
    for (let attr in attrMap) {
      if (!Object.prototype.hasOwnProperty.call(attrMap, attr)) continue;
      let attrVal = attrMap[attr];
      if (attrVal === true && options.suppressBooleanAttributes) {
        attrStr += ` ${attr.substr(options.attributeNamePrefix.length)}`;
      } else {
        attrStr += ` ${attr.substr(options.attributeNamePrefix.length)}="${escapeAttribute(attrVal)}"`;
      }
    }
  }
  return attrStr;
}
function propName(obj) {
  const keys = Object.keys(obj);
  for (let i2 = 0; i2 < keys.length; i2++) {
    const key = keys[i2];
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    if (key !== ":@") return key;
  }
}
function attr_to_str(attrMap, options, isStopNode, matcher, qNameValidator) {
  let attrStr = "";
  if (attrMap && !options.ignoreAttributes) {
    for (let attr in attrMap) {
      if (!Object.prototype.hasOwnProperty.call(attrMap, attr)) continue;
      const cleanAttrName = attr.substr(options.attributeNamePrefix.length);
      const resolvedAttrName = isStopNode ? cleanAttrName : resolveTagName$1(cleanAttrName, true, options, matcher, qNameValidator);
      let attrVal;
      if (isStopNode) {
        attrVal = attrMap[attr];
      } else {
        attrVal = options.attributeValueProcessor(attr, attrMap[attr]);
        attrVal = replaceEntitiesValue(attrVal, options);
      }
      if (attrVal === true && options.suppressBooleanAttributes) {
        attrStr += ` ${resolvedAttrName}`;
      } else {
        attrStr += ` ${resolvedAttrName}="${escapeAttribute(attrVal)}"`;
      }
    }
  }
  return attrStr;
}
function checkStopNode(matcher, stopNodeExpressions) {
  if (!stopNodeExpressions || stopNodeExpressions.length === 0) return false;
  for (let i2 = 0; i2 < stopNodeExpressions.length; i2++) {
    if (matcher.matches(stopNodeExpressions[i2])) {
      return true;
    }
  }
  return false;
}
function replaceEntitiesValue(textValue, options) {
  if (textValue && textValue.length > 0 && options.processEntities) {
    for (let i2 = 0; i2 < options.entities.length; i2++) {
      const entity = options.entities[i2];
      textValue = textValue.replace(entity.regex, entity.val);
    }
  }
  return textValue;
}
function getIgnoreAttributesFn(ignoreAttributes) {
  if (typeof ignoreAttributes === "function") {
    return ignoreAttributes;
  }
  if (Array.isArray(ignoreAttributes)) {
    return (attrName) => {
      for (const pattern of ignoreAttributes) {
        if (typeof pattern === "string" && attrName === pattern) {
          return true;
        }
        if (pattern instanceof RegExp && pattern.test(attrName)) {
          return true;
        }
      }
    };
  }
  return () => false;
}
const defaultOptions = {
  attributeNamePrefix: "@_",
  attributesGroupName: false,
  textNodeName: "#text",
  ignoreAttributes: true,
  cdataPropName: false,
  format: false,
  indentBy: "  ",
  suppressEmptyNode: false,
  suppressUnpairedNode: true,
  suppressBooleanAttributes: true,
  tagValueProcessor: function(key, a) {
    return a;
  },
  attributeValueProcessor: function(attrName, a) {
    return a;
  },
  preserveOrder: false,
  commentPropName: false,
  unpairedTags: [],
  entities: [
    { regex: new RegExp("&", "g"), val: "&amp;" },
    //it must be on top
    { regex: new RegExp(">", "g"), val: "&gt;" },
    { regex: new RegExp("<", "g"), val: "&lt;" },
    { regex: new RegExp("'", "g"), val: "&apos;" },
    { regex: new RegExp('"', "g"), val: "&quot;" }
  ],
  processEntities: true,
  stopNodes: [],
  // transformTagName: false,
  // transformAttributeName: false,
  oneListGroup: false,
  maxNestedTags: 100,
  jPath: true,
  // When true, callbacks receive string jPath; when false, receive Matcher instance
  sanitizeName: false
  // false = allow all names as-is (default, backward-compatible).
  // Set to a function (name, { isAttribute, matcher }) => string to
  // validate/sanitize tag and attribute names. Throw inside the function
  // to reject an invalid name.
};
function Builder(options) {
  this.options = Object.assign({}, defaultOptions, options);
  if (this.options.stopNodes && Array.isArray(this.options.stopNodes)) {
    this.options.stopNodes = this.options.stopNodes.map((node) => {
      if (typeof node === "string" && node.startsWith("*.")) {
        return ".." + node.substring(2);
      }
      return node;
    });
  }
  this.stopNodeExpressions = [];
  if (this.options.stopNodes && Array.isArray(this.options.stopNodes)) {
    for (let i2 = 0; i2 < this.options.stopNodes.length; i2++) {
      const node = this.options.stopNodes[i2];
      if (typeof node === "string") {
        this.stopNodeExpressions.push(new Expression(node));
      } else if (node instanceof Expression) {
        this.stopNodeExpressions.push(node);
      }
    }
  }
  if (this.options.ignoreAttributes === true || this.options.attributesGroupName) {
    this.isAttribute = function() {
      return false;
    };
  } else {
    this.ignoreAttributesFn = getIgnoreAttributesFn(this.options.ignoreAttributes);
    this.attrPrefixLen = this.options.attributeNamePrefix.length;
    this.isAttribute = isAttribute;
  }
  this.processTextOrObjNode = processTextOrObjNode;
  if (this.options.format) {
    this.indentate = indentate;
    this.tagEndChar = ">\n";
    this.newLine = "\n";
  } else {
    this.indentate = function() {
      return "";
    };
    this.tagEndChar = ">";
    this.newLine = "";
  }
}
function detectXmlVersionFromObj(jObj, options) {
  const decl = jObj["?xml"];
  if (decl && typeof decl === "object") {
    if (options.attributesGroupName && decl[options.attributesGroupName]) {
      const v2 = decl[options.attributesGroupName][options.attributeNamePrefix + "version"];
      if (v2) return v2;
    }
    const v = decl[options.attributeNamePrefix + "version"];
    if (v) return v;
  }
  return "1.0";
}
function resolveTagName(name, isAttribute2, options, matcher, qNameValidator) {
  if (!options.sanitizeName) return name;
  if (qNameValidator(name)) return name;
  return options.sanitizeName(name, { isAttribute: isAttribute2, matcher: matcher.readOnly() });
}
Builder.prototype.build = function(jObj) {
  if (this.options.preserveOrder) {
    return toXml(jObj, this.options);
  } else {
    if (Array.isArray(jObj) && this.options.arrayNodeName && this.options.arrayNodeName.length > 1) {
      jObj = {
        [this.options.arrayNodeName]: jObj
      };
    }
    const matcher = new Matcher();
    const xmlVersion = detectXmlVersionFromObj(jObj, this.options);
    const qNameValidator = createValidator("qName", { xmlVersion });
    return this.j2x(jObj, 0, matcher, qNameValidator).val;
  }
};
Builder.prototype.j2x = function(jObj, level, matcher, qNameValidator) {
  let attrStr = "";
  let val = "";
  if (this.options.maxNestedTags && matcher.getDepth() >= this.options.maxNestedTags) {
    throw new Error("Maximum nested tags exceeded");
  }
  const jPath = this.options.jPath ? matcher.toString() : matcher;
  const isCurrentStopNode = this.checkStopNode(matcher);
  for (let key in jObj) {
    if (!Object.prototype.hasOwnProperty.call(jObj, key)) continue;
    const isSpecialKey = key === this.options.textNodeName || key === this.options.cdataPropName || key === this.options.commentPropName || this.options.attributesGroupName && key === this.options.attributesGroupName || this.isAttribute(key) || key[0] === "?";
    const resolvedKey = isSpecialKey ? key : resolveTagName(key, false, this.options, matcher, qNameValidator);
    if (typeof jObj[key] === "undefined") {
      if (this.isAttribute(key)) {
        val += "";
      }
    } else if (jObj[key] === null) {
      if (this.isAttribute(key)) {
        val += "";
      } else if (resolvedKey === this.options.cdataPropName || resolvedKey === this.options.commentPropName) {
        val += "";
      } else if (resolvedKey[0] === "?") {
        val += this.indentate(level) + "<" + resolvedKey + "?" + this.tagEndChar;
      } else {
        val += this.indentate(level) + "<" + resolvedKey + "/" + this.tagEndChar;
      }
    } else if (jObj[key] instanceof Date) {
      val += this.buildTextValNode(jObj[key], resolvedKey, "", level, matcher);
    } else if (typeof jObj[key] !== "object") {
      const attr = this.isAttribute(key);
      if (attr && !this.ignoreAttributesFn(attr, jPath)) {
        const resolvedAttr = resolveTagName(attr, true, this.options, matcher, qNameValidator);
        attrStr += this.buildAttrPairStr(resolvedAttr, valToStr(jObj[key]), isCurrentStopNode);
      } else if (!attr) {
        if (key === this.options.textNodeName) {
          let newval = this.options.tagValueProcessor(key, valToStr(jObj[key]));
          val += this.replaceEntitiesValue(newval);
        } else {
          matcher.push(resolvedKey);
          const isStopNode = this.checkStopNode(matcher);
          matcher.pop();
          if (isStopNode) {
            const textValue = valToStr(jObj[key]);
            if (textValue === "") {
              val += this.indentate(level) + "<" + resolvedKey + this.closeTag(resolvedKey) + this.tagEndChar;
            } else {
              val += this.indentate(level) + "<" + resolvedKey + ">" + textValue + "</" + resolvedKey + this.tagEndChar;
            }
          } else {
            val += this.buildTextValNode(jObj[key], resolvedKey, "", level, matcher);
          }
        }
      }
    } else if (Array.isArray(jObj[key])) {
      const arrLen = jObj[key].length;
      let listTagVal = "";
      let listTagAttr = "";
      for (let j = 0; j < arrLen; j++) {
        const item = jObj[key][j];
        if (typeof item === "undefined") ;
        else if (item === null) {
          if (resolvedKey[0] === "?") val += this.indentate(level) + "<" + resolvedKey + "?" + this.tagEndChar;
          else val += this.indentate(level) + "<" + resolvedKey + "/" + this.tagEndChar;
        } else if (typeof item === "object") {
          if (this.options.oneListGroup) {
            matcher.push(resolvedKey);
            const result = this.j2x(item, level + 1, matcher, qNameValidator);
            matcher.pop();
            listTagVal += result.val;
            if (this.options.attributesGroupName && item.hasOwnProperty(this.options.attributesGroupName)) {
              listTagAttr += result.attrStr;
            }
          } else {
            listTagVal += this.processTextOrObjNode(item, resolvedKey, level, matcher, qNameValidator);
          }
        } else {
          if (this.options.oneListGroup) {
            let textValue = this.options.tagValueProcessor(resolvedKey, item);
            textValue = this.replaceEntitiesValue(textValue);
            textValue = valToStr(textValue);
            listTagVal += textValue;
          } else {
            matcher.push(resolvedKey);
            const isStopNode = this.checkStopNode(matcher);
            matcher.pop();
            if (isStopNode) {
              const textValue = valToStr(item);
              if (textValue === "") {
                listTagVal += this.indentate(level) + "<" + resolvedKey + this.closeTag(resolvedKey) + this.tagEndChar;
              } else {
                listTagVal += this.indentate(level) + "<" + resolvedKey + ">" + textValue + "</" + resolvedKey + this.tagEndChar;
              }
            } else {
              listTagVal += this.buildTextValNode(item, resolvedKey, "", level, matcher);
            }
          }
        }
      }
      if (this.options.oneListGroup) {
        listTagVal = this.buildObjectNode(listTagVal, resolvedKey, listTagAttr, level);
      }
      val += listTagVal;
    } else {
      if (this.options.attributesGroupName && key === this.options.attributesGroupName) {
        const Ks = Object.keys(jObj[key]);
        const L = Ks.length;
        for (let j = 0; j < L; j++) {
          const resolvedAttr = resolveTagName(Ks[j], true, this.options, matcher, qNameValidator);
          attrStr += this.buildAttrPairStr(resolvedAttr, valToStr(jObj[key][Ks[j]]), isCurrentStopNode);
        }
      } else {
        val += this.processTextOrObjNode(jObj[key], resolvedKey, level, matcher, qNameValidator);
      }
    }
  }
  return { attrStr, val };
};
Builder.prototype.buildAttrPairStr = function(attrName, val, isStopNode) {
  if (!isStopNode) {
    val = this.options.attributeValueProcessor(attrName, valToStr(val));
    val = this.replaceEntitiesValue(val);
  }
  if (this.options.suppressBooleanAttributes && val === "true") {
    return " " + attrName;
  } else return " " + attrName + '="' + escapeAttribute(val) + '"';
};
function processTextOrObjNode(object, key, level, matcher, qNameValidator) {
  const attrValues = this.extractAttributes(object);
  matcher.push(key, attrValues);
  const isStopNode = this.checkStopNode(matcher);
  if (isStopNode) {
    const rawContent = this.buildRawContent(object);
    const attrStr = this.buildAttributesForStopNode(object);
    matcher.pop();
    return this.buildObjectNode(rawContent, key, attrStr, level);
  }
  const result = this.j2x(object, level + 1, matcher, qNameValidator);
  matcher.pop();
  if (key[0] === "?") {
    return this.buildTextValNode("", key, result.attrStr, level, matcher);
  } else if (object[this.options.textNodeName] !== void 0 && Object.keys(object).length === 1) {
    return this.buildTextValNode(object[this.options.textNodeName], key, result.attrStr, level, matcher);
  } else {
    return this.buildObjectNode(result.val, key, result.attrStr, level);
  }
}
Builder.prototype.extractAttributes = function(obj) {
  if (!obj || typeof obj !== "object") return null;
  const attrValues = {};
  let hasAttrs = false;
  if (this.options.attributesGroupName && obj[this.options.attributesGroupName]) {
    const attrGroup = obj[this.options.attributesGroupName];
    for (let attrKey in attrGroup) {
      if (!Object.prototype.hasOwnProperty.call(attrGroup, attrKey)) continue;
      const cleanKey = attrKey.startsWith(this.options.attributeNamePrefix) ? attrKey.substring(this.options.attributeNamePrefix.length) : attrKey;
      attrValues[cleanKey] = escapeAttribute(attrGroup[attrKey]);
      hasAttrs = true;
    }
  } else {
    for (let key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      const attr = this.isAttribute(key);
      if (attr) {
        attrValues[attr] = escapeAttribute(obj[key]);
        hasAttrs = true;
      }
    }
  }
  return hasAttrs ? attrValues : null;
};
Builder.prototype.buildRawContent = function(obj) {
  if (typeof obj === "string") {
    return obj;
  }
  if (typeof obj !== "object" || obj === null) {
    return String(obj);
  }
  if (obj[this.options.textNodeName] !== void 0) {
    return obj[this.options.textNodeName];
  }
  let content = "";
  for (let key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    if (this.isAttribute(key)) continue;
    if (this.options.attributesGroupName && key === this.options.attributesGroupName) continue;
    const value = obj[key];
    if (key === this.options.textNodeName) {
      content += value;
    } else if (Array.isArray(value)) {
      for (let item of value) {
        if (typeof item === "string" || typeof item === "number") {
          content += `<${key}>${item}</${key}>`;
        } else if (typeof item === "object" && item !== null) {
          const nestedContent = this.buildRawContent(item);
          const nestedAttrs = this.buildAttributesForStopNode(item);
          if (nestedContent === "") {
            content += `<${key}${nestedAttrs}/>`;
          } else {
            content += `<${key}${nestedAttrs}>${nestedContent}</${key}>`;
          }
        }
      }
    } else if (typeof value === "object" && value !== null) {
      const nestedContent = this.buildRawContent(value);
      const nestedAttrs = this.buildAttributesForStopNode(value);
      if (nestedContent === "") {
        content += `<${key}${nestedAttrs}/>`;
      } else {
        content += `<${key}${nestedAttrs}>${nestedContent}</${key}>`;
      }
    } else {
      content += `<${key}>${value}</${key}>`;
    }
  }
  return content;
};
Builder.prototype.buildAttributesForStopNode = function(obj) {
  if (!obj || typeof obj !== "object") return "";
  let attrStr = "";
  if (this.options.attributesGroupName && obj[this.options.attributesGroupName]) {
    const attrGroup = obj[this.options.attributesGroupName];
    for (let attrKey in attrGroup) {
      if (!Object.prototype.hasOwnProperty.call(attrGroup, attrKey)) continue;
      const cleanKey = attrKey.startsWith(this.options.attributeNamePrefix) ? attrKey.substring(this.options.attributeNamePrefix.length) : attrKey;
      const val = attrGroup[attrKey];
      if (val === true && this.options.suppressBooleanAttributes) {
        attrStr += " " + cleanKey;
      } else {
        attrStr += " " + cleanKey + '="' + escapeAttribute(val) + '"';
      }
    }
  } else {
    for (let key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      const attr = this.isAttribute(key);
      if (attr) {
        const val = obj[key];
        if (val === true && this.options.suppressBooleanAttributes) {
          attrStr += " " + attr;
        } else {
          attrStr += " " + attr + '="' + escapeAttribute(val) + '"';
        }
      }
    }
  }
  return attrStr;
};
Builder.prototype.buildObjectNode = function(val, key, attrStr, level) {
  if (val === "") {
    if (key[0] === "?") return this.indentate(level) + "<" + key + attrStr + "?" + this.tagEndChar;
    else {
      return this.indentate(level) + "<" + key + attrStr + this.closeTag(key) + this.tagEndChar;
    }
  } else if (key[0] === "?") {
    return this.indentate(level) + "<" + key + attrStr + "?" + this.tagEndChar;
  } else {
    let tagEndExp = "</" + key + this.tagEndChar;
    let piClosingChar = "";
    if (key[0] === "?") {
      piClosingChar = "?";
      tagEndExp = "";
    }
    if ((attrStr || attrStr === "") && val.indexOf("<") === -1) {
      return this.indentate(level) + "<" + key + attrStr + piClosingChar + ">" + val + tagEndExp;
    } else if (this.options.commentPropName !== false && key === this.options.commentPropName && piClosingChar.length === 0) {
      return this.indentate(level) + `<!--${safeComment(val)}-->` + this.newLine;
    } else {
      return this.indentate(level) + "<" + key + attrStr + piClosingChar + this.tagEndChar + val + this.indentate(level) + tagEndExp;
    }
  }
};
Builder.prototype.closeTag = function(key) {
  let closeTag = "";
  if (this.options.unpairedTags.indexOf(key) !== -1) {
    if (!this.options.suppressUnpairedNode) closeTag = "/";
  } else if (this.options.suppressEmptyNode) {
    closeTag = "/";
  } else {
    closeTag = `></${key}`;
  }
  return closeTag;
};
Builder.prototype.checkStopNode = function(matcher) {
  if (!this.stopNodeExpressions || this.stopNodeExpressions.length === 0) return false;
  for (let i2 = 0; i2 < this.stopNodeExpressions.length; i2++) {
    if (matcher.matches(this.stopNodeExpressions[i2])) {
      return true;
    }
  }
  return false;
};
Builder.prototype.buildTextValNode = function(val, key, attrStr, level, matcher) {
  if (this.options.cdataPropName !== false && key === this.options.cdataPropName) {
    const safeVal = safeCdata(val);
    return this.indentate(level) + `<![CDATA[${safeVal}]]>` + this.newLine;
  } else if (this.options.commentPropName !== false && key === this.options.commentPropName) {
    const safeVal = safeComment(val);
    return this.indentate(level) + `<!--${safeVal}-->` + this.newLine;
  } else if (key[0] === "?") {
    return this.indentate(level) + "<" + key + attrStr + "?" + this.tagEndChar;
  } else {
    let textValue = this.options.tagValueProcessor(key, val);
    textValue = this.replaceEntitiesValue(textValue);
    textValue = valToStr(textValue);
    if (textValue === "") {
      return this.indentate(level) + "<" + key + attrStr + this.closeTag(key) + this.tagEndChar;
    } else {
      return this.indentate(level) + "<" + key + attrStr + ">" + textValue + "</" + key + this.tagEndChar;
    }
  }
};
Builder.prototype.replaceEntitiesValue = function(textValue) {
  if (textValue && textValue.length > 0 && this.options.processEntities) {
    for (let i2 = 0; i2 < this.options.entities.length; i2++) {
      const entity = this.options.entities[i2];
      textValue = textValue.replace(entity.regex, entity.val);
    }
  }
  return textValue;
};
function indentate(level) {
  return this.options.indentBy.repeat(level);
}
function isAttribute(name) {
  if (name.startsWith(this.options.attributeNamePrefix) && name !== this.options.textNodeName) {
    return name.substr(this.attrPrefixLen);
  } else {
    return false;
  }
}
var nestedProperty;
var hasRequiredNestedProperty;
function requireNestedProperty() {
  if (hasRequiredNestedProperty) return nestedProperty;
  hasRequiredNestedProperty = 1;
  function _typeof(obj) {
    "@babel/helpers - typeof";
    if (typeof Symbol === "function" && typeof Symbol.iterator === "symbol") {
      _typeof = function _typeof2(obj2) {
        return typeof obj2;
      };
    } else {
      _typeof = function _typeof2(obj2) {
        return obj2 && typeof Symbol === "function" && obj2.constructor === Symbol && obj2 !== Symbol.prototype ? "symbol" : typeof obj2;
      };
    }
    return _typeof(obj);
  }
  function _classCallCheck(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  }
  function _possibleConstructorReturn(self2, call) {
    if (call && (_typeof(call) === "object" || typeof call === "function")) {
      return call;
    }
    return _assertThisInitialized(self2);
  }
  function _assertThisInitialized(self2) {
    if (self2 === void 0) {
      throw new ReferenceError("this hasn't been initialised - super() hasn't been called");
    }
    return self2;
  }
  function _inherits(subClass, superClass) {
    if (typeof superClass !== "function" && superClass !== null) {
      throw new TypeError("Super expression must either be null or a function");
    }
    subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, writable: true, configurable: true } });
    if (superClass) _setPrototypeOf(subClass, superClass);
  }
  function _wrapNativeSuper(Class) {
    var _cache = typeof Map === "function" ? /* @__PURE__ */ new Map() : void 0;
    _wrapNativeSuper = function _wrapNativeSuper2(Class2) {
      if (Class2 === null || !_isNativeFunction(Class2)) return Class2;
      if (typeof Class2 !== "function") {
        throw new TypeError("Super expression must either be null or a function");
      }
      if (typeof _cache !== "undefined") {
        if (_cache.has(Class2)) return _cache.get(Class2);
        _cache.set(Class2, Wrapper);
      }
      function Wrapper() {
        return _construct(Class2, arguments, _getPrototypeOf(this).constructor);
      }
      Wrapper.prototype = Object.create(Class2.prototype, { constructor: { value: Wrapper, enumerable: false, writable: true, configurable: true } });
      return _setPrototypeOf(Wrapper, Class2);
    };
    return _wrapNativeSuper(Class);
  }
  function _construct(Parent, args, Class) {
    if (_isNativeReflectConstruct()) {
      _construct = Reflect.construct;
    } else {
      _construct = function _construct2(Parent2, args2, Class2) {
        var a = [null];
        a.push.apply(a, args2);
        var Constructor = Function.bind.apply(Parent2, a);
        var instance = new Constructor();
        if (Class2) _setPrototypeOf(instance, Class2.prototype);
        return instance;
      };
    }
    return _construct.apply(null, arguments);
  }
  function _isNativeReflectConstruct() {
    if (typeof Reflect === "undefined" || !Reflect.construct) return false;
    if (Reflect.construct.sham) return false;
    if (typeof Proxy === "function") return true;
    try {
      Date.prototype.toString.call(Reflect.construct(Date, [], function() {
      }));
      return true;
    } catch (e2) {
      return false;
    }
  }
  function _isNativeFunction(fn) {
    return Function.toString.call(fn).indexOf("[native code]") !== -1;
  }
  function _setPrototypeOf(o, p) {
    _setPrototypeOf = Object.setPrototypeOf || function _setPrototypeOf2(o2, p2) {
      o2.__proto__ = p2;
      return o2;
    };
    return _setPrototypeOf(o, p);
  }
  function _getPrototypeOf(o) {
    _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf : function _getPrototypeOf2(o2) {
      return o2.__proto__ || Object.getPrototypeOf(o2);
    };
    return _getPrototypeOf(o);
  }
  var ARRAY_WILDCARD = "+";
  var PATH_DELIMITER = ".";
  var ObjectPrototypeMutationError = /* @__PURE__ */ (function(_Error) {
    _inherits(ObjectPrototypeMutationError2, _Error);
    function ObjectPrototypeMutationError2(params) {
      var _this;
      _classCallCheck(this, ObjectPrototypeMutationError2);
      _this = _possibleConstructorReturn(this, _getPrototypeOf(ObjectPrototypeMutationError2).call(this, params));
      _this.name = "ObjectPrototypeMutationError";
      return _this;
    }
    return ObjectPrototypeMutationError2;
  })(_wrapNativeSuper(Error));
  nestedProperty = {
    set: setNestedProperty,
    get: getNestedProperty,
    has: hasNestedProperty,
    hasOwn: function hasOwn(object, property, options) {
      return this.has(object, property, options || {
        own: true
      });
    },
    isIn: isInNestedProperty,
    ObjectPrototypeMutationError
  };
  function getNestedProperty(object, property) {
    if (_typeof(object) != "object" || object === null) {
      return object;
    }
    if (typeof property == "undefined") {
      return object;
    }
    if (typeof property == "number") {
      return object[property];
    }
    try {
      return traverse(object, property, function _getNestedProperty(currentObject, currentProperty) {
        return currentObject[currentProperty];
      });
    } catch (err) {
      return object;
    }
  }
  function hasNestedProperty(object, property) {
    var options = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {};
    if (_typeof(object) != "object" || object === null) {
      return false;
    }
    if (typeof property == "undefined") {
      return false;
    }
    if (typeof property == "number") {
      return property in object;
    }
    try {
      var has = false;
      traverse(object, property, function _hasNestedProperty(currentObject, currentProperty, segments, index) {
        if (isLastSegment(segments, index)) {
          if (options.own) {
            has = currentObject.hasOwnProperty(currentProperty);
          } else {
            has = currentProperty in currentObject;
          }
        } else {
          return currentObject && currentObject[currentProperty];
        }
      });
      return has;
    } catch (err) {
      return false;
    }
  }
  function setNestedProperty(object, property, value) {
    if (_typeof(object) != "object" || object === null) {
      return object;
    }
    if (typeof property == "undefined") {
      return object;
    }
    if (typeof property == "number") {
      object[property] = value;
      return object[property];
    }
    try {
      return traverse(object, property, function _setNestedProperty(currentObject, currentProperty, segments, index) {
        if (currentObject === Reflect.getPrototypeOf({})) {
          throw new ObjectPrototypeMutationError("Attempting to mutate Object.prototype");
        }
        if (!currentObject[currentProperty]) {
          var nextPropIsNumber = Number.isInteger(Number(segments[index + 1]));
          var nextPropIsArrayWildcard = segments[index + 1] === ARRAY_WILDCARD;
          if (nextPropIsNumber || nextPropIsArrayWildcard) {
            currentObject[currentProperty] = [];
          } else {
            currentObject[currentProperty] = {};
          }
        }
        if (isLastSegment(segments, index)) {
          currentObject[currentProperty] = value;
        }
        return currentObject[currentProperty];
      });
    } catch (err) {
      if (err instanceof ObjectPrototypeMutationError) {
        throw err;
      } else {
        return object;
      }
    }
  }
  function isInNestedProperty(object, property, objectInPath) {
    var options = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : {};
    if (_typeof(object) != "object" || object === null) {
      return false;
    }
    if (typeof property == "undefined") {
      return false;
    }
    try {
      var isIn = false, pathExists = false;
      traverse(object, property, function _isInNestedProperty(currentObject, currentProperty, segments, index) {
        isIn = isIn || currentObject === objectInPath || !!currentObject && currentObject[currentProperty] === objectInPath;
        pathExists = isLastSegment(segments, index) && _typeof(currentObject) === "object" && currentProperty in currentObject;
        return currentObject && currentObject[currentProperty];
      });
      if (options.validPath) {
        return isIn && pathExists;
      } else {
        return isIn;
      }
    } catch (err) {
      return false;
    }
  }
  function traverse(object, path2) {
    var callback = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : function() {
    };
    var segments = path2.split(PATH_DELIMITER);
    var length = segments.length;
    var _loop = function _loop2(idx2) {
      var currentSegment = segments[idx2];
      if (!object) {
        return {
          v: void 0
        };
      }
      if (currentSegment === ARRAY_WILDCARD) {
        if (Array.isArray(object)) {
          return {
            v: object.map(function(value, index) {
              var remainingSegments = segments.slice(idx2 + 1);
              if (remainingSegments.length > 0) {
                return traverse(value, remainingSegments.join(PATH_DELIMITER), callback);
              } else {
                return callback(object, index, segments, idx2);
              }
            })
          };
        } else {
          var pathToHere = segments.slice(0, idx2).join(PATH_DELIMITER);
          throw new Error("Object at wildcard (".concat(pathToHere, ") is not an array"));
        }
      } else {
        object = callback(object, currentSegment, segments, idx2);
      }
    };
    for (var idx = 0; idx < length; idx++) {
      var _ret = _loop(idx);
      if (_typeof(_ret) === "object") return _ret.v;
    }
    return object;
  }
  function isLastSegment(segments, index) {
    return segments.length === index + 1;
  }
  return nestedProperty;
}
var nestedPropertyExports = requireNestedProperty();
const nestedProp = /* @__PURE__ */ getDefaultExportFromCjs(nestedPropertyExports);
var PropertyType;
(function(PropertyType2) {
  PropertyType2["Array"] = "array";
  PropertyType2["Object"] = "object";
  PropertyType2["Original"] = "original";
})(PropertyType || (PropertyType = {}));
function toJPathString(jPath) {
  if (typeof jPath === "string") {
    return jPath;
  }
  return jPath.toString(".", false);
}
function getParser$1({ attributeNamePrefix, attributeParsers, entityDecoder: entityDecoderOptions, tagParsers }) {
  const parserOptions = {
    allowBooleanAttributes: true,
    attributeNamePrefix,
    textNodeName: "text",
    ignoreAttributes: false,
    removeNSPrefix: true,
    jPath: false,
    numberParseOptions: {
      hex: true,
      leadingZeros: false
    },
    attributeValueProcessor(_, attrValue, jPath) {
      const pathStr = toJPathString(jPath);
      for (const processor of attributeParsers) {
        try {
          const value = processor(pathStr, attrValue);
          if (value !== attrValue) {
            return value;
          }
        } catch (error) {
        }
      }
      return attrValue;
    },
    tagValueProcessor(tagName, tagValue, jPath) {
      const pathStr = toJPathString(jPath);
      for (const processor of tagParsers) {
        try {
          const value = processor(pathStr, tagValue);
          if (value !== tagValue) {
            return value;
          }
        } catch (error) {
        }
      }
      return tagValue;
    }
  };
  if (entityDecoderOptions) {
    parserOptions.entityDecoder = new EntityDecoder({
      limit: {
        maxTotalExpansions: entityDecoderOptions.limit?.maxTotalExpansions ?? 0,
        maxExpandedLength: entityDecoderOptions.limit?.maxExpandedLength ?? 0
      }
    });
  }
  return new XMLParser(parserOptions);
}
function displaynameTagParser(path2, value) {
  if (path2.endsWith("propstat.prop.displayname")) {
    return;
  }
  return value;
}
function getPropertyOfType(obj, prop, type = PropertyType.Original) {
  const val = nestedProp.get(obj, prop);
  if (type === "array" && Array.isArray(val) === false) {
    return [val];
  } else if (type === "object" && Array.isArray(val)) {
    return val[0];
  }
  return val;
}
function normaliseResponse(response) {
  const output = Object.assign({}, response);
  if (output.status) {
    nestedProp.set(output, "status", getPropertyOfType(output, "status", PropertyType.Object));
  } else {
    nestedProp.set(output, "propstat", getPropertyOfType(output, "propstat", PropertyType.Object));
    nestedProp.set(output, "propstat.prop", getPropertyOfType(output, "propstat.prop", PropertyType.Object));
  }
  return output;
}
function normaliseResult(result) {
  const { multistatus } = result;
  if (multistatus === "") {
    return {
      multistatus: {
        response: []
      }
    };
  }
  if (!multistatus) {
    throw new Error("Invalid response: No root multistatus found");
  }
  const output = {
    multistatus: Array.isArray(multistatus) ? multistatus[0] : multistatus
  };
  nestedProp.set(output, "multistatus.response", getPropertyOfType(output, "multistatus.response", PropertyType.Array));
  nestedProp.set(output, "multistatus.response", nestedProp.get(output, "multistatus.response").map((response) => normaliseResponse(response)));
  return output;
}
function parseXML(xml, context) {
  context = context ?? {
    attributeNamePrefix: "@",
    attributeParsers: [],
    tagParsers: [displaynameTagParser]
  };
  return new Promise((resolve) => {
    const result = getParser$1(context).parse(xml);
    resolve(normaliseResult(result));
  });
}
function prepareFileFromProps(props, filename, isDetailed = false) {
  const { getlastmodified: lastMod = null, getcontentlength: rawSize = "0", resourcetype: resourceType = null, getcontenttype: mimeType = null, getetag: etag = null } = props;
  const type = resourceType && typeof resourceType === "object" && typeof resourceType.collection !== "undefined" ? "directory" : "file";
  const stat2 = {
    filename,
    basename: pathPosix.basename(filename),
    lastmod: lastMod,
    size: parseInt(rawSize, 10),
    type,
    etag: typeof etag === "string" ? etag.replace(/"/g, "") : null
  };
  if (type === "file") {
    stat2.mime = mimeType && typeof mimeType === "string" ? mimeType.split(";")[0] : "";
  }
  if (isDetailed) {
    if (typeof props.displayname !== "undefined") {
      props.displayname = String(props.displayname);
    }
    stat2.props = props;
  }
  return stat2;
}
function parseStat(result, filename, isDetailed = false) {
  let responseItem = null;
  try {
    if (result.multistatus.response[0].propstat) {
      responseItem = result.multistatus.response[0];
    }
  } catch (e2) {
  }
  if (!responseItem) {
    throw new Error("Failed getting item stat: bad response");
  }
  const { propstat: { prop: props, status: statusLine } } = responseItem;
  const [_, statusCodeStr, statusText] = statusLine.split(" ", 3);
  const statusCode = parseInt(statusCodeStr, 10);
  if (statusCode >= 400) {
    const err = new Error(`Invalid response: ${statusCode} ${statusText}`);
    err.status = statusCode;
    throw err;
  }
  const filePath = normalisePath(filename);
  return prepareFileFromProps(props, filePath, isDetailed);
}
function parseSearch(result, searchArbiter, isDetailed) {
  const response = {
    truncated: false,
    results: []
  };
  response.truncated = result.multistatus.response.some((v) => {
    return (v.status || v.propstat?.status).split(" ", 3)?.[1] === "507" && v.href.replace(/\/$/, "").endsWith(encodePath(searchArbiter).replace(/\/$/, ""));
  });
  result.multistatus.response.forEach((result2) => {
    if (result2.propstat === void 0) {
      return;
    }
    const filename = result2.href.split("/").map(decodeURIComponent).join("/");
    response.results.push(prepareFileFromProps(result2.propstat.prop, filename, isDetailed));
  });
  return response;
}
function translateDiskSpace(value) {
  switch (String(value)) {
    case "-3":
      return "unlimited";
    case "-2":
    /* falls-through */
    case "-1":
      return "unknown";
    default:
      return parseInt(String(value), 10);
  }
}
async function getStat(context, filename, options = {}) {
  const { details: isDetailed = false } = options;
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filename)),
    method: "PROPFIND",
    headers: {
      Accept: "text/plain,application/xml",
      Depth: "0"
    }
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
  const responseData = await response.text();
  const result = await parseXML(responseData, context.parsing);
  const stat2 = parseStat(result, filename, isDetailed);
  return processResponsePayload(response, stat2, isDetailed);
}
async function createDirectory(context, dirPath, options = {}) {
  if (options.recursive === true)
    return createDirectoryRecursively(context, dirPath, options);
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, ensureCollectionPath(encodePath(dirPath))),
    method: "MKCOL"
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
}
function ensureCollectionPath(path2) {
  if (!path2.endsWith("/")) {
    return path2 + "/";
  }
  return path2;
}
async function createDirectoryRecursively(context, dirPath, options = {}) {
  const paths = getAllDirectories(normalisePath(dirPath));
  paths.sort((a, b) => {
    if (a.length > b.length) {
      return 1;
    } else if (b.length > a.length) {
      return -1;
    }
    return 0;
  });
  let creating = false;
  for (const testPath of paths) {
    if (creating) {
      await createDirectory(context, testPath, {
        ...options,
        recursive: false
      });
      continue;
    }
    try {
      const testStat = await getStat(context, testPath);
      if (testStat.type !== "directory") {
        throw new Error(`Path includes a file: ${dirPath}`);
      }
    } catch (err) {
      const error = err;
      if (error.status === 404) {
        creating = true;
        await createDirectory(context, testPath, {
          ...options,
          recursive: false
        });
      } else {
        throw err;
      }
    }
  }
}
const NOOP = () => {
};
function createReadStream(context, filePath, options = {}) {
  const PassThroughStream = Stream$1.PassThrough;
  const outStream = new PassThroughStream();
  getFileStream(context, filePath, options).then((stream) => {
    stream.pipe(outStream);
  }).catch((err) => {
    outStream.emit("error", err);
  });
  return outStream;
}
function createWriteStream(context, filePath, options = {}, callback = NOOP) {
  const PassThroughStream = Stream$1.PassThrough;
  const writeStream = new PassThroughStream();
  const headers = {};
  if (options.overwrite === false) {
    headers["If-None-Match"] = "*";
  }
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filePath)),
    method: "PUT",
    headers,
    data: writeStream,
    maxRedirects: 0
  }, context, options);
  request(requestOptions, context).then((response) => handleResponseCode(context, response)).then((response) => {
    setTimeout(() => {
      callback(response);
    }, 0);
  }).catch((err) => {
    writeStream.emit("error", err);
  });
  return writeStream;
}
async function getFileStream(context, filePath, options = {}) {
  const headers = {};
  if (typeof options.range === "object" && typeof options.range.start === "number") {
    let rangeHeader = `bytes=${options.range.start}-`;
    if (typeof options.range.end === "number") {
      rangeHeader = `${rangeHeader}${options.range.end}`;
    }
    headers.Range = rangeHeader;
  }
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filePath)),
    method: "GET",
    headers
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
  if (headers.Range && response.status !== 206) {
    const responseError = new Error(`Invalid response code for partial request: ${response.status}`);
    responseError.status = response.status;
    throw responseError;
  }
  if (options.callback) {
    setTimeout(() => {
      options.callback(response);
    }, 0);
  }
  return response.body;
}
async function customRequest(context, remotePath, requestOptions) {
  if (!requestOptions.url) {
    requestOptions.url = joinURL(context.remoteURL, encodePath(remotePath));
  }
  const finalOptions = prepareRequestOptions(requestOptions, context, {});
  const response = await request(finalOptions, context);
  handleResponseCode(context, response);
  return response;
}
async function deleteFile(context, filename, options = {}) {
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filename)),
    method: "DELETE"
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
}
async function exists(context, remotePath, options = {}) {
  try {
    await getStat(context, remotePath, options);
    return true;
  } catch (err) {
    if (err.status === 404) {
      return false;
    }
    throw err;
  }
}
async function getDirectoryContents(context, remotePath, options = {}) {
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(remotePath), "/"),
    method: "PROPFIND",
    headers: {
      Accept: "text/plain,application/xml",
      Depth: options.deep ? "infinity" : "1"
    }
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
  const responseData = await response.text();
  if (!responseData) {
    throw new Error("Failed parsing directory contents: Empty response");
  }
  const davResp = await parseXML(responseData, context.parsing);
  const _remotePath = makePathAbsolute(remotePath);
  const remoteBasePath = makePathAbsolute(context.remoteBasePath || context.remotePath);
  let files = getDirectoryFiles(davResp, remoteBasePath, _remotePath, options.details, options.includeSelf);
  if (options.glob) {
    files = processGlobFilter(files, options.glob);
  }
  return processResponsePayload(response, files, options.details);
}
function getDirectoryFiles(result, serverremoteBasePath, requestPath, isDetailed = false, includeSelf = false) {
  const serverBase = pathPosix.join(serverremoteBasePath, "/");
  const { multistatus: { response: responseItems } } = result;
  const nodes = responseItems.map((item) => {
    const href = normaliseHREF(item.href);
    const { propstat: { prop: props } } = item;
    const filename = serverBase === "/" ? decodeURIComponent(normalisePath(href)) : normalisePath(pathPosix.relative(decodeURIComponent(serverBase), decodeURIComponent(href)));
    return prepareFileFromProps(props, filename, isDetailed);
  });
  if (includeSelf) {
    return nodes;
  }
  return nodes.filter((item) => item.basename && (item.type === "file" || item.filename !== requestPath.replace(/\/$/, "")));
}
const TRANSFORM_RETAIN_FORMAT = (v) => v;
async function getFileContents(context, filePath, options = {}) {
  const { format: format2 = "binary" } = options;
  if (format2 !== "binary" && format2 !== "text") {
    throw new Layerr({
      info: {
        code: ErrorCode.InvalidOutputFormat
      }
    }, `Invalid output format: ${format2}`);
  }
  return format2 === "text" ? getFileContentsString(context, filePath, options) : getFileContentsBuffer(context, filePath, options);
}
async function getFileContentsBuffer(context, filePath, options = {}) {
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filePath)),
    method: "GET"
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
  let body;
  if (isWeb() || isReactNative()) {
    body = await response.arrayBuffer();
  } else {
    body = Buffer.from(await response.arrayBuffer());
  }
  return processResponsePayload(response, body, options.details);
}
async function getFileContentsString(context, filePath, options = {}) {
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filePath)),
    method: "GET",
    headers: {
      Accept: "text/plain"
    },
    transformResponse: [TRANSFORM_RETAIN_FORMAT]
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
  const body = await response.text();
  return processResponsePayload(response, body, options.details);
}
function getFileDownloadLink(context, filePath) {
  let url = joinURL(context.remoteURL, encodePath(filePath));
  const protocol = /^https:/i.test(url) ? "https" : "http";
  switch (context.authType) {
    case AuthType.None:
      break;
    case AuthType.Password: {
      const authPart = context.headers.Authorization.replace(/^Basic /i, "").trim();
      const authContents = fromBase64(authPart);
      url = url.replace(/^https?:\/\//, `${protocol}://${authContents}@`);
      break;
    }
    default:
      throw new Layerr({
        info: {
          code: ErrorCode.LinkUnsupportedAuthType
        }
      }, `Unsupported auth type for file link: ${context.authType}`);
  }
  return url;
}
function generateLockXML(ownerHREF) {
  return getBuilder().build(namespace({
    lockinfo: {
      "@_xmlns:d": "DAV:",
      lockscope: {
        exclusive: {}
      },
      locktype: {
        write: {}
      },
      owner: {
        href: ownerHREF
      }
    }
  }, "d"));
}
function getBuilder() {
  return new Builder({
    attributeNamePrefix: "@_",
    format: true,
    ignoreAttributes: false,
    suppressEmptyNode: true
  });
}
function getParser() {
  return new XMLParser({
    removeNSPrefix: true,
    parseAttributeValue: true,
    parseTagValue: true
  });
}
function namespace(obj, ns) {
  const copy = { ...obj };
  for (const key in copy) {
    if (!copy.hasOwnProperty(key)) {
      continue;
    }
    if (copy[key] && typeof copy[key] === "object" && key.indexOf(":") === -1) {
      copy[`${ns}:${key}`] = namespace(copy[key], ns);
      delete copy[key];
    } else if (/^@_/.test(key) === false) {
      copy[`${ns}:${key}`] = copy[key];
      delete copy[key];
    }
  }
  return copy;
}
function parseGenericResponse(xml) {
  return getParser().parse(xml);
}
const DEFAULT_TIMEOUT = "Infinite, Second-4100000000";
async function lock(context, path2, options = {}) {
  const { refreshToken, timeout = DEFAULT_TIMEOUT } = options;
  const headers = {
    Accept: "text/plain,application/xml",
    Timeout: timeout
  };
  if (refreshToken) {
    headers.If = refreshToken;
  }
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(path2)),
    method: "LOCK",
    headers,
    data: generateLockXML(context.contactHref)
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
  const responseData = await response.text();
  const lockPayload = parseGenericResponse(responseData);
  const token = nestedProp.get(lockPayload, "prop.lockdiscovery.activelock.locktoken.href");
  const serverTimeout = nestedProp.get(lockPayload, "prop.lockdiscovery.activelock.timeout");
  if (!token) {
    const err = createErrorFromResponse(response, "No lock token received: ");
    throw err;
  }
  return {
    token,
    serverTimeout
  };
}
async function unlock(context, path2, token, options = {}) {
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(path2)),
    method: "UNLOCK",
    headers: {
      "Lock-Token": token
    }
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
  if (response.status !== 204 && response.status !== 200) {
    const err = createErrorFromResponse(response);
    throw err;
  }
}
function parseQuota(result) {
  try {
    const [responseItem] = result.multistatus.response;
    const { propstat: { prop: { "quota-used-bytes": quotaUsed, "quota-available-bytes": quotaAvail } } } = responseItem;
    return typeof quotaUsed !== "undefined" && typeof quotaAvail !== "undefined" ? {
      // As it could be both a string or a number ensure we are working with a number
      used: parseInt(String(quotaUsed), 10),
      available: translateDiskSpace(quotaAvail)
    } : null;
  } catch (err) {
  }
  return null;
}
async function getQuota(context, options = {}) {
  const path2 = options.path || "/";
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, path2),
    method: "PROPFIND",
    headers: {
      Accept: "text/plain,application/xml",
      Depth: "0"
    }
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
  const responseData = await response.text();
  const result = await parseXML(responseData, context.parsing);
  const quota = parseQuota(result);
  return processResponsePayload(response, quota, options.details);
}
async function getSearch(context, searchArbiter, options = {}) {
  const { details: isDetailed = false } = options;
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(searchArbiter)),
    method: "SEARCH",
    headers: {
      Accept: "text/plain,application/xml",
      // Ensure a Content-Type header is set was this is required by e.g. sabre/dav
      "Content-Type": context.headers["Content-Type"] || "application/xml; charset=utf-8"
    }
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
  const responseText = await response.text();
  const responseData = await parseXML(responseText, context.parsing);
  const results = parseSearch(responseData, searchArbiter, isDetailed);
  return processResponsePayload(response, results, isDetailed);
}
async function moveFile(context, filename, destination, options = {}) {
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filename)),
    method: "MOVE",
    headers: {
      Destination: joinURL(context.remoteURL, encodePath(destination)),
      /**
       * From RFC4918 section 10.6: If the overwrite header is not included in a COPY or MOVE request,
       * then the resource MUST treat the request as if it has an overwrite header of value "T".
       *
       * Meaning the overwrite header is always set to "T" EXCEPT the option is explicitly set to false.
       */
      Overwrite: options.overwrite === false ? "F" : "T"
    }
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
}
var dist = {};
var hasRequiredDist;
function requireDist() {
  if (hasRequiredDist) return dist;
  hasRequiredDist = 1;
  Object.defineProperty(dist, "__esModule", { value: true });
  function byteLength(str) {
    if (!str) {
      return 0;
    }
    str = str.toString();
    var len = str.length;
    for (var i2 = str.length; i2--; ) {
      var code = str.charCodeAt(i2);
      if (56320 <= code && code <= 57343) {
        i2--;
      }
      if (127 < code && code <= 2047) {
        len++;
      } else if (2047 < code && code <= 65535) {
        len += 2;
      }
    }
    return len;
  }
  dist.byteLength = byteLength;
  return dist;
}
var distExports = requireDist();
function calculateDataLength(data) {
  if (isArrayBuffer(data)) {
    return data.byteLength;
  } else if (isBuffer(data)) {
    return data.length;
  } else if (typeof data === "string") {
    return distExports.byteLength(data);
  }
  throw new Layerr({
    info: {
      code: ErrorCode.DataTypeNoLength
    }
  }, "Cannot calculate data length: Invalid type");
}
async function putFileContents(context, filePath, data, options = {}) {
  const { contentLength = true, overwrite = true } = options;
  const headers = {
    "Content-Type": "application/octet-stream"
  };
  if (!isWeb() && !isReactNative() && typeof Stream$1 !== "undefined" && typeof Stream$1?.Readable !== "undefined" && data instanceof Stream$1.Readable) ;
  else if (contentLength === false) ;
  else if (typeof contentLength === "number") {
    headers["Content-Length"] = `${contentLength}`;
  } else {
    headers["Content-Length"] = `${calculateDataLength(data)}`;
  }
  if (!overwrite) {
    headers["If-None-Match"] = "*";
  }
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filePath)),
    method: "PUT",
    headers,
    data
  }, context, options);
  const response = await request(requestOptions, context);
  try {
    handleResponseCode(context, response);
  } catch (err) {
    const error = err;
    if (error.status === 412 && !overwrite) {
      return false;
    } else {
      throw error;
    }
  }
  return true;
}
function getFileUploadLink(context, filePath) {
  let url = `${joinURL(context.remoteURL, encodePath(filePath))}?Content-Type=application/octet-stream`;
  const protocol = /^https:/i.test(url) ? "https" : "http";
  switch (context.authType) {
    case AuthType.None:
      break;
    case AuthType.Password: {
      const authPart = context.headers.Authorization.replace(/^Basic /i, "").trim();
      const authContents = fromBase64(authPart);
      url = url.replace(/^https?:\/\//, `${protocol}://${authContents}@`);
      break;
    }
    default:
      throw new Layerr({
        info: {
          code: ErrorCode.LinkUnsupportedAuthType
        }
      }, `Unsupported auth type for file link: ${context.authType}`);
  }
  return url;
}
async function getDAVCompliance(context, filePath, options = {}) {
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filePath)),
    method: "OPTIONS"
  }, context, options);
  const response = await request(requestOptions, context);
  try {
    handleResponseCode(context, response);
  } catch (err) {
    const error = err;
    throw error;
  }
  const davHeader = response.headers.get("DAV") ?? "";
  const compliance = davHeader.split(",").map((item) => item.trim());
  const server = response.headers.get("Server") ?? "";
  return {
    compliance,
    server
  };
}
async function partialUpdateFileContents(context, filePath, start, end, data, options = {}) {
  const compliance = await getDAVCompliance(context, filePath, options);
  if (compliance.compliance.includes("sabredav-partialupdate")) {
    return await partialUpdateFileContentsSabredav(context, filePath, start, end, data, options);
  }
  if (compliance.server.includes("Apache") && compliance.compliance.includes("<http://apache.org/dav/propset/fs/1>")) {
    return await partialUpdateFileContentsApache(context, filePath, start, end, data, options);
  }
  throw new Layerr({
    info: {
      code: ErrorCode.NotSupported
    }
  }, "Not supported");
}
async function partialUpdateFileContentsSabredav(context, filePath, start, end, data, options = {}) {
  if (start > end || start < 0) {
    throw new Layerr({
      info: {
        code: ErrorCode.InvalidUpdateRange
      }
    }, `Invalid update range ${start} for partial update`);
  }
  const headers = {
    "Content-Type": "application/x-sabredav-partialupdate",
    "Content-Length": `${end - start + 1}`,
    "X-Update-Range": `bytes=${start}-${end}`
  };
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filePath)),
    method: "PATCH",
    headers,
    data
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
}
async function partialUpdateFileContentsApache(context, filePath, start, end, data, options = {}) {
  if (start > end || start < 0) {
    throw new Layerr({
      info: {
        code: ErrorCode.InvalidUpdateRange
      }
    }, `Invalid update range ${start} for partial update`);
  }
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Length": `${end - start + 1}`,
    "Content-Range": `bytes ${start}-${end}/*`
  };
  const requestOptions = prepareRequestOptions({
    url: joinURL(context.remoteURL, encodePath(filePath)),
    method: "PUT",
    headers,
    data
  }, context, options);
  const response = await request(requestOptions, context);
  handleResponseCode(context, response);
}
const DEFAULT_CONTACT_HREF = "https://github.com/perry-mitchell/webdav-client/blob/master/LOCK_CONTACT.md";
function createClient(remoteURL, options = {}) {
  const { authType: authTypeRaw = null, remoteBasePath, contactHref = DEFAULT_CONTACT_HREF, entityDecoder, ha1, headers = {}, httpAgent, httpsAgent, password, token, username, withCredentials } = options;
  let authType = authTypeRaw;
  if (!authType) {
    authType = username || password ? AuthType.Password : AuthType.None;
  }
  const context = {
    authType,
    remoteBasePath,
    contactHref,
    ha1,
    headers: Object.assign({}, headers),
    httpAgent,
    httpsAgent,
    password,
    parsing: {
      attributeNamePrefix: options.attributeNamePrefix ?? "@",
      attributeParsers: [],
      entityDecoder,
      tagParsers: [displaynameTagParser]
    },
    remotePath: extractURLPath(remoteURL),
    remoteURL,
    token,
    username,
    withCredentials
  };
  setupAuth(context, username, password, token, ha1);
  return {
    copyFile: (filename, destination, options2) => copyFile(context, filename, destination, options2),
    createDirectory: (path2, options2) => createDirectory(context, path2, options2),
    createReadStream: (filename, options2) => createReadStream(context, filename, options2),
    createWriteStream: (filename, options2, callback) => createWriteStream(context, filename, options2, callback),
    customRequest: (path2, requestOptions) => customRequest(context, path2, requestOptions),
    deleteFile: (filename, options2) => deleteFile(context, filename, options2),
    exists: (path2, options2) => exists(context, path2, options2),
    getDirectoryContents: (path2, options2) => getDirectoryContents(context, path2, options2),
    getFileContents: (filename, options2) => getFileContents(context, filename, options2),
    getFileDownloadLink: (filename) => getFileDownloadLink(context, filename),
    getFileUploadLink: (filename) => getFileUploadLink(context, filename),
    getHeaders: () => Object.assign({}, context.headers),
    getQuota: (options2) => getQuota(context, options2),
    lock: (path2, options2) => lock(context, path2, options2),
    moveFile: (filename, destinationFilename, options2) => moveFile(context, filename, destinationFilename, options2),
    putFileContents: (filename, data, options2) => putFileContents(context, filename, data, options2),
    partialUpdateFileContents: (filePath, start, end, data, options2) => partialUpdateFileContents(context, filePath, start, end, data, options2),
    getDAVCompliance: (path2) => getDAVCompliance(context, path2),
    search: (path2, options2) => getSearch(context, path2, options2),
    setHeaders: (headers2) => {
      context.headers = Object.assign({}, headers2);
    },
    stat: (path2, options2) => getStat(context, path2, options2),
    unlock: (path2, token2, options2) => unlock(context, path2, token2, options2),
    registerAttributeParser: (parser) => {
      context.parsing.attributeParsers.push(parser);
    },
    registerTagParser: (parser) => {
      context.parsing.tagParsers.push(parser);
    }
  };
}
class SyncEngine {
  constructor(db, paths, memory, getConfig, onReport = () => {
  }) {
    this.db = db;
    this.paths = paths;
    this.memory = memory;
    this.getConfig = getConfig;
    this.onReport = onReport;
  }
  db;
  paths;
  memory;
  getConfig;
  onReport;
  davClient = null;
  cfg() {
    const cfg = this.getConfig();
    if (!cfg || !cfg.url) throw new Error("WebDAV 未配置");
    return cfg;
  }
  client() {
    if (!this.davClient) {
      const cfg = this.cfg();
      this.davClient = createClient(cfg.url, { username: cfg.username, password: cfg.password });
    }
    return this.davClient;
  }
  /** 重置 client（配置变更后） */
  resetClient() {
    this.davClient = null;
  }
  base() {
    return this.cfg().basePath.replace(/\/+$/, "") || "/jeff";
  }
  async sync() {
    const report = { ok: false, at: Date.now(), uploaded: 0, downloaded: 0, conflicts: [] };
    try {
      const client = this.client();
      const base = this.base();
      await client.createDirectory(base, { recursive: true }).catch(() => {
      });
      await client.createDirectory(`${base}/memory`, { recursive: true }).catch(() => {
      });
      const remote = /* @__PURE__ */ new Map();
      for (const name of ["agents", "projects", "tasks", "settings"]) {
        for (const raw of await this.getJsonArray(name)) {
          remote.set(raw.id, { id: raw.id, updatedAt: raw.updatedAt, deletedAt: raw.deletedAt, data: raw.data, memoryFile: null });
        }
      }
      const tomb = await this.getJsonObj("tombstones");
      for (const [id, t2] of Object.entries(tomb)) {
        const cur = remote.get(id);
        if (cur) {
          if (t2 > cur.updatedAt) {
            cur.updatedAt = t2;
            cur.deletedAt = t2;
          }
        } else {
          remote.set(id, { id, updatedAt: t2, deletedAt: t2, data: null, memoryFile: null });
        }
      }
      for (const f2 of await this.listMemoryFiles(base, client)) {
        const content = String(await client.getFileContents(`${base}/${f2}`) ?? "");
        const mtime = await this.remoteMtime(`${base}/${f2}`);
        const key = memKeyFromRel(f2);
        remote.set(key, { id: key, updatedAt: mtime, deletedAt: null, data: null, memoryFile: { rel: f2, content, mtime } });
      }
      const local = this.collectLocal();
      const lastState = this.kvGetJSON("sync:laststate", {});
      const merged = /* @__PURE__ */ new Map();
      for (const [id, l] of local) merged.set(id, { ...l });
      for (const [id, r2] of remote) {
        const l = merged.get(id);
        if (!l) {
          merged.set(id, { id, updatedAt: r2.updatedAt, deletedAt: r2.deletedAt, data: r2.data, memoryFile: r2.memoryFile });
          continue;
        }
        if (l.updatedAt > (lastState[id] || 0) && r2.updatedAt > (lastState[id] || 0) && l.updatedAt !== r2.updatedAt) {
          report.conflicts.push(id);
        }
        if (r2.updatedAt > l.updatedAt || r2.updatedAt === l.updatedAt && r2.deletedAt != null && l.deletedAt == null) {
          merged.set(id, { id, updatedAt: r2.updatedAt, deletedAt: r2.deletedAt, data: r2.data, memoryFile: r2.memoryFile });
        }
      }
      report.downloaded = this.applyToLocal(merged);
      report.uploaded = await this.pushToRemote(merged);
      const nextLast = {};
      for (const [id, rec] of merged) nextLast[id] = rec.updatedAt;
      this.kvSetJSON("sync:laststate", nextLast);
      this.kvSetJSON("sync:lastreport", report);
      report.ok = true;
    } catch (err) {
      report.error = String(err?.message || err).slice(0, 300);
      this.kvSetJSON("sync:lastreport", report);
    }
    this.onReport(report);
    return report;
  }
  // ---------- 本地收集 ----------
  collectLocal() {
    const out = /* @__PURE__ */ new Map();
    for (const a of agentRepo(this.db).list(true)) {
      out.set(a.id, { id: a.id, updatedAt: a.updated_at, deletedAt: a.deleted_at, data: a, memoryFile: null });
    }
    for (const p of projectRepo(this.db).list(true)) {
      const members = projectAgentRepo(this.db).listByProject(p.id);
      out.set(p.id, { id: p.id, updatedAt: p.updated_at, deletedAt: p.deleted_at, data: { project: p, members }, memoryFile: null });
    }
    const allTasks = this.db.prepare("SELECT id FROM task").all();
    for (const { id } of allTasks) {
      const t2 = taskRepo(this.db).get(id);
      if (t2) out.set(t2.id, { id: t2.id, updatedAt: t2.updated_at, deletedAt: t2.deleted_at, data: t2, memoryFile: null });
    }
    const settings = {
      providers: this.kvGet("settings:providers"),
      defaultModel: this.kvGet("settings:defaultModel"),
      theme: this.kvGet("settings:theme")
      // webdav 配置本身不同步（每台设备自己的连接信息）
    };
    const settingsUpdated = Number(
      this.db.prepare("SELECT updated_at FROM kv WHERE key = ?").get("settings:providers")?.updated_at || 0
    );
    out.set("settings", { id: "settings", updatedAt: settingsUpdated, deletedAt: null, data: settings, memoryFile: null });
    for (const [key, scope] of this.memoryScopes()) {
      const file = this.memory.file(scope);
      let content = "";
      let mtime = 0;
      try {
        content = fs.readFileSync(file, "utf8");
        mtime = Math.floor(fs.statSync(file).mtimeMs);
      } catch {
        continue;
      }
      out.set(key, { id: key, updatedAt: mtime, deletedAt: null, data: null, memoryFile: { rel: memRel(scope), content, mtime } });
    }
    return out;
  }
  memoryScopes() {
    const out = [["mem:user", { kind: "user" }]];
    for (const a of agentRepo(this.db).list()) out.push([`mem:agent:${a.id}`, { kind: "agent", agentId: a.id }]);
    for (const p of projectRepo(this.db).list()) out.push([`mem:project:${p.id}`, { kind: "project", projectId: p.id }]);
    return out;
  }
  // ---------- 应用到本地 ----------
  applyToLocal(merged) {
    let n = 0;
    for (const [id, rec] of merged) {
      if (id === "settings") {
        const d = rec.data || {};
        this.kvSetJSON("settings:providers", d.providers ?? []);
        this.kvSetJSON("settings:defaultModel", d.defaultModel ?? null);
        this.kvSetJSON("settings:theme", d.theme ?? "system");
        n += 1;
        continue;
      }
      if (id.startsWith("mem:")) {
        if (rec.memoryFile) {
          const file = this.memory.file(memScopeFromRel(rec.memoryFile.rel));
          fs.mkdirSync(path$1.dirname(file), { recursive: true });
          fs.writeFileSync(file, rec.memoryFile.content, "utf8");
          n += 1;
        }
        continue;
      }
      if (id.startsWith("agt_")) {
        const d = rec.data;
        if (!d) continue;
        const exists2 = agentRepo(this.db).get(id);
        if (!exists2) {
          this.db.prepare(
            `INSERT INTO agent (id, name, avatar, description, instructions, model_provider, model_id, builtin, archived, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(id, d.name, d.avatar, d.description, d.instructions, d.model_provider, d.model_id, d.builtin, d.archived, d.created_at, rec.updatedAt, rec.deletedAt);
        } else {
          this.db.prepare(`UPDATE agent SET name=?, avatar=?, description=?, instructions=?, model_provider=?, model_id=?, builtin=?, archived=?, updated_at=?, deleted_at=? WHERE id=?`).run(d.name, d.avatar, d.description, d.instructions, d.model_provider, d.model_id, d.builtin, d.archived, rec.updatedAt, rec.deletedAt, id);
        }
        n += 1;
        continue;
      }
      if (id.startsWith("prj_")) {
        const d = rec.data;
        if (!d) continue;
        const exists2 = projectRepo(this.db).get(id);
        if (!exists2) {
          this.db.prepare(`INSERT INTO project (id, title, description, icon, status, leader_agent_id, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(id, d.project.title, d.project.description, d.project.icon, d.project.status, d.project.leader_agent_id, d.project.created_at, rec.updatedAt, rec.deletedAt);
        } else {
          this.db.prepare(`UPDATE project SET title=?, description=?, icon=?, status=?, leader_agent_id=?, updated_at=?, deleted_at=? WHERE id=?`).run(d.project.title, d.project.description, d.project.icon, d.project.status, d.project.leader_agent_id, rec.updatedAt, rec.deletedAt, id);
        }
        this.db.prepare("DELETE FROM project_agent WHERE project_id = ?").run(id);
        for (const m2 of d.members) {
          this.db.prepare("INSERT INTO project_agent (project_id, agent_id, role, position, created_at) VALUES (?,?,?,?,?)").run(id, m2.agent_id, m2.role, m2.position, m2.created_at);
        }
        n += 1;
        continue;
      }
      if (id.startsWith("task_")) {
        const d = rec.data;
        if (!d) continue;
        const exists2 = taskRepo(this.db).get(id);
        if (!exists2) {
          this.db.prepare(
            `INSERT INTO task (id, project_id, number, title, description, status, priority, assignee_type, assignee_id, parent_task_id, position, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(id, d.project_id, d.number, d.title, d.description, d.status, d.priority, d.assignee_type, d.assignee_id, d.parent_task_id, d.position, d.created_at, rec.updatedAt, rec.deletedAt);
        } else {
          this.db.prepare(
            `UPDATE task SET project_id=?, number=?, title=?, description=?, status=?, priority=?, assignee_type=?, assignee_id=?, parent_task_id=?, position=?, updated_at=?, deleted_at=? WHERE id=?`
          ).run(d.project_id, d.number, d.title, d.description, d.status, d.priority, d.assignee_type, d.assignee_id, d.parent_task_id, d.position, rec.updatedAt, rec.deletedAt, id);
        }
        n += 1;
      }
    }
    return n;
  }
  // ---------- 推远端 ----------
  async pushToRemote(merged) {
    const client = this.client();
    const base = this.base();
    let uploaded = 0;
    const byName = { agents: [], projects: [], tasks: [], settings: [] };
    const tomb = {};
    for (const rec of merged.values()) {
      if (rec.id.startsWith("mem:")) {
        if (rec.memoryFile) {
          await client.putFileContents(`${base}/${rec.memoryFile.rel}`, rec.memoryFile.content, { overwrite: true });
          uploaded += 1;
        }
        continue;
      }
      if (rec.id === "settings") byName.settings.push({ id: rec.id, updatedAt: rec.updatedAt, deletedAt: null, data: rec.data });
      else if (rec.id.startsWith("agt_")) byName.agents.push({ id: rec.id, updatedAt: rec.updatedAt, deletedAt: rec.deletedAt, data: rec.data });
      else if (rec.id.startsWith("prj_")) byName.projects.push({ id: rec.id, updatedAt: rec.updatedAt, deletedAt: rec.deletedAt, data: rec.data });
      else if (rec.id.startsWith("task_")) byName.tasks.push({ id: rec.id, updatedAt: rec.updatedAt, deletedAt: rec.deletedAt, data: rec.data });
      if (rec.deletedAt != null) tomb[rec.id] = rec.deletedAt;
    }
    for (const name of ["agents", "projects", "tasks", "settings"]) {
      await client.putFileContents(`${base}/${name}.json`, JSON.stringify(byName[name], null, 2), { overwrite: true });
      uploaded += 1;
    }
    await client.putFileContents(`${base}/tombstones.json`, JSON.stringify(tomb, null, 2), { overwrite: true });
    await client.putFileContents(`${base}/manifest.json`, JSON.stringify({ updatedAt: Date.now() }), { overwrite: true });
    return uploaded;
  }
  // ---------- 远端原语 ----------
  async getJsonArray(name) {
    try {
      const buf = await this.client().getFileContents(`${this.base()}/${name}.json`);
      const text = typeof buf === "string" ? buf : buf.toString("utf8");
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  async getJsonObj(name) {
    try {
      const buf = await this.client().getFileContents(`${this.base()}/${name}.json`);
      const text = typeof buf === "string" ? buf : buf.toString("utf8");
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  async listMemoryFiles(base, client) {
    try {
      const stat2 = await client.stat(`${base}/memory`);
      if (!stat2) return [];
      const items = await client.getDirectoryContents(`${base}/memory`);
      return items.filter((i2) => i2.type === "file" && i2.basename.endsWith(".md")).map((i2) => `memory/${i2.basename}`);
    } catch {
      return [];
    }
  }
  async remoteMtime(path2) {
    try {
      const stat2 = await this.client().stat(path2);
      const m2 = stat2?.mtime;
      if (typeof m2 === "number") return Math.floor(m2);
      if (m2 instanceof Date) return Math.floor(m2.getTime());
      if (stat2?.lastmod) return Math.floor(new Date(stat2.lastmod).getTime());
    } catch {
    }
    return 0;
  }
  // ---------- kv 原语 ----------
  kvGet(key) {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }
  kvGetJSON(key, fallback) {
    const v = this.kvGet(key);
    return v == null ? fallback : v;
  }
  kvSetJSON(key, value) {
    this.db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, JSON.stringify(value ?? null), Date.now());
  }
}
function memRel(scope) {
  if (scope.kind === "user") return "memory/user.md";
  if (scope.kind === "agent") return `memory/agent-${scope.agentId}.md`;
  return `memory/project-${scope.projectId}.md`;
}
function memKeyFromRel(rel) {
  const name = path$1.basename(rel, ".md");
  if (name === "user") return "mem:user";
  if (name.startsWith("agent-")) return `mem:agent:${name.slice(6)}`;
  return `mem:project:${name.slice(8)}`;
}
function memScopeFromRel(rel) {
  const name = path$1.basename(rel, ".md");
  if (name === "user") return { kind: "user" };
  if (name.startsWith("agent-")) return { kind: "agent", agentId: name.slice(6) };
  return { kind: "project", projectId: name.slice(8) };
}
const NUDGE_INTERVAL = 10;
const NUDGE_REVIEW_MAX_CHARS = 6e3;
class JeffCore extends EventEmitter {
  paths;
  db;
  sidecar;
  oc;
  registry;
  bridge = new ToolBridge();
  privateChat;
  groupChat;
  delegator;
  memory;
  indexer;
  sync;
  bus = new EventEmitter();
  started = false;
  registryDirty = false;
  lastSyncReport = null;
  autoSyncTimer = null;
  constructor(home) {
    super();
    this.paths = buildPaths(jeffRoot(home));
  }
  async init(opts = {}) {
    if (this.started) return;
    ensureDirs(this.paths);
    this.db = openDb(this.paths);
    this.seedXiaojie();
    this.registry = new AgentRegistry(this.db, this.paths);
    this.memory = new MemoryStore(this.paths);
    this.indexer = new SessionIndex(this.db);
    this.groupChat = new GroupChat(this.db, () => this.oc, this.chatHooks());
    this.privateChat = new PrivateChat(this.db, () => this.oc, this.chatHooks());
    this.delegator = new Delegator(this.db, () => this.oc, this.groupChat, (projectId) => {
      this.bus.emit("group-updated", { projectId });
    });
    this.sync = new SyncEngine(this.db, this.paths, this.memory, () => this.kv().getJSON("settings:webdav", null), (r2) => {
      this.lastSyncReport = r2;
      this.bus.emit("sync-report", r2);
    });
    this.bus.on("data-changed", () => this.scheduleAutoSync());
    registerAdminTools(this.bridge, {
      db: this.db,
      onChanged: () => {
        this.syncRegistry();
        this.markRegistryDirty();
        this.bus.emit("data-changed", "agents");
      }
    });
    registerProjectTools(this.bridge, {
      db: this.db,
      onProjectChanged: () => {
        this.bus.emit("data-changed", "projects");
      },
      onTaskChanged: (projectId, taskId) => {
        if (taskId) {
          const card = taskCardMessage(this.db, projectId, taskId);
          if (card.content) this.groupChat.addSystemMessage(projectId, card.content, card.meta);
        }
        this.bus.emit("data-changed", "tasks");
        this.bus.emit("group-updated", { projectId });
      }
    });
    registerMemoryTools(this.bridge, {
      db: this.db,
      store: this.memory,
      indexer: this.indexer,
      resolveSession: (sessionId) => this.resolveSession(sessionId)
    });
    this.bridge.register(DELEGATE_TOOL, async (raw) => {
      const { __ctx, member_agent_id, instruction } = raw;
      const resolved = __ctx?.sessionID ? this.resolveSession(__ctx.sessionID) : null;
      if (!resolved || resolved.kind !== "group") {
        return { ok: false, error: "jeff_delegate 只能在项目群里使用（且你必须是群主）" };
      }
      if (!member_agent_id || !instruction) return { ok: false, error: "member_agent_id 与 instruction 必填" };
      const r2 = await this.delegator.delegate(
        { projectId: resolved.projectId, leaderAgentId: resolved.agentId },
        member_agent_id,
        instruction,
        __ctx?.messageID
      );
      return r2.ok ? { member: r2.memberName, result: r2.result } : { ok: false, error: r2.error };
    });
    await this.bridge.start();
    this.writeBridgePlugin();
    this.writeSidecarConfig();
    this.syncRegistry();
    this.sidecar = new SidecarManager({ paths: this.paths, resourceBinDir: opts.resourceBinDir, binaryPath: opts.binaryPath });
    this.sidecar.on("status", (status, error) => {
      this.bus.emit("sidecar-status", { status, error });
      this.emit("sidecar-status", { status, error });
    });
    this.sidecar.on("log", (line) => this.emit("sidecar-log", line));
    await this.sidecar.start();
    this.oc = new OcClient(this.sidecar.port);
    this.oc.startEventStream();
    this.oc.on("event", (evt) => this.handleOcEvent(evt));
    this.writeUsageSkill();
    this.backfillIndex();
    this.started = true;
    if (this.kv().getJSON("settings:webdav", null)?.autoSync) {
      setTimeout(() => void this.syncNow().catch(() => {
      }), 5e3);
    }
  }
  /** 数据变化后防抖自动同步 */
  scheduleAutoSync() {
    const cfg = this.kv().getJSON("settings:webdav", null);
    if (!cfg?.autoSync || !this.started) return;
    if (this.autoSyncTimer) clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = setTimeout(() => {
      this.autoSyncTimer = null;
      void this.syncNow().catch(() => {
      });
    }, 3e4);
    this.autoSyncTimer.unref?.();
  }
  /** 手动同步 */
  async syncNow() {
    return this.sync.sync();
  }
  /** 配置 WebDAV（密码存本地 kv） */
  async configureSync(cfg) {
    this.kv().setJSON("settings:webdav", cfg);
    this.sync.resetClient();
    if (cfg.autoSync) void this.syncNow().catch(() => {
    });
  }
  syncConfig() {
    const cfg = this.kv().getJSON("settings:webdav", null);
    if (!cfg?.url) return null;
    const { password: _password, ...rest } = cfg;
    return rest;
  }
  chatHooks() {
    return {
      beforeEnsure: () => this.restartIfRegistryDirty(),
      onSessionCreated: (sessionId, meta) => {
        this.kv().setJSON(sesMetaKey(sessionId), meta);
      },
      buildSystem: (agentId, projectId) => this.buildMemorySystem(agentId, projectId),
      afterReply: (scope) => {
        this.onReplyDone(scope);
      }
    };
  }
  /** 记忆注入：agent 记忆 + 项目记忆（群聊）+ 全局用户画像 */
  buildMemorySystem(agentId, projectId) {
    const blocks = [];
    const agentBlock = this.memory.renderBlock({ kind: "agent", agentId });
    if (agentBlock) blocks.push(agentBlock);
    if (projectId) {
      const projectBlock = this.memory.renderBlock({ kind: "project", projectId });
      if (projectBlock) blocks.push(projectBlock);
    }
    const userBlock = this.memory.renderBlock({ kind: "user" });
    if (userBlock) blocks.push(userBlock);
    if (blocks.length === 0) return void 0;
    return [
      "【长期记忆（Jeff）】以下是关于用户与项目的持久记忆，供你参考；如与当前对话冲突，以对话为准，并可用 jeff_memory 工具更新你的记忆。",
      ...blocks
    ].join("\n");
  }
  /** 回复完成：索引本轮内容 + 计数 nudge */
  onReplyDone(scope) {
    try {
      if (scope.kind === "private") {
        const sessionId = this.privateChat.getSessionId(scope.agentId);
        if (sessionId) void this.indexSession(sessionId, `private:${scope.agentId}`);
      } else {
        const scopeKey2 = `group:${scope.projectId}`;
        const msgs = chatMessageRepo(this.db).listByScope(scopeKey2, 4);
        const agents = agentRepo(this.db);
        for (const m2 of msgs) {
          if (this.indexer.has(`chat:${m2.id}`)) continue;
          const sender = m2.sender_type === "user" ? "user" : m2.sender_type === "agent" ? agents.get(m2.sender_id)?.name || "agent" : "system";
          this.indexer.index({ id: `chat:${m2.id}`, scope: scopeKey2, sender, ts: m2.created_at, text: m2.content, sessionId: "" });
        }
      }
    } catch {
    }
    void this.maybeNudge(scope);
  }
  /** opencode 会话内容 → 索引（幂等，按消息 id 去重） */
  async indexSession(sessionId, scope) {
    const msgs = await this.oc.getMessages(sessionId);
    let n = 0;
    for (const m2 of msgs) {
      const info = m2.info;
      if (!info?.id) continue;
      if (this.indexer.has(`oc:${info.id}`)) continue;
      const parts = m2.parts || [];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text || "").join("\n");
      if (!text.trim()) continue;
      this.indexer.index({ id: `oc:${info.id}`, scope, sessionId, sender: info.role || "", ts: info.time?.created || 0, text });
      n += 1;
    }
    return n;
  }
  /** 启动时回填索引（群消息 + 既有会话） */
  backfillIndex() {
    try {
      const all = this.db.prepare("SELECT id, scope, sender_type, sender_id, content, created_at FROM chat_message ORDER BY created_at ASC").all();
      const agents = agentRepo(this.db);
      for (const m2 of all) {
        if (this.indexer.has(`chat:${m2.id}`)) continue;
        const sender = m2.sender_type === "user" ? "user" : m2.sender_type === "agent" ? agents.get(m2.sender_id)?.name || "agent" : "system";
        this.indexer.index({ id: `chat:${m2.id}`, scope: m2.scope, sender, ts: m2.created_at, text: m2.content });
      }
      for (const a of agents.list()) {
        const sessionId = this.kv().get(`session:private:${a.id}`);
        if (sessionId) void this.indexSession(sessionId, `private:${a.id}`).catch(() => {
        });
      }
    } catch {
    }
  }
  /** hermes 式 nudge：每 N 轮触发后台记忆自省 */
  async maybeNudge(scope) {
    const key = scope.kind === "private" ? `private:${scope.agentId}` : `group:${scope.projectId}`;
    const kv = this.kv();
    const count = (kv.getJSON(`nudge:${key}`, 0) || 0) + 1;
    kv.setJSON(`nudge:${key}`, count);
    if (count % NUDGE_INTERVAL !== 0) return;
    const guardKey = `nudge:running:${key}`;
    if (kv.get(guardKey)) return;
    kv.set(guardKey, String(Date.now()));
    void this.runNudgeReview(scope, key, guardKey).catch(() => {
      kv.delete(guardKey);
    });
  }
  /** 后台自省：fork 一个临时会话，重放最近对话，让 agent 自己决定存什么 */
  async runNudgeReview(scope, key, guardKey) {
    try {
      this.emit("sidecar-log", `[nudge] 触发记忆自省 ${key}`);
      let transcript = "";
      if (scope.kind === "private") {
        const sessionId = this.privateChat.getSessionId(scope.agentId);
        if (!sessionId) return;
        const msgs = await this.privateChat.mapSessionMessages(sessionId);
        transcript = msgs.slice(-30).map((m2) => `${m2.role === "user" ? "用户" : "assistant"}: ${m2.text.slice(0, 300)}`).join("\n");
      } else {
        const history = this.groupChat.history(scope.projectId);
        transcript = history.slice(-30).map((m2) => `${m2.sender_name}: ${m2.text.slice(0, 300)}`).join("\n");
      }
      if (!transcript.trim()) return;
      transcript = transcript.slice(0, NUDGE_REVIEW_MAX_CHARS);
      const agent = agentRepo(this.db).get(scope.agentId);
      if (!agent) return;
      const s = await this.oc.createSession({ title: `记忆自省 ${key}`, agent: agentSlug(scope.agentId) });
      this.kv().setJSON(sesMetaKey(s.id), { kind: "review", agentId: scope.agentId, projectId: scope.kind === "group" ? scope.projectId : void 0 });
      try {
        await this.oc.sendMessage({
          sessionId: s.id,
          agent: agentSlug(scope.agentId),
          timeoutMs: 12e4,
          text: [
            "【后台记忆自省】回顾以下最近对话（你只能用 jeff_memory 工具，不要回复用户任何文字）。",
            "把值得长期记住的信息写进你的记忆：用户偏好、环境事实、被纠正的错误、长期惯例。",
            "不要记录：琐碎寒暄、可随时重查的信息、本次会话临时内容。已有条目不必重复添加。若没有值得记的，直接结束（不用调用工具）。",
            "",
            "--- 对话记录 ---",
            transcript
          ].join("\n")
        });
      } finally {
        await this.oc.deleteSession(s.id).catch(() => {
        });
        this.kv().delete(sesMetaKey(s.id));
      }
    } finally {
      this.kv().delete(guardKey);
    }
  }
  /** opencode session → Jeff 会话语义（元数据优先，kv 扫描回退） */
  resolveSession(sessionId) {
    const meta = this.kv().getJSON(sesMetaKey(sessionId), null);
    if (meta?.agentId) {
      if (meta.kind === "group" && meta.projectId) return { kind: "group", projectId: meta.projectId, agentId: meta.agentId };
      if (meta.kind === "review") return { kind: "review", agentId: meta.agentId, projectId: meta.projectId };
      return { kind: "private", agentId: meta.agentId };
    }
    for (const agent of agentRepo(this.db).list()) {
      if (this.kv().get(`session:private:${agent.id}`) === sessionId) return { kind: "private", agentId: agent.id };
    }
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'session:group:%'").all();
    for (const r2 of rows) {
      if (r2.value === sessionId) {
        const m2 = /session:group:([^:]+):(.+)/.exec(r2.key);
        if (m2) return { kind: "group", projectId: m2[1], agentId: m2[2] };
      }
    }
    return null;
  }
  /** SSE 事件 → bus（UI 刷新信号） */
  handleOcEvent(evt) {
    if (!evt?.type) return;
    if (evt.type === "message.updated" || evt.type === "message.part.updated" || evt.type === "message.part.delta") {
      const sessionId = evt.properties?.sessionID;
      if (!sessionId) return;
      const resolved = this.resolveSession(sessionId);
      if (!resolved) return;
      if (resolved.kind === "group") this.bus.emit("group-updated", { projectId: resolved.projectId });
      else this.bus.emit("chat-updated", { agentId: resolved.agentId, sessionId });
    }
  }
  async dispose() {
    if (!this.started) return;
    this.oc?.stopEventStream();
    await this.sidecar?.stop().catch(() => {
    });
    await this.bridge?.stop().catch(() => {
    });
    this.db?.close();
    this.started = false;
  }
  get isStarted() {
    return this.started;
  }
  /** agent md 同步（带全局默认模型兜底） */
  syncRegistry() {
    this.registry.syncAll(this.defaultModel() ?? void 0);
  }
  /** agent 定义有变化：md 已同步，下次会话前需重启 sidecar（opencode 不热加载 agent） */
  markRegistryDirty() {
    this.registryDirty = true;
  }
  async restartIfRegistryDirty() {
    if (!this.registryDirty || !this.sidecar) return;
    this.registryDirty = false;
    await this.restartSidecar();
  }
  /** 重启 sidecar 并重建客户端/会话对象 */
  async restartSidecar() {
    const old = this.oc;
    await this.sidecar.stop();
    await this.sidecar.start();
    old?.stopEventStream();
    this.oc = new OcClient(this.sidecar.port);
    this.oc.startEventStream();
    this.oc.on("event", (evt) => this.handleOcEvent(evt));
    this.groupChat = new GroupChat(this.db, () => this.oc, this.chatHooks());
    this.privateChat = new PrivateChat(this.db, () => this.oc, this.chatHooks());
  }
  /** 内置小杰：不存在则创建；存在则强制对齐指令（保持与代码同步，不可被改） */
  seedXiaojie() {
    const agents = agentRepo(this.db);
    const existing = agents.get(XIAOJIE_ID);
    if (!existing) {
      agents.create({
        id: XIAOJIE_ID,
        name: "小杰",
        avatar: "🧑‍💻",
        description: "Jeff 内置管家：问答、创建与管理一切",
        builtin: 1
      });
    }
    agents.update(XIAOJIE_ID, { instructions: XIAOJIE_INSTRUCTIONS });
  }
  /** 把工具桥插件写进 sidecar 插件目录 */
  writeBridgePlugin() {
    fs.mkdirSync(this.paths.ocPluginsDir, { recursive: true });
    const defs = allToolDefs().map((d) => ({ name: d.name, description: d.description, args: d.args }));
    const plugin = renderBridgePlugin(this.bridge.url(), this.bridge.token, defs);
    fs.writeFileSync(path$1.join(this.paths.ocPluginsDir, "jeff-bridge.js"), plugin, "utf8");
  }
  /** 内置使用说明 skill（所有 agent 可调用 /jeff-usage 或被自动加载） */
  writeUsageSkill() {
    const dir = path$1.join(this.paths.ocSkillsDir, "jeff-usage");
    fs.mkdirSync(dir, { recursive: true });
    const content = `---
name: jeff-usage
description: Jeff 桌面应用的完整使用说明：智能体、项目群（leader 统筹）、任务看板、记忆、WebDAV 同步。当用户问「Jeff 怎么用 / 能做什么」时加载。
---

# Jeff 使用说明

Jeff 把「开发 + 项目管理」组织成三个概念（微信心智模型）：

## 1. 智能体 = 聊天好友
- 每个智能体是会话列表里的一个联系人，有自己的身份指令、默认模型、长期记忆。
- 私聊 = 和这个智能体一对一协作（它带编码/MCP/技能工具，可以直接干活）。
- 创建途径：① 找小杰说「帮我创建一个智能体」；② 「智能体」页手动新建。

## 2. 项目群 = 微信群
- 一个项目就是一个群；群里有你 + 若干智能体成员（开发/UI/测试/产品…）。
- **只有一个群主（leader）**，所有工作由它统筹：群消息默认给 leader，@成员名 直达该成员。
- leader 用 jeff_delegate 工具把活儿委派给成员，成员独立执行后结果自动回群，leader 再汇总。
- 群资料面板：成员管理 + 任务看板（拖拽改状态）。

## 3. 任务 = JEF-n
- 任务归属项目群，编号 JEF-n，状态：待办/进行中/待审/完成/已取消；优先级四级。
- 创建途径：群里对话让 leader/小杰建（自动出现任务卡片）、或群资料看板手动建。

## 其他能力
- **记忆**：每个智能体有自己的长期记忆；项目群有共享记忆；全局用户画像由小杰维护（用 jeff_memory 工具读写）。设置页可人工查看/编辑。
- **会话搜索**：所有历史对话全文可搜（jeff_session_search）。
- **模型提供商**：设置页配置（OpenAI/Anthropic/DeepSeek/Kimi/OpenRouter/自定义 OpenAI 兼容端点）；聊天输入框可临时切换模型。
- **WebDAV 同步**：设置页配置；同步智能体/项目/任务/设置/记忆（不含会话数据）；实体级双向合并，多台机器交替使用不丢数据。
- **亮/深夜模式**：左侧导航底部切换，或跟随系统。
`;
    fs.writeFileSync(path$1.join(dir, "SKILL.md"), content, "utf8");
  }
  writeSidecarConfig() {
    const kv = kvRepo(this.db);
    const providers = kv.getJSON("settings:providers", []);
    const defaultModel = kv.getJSON("settings:defaultModel", null);
    writeSidecarConfig(this.paths, providers, { defaultModel: defaultModel ?? void 0, mcp: this.listMcp() });
  }
  /** MCP 连接器配置（存 kv，写入 sidecar opencode.json 的 mcp 字段） */
  listMcp() {
    return this.kv().getJSON("settings:mcp", {});
  }
  async saveMcp(cfg) {
    this.kv().setJSON("settings:mcp", cfg);
    this.writeSidecarConfig();
    await this.restartSidecar();
  }
  /** 便捷访问器 */
  get agents() {
    return agentRepo(this.db);
  }
  kv() {
    return kvRepo(this.db);
  }
  listProviders() {
    return this.kv().getJSON("settings:providers", []);
  }
  defaultModel() {
    return this.kv().getJSON("settings:defaultModel", null);
  }
  async saveProviders(providers, defaultModel) {
    this.kv().setJSON("settings:providers", providers);
    if (defaultModel !== void 0) this.kv().setJSON("settings:defaultModel", defaultModel ?? null);
    this.writeSidecarConfig();
    await this.restartSidecar();
  }
  /** 小杰默认模型兜底 */
  xiaojieAgentRow() {
    return agentRepo(this.db).get(XIAOJIE_ID);
  }
}
function registerIpc(core2) {
  const handlers = {
    [IPC.appInfo]: async () => ({
      version: app.getVersion(),
      jeffVersion: "0.1.0",
      sidecarStatus: core2.sidecar?.status ?? "stopped",
      opencodeBinary: core2.sidecar?.resolveBinary() ?? null,
      dataDir: core2.paths.root
    }),
    // ---------- agents ----------
    [IPC.agentsList]: async () => core2.agents.list().filter((a) => !a.archived).map(toAgentInfo),
    [IPC.agentsGet]: async (p) => {
      const { id } = p;
      const row = core2.agents.get(id);
      if (!row) throw new Error("智能体不存在");
      return toAgentInfo(row);
    },
    [IPC.agentsUpsert]: async (p) => {
      const d = p;
      if (d.id === XIAOJIE_ID) throw new Error("小杰是内置管家，不可编辑");
      const row = d.id ? core2.agents.update(d.id, { name: d.name, avatar: d.avatar, description: d.description, instructions: d.instructions, model_provider: d.model_provider ?? "", model_id: d.model_id ?? "" }) : core2.agents.create({ name: d.name, avatar: d.avatar, description: d.description, instructions: d.instructions, model_provider: d.model_provider, model_id: d.model_id });
      if (!row) throw new Error("保存失败");
      core2.syncRegistry();
      core2.markRegistryDirty();
      core2.bus.emit("data-changed", "agents");
      return toAgentInfo(row);
    },
    [IPC.agentsDelete]: async (p) => {
      const { id } = p;
      if (id === XIAOJIE_ID) throw new Error("小杰是内置管家，不可删除");
      const ok = core2.agents.softDelete(id);
      if (ok) {
        core2.registry.remove(id);
        core2.syncRegistry();
        core2.markRegistryDirty();
        core2.bus.emit("data-changed", "agents");
      }
      return { ok };
    },
    // ---------- 私聊 ----------
    [IPC.chatHistory]: async (p) => {
      const { agentId } = p;
      core2.agents.get(agentId);
      return core2.privateChat.history(agentId);
    },
    [IPC.chatSend]: async (p) => {
      const { agentId, text, model } = p;
      const row = core2.agents.get(agentId);
      if (!row) throw new Error("智能体不存在");
      await core2.privateChat.send(agentId, row.name, text, model);
      return { ok: true };
    },
    [IPC.chatNew]: async (p) => {
      const { agentId } = p;
      const row = core2.agents.get(agentId);
      if (!row) throw new Error("智能体不存在");
      const sessionId = await core2.privateChat.newSession(agentId, row.name);
      return { sessionId };
    },
    [IPC.chatStop]: async (p) => {
      const { agentId } = p;
      const sessionId = core2.privateChat.getSessionId(agentId);
      if (sessionId) await core2.oc.abortSession(sessionId);
    },
    // ---------- provider / 设置 ----------
    [IPC.providersList]: async () => ({
      providers: core2.listProviders(),
      defaultModel: core2.defaultModel()
    }),
    [IPC.providersSave]: async (p) => {
      const { providers, defaultModel } = p;
      await core2.saveProviders(providers, defaultModel);
      core2.bus.emit("data-changed", "settings");
      return { ok: true };
    },
    [IPC.providersCatalog]: async () => {
      const providers = await core2.oc.listProviders();
      const catalog = providers.map((pv) => ({
        id: pv.id,
        name: pv.name || pv.id,
        models: Object.keys(pv.models || {}).map((mid) => ({ providerID: pv.id, modelID: mid, label: `${pv.name || pv.id} / ${mid}` }))
      }));
      return { catalog };
    },
    [IPC.modelsDefault]: async (p) => {
      const { defaultModel } = p;
      core2.kv().setJSON("settings:defaultModel", defaultModel ?? null);
      return { ok: true };
    },
    [IPC.settingsGet]: async () => {
      const kv = core2.kv();
      return {
        theme: kv.getJSON("settings:theme", "system"),
        defaultModel: core2.defaultModel(),
        webdav: kv.getJSON("settings:webdav", null) ?? void 0
      };
    },
    [IPC.settingsSet]: async (p) => {
      const { theme } = p;
      if (theme) {
        core2.kv().setJSON("settings:theme", theme);
        nativeTheme.themeSource = theme;
      }
      return { ok: true };
    },
    // ---------- WebDAV 同步 ----------
    [IPC.syncConfigure]: async (p) => {
      const d = p;
      if (!d.url || !d.basePath) throw new Error("url 与 basePath 必填");
      await core2.configureSync({ url: d.url.replace(/\/+$/, ""), username: d.username || "", password: d.password || "", basePath: d.basePath, autoSync: !!d.autoSync });
      return { ok: true };
    },
    [IPC.syncNow]: async () => core2.syncNow(),
    [IPC.syncStatus]: async () => ({
      config: core2.syncConfig(),
      report: core2.lastSyncReport
    }),
    // ---------- MCP 连接器 ----------
    [IPC.mcpList]: async () => core2.listMcp(),
    [IPC.mcpSave]: async (p) => {
      const d = p;
      await core2.saveMcp(d.servers);
      core2.bus.emit("data-changed", "settings");
      return { ok: true };
    },
    // ---------- 记忆管理 ----------
    [IPC.memoryScopes]: async () => {
      const out = [{ kind: "user", id: "user", label: "全局用户画像", file: core2.memory.file({ kind: "user" }) }];
      for (const a of agentRepo(core2.db).list()) {
        if (a.builtin) continue;
        out.push({ kind: "agent", id: a.id, label: `${a.avatar} ${a.name}`, file: core2.memory.file({ kind: "agent", agentId: a.id }) });
      }
      for (const pr of projectRepo(core2.db).list()) {
        out.push({ kind: "project", id: pr.id, label: `${pr.icon} ${pr.title}`, file: core2.memory.file({ kind: "project", projectId: pr.id }) });
      }
      return out;
    },
    [IPC.memoryGet]: async (p) => {
      const d = p;
      const scope = d.kind === "user" ? { kind: "user" } : d.kind === "agent" ? { kind: "agent", agentId: d.id } : { kind: "project", projectId: d.id };
      return { content: core2.memory.list(scope).join("\n§\n"), label: core2.memory.label(scope) };
    },
    [IPC.memorySave]: async (p) => {
      const d = p;
      const scope = d.kind === "user" ? { kind: "user" } : d.kind === "agent" ? { kind: "agent", agentId: d.id } : { kind: "project", projectId: d.id };
      core2.memory.writeRaw(scope, d.content);
      return { ok: true };
    },
    // ---------- 项目群 ----------
    [IPC.projectsList]: async () => {
      const projects = projectRepo(core2.db).list();
      return projects.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        icon: p.icon,
        status: p.status,
        leader_agent_id: p.leader_agent_id,
        updated_at: p.updated_at,
        memberCount: projectAgentRepo(core2.db).listByProject(p.id).length
      }));
    },
    [IPC.projectSave]: async (p) => {
      const d = p;
      if (!d.leader_agent_id) throw new Error("必须选择群主（leader）");
      if (d.id) {
        const row2 = projectRepo(core2.db).update(d.id, { title: d.title, description: d.description, icon: d.icon, leader_agent_id: d.leader_agent_id });
        if (!row2) throw new Error("项目不存在");
        projectAgentRepo(core2.db).add(d.id, d.leader_agent_id, "leader", 0);
        for (const mid of d.memberAgentIds || []) {
          if (mid !== d.leader_agent_id) projectAgentRepo(core2.db).add(d.id, mid, "member");
        }
      } else {
        const row2 = projectRepo(core2.db).create({ title: d.title, description: d.description, icon: d.icon, leader_agent_id: d.leader_agent_id });
        projectAgentRepo(core2.db).add(row2.id, d.leader_agent_id, "leader", 0);
        for (const mid of d.memberAgentIds || []) {
          if (mid !== d.leader_agent_id) projectAgentRepo(core2.db).add(row2.id, mid, "member");
        }
      }
      core2.bus.emit("data-changed", "projects");
      const row = projectRepo(core2.db).list().find((x2) => x2.title === d.title);
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        icon: row.icon,
        status: row.status,
        leader_agent_id: row.leader_agent_id,
        updated_at: row.updated_at,
        memberCount: projectAgentRepo(core2.db).listByProject(row.id).length
      };
    },
    [IPC.projectDelete]: async (p) => {
      const { id } = p;
      const ok = projectRepo(core2.db).softDelete(id);
      core2.bus.emit("data-changed", "projects");
      return { ok };
    },
    [IPC.projectMembers]: async (p) => {
      const { projectId } = p;
      return projectAgentRepo(core2.db).listByProject(projectId).map((m2) => {
        const a = agentRepo(core2.db).get(m2.agent_id);
        return { agent_id: m2.agent_id, role: m2.role, name: a?.name || m2.agent_id, avatar: a?.avatar || "🤖" };
      });
    },
    [IPC.projectAddMember]: async (p) => {
      const { projectId, agentId, role } = p;
      projectAgentRepo(core2.db).add(projectId, agentId, role || "member");
      core2.bus.emit("data-changed", "projects");
      return { ok: true };
    },
    [IPC.projectRemoveMember]: async (p) => {
      const { projectId, agentId } = p;
      const project = projectRepo(core2.db).get(projectId);
      if (project?.leader_agent_id === agentId) throw new Error("不能移除群主；请先改群主");
      projectAgentRepo(core2.db).remove(projectId, agentId);
      core2.bus.emit("data-changed", "projects");
      return { ok: true };
    },
    // ---------- 任务 ----------
    [IPC.tasksList]: async (p) => {
      const { projectId } = p;
      return taskRepo(core2.db).listByProject(projectId).map(toTaskInfo);
    },
    [IPC.taskSave]: async (p) => {
      const d = p;
      let row;
      if (d.id) {
        row = taskRepo(core2.db).update(d.id, {
          title: d.title,
          description: d.description,
          status: d.status,
          priority: d.priority,
          ...d.assignee_id !== void 0 ? { assignee_type: d.assignee_id ? "agent" : "none", assignee_id: d.assignee_id } : {}
        });
      } else {
        row = taskRepo(core2.db).create({
          project_id: d.project_id,
          title: d.title,
          description: d.description,
          status: d.status,
          priority: d.priority,
          assignee_type: d.assignee_id ? "agent" : "none",
          assignee_id: d.assignee_id || ""
        });
      }
      if (!row) throw new Error("任务保存失败");
      const card = taskCardMessage(core2.db, row.project_id, row.id);
      if (card.content) core2.groupChat.addSystemMessage(row.project_id, card.content, card.meta);
      core2.bus.emit("data-changed", "tasks");
      core2.bus.emit("group-updated", { projectId: row.project_id });
      return toTaskInfo(row);
    },
    [IPC.taskDelete]: async (p) => {
      const { id } = p;
      const cur = taskRepo(core2.db).get(id);
      const ok = cur ? taskRepo(core2.db).softDelete(id) : false;
      if (cur) {
        core2.bus.emit("data-changed", "tasks");
        core2.bus.emit("group-updated", { projectId: cur.project_id });
      }
      return { ok };
    },
    // ---------- 群聊 ----------
    [IPC.groupHistory]: async (p) => {
      const { projectId } = p;
      return core2.groupChat.history(projectId);
    },
    [IPC.groupSend]: async (p) => {
      const { projectId, text, model } = p;
      return core2.groupChat.send({ projectId, text, model });
    }
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(`jeff:${channel}`, (_evt, payload) => handler(payload));
  }
}
function toAgentInfo(row) {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    description: row.description,
    instructions: row.instructions,
    model_provider: row.model_provider,
    model_id: row.model_id,
    builtin: !!row.builtin,
    archived: !!row.archived
  };
}
function toTaskInfo(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    number: row.number,
    key: `JEF-${row.number}`,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignee_type: row.assignee_type,
    assignee_id: row.assignee_id,
    parent_task_id: row.parent_task_id
  };
}
let win = null;
let core = null;
let tray = null;
function iconPath() {
  const cand = app.isPackaged ? path$1.join(process.resourcesPath ?? "", "icon.png") : path$1.join(__dirname, "../../../build/icon.png");
  try {
    if (fs.existsSync(cand)) return cand;
  } catch {
  }
  return null;
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    core = new JeffCore();
    const resourceBinDir = app.isPackaged ? path$1.join(process.resourcesPath, "oc-bin") : void 0;
    try {
      await core.init({ resourceBinDir });
    } catch (err) {
      console.error("[jeff] core init 失败:", err);
    }
    core.bus.on("data-changed", (what) => broadcast(what));
    core.bus.on("chat-updated", (p) => broadcast("chat-updated", p));
    core.on("sidecar-status", (p) => broadcast("sidecar-status", p));
    registerIpc(core);
    createWindow();
    setupTray();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", async () => {
    if (core) await core.dispose().catch(() => {
    });
    if (process.platform !== "darwin") app.quit();
  });
}
function setupTray() {
  const icon = iconPath();
  if (!icon) return;
  try {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 24, height: 24 }));
    tray.setToolTip("Jeff — 个人 agent 工作台");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "显示主窗口",
          click: () => {
            if (win) {
              win.show();
              win.focus();
            } else {
              createWindow();
            }
          }
        },
        { type: "separator" },
        {
          label: "退出",
          click: () => app.quit()
        }
      ])
    );
    tray.on("double-click", () => {
      if (win) {
        win.show();
        win.focus();
      }
    });
  } catch (err) {
    console.error("[jeff] 托盘创建失败:", err);
  }
}
function broadcast(what, payload) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(`jeff:push`, { what, payload });
}
function createWindow() {
  const icon = iconPath();
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1e3,
    minHeight: 680,
    title: "Jeff",
    ...icon ? { icon } : {},
    backgroundColor: "#ededed",
    webPreferences: {
      preload: path$1.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path$1.join(__dirname, "../renderer/index.html"));
  }
  win.on("closed", () => {
    win = null;
  });
  if (process.env.JEFF_SMOKE === "1") {
    win.webContents.once("did-finish-load", async () => {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          const out = process.env.JEFF_SMOKE_OUT || path$1.join(app.getPath("temp"), "jeff-smoke.png");
          fs.writeFileSync(out, image.toPNG());
          console.log(`[jeff-smoke] screenshot saved: ${out}`);
        } catch (err) {
          console.error("[jeff-smoke] capture failed:", err);
        }
        app.exit(0);
      }, Number(process.env.JEFF_SMOKE_DELAY_MS || 4e3));
    });
  }
}
function getMainWindow() {
  return win;
}
export {
  FormData as F,
  File2 as a,
  getMainWindow
};
