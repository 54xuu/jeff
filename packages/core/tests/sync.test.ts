import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMockWebdav } from './helpers/mock-webdav.mjs'
import { openDb } from '../src/db/db.js'
import { buildPaths, ensureDirs, type JeffPaths } from '../src/paths.js'
import { agentRepo, projectRepo, projectAgentRepo, taskRepo, kvRepo } from '../src/db/repos.js'
import { MemoryStore } from '../src/memory/store.js'
import { SyncEngine } from '../src/sync/engine.js'
import { XIAOJIE_ID } from '../src/ipc/contract.js'
import type { Server } from 'node:http'
import type { DB } from '../src/db/db.js'

const PORT = 19021
let server: Server
let davRoot: string

interface Side {
  home: string
  paths: JeffPaths
  db: DB
  engine: SyncEngine
  memory: MemoryStore
}

function makeSide(tag: string, remote: string): Side {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `jeff-sync-${tag}-`))
  const paths = buildPaths(home)
  ensureDirs(paths)
  const db = openDb(paths)
  const memory = new MemoryStore(paths)
  const engine = new SyncEngine(db, paths, memory, () => ({
    url: `http://127.0.0.1:${PORT}`,
    username: 'u',
    password: 'p',
    basePath: `/dav/${remote}`,
    autoSync: false,
  }))
  return { home, paths, db, engine, memory }
}

function seed(side: Side): void {
  const agents = agentRepo(side.db)
  agents.create({ id: XIAOJIE_ID, name: '小杰', builtin: 1 })
  const leader = agents.create({ name: '架构师', instructions: 'v1' })
  const dev = agents.create({ name: '开发', instructions: '前端' })
  const p = projectRepo(side.db).create({
    title: '同步测试群',
    leader_agent_id: leader.id,
    workspace_dir: '/home/linux/project-a',
  })
  projectAgentRepo(side.db).add(p.id, leader.id, 'leader')
  projectAgentRepo(side.db).add(p.id, dev.id, 'worker')
  taskRepo(side.db).create({ project_id: p.id, title: '任务一', priority: 'high' })
  side.memory.add({ kind: 'agent', agentId: dev.id }, '用户偏好 vite')
  side.memory.add({ kind: 'user' }, '称呼：Jeff 老师们')
  kvRepo(side.db).setJSON('settings:providers', [{ id: 'mock', name: 'Mock', apiKey: 'k', baseURL: 'http://x', enabled: true, models: [] }])
  kvRepo(side.db).setJSON('settings:mcp', {
    demo: { type: 'remote', enabled: true, url: 'https://mcp.example.com' },
  })
  fs.writeFileSync(side.paths.agentsMdUser, '# 用户级 AGENTS\n用简体中文', 'utf8')
  fs.writeFileSync(path.join(side.paths.agentsMdDir, `${p.id}.md`), '# 项目 AGENTS\n用 vite', 'utf8')
}

beforeAll(async () => {
  davRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-dav-'))
  server = await startMockWebdav(PORT, davRoot)
})

afterAll(async () => {
  server?.close()
})

