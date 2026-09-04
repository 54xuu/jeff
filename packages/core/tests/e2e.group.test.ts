/**
 * E2E：项目群聊（M2）——建群 → 群消息路由 leader → 回帖入群记录 → 任务卡片。
 * 仅在 JEFF_E2E=1 时运行。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JeffCore, agentRepo, projectRepo, taskRepo, projectAgentRepo, buildPaths, openDb, kvRepo, XIAOJIE_ID, chatMessageRepo } from '../src/index.js'

const RUN = process.env.JEFF_E2E === '1'
const d = RUN ? describe : describe.skip

const helperDir = path.dirname(fileURLToPath(import.meta.url))
const MOCK_PORT = 18082
const BIN = process.env.JEFF_OPENCODE_BIN || path.join(process.env.HOME || '', '.opencode/bin/opencode')

let mockServer: ChildProcess | null = null
let core: JeffCore
let home: string

d('E2E: 项目群聊 + 任务卡片', () => {
  beforeAll(async () => {
    if (!fs.existsSync(BIN)) throw new Error(`找不到 opencode: ${BIN}`)
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-e2eg-'))
    const helper = path.join(helperDir, 'helpers', 'mock-llm.mjs')
    mockServer = spawn(process.execPath, [helper], {
      env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
      stdio: 'ignore',
    })
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`)
        if (r.ok) break
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    const paths = buildPaths(home)
    fs.mkdirSync(path.dirname(paths.dbFile), { recursive: true })
    const db = openDb(paths)
    kvRepo(db).setJSON('settings:providers', [
      { id: 'mockai', kind: 'custom', name: 'MockAI', baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, models: [{ id: 'mock-mini' }] },
    ])
    kvRepo(db).setJSON('settings:defaultModel', { providerID: 'mockai', modelID: 'mock-mini' })
    db.close()
    core = new JeffCore(home)
    await core.init({ binaryPath: BIN })
  }, 60000)

  afterAll(async () => {
    await core?.dispose()
    mockServer && mockServer.kill?.()
    if (home && process.env.JEFF_E2E_KEEP !== '1') fs.rmSync(home, { recursive: true, force: true })
  })

  it('建群（leader=小杰 + 成员）并群消息路由', async () => {
    // 建一个成员 agent
    const dev = agentRepo(core.db).create({ name: '前端小王', instructions: '你负责前端' })
    // 同步注册表并标脏（模拟真实路径：UI/工具创建后都会走这两步）
    core.syncRegistry()
    core.markRegistryDirty()
    // 经工具桥建群（模拟小杰调用）
    const res = await fetch(`${core.bridge.url()}/tools/jeff_project_create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${core.bridge.token}` },
      body: JSON.stringify({
        title: '官网开发群',
        leader_agent_id: XIAOJIE_ID,
        members: [{ agentId: dev.id, role: '开发' }],
      }),
    })
    const created = (await res.json()) as { ok: boolean; data?: { id: string }; error?: string }
    expect(created.ok).toBe(true)
    const projectId = created.data!.id

    // 群消息：默认路由 leader（小杰）
    const routed = await core.groupChat.send({ projectId, text: '大家好，项目启动了' })
    expect(routed.routedTo).toBe(XIAOJIE_ID)
    const history = core.groupChat.history(projectId)
    expect(history.some((m) => m.role === 'user' && m.text.includes('项目启动'))).toBe(true)
    expect(history.some((m) => m.role === 'assistant' && m.sender_name === '小杰')).toBe(true)

    // @直达成员
    const routed2 = await core.groupChat.send({ projectId, text: `@前端小王 把首页改一下` })
    expect(routed2.routedTo).toBe(dev.id)
    const history2 = core.groupChat.history(projectId)
    expect(history2[history2.length - 1].sender_name).toBe('前端小王')

    // 会话绑定：群内各 agent 有独立 session
    expect(core.groupChat.getSessionId(projectId, XIAOJIE_ID)).toMatch(/^ses_/)
    expect(core.groupChat.getSessionId(projectId, dev.id)).toMatch(/^ses_/)
  }, 120000)

  it('工具桥建任务 → 群里出现任务卡片', async () => {
    const p = projectRepo(core.db).list()[0]
    const dev = agentRepo(core.db).list().find((a) => a.name === '前端小王')!
    const res = await fetch(`${core.bridge.url()}/tools/jeff_task_create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${core.bridge.token}` },
      body: JSON.stringify({ project_id: p.id, title: '重构首页样式', priority: 'high', assignee_agent_id: dev.id }),
    })
    const created = (await res.json()) as { ok: boolean; data?: { key: string }; error?: string }
    expect(created.ok).toBe(true)
    expect(created.data!.key).toBe('JEF-1')

    const history = core.groupChat.history(p.id)
    const card = history.find((m) => (m.meta as { type?: string })?.type === 'task')
    expect(card).toBeDefined()
    expect(card!.text).toContain('JEF-1')
    expect(card!.text).toContain('重构首页样式')

    // 任务状态流转（工具桥）
    const tasks = taskRepo(core.db).listByProject(p.id)
    const res2 = await fetch(`${core.bridge.url()}/tools/jeff_task_update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${core.bridge.token}` },
      body: JSON.stringify({ id: tasks[0].id, status: 'in_progress' }),
    })
    const upd = (await res2.json()) as { ok: boolean; data?: { status: string } }
    expect(upd.ok).toBe(true)
    expect(upd.data!.status).toBe('in_progress')
    // 状态变化也产生系统消息
    const history2 = core.groupChat.history(p.id)
    expect(history2.filter((m) => (m.meta as { type?: string })?.type === 'task').length).toBeGreaterThanOrEqual(2)
  }, 60000)
})
