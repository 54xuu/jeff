import { test, expect } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeJeff, launchJeff, loadE2eEnv, REPO_ROOT } from './helpers/launch.js'

test.describe.configure({ mode: 'serial' })

/**
 * v1.8.0 新功能 UI 封闭测试（不需要模型）：
 * 智能体分组 / 定时任务 / 插件 + MCP 注入 / 斜杠指令 / 内置浏览器面板。
 *
 * 判据不只靠界面：涉及落库与配置的断言都直连 jeff.db 对账（agent.category、
 * cron_task 行、settings:mcp 的 plugin-* 注入），避免「界面看起来对、数据没写」。
 */
const HOME = path.join(REPO_ROOT, '.tmp/jeff-v18-home')
const EVIDENCE = path.join(REPO_ROOT, '.tmp/v18/evidence')

function dbQuery<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(path.join(HOME, 'jeff.db'), { readOnly: true })
  try {
    return db.prepare(sql).all(...(params as never[])) as T[]
  } finally {
    db.close()
  }
}

/** 预置插件目录（含首页 MCP 与一条快捷指令） */
function seedPlugin(homepage: string): void {
  const dir = path.join(HOME, 'plugins', 'e2e-plugin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      {
        id: 'e2e-plugin',
        name: '测试插件',
        version: '0.1.0',
        icon: '🧪',
        description: 'E2E 用的示例插件：验证启用、MCP 注入与快捷指令',
        homepage,
        commands: [{ name: '/e2e', description: '向插件提问', prompt: '请通过测试插件查询病区概况。' }],
        mcp: { url: 'http://127.0.0.1:9/mcp', tools: ['ward_overview'], headers: { 'X-Agent-Token': '${SECRET}' } },
      },
      null,
      2,
    ),
  )
}