describe('SyncEngine（实体级双向合并）', () => {
  it('A 上传 → B 首次拉取全量（agents/projects/tasks/memory/settings/mcp/AGENTS.md）', async () => {
    const A = makeSide('a', 'r1')
    const B = makeSide('b', 'r1')
    seed(A)
    const rA = await A.engine.sync()
    expect(rA.ok).toBe(true)
    expect(rA.error).toBeUndefined()
    expect(rA.uploaded).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(davRoot, 'dav/r1/agents.json'))).toBe(true)
    expect(fs.existsSync(path.join(davRoot, 'dav/r1/memory/user.md'))).toBe(true)
    expect(fs.existsSync(path.join(davRoot, 'dav/r1/agents-md/user.md'))).toBe(true)

    const rB = await B.engine.sync()
    expect(rB.ok).toBe(true)
    expect(rB.downloaded).toBeGreaterThan(0)
    const agentsB = agentRepo(B.db).list()
    expect(agentsB.map((a) => a.name)).toContain('架构师')
    expect(agentsB.map((a) => a.name)).toContain('开发')
    const projects = projectRepo(B.db).list()
    expect(projects).toHaveLength(1)
    // 新建项目：workspace_dir 按设备留空，不拷贝 Linux 路径
    expect(projects[0].workspace_dir).toBe('')
    expect(projectAgentRepo(B.db).listByProject(projects[0].id)).toHaveLength(2)
    expect(taskRepo(B.db).listByProject(projects[0].id)).toHaveLength(1)
    expect(B.memory.list({ kind: 'user' })).toContain('称呼：Jeff 老师们')
    const devB = agentsB.find((a) => a.name === '开发')!
    expect(B.memory.list({ kind: 'agent', agentId: devB.id })).toContain('用户偏好 vite')
    expect(kvRepo(B.db).getJSON<Record<string, unknown>>('settings:mcp', {})).toMatchObject({
      demo: { type: 'remote', url: 'https://mcp.example.com' },
    })
    expect(fs.readFileSync(B.paths.agentsMdUser, 'utf8')).toContain('用户级 AGENTS')
    expect(fs.readFileSync(path.join(B.paths.agentsMdDir, `${projects[0].id}.md`), 'utf8')).toContain('用 vite')
    fs.rmSync(A.home, { recursive: true, force: true })
    fs.rmSync(B.home, { recursive: true, force: true })
  })

  it('workspace_dir 按设备保留：已有本机路径不被远端覆盖', async () => {
    const A = makeSide('aws', 'r-ws')
    const B = makeSide('bws', 'r-ws')
    seed(A)
    await A.engine.sync()
    await B.engine.sync()
    const prjB = projectRepo(B.db).list()[0]
    projectRepo(B.db).update(prjB.id, { workspace_dir: 'C:\\Users\\win\\proj' })
    await B.engine.sync()
    // A 再改群名并推送（含 A 的 Linux workspace_dir）
    const prjA = projectRepo(A.db).list()[0]
    projectRepo(A.db).update(prjA.id, { title: '改名后的群' })
    await A.engine.sync()
    await B.engine.sync()
    const after = projectRepo(B.db).get(prjB.id)!
    expect(after.title).toBe('改名后的群')
    expect(after.workspace_dir).toBe('C:\\Users\\win\\proj')
    fs.rmSync(A.home, { recursive: true, force: true })
    fs.rmSync(B.home, { recursive: true, force: true })
  })

  it('GET agents.json 500 → sync 失败且不回推空数组覆盖远端', async () => {
    const A = makeSide('a5', 'r5')
    const B = makeSide('b5', 'r5')
    seed(A)
    await A.engine.sync()
    const before = fs.readFileSync(path.join(davRoot, 'dav/r5/agents.json'), 'utf8')
    expect(JSON.parse(before).length).toBeGreaterThan(1)

    fs.writeFileSync(path.join(davRoot, '.dav-fail'), JSON.stringify({ 'agents.json': 500 }))
    try {
      const rB = await B.engine.sync()
      expect(rB.ok).toBe(false)
      expect(rB.error).toMatch(/500|拉取 agents/)
      const after = fs.readFileSync(path.join(davRoot, 'dav/r5/agents.json'), 'utf8')
      expect(after).toBe(before)
      expect(agentRepo(B.db).list().map((a) => a.name)).not.toContain('架构师')
    } finally {
      fs.rmSync(path.join(davRoot, '.dav-fail'), { force: true })
    }
    fs.rmSync(A.home, { recursive: true, force: true })
    fs.rmSync(B.home, { recursive: true, force: true })
  })

  it('双向：B 的修改回传 A；A 的新任务传播到 B', async () => {
    const A = makeSide('a2', 'r2')
    const B = makeSide('b2', 'r2')
    seed(A)
    await A.engine.sync()
    await B.engine.sync()

    const devB = agentRepo(B.db).list().find((a) => a.name === '开发')!
    agentRepo(B.db).update(devB.id, { instructions: '前端 + vite 专项' })
    const prjB = projectRepo(B.db).list()[0]
    taskRepo(B.db).create({ project_id: prjB.id, title: 'B 新建的任务' })
    await B.engine.sync()

    await A.engine.sync()
    const devA = agentRepo(A.db).list().find((a) => a.name === '开发')!
    expect(devA.instructions).toBe('前端 + vite 专项')
    expect(taskRepo(A.db).listByProject(prjB.id).map((t) => t.title)).toContain('B 新建的任务')

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
    agentRepo(A.db).update(devA.id, { instructions: 'A 的版本' })
    await new Promise((r) => setTimeout(r, 5))
    agentRepo(B.db).update(devB.id, { instructions: 'B 的版本' })
    const rB = await B.engine.sync()
    const rA = await A.engine.sync()
    expect(agentRepo(A.db).get(devA.id)?.instructions).toBe('B 的版本')
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
