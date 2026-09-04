import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockWebdav } from './helpers/mock-webdav.mjs'
import { openDb } from '../src/db/db.js'
import { buildPaths } from '../src/paths.js'
import { agentRepo, projectRepo, projectAgentRepo, taskRepo, kvRepo } from '../src/db/repos.js'
import { MemoryStore } from '../src/memory/store.js'
import { SyncEngine, type WebdavConfig } from '../src/sync/engine.js'
import { XIAOJIE_ID } from '../src/ipc/contract.js'
import type { Server } from 'node:http'
import type { DB } from '../src/db/db.js'

const helperDir = path.dirname(fileURLToPath(import.meta.url))
const PORT = 19021
let server: Server
let davRoot: string

interface Side {
  home: string
  db: DB
  engine: SyncEngine
  memory: MemoryStore
}

function makeSide(tag: string, remote: string): Side {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `jeff-sync-${tag}-`))
  const paths = buildPaths(home)
  fs.mkdirSync(path.dirname(paths.dbFile), { recursive: true })
  const db = openDb(paths)
  const memory = new MemoryStore(paths)
  const engine = new SyncEngine(db, paths, memory, () => ({
    url: `http://127.0.0.1:${PORT}`,
    username: 'u',
    password: 'p',
    basePath: `/dav/${remote}`,
    autoSync: false,
  }))
  return { home, db, engine, memory }
}

function seed(side: Side): void {
  const agents = agentRepo(side.db)
  agents.create({ id: XIAOJIE_ID, name: '小杰', builtin: 1 })
  const leader = agents.create({ name: '架构师', instructions: 'v1' })
  const dev = agents.create({ name: '开发', instructions: '前端' })
  const p = projectRepo(side.db).create({ title: '同步测试群', leader_agent_id: leader.id })
  projectAgentRepo(side.db).add(p.id, leader.id, 'leader')
  projectAgentRepo(side.db).add(p.id, dev.id, '开发')
  taskRepo(side.db).create({ project_id: p.id, title: '任务一', priority: 'high' })
  side.memory.add({ kind: 'agent', agentId: dev.id }, '用户偏好 vite')
  side.memory.add({ kind: 'user' }, '称呼：Jeff 老师们')
}

beforeAll(async () => {
  davRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-dav-'))
  server = await startMockWebdav(PORT, davRoot)
})

afterAll(async () => {
  server?.close()
  // 保留 davRoot 便于调试；测试进程退出后由 /tmp 清理
})

