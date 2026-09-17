import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeJeff, launchJeff, REPO_ROOT } from './helpers/launch.js'
import { readBridge, callToolOk } from './helpers/bridge.js'

test.describe.configure({ mode: 'serial' })

/**
 * 定时任务 10 轮封闭 E2E（不依赖模型成功回复）：
 * 目标下拉分组、多任务并行、同一智能体/项目群下多会话互不污染。
 *
 * 立即执行若无可用模型会 failed，但专属会话/话题在投递前就会落 kv / chat_message，
 * 所以隔离断言不靠模型正文。
 */
const HOME = path.join(REPO_ROOT, '.tmp/jeff-cron-e2e-home')
const EVIDENCE = path.join(REPO_ROOT, '.tmp/cron/evidence')

function dbQuery<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  let lastErr: unknown
  for (let i = 0; i < 8; i++) {
    try {
      const db = new DatabaseSync(path.join(HOME, 'jeff.db'), { readOnly: true })
      try {
        return db.prepare(sql).all(...(params as never[])) as T[]
      } finally {
        db.close()
      }
    } catch (err) {
      lastErr = err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80)
    }
  }
  throw lastErr
}

async function waitKv(key: string, timeout = 45_000): Promise<string> {
  await expect
    .poll(() => dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)[0]?.value || '', { timeout })
    .not.toBe('')
  return dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)[0].value
}

async function waitRunStarted(taskId: string, timeout = 20_000): Promise<void> {
  await expect
    .poll(() => dbQuery<{ n: number }>('SELECT COUNT(*) AS n FROM cron_run WHERE task_id = ?', taskId)[0]?.n || 0, { timeout })
    .toBeGreaterThan(0)
}

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(async ({ channel, payload }) => window.jeff.invoke(channel, payload) as Promise<T>, { channel, payload })
}