/** 起一个本地页面，供内置浏览器导航用（webview 需要真实的 http 目标） */
async function startLocalPage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>Jeff 测试页</title></head><body>
      <h1>内置浏览器测试页</h1>
      <button id="btn" onclick="document.getElementById('out').textContent='已点击'">点我</button>
      <div id="out">未点击</div>
      <input id="box" placeholder="输入框" />
    </body></html>`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

test('v1.8.0：分组 / 定时任务 / 插件 / 斜杠指令 / 内置浏览器', async () => {
  test.setTimeout(600_000)
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const localPage = await startLocalPage()

  const env = loadE2eEnv()
  const { app, page } = await launchJeff({
    home: HOME,
    // testAgent: 需要一个非内置智能体来验证分组（小杰的资料锁定，分类框禁用）
    seed: { apiKey: process.env.SILICONFLOW_API_KEY || env.SILICONFLOW_API_KEY || '', testAgent: true },
  })
  // 插件目录必须在 seed 之后写：seedJeffHomeSync 会清空 home
  seedPlugin(localPage.url)
  if (process.env.JEFF_E2E_DEBUG_CONSOLE === '1') {
    page.on('console', (m) => console.log(`[renderer:${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => console.log(`[renderer:error] ${e.message}`))
  }

  try {
    await expect(page.getByTestId('nav-rail')).toBeVisible()

    // ---------- 1. 通讯录：分组与分类编辑 ----------
    await page.getByTestId('nav-contacts').click()
    await expect(page.getByTestId('agents-page')).toBeVisible()
    // 给第一个非内置智能体设置分类（小杰的资料锁定，分类框禁用属预期）
    const firstCard = page.locator('[data-testid^="agent-card-"]').last()
    await firstCard.click()
    await page.getByTestId('agent-category').fill('医疗场景')
    await page.getByTestId('agent-save').click()
    await expect(page.getByTestId('agent-saved')).toBeVisible({ timeout: 20_000 })
    // 数据库确实写入了 category（界面分组只是投影）
    await expect
      .poll(() => dbQuery<{ category: string }>('SELECT category FROM agent WHERE category = ?', '医疗场景').length, { timeout: 15_000 })
      .toBeGreaterThan(0)
    // 分组视图出现「医疗场景」组头，且可折叠
    await expect(page.getByTestId('agent-group-医疗场景')).toBeVisible()
    await page.getByTestId('agent-group-toggle-医疗场景').click()
    await expect(page.getByTestId('agent-card-' + String(dbQuery<{ id: string }>("SELECT id FROM agent WHERE category='医疗场景' LIMIT 1")[0].id))).toBeHidden()
    await page.getByTestId('agent-group-toggle-医疗场景').click()
    await page.screenshot({ path: path.join(EVIDENCE, '01-agents-grouped.png'), fullPage: true })

    // ---------- 1b. 聊天列表同样按分类显示（不只是通讯录） ----------
    await page.getByTestId('nav-chats').click()
    await expect(page.getByTestId('chat-agent-group-医疗场景')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('chat-agent-group-医疗场景').click()
    await expect(page.getByTestId('chat-agent-E2E探路者')).toBeHidden()
    await page.getByTestId('chat-agent-group-医疗场景').click()
    await expect(page.getByTestId('chat-agent-E2E探路者')).toBeVisible()
    await page.screenshot({ path: path.join(EVIDENCE, '01b-chatlist-grouped.png'), fullPage: true })

    // ---------- 2. 定时任务：新建 → 落库 → 立即执行 ----------
    await page.getByTestId('nav-schedules').click()
    await expect(page.getByTestId('schedules-page')).toBeVisible()
    await page.getByTestId('cron-create').click()
    await page.getByTestId('cron-name').fill('E2E 早报')
    await page.getByTestId('cron-target-type').selectOption('agent')
    // 目标下拉里选第一个智能体
    const targetValue = await page.getByTestId('cron-target-id').locator('option').nth(1).getAttribute('value')
    await page.getByTestId('cron-target-id').selectOption(targetValue || '')
    await page.getByTestId('cron-expr').fill('30 8 * * 1-5')
    await page.getByTestId('cron-prompt').fill('请汇报今天的病区动态。')
    await page.getByTestId('cron-miss-skip').click()
    await page.getByTestId('cron-save').click()
    await expect(page.locator('[data-testid^="cron-card-"]')).toHaveCount(1)
    const cronRow = await expect
      .poll(() => dbQuery<{ name: string; cron_expr: string; miss_policy: string; next_run_at: number | null }>('SELECT name, cron_expr, miss_policy, next_run_at FROM cron_task')[0], { timeout: 15_000 })
      .toBeTruthy()
    void cronRow
    const tasks = dbQuery<{ name: string; cron_expr: string; miss_policy: string }>('SELECT name, cron_expr, miss_policy FROM cron_task')
    expect(tasks[0]).toMatchObject({ name: 'E2E 早报', cron_expr: '30 8 * * 1-5', miss_policy: 'skip' })
    // 人性化描述与下次时间都渲染出来了（左侧列表与卡片各有一处）
    await expect(page.locator('[data-testid^="cron-card-"]').getByText('工作日 08:30')).toBeVisible()
    await page.screenshot({ path: path.join(EVIDENCE, '02-schedules.png'), fullPage: true })
    // 立即执行 → 生成运行记录（无模型/无引擎时会失败，但必须留下 failed + 原因，而不是静默）
    const cronId = dbQuery<{ id: string }>('SELECT id FROM cron_task')[0].id
    await page.getByTestId(`cron-run-${cronId}`).click()
    await expect
      .poll(() => dbQuery<{ status: string }>('SELECT status FROM cron_run ORDER BY started_at DESC').length, { timeout: 40_000 })
      .toBeGreaterThan(0)
    // 点「立即执行」会自动展开运行历史
    await expect(page.getByTestId(`cron-runs-${cronId}`)).toBeVisible()
    await page.screenshot({ path: path.join(EVIDENCE, '03-cron-runs.png'), fullPage: true })

    // ---------- 3. 插件：列出 / 启用 / MCP 注入 / 密钥 ----------
    await page.getByTestId('nav-plugins').click()
    await expect(page.getByTestId('plugins-page')).toBeVisible()
    await expect(page.getByTestId('plugin-card-e2e-plugin')).toBeVisible()
    await page.getByTestId('plugin-detail-e2e-plugin').click()
    const dialog = page.getByTestId('dialog')
    await expect(dialog.getByText('/e2e', { exact: true })).toBeVisible()
    await expect(dialog.getByText('ward_overview')).toBeVisible()
    await page.getByTestId('dialog-mask').click({ position: { x: 5, y: 5 } })
    // 存密钥（会被写进 MCP 注入的请求头）
    await page.getByTestId('plugin-card-e2e-plugin').locator('button[title="配置密钥 / 认证"]').click()
    await page.getByTestId('plugin-secret').fill('e2e-token-123')
    await page.getByTestId('plugin-secret-save').click()
    await expect(page.getByText('已存密钥')).toBeVisible({ timeout: 20_000 })
    // 启用 → settings:mcp 里出现 plugin-e2e-plugin 且 header 用真实密钥替换了 ${SECRET}
    await page.getByTestId('plugin-toggle-e2e-plugin').click()
    await expect
      .poll(
        () => {
          const rows = dbQuery<{ value: string }>("SELECT value FROM kv WHERE key = 'settings:mcp'")
          if (rows.length === 0) return ''
          const mcp = JSON.parse(rows[0].value) as Record<string, { url?: string; headers?: Record<string, string> }>
          return mcp['plugin-e2e-plugin']?.headers?.['X-Agent-Token'] || ''
        },
        { timeout: 20_000 },
      )
      .toBe('e2e-token-123')
    const injected = JSON.parse(dbQuery<{ value: string }>("SELECT value FROM kv WHERE key = 'settings:mcp'")[0].value) as Record<string, { url?: string }>
    expect(injected['plugin-e2e-plugin'].url).toBe('http://127.0.0.1:9/mcp')
    await page.screenshot({ path: path.join(EVIDENCE, '04-plugins.png'), fullPage: true })

    // ---------- 3b. 备份/恢复入口统一在「设置 → 同步」（功能页只放跳转） ----------
    await page.getByTestId('plugin-goto-backup').click()
    await expect(page.getByTestId('settings-nav-sync')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('plugin-backup')).toBeVisible()
    await expect(page.getByTestId('plugin-restore')).toBeVisible()
    await expect(page.getByTestId('cron-backup')).toBeVisible()
    await expect(page.getByTestId('cron-restore')).toBeVisible()
    await expect(page.getByText('插件目录备份')).toBeVisible()
    await expect(page.getByText('定时任务备份')).toBeVisible()
    await page.screenshot({ path: path.join(EVIDENCE, '04b-settings-backups.png'), fullPage: true })
    // 回插件页确认那边已经没有备份按钮了
    await page.getByTestId('nav-plugins').click()
    await expect(page.getByTestId('plugin-card-e2e-plugin')).toBeVisible()
    await expect(page.getByTestId('plugins-page').getByTestId('plugin-backup')).toHaveCount(0)

    // ---------- 4. 斜杠指令：启用插件的 commands 进入 `/` 菜单并插入提示词 ----------
    await page.getByTestId('nav-chats').click()
    // 先进入一个会话（全新 home 启动时默认停在空态）
    await page.getByTestId('chat-agent-E2E探路者').click()
    const draft = page.getByTestId('chat-draft')
    await expect(draft).toBeVisible()
    await draft.click()
    await draft.fill('/')
    await expect(page.getByTestId('slash-pop')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('slash-item-0')).toContainText('/e2e')
    await page.screenshot({ path: path.join(EVIDENCE, '05-slash-menu.png'), fullPage: true })
    await page.getByTestId('slash-item-0').click()
    await expect(draft).toHaveValue('请通过测试插件查询病区概况。')
    await draft.fill('')

    // ---------- 5. 内置浏览器面板：手动导航 + 页面内容 + 宽度拖拽 ----------
    await page.getByTestId('nav-browser').click()
    await expect(page.getByTestId('browser-panel')).toBeVisible()
    await page.getByTestId('browser-address').fill(localPage.url)
    await page.getByTestId('browser-address').press('Enter')
    // webview 里真的加载了页面：标题同步到地址栏/状态
    await expect
      .poll(async () => (await page.getByTestId('browser-address').inputValue()).includes('127.0.0.1'), { timeout: 30_000 })
      .toBe(true)
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(EVIDENCE, '06-browser-panel.png'), fullPage: true })
    // agent 工具与面板共用一个 webview：验证面板内可执行页面脚本（点击/输入的基础）
    const clicked = await page.evaluate(async () => {
      const wv = document.querySelector('webview') as unknown as { executeJavaScript: (c: string) => Promise<unknown> } | null
      if (!wv) return 'no-webview'
      try {
        return (await wv.executeJavaScript("document.getElementById('btn').click(); document.getElementById('out').textContent")) as string
      } catch (err) {
        const w = window as unknown as { __jeffBrowserEvents?: string[] }
        return `error:${String((err as Error)?.message || err).slice(0, 120)}|events:${(w.__jeffBrowserEvents || []).join(',')}`
      }
    })
    expect(clicked).toBe('已点击')
    await page.getByTestId('browser-close').click()
    await expect(page.getByTestId('browser-panel')).toBeHidden()
  } finally {
    await closeJeff(app)
    await localPage.close()
  }
})
