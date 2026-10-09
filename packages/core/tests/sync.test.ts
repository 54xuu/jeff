import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMockWebdav } from './helpers/mock-webdav.mjs'
import { openDb } from '../src/db/db.js'
import { buildPaths, ensureDirs, type JeffPaths } from '../src/paths.js'
import { agentRepo, projectRepo, projectAgentRepo, taskActivityRepo, taskRepo, kvRepo } from '../src/db/repos.js'
import { MemoryStore } from '../src/memory/store.js'
import { SyncEngine } from '../src/sync/engine.js'
import { SecretVault } from '../src/secrets/vault.js'
import type { SecretCipher } from '../src/secrets/types.js'
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
    system_prompt: '群规则：销小美协调；成员按本群职责执行。',
    leader_agent_id: leader.id,
    workspace_dir: '/home/linux/project-a',
    siyuan_notebook_id: '20261005111111-nb12345',
    siyuan_parent_doc_id: '20261005123456-abc1234',
  })
  projectAgentRepo(side.db).add(p.id, leader.id, 'leader')
  projectAgentRepo(side.db).add(p.id, dev.id, 'worker')
  projectAgentRepo(side.db).updateConfig(p.id, leader.id, { duties: '本群协调、拆解和验收', model_override: 'openai/gpt-5.1', thinking_override: 'high' })
  projectAgentRepo(side.db).updateConfig(p.id, dev.id, { duties: '本群按分配提交实现', model_override: 'openai/gpt-5.1-mini', thinking_override: 'low' })
  taskRepo(side.db).create({ project_id: p.id, title: '任务一', priority: 'high' })
  side.memory.add({ kind: 'agent', agentId: dev.id }, '用户偏好 vite')
  side.memory.add({ kind: 'user' }, '称呼：Jeff 老师们')
  kvRepo(side.db).setJSON('settings:providers', [{ id: 'mock', name: 'Mock', apiKey: 'k', baseURL: 'http://x', enabled: true, models: [] }])
  kvRepo(side.db).setJSON('settings:mcp', {
    demo: { type: 'remote', enabled: true, url: 'https://mcp.example.com' },
  })
  // 提醒开关随 settings 包同步（notifySound=false 是关键用例：关掉的「假值」不能被当成「没配」丢掉）
  kvRepo(side.db).setJSON('settings:notifySound', false)
  kvRepo(side.db).setJSON('settings:notifyDesktop', true)
  kvRepo(side.db).setJSON('settings:siyuanArchiveTarget', { notebookId: '20261005111111-nb12345', parentDocId: '' })
  kvRepo(side.db).setJSON('integration:siyuan', { baseUrl: 'http://192.168.3.249:6806', token: 'must-stay-local' })
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
  it('私有记忆不上传；远端新版记忆不会覆盖本机保密条目', async () => {
    const A = makeSide('private-a', 'private-memory')
    const B = makeSide('private-b', 'private-memory')
    try {
      A.memory.add({ kind: 'user' }, '[私有] api_key=test-local-secret')
      A.memory.add({ kind: 'user' }, '旧版公开偏好：中文')
      expect((await A.engine.sync()).ok).toBe(true)
      const remote = path.join(davRoot, 'dav/private-memory/memory/user.md')
      expect(fs.readFileSync(remote, 'utf8')).not.toContain('test-local-secret')
      expect((await B.engine.sync()).ok).toBe(true)
      expect(B.memory.list({ kind: 'user' })).toEqual(['旧版公开偏好：中文'])
      B.memory.writeRaw({ kind: 'user' }, '另一台电脑更新公开偏好')
      expect((await B.engine.sync()).ok).toBe(true)
      expect((await A.engine.sync()).ok).toBe(true)
      expect(A.memory.list({ kind: 'user' })).toContain('[私有] api_key=test-local-secret')
      expect(A.memory.list({ kind: 'user' })).toContain('另一台电脑更新公开偏好')
      expect(fs.readFileSync(remote, 'utf8')).not.toContain('test-local-secret')
    } finally { A.db.close(); B.db.close(); fs.rmSync(A.home, { recursive: true, force: true }); fs.rmSync(B.home, { recursive: true, force: true }) }
  })

  it('引擎、模型、思考双向同步，旧 payload 不覆盖已有引擎；本机路径和会话不上传', async () => {
    const A = makeSide('engine-a', 'engine-fields')
    const B = makeSide('engine-b', 'engine-fields')
    try {
      const agent = agentRepo(A.db).create({ name: '多引擎开发', execution_engine: 'codex', engine_model: 'gpt-5', thinking: 'high' })
      kvRepo(A.db).set('engine:path:codex', '/private/bin/codex')
      kvRepo(A.db).setJSON('engine:session:local', { nativeSessionId: 'private-thread' })
      expect((await A.engine.sync()).ok).toBe(true)
      expect((await B.engine.sync()).ok).toBe(true)
      expect(agentRepo(B.db).get(agent.id)).toMatchObject({ execution_engine: 'codex', engine_model: 'gpt-5', thinking: 'high' })
      expect(kvRepo(B.db).get('engine:path:codex')).toBeNull()
      const file = path.join(davRoot, 'dav/engine-fields/agents.json')
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
      const row = rows.find((item: any) => item.id === agent.id)
      delete row.data.execution_engine; delete row.data.engine_model
      row.data.name = '旧客户端修改'; row.updatedAt = Date.now() + 1000
      fs.writeFileSync(file, JSON.stringify(rows))
      expect((await B.engine.sync()).ok).toBe(true)
      expect(agentRepo(B.db).get(agent.id)).toMatchObject({ name: '旧客户端修改', execution_engine: 'codex', engine_model: 'gpt-5' })
      expect(fs.readFileSync(path.join(davRoot, 'dav/engine-fields/settings.json'), 'utf8')).not.toMatch(/private-thread|private\/bin/)
    } finally { A.db.close(); B.db.close(); fs.rmSync(A.home, { recursive: true, force: true }); fs.rmSync(B.home, { recursive: true, force: true }) }
  })

  it('A 上传 → B 首次拉取全量（agents/projects/tasks/memory/settings/mcp/AGENTS.md）', async () => {
    const A = makeSide('a', 'r1')
    const B = makeSide('b', 'r1')
    seed(A)
    const rA = await A.engine.sync()
    expect(rA.ok).toBe(true)
    expect(rA.error).toBeUndefined()
    expect(rA.uploaded).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(davRoot, 'dav/r1/agents.json'))).toBe(true)
    expect(fs.existsSync(path.join(davRoot, 'dav/r1/task_activity.json'))).toBe(true)
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
    expect(projects[0].system_prompt).toBe('群规则：销小美协调；成员按本群职责执行。')
    expect(projects[0]).toMatchObject({ siyuan_notebook_id: '20261005111111-nb12345', siyuan_parent_doc_id: '20261005123456-abc1234' })
    expect(projectAgentRepo(B.db).listByProject(projects[0].id)).toMatchObject([
      { duties: '本群协调、拆解和验收', model_override: 'openai/gpt-5.1', thinking_override: 'high' },
      { duties: '本群按分配提交实现', model_override: 'openai/gpt-5.1-mini', thinking_override: 'low' },
    ])
    expect(taskRepo(B.db).listByProject(projects[0].id)).toHaveLength(1)
    const syncedTask = taskRepo(A.db).listByProject(projects[0].id)[0]
    taskRepo(A.db).update(syncedTask.id, { status: 'in_progress' })
    await A.engine.sync()
    await B.engine.sync()
    expect(taskActivityRepo(B.db).listByProject(projects[0].id).map((item) => item.kind)).toEqual(['created', 'status_changed'])
    expect(B.memory.list({ kind: 'user' })).toContain('称呼：Jeff 老师们')
    const devB = agentsB.find((a) => a.name === '开发')!
    expect(B.memory.list({ kind: 'agent', agentId: devB.id })).toContain('用户偏好 vite')
    expect(kvRepo(B.db).getJSON<Record<string, unknown>>('settings:mcp', {})).toMatchObject({
      demo: { type: 'remote', url: 'https://mcp.example.com' },
    })
    expect(kvRepo(B.db).getJSON<boolean>('settings:notifySound', true)).toBe(false)
    expect(kvRepo(B.db).getJSON<boolean>('settings:notifyDesktop', true)).toBe(true)
    expect(kvRepo(B.db).getJSON('settings:siyuanArchiveTarget', {})).toEqual({ notebookId: '20261005111111-nb12345', parentDocId: '' })
    expect(kvRepo(B.db).getJSON('integration:siyuan', null)).toBeNull()
    expect(fs.readFileSync(path.join(davRoot, 'dav/r1/settings.json'), 'utf8')).not.toContain('must-stay-local')
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

  it('旧客户端项目 payload 缺少群规则和成员覆盖时保留本机已有配置', async () => {
    const A = makeSide('legacy-project-a', 'legacy-project-config')
    const B = makeSide('legacy-project-b', 'legacy-project-config')
    try {
      seed(A)
      expect((await A.engine.sync()).ok).toBe(true)
      expect((await B.engine.sync()).ok).toBe(true)
      const project = projectRepo(B.db).list()[0]
      expect(project.system_prompt).toContain('销小美协调')
      const membersBefore = projectAgentRepo(B.db).listByProject(project.id)
      const file = path.join(davRoot, 'dav/legacy-project-config/projects.json')
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
      const row = rows.find((item: any) => item.id === project.id)
      delete row.data.project.system_prompt
      for (const member of row.data.members) {
        delete member.duties
        delete member.model_override
        delete member.thinking_override
      }
      row.updatedAt = Date.now() + 1000
      fs.writeFileSync(file, JSON.stringify(rows))
      expect((await B.engine.sync()).ok).toBe(true)
      expect(projectRepo(B.db).get(project.id)?.system_prompt).toContain('销小美协调')
      expect(projectAgentRepo(B.db).listByProject(project.id)).toMatchObject(membersBefore.map(({ duties, model_override, thinking_override }) => ({ duties, model_override, thinking_override })))
    } finally { A.db.close(); B.db.close(); fs.rmSync(A.home, { recursive: true, force: true }); fs.rmSync(B.home, { recursive: true, force: true }) }
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

  it('密码只同步元数据，远端文件不含值', async () => {
    const A = makeSide('sec-a', 'secrets-meta')
    const B = makeSide('sec-b', 'secrets-meta')
    const cipher: SecretCipher = {
      isAvailable: () => true,
      encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
      decrypt: (blob) => Buffer.from(blob, 'base64').toString('utf8'),
    }
    try {
      seed(A)
      seed(B)
      const vaultA = new SecretVault(kvRepo(A.db), cipher)
      vaultA.save({ name: 'WEB_SEARCH_API_KEY', value: 'must-not-sync-value', note: '搜索' })
      expect((await A.engine.sync()).ok).toBe(true)
      const remote = fs.readFileSync(path.join(davRoot, 'dav/secrets-meta/settings.json'), 'utf8')
      expect(remote).not.toContain('must-not-sync-value')
      expect(remote).not.toContain(Buffer.from('must-not-sync-value', 'utf8').toString('base64'))
      expect(remote).toContain('WEB_SEARCH_API_KEY')
      expect((await B.engine.sync()).ok).toBe(true)
      const vaultB = new SecretVault(kvRepo(B.db), cipher)
      const item = vaultB.list().items.find((entry) => entry.name === 'WEB_SEARCH_API_KEY')
      expect(item).toMatchObject({ pending: true, hasValue: false, note: '搜索' })
      expect(JSON.stringify(vaultB.read())).not.toContain('must-not-sync-value')
    } finally {
      A.db.close(); B.db.close()
      fs.rmSync(A.home, { recursive: true, force: true })
      fs.rmSync(B.home, { recursive: true, force: true })
    }
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