test.describe('定时任务 10 轮：分组下拉 / 并行 / 会话隔离', () => {
  test.setTimeout(180_000)
  let app: Awaited<ReturnType<typeof launchJeff>>['app']
  let page: Page
  let agentId = ''
  let xiaojieId = ''
  let projectId = ''
  let agentTaskA = ''
  let agentTaskB = ''
  let projectTaskA = ''
  let projectTaskB = ''
  let userPrivateSession = ''
  let userActiveThread = ''

  test.beforeAll(async () => {
    fs.mkdirSync(EVIDENCE, { recursive: true })
    const launched = await launchJeff({
      home: HOME,
      seed: { apiKey: 'sk-e2e-invalid', testAgent: true },
    })
    app = launched.app
    page = launched.page
    await expect(page.getByTestId('nav-rail')).toBeVisible()
    await expect.poll(() => fs.existsSync(path.join(HOME, 'oc-home/config/opencode/plugin/jeff-bridge.js')), { timeout: 30_000 }).toBe(true)
    const bridge = readBridge(HOME)
    const agents = dbQuery<{ id: string; name: string; builtin: number }>('SELECT id, name, builtin FROM agent WHERE deleted_at IS NULL')
    xiaojieId = agents.find((a) => a.builtin === 1)?.id || ''
    agentId = agents.find((a) => a.builtin !== 1)?.id || ''
    expect(xiaojieId, '小杰应存在').toBeTruthy()
    expect(agentId, 'E2E探路者应存在').toBeTruthy()
    const project = await callToolOk<{ id: string }>(bridge, 'jeff_project_create', {
      title: 'E2E 护士站',
      leader_agent_id: agentId,
    })
    projectId = project.id
  })

  test.afterAll(async () => {
    if (app) await closeJeff(app)
  })

  test('R1 新建弹窗目标下拉按智能体/项目群分组', async () => {
    await page.getByTestId('nav-schedules').click()
    await expect(page.getByTestId('schedules-page')).toBeVisible()
    await expect
      .poll(async () => {
        const list = (await invoke<{ id: string }[]>(page, 'projects:list')) || []
        return Array.isArray(list) ? list.length : 0
      }, { timeout: 15_000 })
      .toBeGreaterThan(0)
    await page.getByTestId('cron-create').click()
    await expect(page.getByTestId('cron-target-id')).toBeVisible()
    const agentOpts = page.getByTestId('cron-target-id').locator('optgroup[label="智能体"] option')
    const projectOpts = page.getByTestId('cron-target-id').locator('optgroup[label="项目群"] option')
    await expect(agentOpts).toHaveCount(2) // 小杰 + 探路者
    await expect(projectOpts).toHaveCount(1)
    expect(await agentOpts.first().getAttribute('value')).toMatch(/^agent:/)
    expect(await projectOpts.first().getAttribute('value')).toMatch(/^project:/)
    await expect(page.getByTestId('cron-target-type')).toHaveCount(0)
    await page.screenshot({ path: path.join(EVIDENCE, 'R1-grouped-dropdown.png'), fullPage: true })
    await page.getByTestId('dialog-mask').click({ position: { x: 5, y: 5 } })
    await expect(page.getByTestId('cron-target-id')).toHaveCount(0)
  })

  test('R2 分组下拉选智能体保存任务', async () => {
    await page.getByTestId('cron-create').click()
    await page.getByTestId('cron-name').fill('探路者早报')
    await page.getByTestId('cron-target-id').selectOption(`agent:${agentId}`)
    await page.getByTestId('cron-expr').fill('0 8 * * *')
    await page.getByTestId('cron-prompt').fill('请报早报暗号 ALPHA')
    await page.getByTestId('cron-miss-skip').click()
    await page.getByTestId('cron-save').click()
    await expect
      .poll(() => dbQuery<{ id: string; target_type: string; target_id: string }>('SELECT id, target_type, target_id FROM cron_task WHERE name = ? AND deleted_at IS NULL', '探路者早报')[0] || null, {
        timeout: 15_000,
      })
      .toMatchObject({ target_type: 'agent', target_id: agentId })
    agentTaskA = dbQuery<{ id: string }>('SELECT id FROM cron_task WHERE name = ? AND deleted_at IS NULL', '探路者早报')[0].id
  })

  test('R3 分组下拉选项目群保存任务', async () => {
    await page.getByTestId('cron-create').click()
    await page.getByTestId('cron-name').fill('护士站晨间')
    await page.getByTestId('cron-target-id').selectOption(`project:${projectId}`)
    await page.getByTestId('cron-expr').fill('30 8 * * 1-5')
    await page.getByTestId('cron-prompt').fill('晨间暗号 GAMMA')
    await page.getByTestId('cron-miss-skip').click()
    await page.getByTestId('cron-save').click()
    await expect
      .poll(() => dbQuery<{ target_type: string; target_id: string }>('SELECT target_type, target_id FROM cron_task WHERE name = ? AND deleted_at IS NULL', '护士站晨间')[0] || null, {
        timeout: 15_000,
      })
      .toMatchObject({ target_type: 'project', target_id: projectId })
    projectTaskA = dbQuery<{ id: string }>('SELECT id FROM cron_task WHERE name = ? AND deleted_at IS NULL', '护士站晨间')[0].id
  })

  test('R4 同一智能体两条任务 → 两条 session:cron，用户私聊指针不变', async () => {
    const created = await invoke<{ sessionId: string }>(page, 'chat:new', { agentId })
    userPrivateSession = created.sessionId
    expect(userPrivateSession).toBeTruthy()

    const bridge = readBridge(HOME)
    const t2 = await callToolOk<{ id: string }>(bridge, 'jeff_cron_create', {
      name: '探路者晚报',
      target_type: 'agent',
      target_id: agentId,
      cron_expr: '0 18 * * *',
      prompt: '请报晚报暗号 BETA',
      miss_policy: 'skip',
    })
    agentTaskB = t2.id

    await invoke(page, 'cron:run', { id: agentTaskA })
    await invoke(page, 'cron:run', { id: agentTaskB })
    const sesA = await waitKv(`session:cron:${agentTaskA}`)
    const sesB = await waitKv(`session:cron:${agentTaskB}`)
    const userNow = dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `session:private:${agentId}`)[0]?.value
    expect(sesA).not.toBe(sesB)
    expect(userNow).toBe(userPrivateSession)
    expect(sesA).not.toBe(userPrivateSession)
    expect(sesB).not.toBe(userPrivateSession)
  })

  test('R5 同一项目群两条任务 → 两条独立 thread，不抢 active', async () => {
    await invoke(page, 'group:threadNew', { projectId })
    userActiveThread = dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `group:activeThread:${projectId}`)[0]?.value
    expect(userActiveThread).toBeTruthy()

    const bridge = readBridge(HOME)
    const t2 = await callToolOk<{ id: string }>(bridge, 'jeff_cron_create', {
      name: '护士站晚间',
      target_type: 'project',
      target_id: projectId,
      cron_expr: '0 18 * * *',
      prompt: '晚间暗号 DELTA',
      miss_policy: 'skip',
    })
    projectTaskB = t2.id

    await invoke(page, 'cron:run', { id: projectTaskA })
    await invoke(page, 'cron:run', { id: projectTaskB })
    const thrA = await waitKv(`cron:thread:${projectTaskA}`)
    const thrB = await waitKv(`cron:thread:${projectTaskB}`)
    const activeNow = dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `group:activeThread:${projectId}`)[0]?.value
    expect(thrA).not.toBe(thrB)
    expect(activeNow).toBe(userActiveThread)
    expect(thrA).not.toBe(userActiveThread)
    expect(thrB).not.toBe(userActiveThread)
  })

  test('R6 用户私聊会话不被定时任务改写（再次确认指针）', async () => {
    const userNow = dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `session:private:${agentId}`)[0]?.value
    expect(userNow).toBe(userPrivateSession)
  })

  test('R7 三条任务并行触发都留下运行记录、应用不崩', async () => {
    const bridge = readBridge(HOME)
    const ids: string[] = []
    for (const [name, target_type, target_id, prompt] of [
      ['并行探路者', 'agent', agentId, '并行暗号 A'],
      ['并行小杰', 'agent', xiaojieId, '并行暗号 B'],
      ['并行护士站', 'project', projectId, '并行暗号 C'],
    ] as const) {
      const t = await callToolOk<{ id: string }>(bridge, 'jeff_cron_create', {
        name,
        target_type,
        target_id,
        cron_expr: '0 6 * * *',
        prompt,
        miss_policy: 'skip',
      })
      ids.push(t.id)
    }
    const before = dbQuery<{ n: number }>('SELECT COUNT(*) AS n FROM cron_run')[0].n
    const results = await Promise.allSettled(ids.map((id) => invoke(page, 'cron:run', { id })))
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(2)
    for (const id of ids) await waitRunStarted(id)
    const after = dbQuery<{ n: number }>('SELECT COUNT(*) AS n FROM cron_run')[0].n
    expect(after).toBeGreaterThanOrEqual(before + 2)
    await expect(page.getByTestId('nav-rail')).toBeVisible()
    await page.screenshot({ path: path.join(EVIDENCE, 'R7-parallel-runs.png'), fullPage: true })
  })

  test('R8 同一任务连跑两次复用同一条 session:cron', async () => {
    const first = dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `session:cron:${agentTaskA}`)[0]?.value
    expect(first).toBeTruthy()
    try {
      await invoke(page, 'cron:run', { id: agentTaskA })
    } catch (err) {
      expect(String(err)).toMatch(/正在执行/)
    }
    const second = await waitKv(`session:cron:${agentTaskA}`)
    expect(second).toBe(first)
  })

  test('R9 群任务消息带 cron_task_id，且不写入用户当前话题', async () => {
    const thrA = dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `cron:thread:${projectTaskA}`)[0].value
    const rows = dbQuery<{ scope: string; content: string; meta: string }>('SELECT scope, content, meta FROM chat_message WHERE content LIKE ?', '%晨间暗号 GAMMA%')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.scope === `group:${projectId}:${thrA}`)).toBe(true)
    expect(rows.some((r) => String(r.meta).includes(projectTaskA))).toBe(true)
    const leaked = dbQuery<{ n: number }>('SELECT COUNT(*) AS n FROM chat_message WHERE scope = ? AND content LIKE ?', `group:${projectId}:${userActiveThread}`, '%晨间暗号 GAMMA%')[0].n
    expect(leaked).toBe(0)
  })

  test('R10 任务 A 的会话不含任务 B 的提示词', async () => {
    const thrA = dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `cron:thread:${projectTaskA}`)[0].value
    const thrB = dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `cron:thread:${projectTaskB}`)[0].value
    const inA = dbQuery<{ n: number }>('SELECT COUNT(*) AS n FROM chat_message WHERE scope = ? AND content LIKE ?', `group:${projectId}:${thrA}`, '%晚间暗号 DELTA%')[0].n
    const inB = dbQuery<{ n: number }>('SELECT COUNT(*) AS n FROM chat_message WHERE scope = ? AND content LIKE ?', `group:${projectId}:${thrB}`, '%晨间暗号 GAMMA%')[0].n
    expect(inA).toBe(0)
    expect(inB).toBe(0)
    const sesA = dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `session:cron:${agentTaskA}`)[0].value
    const sesB = dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `session:cron:${agentTaskB}`)[0].value
    expect(sesA).not.toBe(sesB)
    await page.screenshot({ path: path.join(EVIDENCE, 'R10-isolated.png'), fullPage: true })
  })
})
