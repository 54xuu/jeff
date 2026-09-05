/**
 * 端到端冒烟：真实 opencode sidecar + mock LLM。
 * 仅在 JEFF_E2E=1 时运行（需要本机有 opencode 可执行文件）。
 * 运行：JEFF_E2E=1 npx vitest run --no-file-parallelism tests/e2e.sidecar.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlm } from './helpers/mock-llm.mjs'
import { JeffCore, agentRepo, buildPaths, openDb, kvRepo, XIAOJIE_ID, agentSlug } from '../src/index.js'

const RUN = process.env.JEFF_E2E === '1'
const d = RUN ? describe : describe.skip

const helperDir = path.dirname(fileURLToPath(import.meta.url))
const MOCK_PORT = 18081
const BIN = process.env.JEFF_OPENCODE_BIN || path.join(process.env.HOME || '', '.opencode/bin/opencode')

let mockServer: ChildProcess | null = null
let core: JeffCore
let home: string

d('E2E: sidecar 私聊 + 小杰管理工具', () => {
  beforeAll(async () => {
    if (!fs.existsSync(BIN)) throw new Error(`找不到 opencode: ${BIN}`)
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-e2e-'))

    // 1. 启动 mock LLM（独立进程，避免 vitest worker 阻塞事件循环影响）
    const helper = path.join(helperDir, 'helpers', 'mock-llm.mjs')
    mockServer = spawn(process.execPath, [helper], {
      env: {
        ...process.env,
        MOCK_PORT: String(MOCK_PORT),
        // 当用户文本提到「创建智能体」时，让 mock 调用 jeff_agent_create
        MOCK_TOOL_CALL: JSON.stringify({
          trigger: '创建.{0,6}智能体|jeff_agent_create',
          name: 'jeff_agent_create',
          args: { name: '测试员', description: '负责跑测试', instructions: '你负责测试工作' },
        }),
      },
      stdio: process.env.MOCK_LOG ? 'inherit' : 'ignore',
    })
    // 等 mock 起来
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`)
        if (r.ok) break
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 250))
    }

    // 2. 预置 provider 配置（mock openai 兼容端点）
    const paths = buildPaths(home)
    fs.mkdirSync(path.dirname(paths.dbFile), { recursive: true })
    const db = openDb(paths)
    kvRepo(db).setJSON('settings:providers', [
      { id: 'mockai', kind: 'custom', name: 'MockAI', baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, models: [{ id: 'mock-mini', name: 'Mock Mini' }] },
    ])
    kvRepo(db).setJSON('settings:defaultModel', { providerID: 'mockai', modelID: 'mock-mini' })
    db.close()

    // 3. 启动 JeffCore（内部起 sidecar）
    core = new JeffCore(home)
    core.on('sidecar-log', (line: string) => {
      if (process.env.JEFF_E2E_LOGS) console.log(line)
    })
    await core.init({ binaryPath: BIN })
  }, 60000)

  afterAll(async () => {
    await core?.dispose()
    mockServer && (mockServer as ChildProcess).kill?.()
    if (home && process.env.JEFF_E2E_KEEP !== '1') fs.rmSync(home, { recursive: true, force: true })
  })

  it('sidecar 就绪且小杰 agent 已注册', async () => {
    expect(core.sidecar.status).toBe('running')
    const agents = await core.oc.listAgents()
    expect(agents.map((a) => a.name)).toContain('jeff_xiaojie')
  }, 30000)

  it('私聊：小杰通过工具桥创建智能体（全链路）', async () => {
    const reply = await core.privateChat.send(
      XIAOJIE_ID,
      '小杰',
      '请帮我在 Jeff 里创建一个智能体，名字叫「测试员」，它负责跑测试。用 jeff_agent_create 工具完成。',
    )
    expect(reply.id).toMatch(/^msg_/)
    // 工具调用落地：DB 里出现「测试员」
    const created = agentRepo(core.db).list().find((a) => a.name === '测试员')
    expect(created).toBeDefined()
    // md 同步：触发惰性重启（新建 agent 的会话）后，opencode 里能看到新 agent
    await core.privateChat.ensureSession(created!.id, '测试员')
    const ocAgents = await core.oc.listAgents()
    expect(ocAgents.map((a) => a.name)).toContain(agentSlug(created!.id))
  }, 120000)

  it('私聊：直接对话（无工具）往返', async () => {
    const reply = await core.privateChat.send(XIAOJIE_ID, '小杰', '你好，请用一句话介绍你自己')
    expect(reply.id).toMatch(/^msg_/)
  }, 60000)

  it('内置保护：尝试删除小杰被拒', async () => {
    const res = await fetch(`${core.bridge.url()}/tools/jeff_agent_delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${core.bridge.token}` },
      body: JSON.stringify({ id: XIAOJIE_ID }),
    })
    const data = (await res.json()) as { ok: boolean; error?: string }
    expect(data.ok).toBe(false)
    expect(data.error).toContain('不可删除')
  })
})