describe('SyncEngine（实体级双向合并）', () => {
  it('A 上传 → B 首次拉取全量（agents/projects/tasks/memory/settings）', async () => {
    const A = makeSide('a', 'r1')
    const B = makeSide('b', 'r1')
    seed(A)
    const rA = await A.engine.sync()
    expect(rA.ok).toBe(true)
    expect(rA.error).toBeUndefined()
    expect(rA.uploaded).toBeGreaterThan(0)
    // 远端确实有文件
    expect(fs.existsSync(path.join(davRoot, 'dav/r1/agents.json'))).toBe(true)
    expect(fs.existsSync(path.join(davRoot, 'dav/r1/memory/user.md'))).toBe(true)

    const rB = await B.engine.sync()
    expect(rB.ok).toBe(true)
    expect(rB.downloaded).toBeGreaterThan(0)
    // B 得到 A 的全部数据
    const agentsB = agentRepo(B.db).list()
    expect(agentsB.map((a) => a.name)).toContain('架构师')
    expect(agentsB.map((a) => a.name)).toContain('开发')
    const projects = projectRepo(B.db).list()
    expect(projects).toHaveLength(1)
    expect(projectAgentRepo(B.db).listByProject(projects[0].id)).toHaveLength(2)
    expect(taskRepo(B.db).listByProject(projects[0].id)).toHaveLength(1)
    expect(B.memory.list({ kind: 'user' })).toContain('称呼：Jeff 老师们')
    const devB = agentsB.find((a) => a.name === '开发')!
    expect(B.memory.list({ kind: 'agent', agentId: devB.id })).toContain('用户偏好 vite')
    fs.rmSync(A.home, { recursive: true, force: true })
    fs.rmSync(B.home, { recursive: true, force: true })
  })

  it('双向：B 的修改回传 A；A 的新任务传播到 B', async () => {
    const A = makeSide('a2', 'r2')
    const B = makeSide('b2', 'r2')
    seed(A)
    await A.engine.sync()
    await B.engine.sync()

    // B 修改 agent 指令 + 建任务
    const devB = agentRepo(B.db).list().find((a) => a.name === '开发')!
    agentRepo(B.db).update(devB.id, { instructions: '前端 + vite 专项' })
    const prjB = projectRepo(B.db).list()[0]
    taskRepo(B.db).create({ project_id: prjB.id, title: 'B 新建的任务' })
    await B.engine.sync()

    // A 拉取
    await A.engine.sync()
    const devA = agentRepo(A.db).list().find((a) => a.name === '开发')!
    expect(devA.instructions).toBe('前端 + vite 专项')
    expect(taskRepo(A.db).listByProject(prjB.id).map((t) => t.title)).toContain('B 新建的任务')

    // A 新增任务 → B
    taskRepo(A.db).create({ project_id: prjB.id, title: 'A 新建的任务' })
    await A.engine.sync()
    await B.engine.sync()
    expect(taskRepo(B.db).listByProject(prjB.id).map((t) => t.title)).toContain('A 新建的任务')
    fs.rmSync(A.home, { recursive: true, force: true })
    fs.rmSync(B.home, { recursive: true, force: true })
  })

  it('墓碑：A 软删除 agent → 传播到 B', async () => {
    const A = makeSide('a3', 'r3')
    const B = makeSide('b3', 'r3')
    seed(A)
    await A.engine.sync()
    await B.engine.sync()
    const devA = agentRepo(A.db).list().find((a) => a.name === '开发')!
    agentRepo(A.db).softDelete(devA.id)
    await A.engine.sync()
    await B.engine.sync()
    const devB = agentRepo(B.db).list().find((a) => a.id === devA.id)
    expect(devB).toBeUndefined()
    expect(agentRepo(B.db).list(true).find((a) => a.id === devA.id)?.deleted_at).not.toBeNull()
    fs.rmSync(A.home, { recursive: true, force: true })
    fs.rmSync(B.home, { recursive: true, force: true })
  })

  it('冲突：双端同改 → LWW 取新 + 记录冲突', async () => {
    const A = makeSide('a4', 'r4')
    const B = makeSide('b4', 'r4')
    seed(A)
    await A.engine.sync()
    await B.engine.sync()
    const devA = agentRepo(A.db).list().find((a) => a.name === '开发')!
    const devB = agentRepo(B.db).list().find((a) => a.name === '开发')!
    // 双端改同一 agent（B 稍后改 → B 应获胜）
    agentRepo(A.db).update(devA.id, { instructions: 'A 的版本' })
    await new Promise((r) => setTimeout(r, 5))
    agentRepo(B.db).update(devB.id, { instructions: 'B 的版本' })
    const rB = await B.engine.sync()
    const rA = await A.engine.sync()
    // A 端应看到 B 的版本（LWW）
    expect(agentRepo(A.db).get(devA.id)?.instructions).toBe('B 的版本')
    // B 端记录到冲突
    expect(rB.conflicts.length + rA.conflicts.length).toBeGreaterThanOrEqual(1)
    fs.rmSync(A.home, { recursive: true, force: true })
    fs.rmSync(B.home, { recursive: true, force: true })
  })

  it('未配置时 sync 报错但不抛出', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-sync-x-'))
    const paths = buildPaths(home)
    const db = openDb(paths)
    const engine = new SyncEngine(db, paths, new MemoryStore(paths), () => null)
    const r = await engine.sync()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未配置')
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
})
