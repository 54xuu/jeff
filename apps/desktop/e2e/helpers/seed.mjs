/**
 * 纯 JS 预置 JEFF_HOME（不依赖 TS 源码导入）。
 * 表结构与 packages/core/src/db/db.ts 对齐的最小子集。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'

function now() {
  return Date.now()
}

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`
}

function openDb(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new DatabaseSync(dbFile)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      model_provider TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      thinking TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `)
  return db
}

function kvSetJSON(db, key, value) {
  const t = now()
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, JSON.stringify(value), t)
}

/**
 * @param {object} opts
 */
export function seedJeffHomeSync(opts) {
  const home = opts.home
  fs.rmSync(home, { recursive: true, force: true })
  for (const d of [
    home,
    path.join(home, 'logs'),
    path.join(home, 'memory'),
    path.join(home, 'workspace'),
    path.join(home, 'oc-home/config/opencode/agent'),
    path.join(home, 'oc-home/config/opencode/plugin'),
    path.join(home, 'oc-home/config/opencode/skills'),
    path.join(home, 'oc-home/data'),
  ]) {
    fs.mkdirSync(d, { recursive: true })
  }

  const dbFile = path.join(home, 'jeff.db')
  const db = openDb(dbFile)
  const providerId = opts.providerId || 'siliconflow-cn'
  const modelId = opts.modelId || 'Qwen/Qwen3.5-9B'
  const providers = [
    {
      id: providerId,
      name: opts.providerName || '硅基流动',
      apiFormat: 'chat',
      baseURL: opts.baseURL || 'https://api.siliconflow.cn/v1',
      apiKey: opts.apiKey || '',
      enabled: true,
      models: [
        {
          id: modelId,
          name: modelId,
          contextLimit: 128000,
          outputLimit: 8192,
          thinkingTiers: ['none', 'low', 'high', 'max'],
          attachment: true,
        },
      ],
    },
  ]
  kvSetJSON(db, 'settings:providers', providers)
  kvSetJSON(db, 'settings:theme', 'light')
  kvSetJSON(db, 'settings:themePack', 'weui')

  if (opts.mcp) {
    kvSetJSON(db, 'settings:mcp', {
      'mysql-test': {
        type: 'local',
        enabled: true,
        command: ['npx', '-y', '@benborla29/mcp-server-mysql'],
        environment: {
          MYSQL_HOST: opts.mysqlHost || '192.168.3.249',
          MYSQL_PORT: '3306',
          MYSQL_USER: 'root',
          MYSQL_PASS: opts.mysqlPass || 'Admin@123',
          MYSQL_DB: '',
          ALLOW_INSERT_OPERATION: 'false',
          ALLOW_UPDATE_OPERATION: 'false',
          ALLOW_DELETE_OPERATION: 'false',
          ALLOW_DDL_OPERATION: 'false',
        },
      },
    })
  }

  const t = now()
  db.prepare(
    `INSERT INTO agent (id, name, avatar, description, instructions, model_provider, model_id, thinking, builtin, archived, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, NULL)`,
  ).run('agt_xiaojie', '小杰', '🧑‍💻', 'Jeff 内置管家：问答、创建与管理一切', '', providerId, modelId, 'high', t, t)

  if (opts.testAgent) {
    const id = genId('agt')
    db.prepare(
      `INSERT INTO agent (id, name, avatar, description, instructions, model_provider, model_id, thinking, builtin, archived, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL)`,
    ).run(
      id,
      'E2E探路者',
      '🧪',
      '用于 skill/MCP 真实冒烟的测试智能体',
      '你是测试智能体。当用户要求搜索时，必须使用 byted-web-search / 豆包搜索 skill。当用户问数据库时，必须调用 mysql MCP 工具做只读查询（如 SHOW DATABASES），禁止写删改。用简体中文简短回复。',
      providerId,
      modelId,
      'high',
      t,
      t,
    )
  }

  db.close()
}
