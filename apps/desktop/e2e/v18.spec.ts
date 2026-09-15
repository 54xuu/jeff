import { test, expect, type Page } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeJeff, launchJeff, loadE2eEnv, REPO_ROOT } from './helpers/launch.js'
import { readBridge, callToolOk, type BridgeClient } from './helpers/bridge.js'
import { startTestSite } from './helpers/testsite.js'

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
    await expect(page.getByText('插件目录备份')).toBeVisible()
    await expect(page.getByText('Skills 目录备份')).toBeVisible()
    // 定时任务是纯配置数据，只随「立即同步」走：这里不该再有独立的备份/恢复入口
    await expect(page.getByTestId('cron-backup')).toHaveCount(0)
    await expect(page.getByTestId('cron-restore')).toHaveCount(0)
    await expect(page.getByText('定时任务备份')).toHaveCount(0)
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

/** 预置一个坏插件目录（验证「坏清单带错误展示，不静默消失、不能被启用」） */
function seedBadPlugin(id: string, json: string): void {
  const dir = path.join(HOME, 'plugins', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), json)
}

/**
 * v1.8.3 封闭测试（不需要模型）：定时任务工具边界 / 插件校验与闸门 / 内置浏览器动作。
 *
 * 关键手法：用 `readBridge(HOME)` 拿到工具桥的地址与 token，像模型一样 `POST /tools/<name>`
 * 调真实工具——所以这些断言覆盖的是**与 agent 相同的链路**（含浏览器工具下发渲染层 webview 执行），
 * mock UI E2E 过去测不到这一段。浏览器动作的取证落在本地测试站的服务端（表单收到了什么、文件字节对不对）。
 */
test('v1.8.3：定时任务工具边界 / 插件校验 / 内置浏览器点击·填表·上传·错误分析', async () => {
  test.setTimeout(600_000)
  const site = await startTestSite()
  const env = loadE2eEnv()
  // 上传用的样本文件（内容里带唯一标记，服务端能据此判「传上来的就是这个文件」）
  const uploadFile = path.join(REPO_ROOT, '.tmp/v18/报告样本-20260915.txt')
  fs.mkdirSync(path.dirname(uploadFile), { recursive: true })
  const uploadText = 'JEFF_UPLOAD_MARKER_9812\n患者：张三\n结论：一切正常\n'
  fs.writeFileSync(uploadFile, uploadText)

  const { app, page } = await launchJeff({
    home: HOME,
    seed: { apiKey: process.env.SILICONFLOW_API_KEY || env.SILICONFLOW_API_KEY || '', testAgent: true },
  })
  // 坏插件目录要在 seed 之后写（seed 会清空 home）
  seedBadPlugin('e2e-bad-json', '{ "id": "e2e-bad-json", "name": "坏 JSON", }')
  seedBadPlugin('e2e-bad-cmd', JSON.stringify({ id: 'e2e-bad-cmd', name: '指令没斜杠', commands: [{ name: 'no-slash', prompt: 'x' }] }))
  seedBadPlugin('e2e-bad-url', JSON.stringify({ id: 'e2e-bad-url', name: '首页协议不对', homepage: 'file:///etc/passwd' }))

  try {
    await expect(page.getByTestId('nav-rail')).toBeVisible()
    const bridge: BridgeClient = readBridge(HOME)
    const b = (name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: unknown; error?: string }> => bridge.call(name, args)

    // ---------- 1. 内置浏览器：面板没开时 agent 调工具 → 自动打开并执行 ----------
    expect(await page.getByTestId('browser-panel').count()).toBe(0)
    // 预埋一个「上次访问的地址」且它已经打不开：面板被唤起时若去恢复它，它的加载失败会与 agent 的导航抢时序
    // （实测 live13 R13：agent 导航到可用地址却拿到 ERR_CONNECTION_REFUSED）。agent 的目标地址必须胜出。
    await page.evaluate(() => localStorage.setItem('jeff-browser-last-url', 'http://127.0.0.1:1/should-not-load'))
    const nav = await callToolOk<{ title: string; url: string }>(bridge, 'jeff_browser_navigate', { url: site.url })
    expect(nav.title).toBe('live13 测试站')
    expect(nav.url.startsWith(site.url), `agent 要打开的页面必须胜出，实际 ${nav.url}`).toBe(true)
    await expect(page.getByTestId('browser-panel')).toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => (await page.getByTestId('browser-address').inputValue()).includes('127.0.0.1')).toBe(true)

    // 读页面：正文 + 可交互元素清单（agent 找按钮/输入框靠它）
    const content = await callToolOk<{ title: string; text: string; interactive: Array<{ id: string; tag: string }>; page_errors?: number }>(
      bridge,
      'jeff_browser_get_content',
      {},
    )
    expect(content.text).toContain('站首页已就绪')
    expect(content.interactive.some((el) => el.tag === 'a')).toBe(true)
    expect(content.page_errors ?? 0).toBe(0)

    // ---------- 2. 三步向导：点击 → 填表（含下拉框）→ 提交，服务端真的收到数据 ----------
    await callToolOk(bridge, 'jeff_browser_navigate', { url: new URL('wizard', site.url).toString() })
    await callToolOk(bridge, 'jeff_browser_type', { selector: '#w-name', text: '张三' })
    const step1 = await callToolOk<{ clicked: string }>(bridge, 'jeff_browser_click', { selector: '#w-next' })
    expect(step1.clicked).toContain('下一步')
    // 下拉框按选项文字选中（<select> 没有 HTMLInputElement 的 value setter，必须单独支持）
    const ward = await callToolOk<{ value: string; selected?: string }>(bridge, 'jeff_browser_type', { selector: '#w-ward', text: '东区' })
    expect(ward.selected || ward.value).toBe('东区')
    await callToolOk(bridge, 'jeff_browser_type', { selector: '#w-note', text: '备注：需陪护' })
    await callToolOk(bridge, 'jeff_browser_click', { selector: '#w-next2' })
    await callToolOk(bridge, 'jeff_browser_click', { selector: '#w-confirm' })
    await callToolOk(bridge, 'jeff_browser_click', { text: '提交' })
    await expect
      .poll(() => site.log().submits.length, { timeout: 20_000, message: '服务端应收到向导提交的表单' })
      .toBeGreaterThan(0)
    expect(site.log().submits.at(-1)).toMatchObject({ name: '张三', ward: '东区', note: '备注：需陪护', step: 3 })
    // 下拉框传错值时给出可选项，便于 agent 自我纠正
    const badWard = await b('jeff_browser_type', { selector: '#w-ward', text: '南区' })
    expect(badWard.ok).toBe(false)
    expect(badWard.error).toContain('可选项')
    await page.screenshot({ path: path.join(EVIDENCE, '10-browser-wizard.png'), fullPage: true })

    // ---------- 3. 文件上传：把本机文件放进 <input type=file>，提交后服务端拿到字节 ----------
    await callToolOk(bridge, 'jeff_browser_navigate', { url: new URL('upload', site.url).toString() })
    const picked = await callToolOk<{ name: string; size: number }>(bridge, 'jeff_browser_upload', { selector: '#up-file', path: uploadFile })
    expect(picked.name).toBe(path.basename(uploadFile))
    expect(picked.size).toBe(Buffer.byteLength(uploadText))
    await callToolOk(bridge, 'jeff_browser_type', { selector: '#up-dept', text: '检验科' })
    await callToolOk(bridge, 'jeff_browser_click', { selector: '#up-submit' })
    await expect.poll(() => site.log().uploads.length, { timeout: 20_000, message: '服务端应收到上传的文件' }).toBeGreaterThan(0)
    const got = site.log().uploads.at(-1)!
    expect(got.name).toBe(path.basename(uploadFile))
    expect(got.body).toContain('JEFF_UPLOAD_MARKER_9812')
    expect(got.body).toContain('检验科')
    // 参数错误要有明确报错（而不是静默失败）
    const notFile = await b('jeff_browser_upload', { selector: '#up-dept', path: uploadFile })
    expect(notFile.ok).toBe(false)
    expect(notFile.error).toContain('input type="file"')
    const noPath = await b('jeff_browser_upload', { selector: '#up-file', path: '/tmp/definitely-not-here-9812.txt' })
    expect(noPath.ok).toBe(false)
    expect(noPath.error).toContain('读不到文件')
    const relPath = await b('jeff_browser_upload', { selector: '#up-file', path: 'relative.txt' })
    expect(relPath.ok).toBe(false)
    expect(relPath.error).toContain('绝对路径')
    await page.screenshot({ path: path.join(EVIDENCE, '11-browser-upload.png'), fullPage: true })

    // ---------- 4. 分析错误：控制台 error / 未捕获异常 / 404 资源 ----------
    await callToolOk(bridge, 'jeff_browser_navigate', { url: new URL('broken', site.url).toString() })
    const console1 = await callToolOk<{ error_count: number; entries: Array<{ level: string; message: string }> }>(bridge, 'jeff_browser_get_console', {})
    const joined = console1.entries.map((e) => e.message).join('\n')
    expect(joined, `应采集到页面错误，实际：${joined}`).toContain('BROKEN_MARKER')
    await expect
      .poll(async () => (await callToolOk<{ entries: Array<{ message: string }> }>(bridge, 'jeff_browser_get_console', {})).entries.map((e) => e.message).join('\n'), {
        timeout: 15_000,
        message: '未捕获异常也应被采集到',
      })
      .toContain('BROKEN_THROW')
    expect(console1.entries.some((e) => /404|missing\.json/.test(e.message))).toBe(true)
    // 面板上的红点与 agent 读到的是同一份采集结果
    await expect(page.getByTestId('browser-errors')).toBeVisible()
    await expect(page.getByTestId('browser-error-count')).toHaveText(/^[1-9]/)
    await page.getByTestId('browser-errors').click()
    await expect(page.getByTestId('browser-console-list')).toContainText('BROKEN_MARKER')
    await page.screenshot({ path: path.join(EVIDENCE, '12-browser-console.png'), fullPage: true })
    await page.getByTestId('dialog-mask').click({ position: { x: 5, y: 5 } })
    // 换页后上一页的错误不再算到新页面头上
    await callToolOk(bridge, 'jeff_browser_navigate', { url: site.url })
    const console2 = await callToolOk<{ error_count: number; entries: unknown[] }>(bridge, 'jeff_browser_get_console', {})
    expect(console2.error_count).toBe(0)
    expect(console2.entries.length).toBe(0)

    // ---------- 5. 浏览器负路径：打不开的地址 / 找不到的元素 ----------
    const dead = await b('jeff_browser_navigate', { url: 'http://127.0.0.1:1/' })
    expect(dead.ok).toBe(false)
    expect(String(dead.error)).toMatch(/ERR_CONNECTION|加载失败|失败/)
    const badUrl = await b('jeff_browser_navigate', { url: 'ftp://example.com' })
    expect(badUrl.ok).toBe(false)
    expect(String(badUrl.error)).toContain('http')
    await callToolOk(bridge, 'jeff_browser_navigate', { url: site.url })
    const noEl = await b('jeff_browser_click', { selector: '#nope-9812' })
    expect(noEl.ok).toBe(false)
    expect(String(noEl.error)).toContain('没找到可点击的元素')
    const noInput = await b('jeff_browser_type', { selector: '#nope-9812', text: 'x' })
    expect(noInput.ok).toBe(false)
    expect(String(noInput.error)).toContain('没找到输入框')

    // ---------- 6. 定时任务工具：空串不得停用/改策略（真模型补默认值的坑） ----------
    const xiaojieId = dbQuery<{ id: string }>('SELECT id FROM agent WHERE builtin = 1 LIMIT 1')[0]?.id
    expect(xiaojieId, '内置小杰应存在').toBeTruthy()
    const task = await callToolOk<{ id: string }>(bridge, 'jeff_cron_create', {
      name: 'v18 工具建的巡检',
      target_type: 'agent',
      target_id: xiaojieId,
      cron_expr: '0 7 * * *',
      prompt: '请汇报当前状态。',
      miss_policy: 'skip',
    })
    const blank = await b('jeff_cron_update', { id: task.id, cron_expr: '15 7 * * *', name: '', prompt: '', miss_policy: '', enabled: '' })
    expect(blank.ok).toBe(true)
    const row = dbQuery<{ name: string; cron_expr: string; prompt: string; miss_policy: string; enabled: number }>(
      'SELECT name, cron_expr, prompt, miss_policy, enabled FROM cron_task WHERE id = ?',
      task.id,
    )[0]
    expect(row).toMatchObject({ name: 'v18 工具建的巡检', cron_expr: '15 7 * * *', prompt: '请汇报当前状态。', miss_policy: 'skip', enabled: 1 })
    // 停用/启用要真的生效
    const off = await callToolOk<{ enabled: boolean }>(bridge, 'jeff_cron_update', { id: task.id, enabled: false })
    expect(off.enabled).toBe(false)
    expect(dbQuery<{ enabled: number }>('SELECT enabled FROM cron_task WHERE id = ?', task.id)[0].enabled).toBe(0)
    // 定时页能看到它，删除后卡片消失（软删除墓碑）
    await page.getByTestId('nav-schedules').click()
    await expect(page.getByTestId(`cron-card-${task.id}`)).toBeVisible({ timeout: 20_000 })
    const list = await callToolOk<Array<{ id: string; schedule: string; enabled: boolean }>>(bridge, 'jeff_cron_list')
    expect(list.find((t) => t.id === task.id)?.schedule).toContain('07:15')
    await callToolOk(bridge, 'jeff_cron_delete', { id: task.id })
    await expect(page.getByTestId(`cron-card-${task.id}`)).toBeHidden({ timeout: 20_000 })
    expect(dbQuery<{ deleted_at: number | null }>('SELECT deleted_at FROM cron_task WHERE id = ?', task.id)[0].deleted_at).toBeTruthy()

    // ---------- 7. 插件：坏清单带错误列出且不能启用；好插件经工具创建/更新/启用 ----------
    await page.getByTestId('nav-plugins').click()
    await expect(page.getByTestId('plugin-card-e2e-bad-json')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('plugin-card-e2e-bad-json')).toContainText('配置有误')
    await expect(page.getByTestId('plugin-card-e2e-bad-json')).toContainText('不是合法 JSON')
    await expect(page.getByTestId('plugin-card-e2e-bad-cmd')).toContainText('必须以 / 开头')
    await expect(page.getByTestId('plugin-card-e2e-bad-url')).toContainText('homepage 必须是 http/https')
    await expect(page.getByTestId('plugin-toggle-e2e-bad-json')).toBeDisabled()
    await page.screenshot({ path: path.join(EVIDENCE, '13-plugins-invalid.png'), fullPage: true })

    const created = await callToolOk<{ id: string; enabled: boolean; next: string }>(bridge, 'jeff_plugin_create', {
      id: 'e2e-flat',
      name: '工具建的插件',
      icon: '🧪',
      description: '用平铺参数创建',
      commands: [{ name: '/flat', prompt: '让插件回显一句话' }],
      mcp_url: 'http://127.0.0.1:9/mcp',
      mcp_headers: '{"X-Agent-Token":"${SECRET}"}',
      files: [{ path: 'README.md', content: '# 工具建的插件' }],
    })
    expect(created.enabled).toBe(false) // 新建默认停用
    expect(fs.existsSync(path.join(HOME, 'plugins', 'e2e-flat', 'README.md'))).toBe(true)
    // update 只传一个字段：其余字段（含 mcp/commands/图标）必须原样保留
    await callToolOk(bridge, 'jeff_plugin_update', { id: 'e2e-flat', description: '' , icon: ''})
    const read = await callToolOk<{ manifest: string; files: string[] }>(bridge, 'jeff_plugin_read', { id: 'e2e-flat' })
    const manifest = JSON.parse(read.manifest) as { name: string; icon: string; description: string; commands: unknown[]; mcp: { url: string } }
    expect(manifest).toMatchObject({ name: '工具建的插件', icon: '🧪', description: '用平铺参数创建' })
    expect(manifest.commands).toHaveLength(1)
    expect(manifest.mcp.url).toBe('http://127.0.0.1:9/mcp')
    expect(read.files).toEqual(['README.md', 'plugin.json'])
    // 启用 → MCP 以 plugin-<id> 注入（header 占位符在没存密钥时替换为空串，属预期）
    const enabled = await callToolOk<{ enabled: boolean }>(bridge, 'jeff_plugin_enable', { id: 'e2e-flat' })
    expect(enabled.enabled).toBe(true)
    await expect
      .poll(() => {
        const rows = dbQuery<{ value: string }>("SELECT value FROM kv WHERE key = 'settings:mcp'")
        if (rows.length === 0) return ''
        const cfg = JSON.parse(rows[0].value) as Record<string, { url?: string }>
        return cfg['plugin-e2e-flat']?.url || ''
      }, { timeout: 20_000 })
      .toBe('http://127.0.0.1:9/mcp')
    await expect(page.getByTestId('plugin-card-e2e-flat')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('plugin-card-e2e-flat')).toContainText(/已启用/)
    await page.screenshot({ path: path.join(EVIDENCE, '14-plugins-tool-created.png'), fullPage: true })
  } finally {
    await closeJeff(app)
    await site.close()
  }
})

/** 拖动分隔条：dx > 0 表示向右拖。刻意避开垂直居中的开合按钮（在那里按下算「点击」不算拖拽） */
async function dragPane(page: Page, testId: string, dx: number): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox()
  if (!box) throw new Error(`找不到分隔条 ${testId}`)
  const y = box.y + box.height / 2 - 80
  await page.mouse.move(box.x, y)
  await page.mouse.down()
  await page.mouse.move(box.x + dx, y, { steps: 10 })
  await page.mouse.up()
}

/** 双击分隔条（恢复默认宽度） */
async function dblclickPane(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox()
  if (!box) throw new Error(`找不到分隔条 ${testId}`)
  await page.mouse.dblclick(box.x, box.y + box.height / 2 - 80)
}

async function paneWidth(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox()
  return box ? Math.round(box.width) : 0
}

/**
 * v1.8.4 三栏布局封闭测试（不需要模型）：拖拽调宽 / 显隐开关 / 默认宽度与上下限。
 *
 * 判据落在「界面真的变了 + 本机真的记住了」：DOM 宽度、localStorage 落值、以及收起左栏后
 * 经工具桥调 jeff_browser_* 的回归（布局怎么变，agent 操作网页的能力都不该受影响）。
 */
test('v1.8.4：三栏布局——拖拽调宽 / 显隐开关 / 默认宽度与上下限', async () => {
  test.setTimeout(600_000)
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const site = await startTestSite()
  const env = loadE2eEnv()
  const { app, page } = await launchJeff({
    home: HOME,
    seed: { apiKey: process.env.SILICONFLOW_API_KEY || env.SILICONFLOW_API_KEY || '', testAgent: true },
  })
  try {
    await expect(page.getByTestId('nav-rail')).toBeVisible()
    const winW = await page.evaluate(() => window.innerWidth)
    const bridge: BridgeClient = readBridge(HOME)

    // ---------- 1. 左栏默认 280，拖宽 80px 真的生效并落盘 ----------
    expect(await paneWidth(page, 'list-pane')).toBe(280)
    await dragPane(page, 'list-resizer', 80)
    await expect.poll(() => paneWidth(page, 'list-pane')).toBe(360)
    expect(await page.evaluate(() => localStorage.getItem('jeff-list-width'))).toBe('360')
    await page.screenshot({ path: path.join(EVIDENCE, '15-layout-list-dragged.png') })

    // ---------- 2. 拖过头被上限拦住（480 或「窗口 - 导航栏 - 对话区最小值」）----------
    const listMax = Math.min(480, winW - 64 - 360)
    await dragPane(page, 'list-resizer', 800)
    await expect.poll(() => paneWidth(page, 'list-pane')).toBe(listMax)

    // ---------- 3. 双击分隔条回到默认宽度 ----------
    await dblclickPane(page, 'list-resizer')
    await expect.poll(() => paneWidth(page, 'list-pane')).toBe(280)

    // ---------- 4. 收起 / 展开：hover 浮出的箭头按钮 + 收起后的常驻细条 ----------
    await page.getByTestId('list-resizer-toggle').click()
    await expect(page.getByTestId('list-pane')).toBeHidden()
    await expect(page.getByTestId('list-expand')).toBeVisible()
    await page.screenshot({ path: path.join(EVIDENCE, '16-layout-list-collapsed.png') })
    await page.getByTestId('list-expand-btn').click()
    await expect(page.getByTestId('list-pane')).toBeVisible()

    // 「显示 → 会话列表」菜单项走的是同一条链路（含快捷键注册）
    const toggleByMenu = (): Promise<string> =>
      app.evaluate(({ Menu }, label) => {
        const items = Menu.getApplicationMenu()?.items.flatMap((m) => (m.submenu ? m.submenu.items : [m])) ?? []
        const item = items.find((i) => i.label === label) as unknown as { accelerator?: string; click: () => void } | undefined
        if (!item) return 'missing'
        item.click()
        return item.accelerator ?? ''
      }, '会话列表')
    expect(await toggleByMenu()).toBe('CmdOrCtrl+B')
    await expect(page.getByTestId('list-pane')).toBeHidden()
    await expect.poll(toggleByMenu).toBe('CmdOrCtrl+B')
    await expect(page.getByTestId('list-pane')).toBeVisible()

    // ---------- 5. 浏览器默认宽度：按窗口比例（>=520），不再是 460 的手机宽 ----------
    const defaultBrowser = Math.max(520, Math.round(winW * 0.42))
    expect(defaultBrowser).toBeGreaterThan(460)
    await page.getByTestId('nav-browser').click()
    await expect(page.getByTestId('browser-panel')).toBeVisible()
    expect(await paneWidth(page, 'browser-panel')).toBe(defaultBrowser)

    // ---------- 6. 浏览器上下限：最宽时给对话区留 360，最窄 320 ----------
    const listW = await paneWidth(page, 'list-pane')
    await dragPane(page, 'browser-resizer', -1200)
    await expect.poll(() => paneWidth(page, 'browser-panel')).toBe(winW - 64 - listW - 360)
    await page.screenshot({ path: path.join(EVIDENCE, '17-layout-browser-wide.png') })
    await dragPane(page, 'browser-resizer', 1200)
    await expect.poll(() => paneWidth(page, 'browser-panel')).toBe(320)
    // 双击回到默认宽度
    await dblclickPane(page, 'browser-resizer')
    await expect.poll(() => paneWidth(page, 'browser-panel')).toBe(defaultBrowser)

    // ---------- 7. 迁移：老版本存过的 460 视为「没设过」，升级到新默认 ----------
    await page.evaluate(() => localStorage.setItem('jeff-browser-width', '460'))
    await page.reload()
    await expect(page.getByTestId('nav-rail')).toBeVisible()
    await page.getByTestId('nav-browser').click()
    await expect.poll(() => paneWidth(page, 'browser-panel')).toBe(defaultBrowser)

    // ---------- 8. 回归：左栏收起 + 浏览器拖到最窄，agent 照样能操作页面 ----------
    await callToolOk(bridge, 'jeff_browser_navigate', { url: site.url })
    await page.getByTestId('list-resizer-toggle').click()
    await expect(page.getByTestId('list-pane')).toBeHidden()
    await dragPane(page, 'browser-resizer', 1200)
    await expect.poll(() => paneWidth(page, 'browser-panel')).toBe(320)
    const content = await callToolOk<{ title: string; text: string }>(bridge, 'jeff_browser_get_content', {})
    expect(content.title).toBe('live13 测试站')
    expect(content.text).toContain('站首页已就绪')
    await page.screenshot({ path: path.join(EVIDENCE, '18-layout-browser-narrow.png') })
  } finally {
    await closeJeff(app)
    await site.close()
  }
})

/** 读 PNG 的实际像素尺寸（直接解析 IHDR，不引入图像库） */
function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file)
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`不是 PNG：${file}`)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 解出来的一行像素，够用来核对「首尾内容在不在图里」 */
type DecodedPng = { width: number; height: number; at: (x: number, y: number) => [number, number, number, number] }

/**
 * 极简 PNG 解码（只支持 8 位 RGB/RGBA，即 Electron 截图的输出）。
 *
 * 为什么要它：断言只看尺寸会被「空白图」蒙混过关——实测就有一次：图确实是 541x5659，
 * 里面却什么都没有（整页截图当时被拉伸掩盖成了一张空图）。用户要的「检查图片是否完整」
 * 必须落到像素上：图的顶部有没有页首内容、底部有没有页尾内容。
 */
function decodePng(file: string): DecodedPng {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`不是 PNG：${file}`)
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`不支持的 PNG：bitDepth=${bitDepth} colorType=${colorType}`)
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const prevOff = Math.max(y - 1, 0) * stride
    const curOff = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[curOff + i - bpp] : 0
      const b = out[prevOff + i]
      const c = i >= bpp ? out[prevOff + i - bpp] : 0
      const x = line[i]
      let v: number
      switch (filter) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`未知的 PNG filter：${filter}`)
      }
      out[curOff + i] = v & 0xff
    }
  }
  return {
    width,
    height,
    at: (x, y) => {
      const o = y * stride + x * bpp
      return bpp === 4 ? [out[o], out[o + 1], out[o + 2], out[o + 3]] : [out[o], out[o + 1], out[o + 2], 255]
    },
  }
}

/** 某一行的颜色占比（抽样，够判断「这条色带在不在」）；只统计不透明像素 */
function rowShare(img: DecodedPng, y: number, match: (px: [number, number, number, number]) => boolean): number {
  let hit = 0
  let total = 0
  for (let x = 0; x < img.width; x += 2) {
    const px = img.at(x, y)
    if (px[3] < 10) continue
    total += 1
    if (match(px)) hit += 1
  }
  return total === 0 ? 0 : hit / total
}

/** 整页图完整性：页首红带与页尾蓝带都要真的出现在图里（顶部/底部各扫几行取最好的一行） */
function checkBands(file: string): { top: number; bottom: number; size: { width: number; height: number } } {
  const img = decodePng(file)
  const red = (px: [number, number, number, number]): boolean => px[0] > 150 && px[1] < 90 && px[2] < 90
  const blue = (px: [number, number, number, number]): boolean => px[2] > 150 && px[0] < 90 && px[1] < 110
  let top = 0
  for (let y = 0; y < Math.min(60, img.height); y++) top = Math.max(top, rowShare(img, y, red))
  let bottom = 0
  for (let y = Math.max(0, img.height - 60); y < img.height; y++) bottom = Math.max(bottom, rowShare(img, y, blue))
  return { top, bottom, size: { width: img.width, height: img.height } }
}

/**
 * v1.8.7 封闭测试（不需要模型）：内置浏览器分辨率控制 + 整页截图。
 *
 * 判据分三层，都落在「页面自己报的事实」与「落盘 PNG 的真实尺寸」上：
 * - 页面侧：window.innerWidth/innerHeight（自报页 #vp-size）必须等于请求的分辨率——只改样式骗不过它；
 * - 图片侧：视口截图的 PNG 尺寸必须**精确等于**视口（用户点名的契约），整页截图必须等于视口宽 × 文档完整高；
 * - 界面侧：工具栏菜单改的分辨率要真的生效、要落 localStorage、面板重开后不许丢。
 */
test('v1.8.7：内置浏览器分辨率（4:3 / 自定义）+ 视口与整页截图尺寸契约', async () => {
  test.setTimeout(600_000)
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const site = await startTestSite()
  const env = loadE2eEnv()
  const { app, page } = await launchJeff({
    home: HOME,
    seed: { apiKey: process.env.SILICONFLOW_API_KEY || env.SILICONFLOW_API_KEY || '', testAgent: true },
  })
  try {
    await expect(page.getByTestId('nav-rail')).toBeVisible()
    const bridge: BridgeClient = readBridge(HOME)
    const b = (name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: unknown; error?: string }> => bridge.call(name, args)
    /** 页面自己报的视口尺寸（agent 通过工具读回，页面侧事实） */
    const pageViewport = async (): Promise<string> => {
      const r = await callToolOk<{ text: string }>(bridge, 'jeff_browser_get_content', { selector: '#vp-size' })
      return r.text.trim()
    }
    /** 面板里那块页面区域的可用尺寸（auto 模式下视口就该等于它） */
    const hostBox = (): Promise<{ w: number; h: number; scrollW: number; scrollH: number; boxed: boolean }> =>
      page.getByTestId('browser-view').evaluate((el) => ({
        w: el.clientWidth,
        h: el.clientHeight,
        scrollW: el.scrollWidth,
        scrollH: el.scrollHeight,
        boxed: el.classList.contains('browser-view--boxed'),
      }))
    const persisted = (): Promise<string> => page.evaluate(() => localStorage.getItem('jeff-browser-resolution') || '')

    // ---------- 1. 4:3 比例自适应：页面视口真的变成 4:3，且等于工具返回值 ----------
    await callToolOk(bridge, 'jeff_browser_navigate', { url: new URL('viewport', site.url).toString() })
    const r43 = await callToolOk<{ mode: string; ratio: string; width: number; height: number; page_width: number; page_height: number }>(
      bridge,
      'jeff_browser_set_viewport',
      { preset: '4:3' },
    )
    expect(r43.mode).toBe('ratio')
    expect(Math.abs(r43.width / r43.height - 4 / 3), `4:3 视口比例不对：${r43.width}x${r43.height}`).toBeLessThan(0.01)
    // 页面自己算出来的 innerWidth/innerHeight 必须就是这两个数（不是「样式上写着 4:3」）
    await expect.poll(pageViewport, { timeout: 15_000 }).toBe(`${r43.width}x${r43.height}`)
    expect(r43.page_width).toBe(r43.width)
    expect(r43.page_height).toBe(r43.height)
    // 比例模式下视口小于面板 → 信箱留白，且不出现滚动条（不然可用宽度会被滚动条吃掉、算出的视口来回抖）
    const boxed43 = await hostBox()
    expect(boxed43.boxed).toBe(true)
    expect(boxed43.scrollW).toBeLessThanOrEqual(boxed43.w)
    expect(boxed43.scrollH).toBeLessThanOrEqual(boxed43.h)
    await page.screenshot({ path: path.join(EVIDENCE, '19-browser-viewport-43.png') })

    // ---------- 2. 视口截图尺寸 = 视口尺寸（用户点名的契约） ----------
    const shot43 = await callToolOk<{ file: string; width: number; height: number; full_page: boolean }>(bridge, 'jeff_browser_screenshot', {})
    expect(shot43.full_page).toBe(false)
    expect({ width: shot43.width, height: shot43.height }).toEqual({ width: r43.width, height: r43.height })
    expect(pngSize(shot43.file), `视口截图的图片尺寸应等于视口 ${r43.width}x${r43.height}`).toEqual({ width: r43.width, height: r43.height })
    // 尺寸对了还不够：图里必须真的有页面内容（页面顶部是一条红带）
    const shot43px = checkBands(shot43.file)
    expect(shot43px.top, '视口截图里应当能看到页面顶部的红带').toBeGreaterThan(0.8)
    // 截图文件名带页面标题（人和 agent 事后能按标题找图）
    expect(path.basename(shot43.file)).toContain('视口自报页')
    // 留档：这张图是 webview 自己合成的（= 用户真正看到的画面），也可以核对页面里自报的尺寸文字
    fs.copyFileSync(shot43.file, path.join(EVIDENCE, '19b-viewport-shot-43.png'))

    // ---------- 3. 自定义精确分辨率：页面视口一字不差，面板放不下就面板内滚动 ----------
    // 选 1280x720：Jeff 窗口是 1290x748，这一档在窗口范围内（截图要能拿到完整画面）
    const rFixed = await callToolOk<{ mode: string; width: number; height: number; page_width: number; page_height: number }>(
      bridge,
      'jeff_browser_set_viewport',
      { width: '1280', height: '720' },
    )
    expect(rFixed).toMatchObject({ mode: 'fixed', width: 1280, height: 720 })
    await expect.poll(pageViewport, { timeout: 15_000 }).toBe('1280x720')
    expect(rFixed.page_width).toBe(1280)
    expect(rFixed.page_height).toBe(720)
    const boxedFixed = await hostBox()
    expect(boxedFixed.scrollW, '精确分辨率比面板宽时，面板内应可滚动查看').toBeGreaterThan(boxedFixed.w)
    const shotFixed = await callToolOk<{ file: string; width: number; height: number }>(bridge, 'jeff_browser_screenshot', {})
    expect(pngSize(shotFixed.file), '精确分辨率下的视口截图必须就是 1280x720').toEqual({ width: 1280, height: 720 })
    expect(checkBands(shotFixed.file).top, '精确分辨率截图里应当能看到页首内容').toBeGreaterThan(0.8)
    fs.copyFileSync(shotFixed.file, path.join(EVIDENCE, '20b-viewport-shot-fixed.png'))
    await page.screenshot({ path: path.join(EVIDENCE, '20-browser-viewport-fixed.png') })

    // 3b. 分辨率超出 Jeff 窗口：页面视口照样按精确像素渲染（布局是真的），但截图必须**如实拒绝**
    // —— 实测这一档 Chromium 会把渲染表面裁掉/平铺，硬截只会得到错位或重复的假图。
    const winSize = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    const rTooBig = await callToolOk<{ page_width: number; page_height: number }>(bridge, 'jeff_browser_set_viewport', {
      width: String(winSize.w + 100),
      height: String(winSize.h + 100),
    })
    expect(rTooBig.page_width, '超出窗口的分辨率仍然精确生效（页面布局不受窗口限制）').toBe(winSize.w + 100)
    const refused = await b('jeff_browser_screenshot', {})
    expect(refused.ok, '超出窗口时截图必须失败，而不是给一张残缺/错位的图').toBe(false)
    expect(String(refused.error)).toContain('超过 Jeff 窗口')
    expect(String(refused.error)).toContain('分辨率改小')

    // ---------- 4. 恢复自适应：视口回铺满面板，信箱与滚动残留都要清掉 ----------
    const rAuto = await callToolOk<{ mode: string; width: number; height: number }>(bridge, 'jeff_browser_set_viewport', { preset: 'auto' })
    expect(rAuto.mode).toBe('auto')
    const autoBox = await page.getByTestId('browser-view').evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }))
    await expect.poll(pageViewport, { timeout: 15_000 }).toBe(`${autoBox.w}x${autoBox.h}`)
    expect(rAuto.width).toBe(autoBox.w)
    const boxedAuto = await hostBox()
    expect(boxedAuto.boxed, '自适应时不该再有信箱边框').toBe(false)
    expect(boxedAuto.scrollW).toBeLessThanOrEqual(boxedAuto.w)

    // ---------- 5. 整页截图：含滚动部分（高 5200 的页面，视口只有几百高） ----------
    await callToolOk(bridge, 'jeff_browser_navigate', { url: new URL('viewport?h=5200&lazy=3', site.url).toString() })
    const scrollInfo = await callToolOk<{ text: string }>(bridge, 'jeff_browser_get_content', { selector: '#vp-scroll' })
    const docHeight = Number(scrollInfo.text.replace(/[^0-9]/g, ''))
    expect(docHeight, '测试页应真的很高').toBeGreaterThan(5000)
    const full = await callToolOk<{ file: string; width: number; height: number; full_page: boolean; page_height: number; truncated?: boolean }>(
      bridge,
      'jeff_browser_screenshot',
      { full_page: 'true' },
    )
    expect(full.full_page).toBe(true)
    expect(full.truncated).toBeUndefined()
    // 宽度不动（改宽度会触发响应式重排，截出来的东西就不是当前页面了）；取的是内容宽
    // （不含纵向滚动条那一列，否则每片右侧都会多一条滚动条），所以允许比视口窄一条滚动条
    expect(full.width).toBeLessThanOrEqual(autoBox.w)
    expect(autoBox.w - full.width, '整页图宽度应≈视口宽（差值只可能是滚动条）').toBeLessThanOrEqual(20)
    expect(full.height, `整页截图应覆盖完整文档高 ${docHeight}，实际 ${full.height}`).toBeGreaterThanOrEqual(docHeight - 4)
    expect(full.height).toBeGreaterThan(autoBox.h)
    expect(pngSize(full.file), '整页截图的图片尺寸必须等于返回值').toEqual({ width: full.width, height: full.height })
    // 像素级完整性：页首红带 + 页尾蓝带都要在图里（只有尺寸对、里面空白，正是曾经踩过的坑）
    const fullPx = checkBands(full.file)
    expect(fullPx.size).toEqual({ width: full.width, height: full.height })
    expect(fullPx.top, '整页图顶部应能看到页首内容（红带）').toBeGreaterThan(0.8)
    expect(fullPx.bottom, '整页图底部应能看到页尾内容（蓝带）——这一条就是「包含滚动部分」').toBeGreaterThan(0.8)
    // 撑高之后懒加载图片才进视口：截图前必须等它们加载完，否则拍到的是一片空白
    await expect.poll(async () => (await callToolOk<{ text: string }>(bridge, 'jeff_browser_get_content', { selector: '#lazy-status' })).text.trim()).toBe('lazy:3/3')
    // 截完要把视口还原（不能把面板留在 5200px 高的状态）
    await expect.poll(async () => (await callToolOk<{ page_height: number }>(bridge, 'jeff_browser_set_viewport', { preset: 'auto' })).page_height).toBeLessThanOrEqual(autoBox.h)
    fs.copyFileSync(full.file, path.join(EVIDENCE, '21-browser-fullpage.png'))
    await page.screenshot({ path: path.join(EVIDENCE, '22-browser-fullpage-ui.png') })

    // ---------- 6. 超出单图上限：如实截断（truncated），不假装截全了 ----------
    await callToolOk(bridge, 'jeff_browser_navigate', { url: new URL('viewport?h=20000', site.url).toString() })
    const capped = await callToolOk<{ file: string; width: number; height: number; page_height: number; truncated?: boolean }>(bridge, 'jeff_browser_screenshot', { full_page: 'true' })
    expect(capped.truncated).toBe(true)
    expect(capped.height).toBe(16384)
    expect(capped.page_height).toBeGreaterThan(16384)
    expect(pngSize(capped.file)).toEqual({ width: capped.width, height: 16384 })
    expect(checkBands(capped.file).top, '超长页面的截图仍应从页首开始').toBeGreaterThan(0.8)

    // ---------- 7. 参数边界：只给一边 / 越界 / 不认识的 preset 都要明确报错 ----------
    const half = await b('jeff_browser_set_viewport', { width: '1697' })
    expect(half.ok).toBe(false)
    expect(String(half.error)).toContain('一起传')
    const tooSmall = await b('jeff_browser_set_viewport', { width: '100', height: '1063' })
    expect(tooSmall.ok).toBe(false)
    expect(String(tooSmall.error)).toContain('320-5120')
    const badPreset = await b('jeff_browser_set_viewport', { preset: '16:9' })
    expect(badPreset.ok).toBe(false)
    expect(String(badPreset.error)).toContain('只支持')
    // 空串是「未提供」而不是「清空」：模型一次全字段补空的调用必须报错，且不许改动已设好的分辨率
    await callToolOk(bridge, 'jeff_browser_set_viewport', { width: '1697', height: '1063' })
    const blankCall = await b('jeff_browser_set_viewport', { preset: '', width: '', height: '' })
    expect(blankCall.ok, '全空串的调用必须失败，而不是静默改成自适应').toBe(false)
    expect(String(blankCall.error)).toContain('没有要设置的分辨率')
    await expect.poll(pageViewport, { timeout: 15_000 }).toBe('1697x1063')

    // ---------- 8. 界面入口：人用工具栏菜单改的，与 agent 改的是同一份设置 ----------
    await page.getByTestId('browser-resolution-btn').click()
    await expect(page.getByTestId('browser-resolution-menu')).toBeVisible()
    await page.getByTestId('browser-resolution-43').click()
    await expect.poll(pageViewport, { timeout: 15_000 }).toBe(`${r43.width}x${r43.height}`)
    await expect.poll(persisted).toContain('"mode":"ratio"')
    await page.screenshot({ path: path.join(EVIDENCE, '23-browser-resolution-menu.png') })
    // 自定义输入：非法值给提示且不生效
    await page.getByTestId('browser-resolution-btn').click()
    await page.getByTestId('browser-resolution-custom').fill('随便写点啥')
    await page.getByTestId('browser-resolution-custom').press('Enter')
    await expect(page.getByTestId('browser-resolution-error')).toBeVisible()
    await expect.poll(pageViewport).toBe(`${r43.width}x${r43.height}`)
    // 合法值：回车生效并落盘
    await page.getByTestId('browser-resolution-custom').fill('1200x700')
    await page.getByTestId('browser-resolution-custom').press('Enter')
    await expect.poll(pageViewport, { timeout: 15_000 }).toBe('1200x700')
    await expect.poll(persisted).toContain('"width":1200')
    expect((await hostBox()).boxed).toBe(true)

    // ---------- 9. 面板重开（webview 重建）后视口不丢：人设定的分辨率要能一直在 ----------
    await page.getByTestId('nav-browser').click()
    await expect(page.getByTestId('browser-panel')).toBeHidden()
    await page.getByTestId('nav-browser').click()
    await expect(page.getByTestId('browser-panel')).toBeVisible()
    await expect.poll(pageViewport, { timeout: 20_000 }).toBe('1200x700')
    // 切回自适应，界面按钮回到未激活态
    await page.getByTestId('browser-resolution-btn').click()
    await page.getByTestId('browser-resolution-auto').click()
    await expect.poll(persisted).toContain('"mode":"auto"')
    await expect(page.getByTestId('browser-resolution-btn')).not.toHaveClass(/\bon\b/)
    const finalBox = await page.getByTestId('browser-view').evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }))
    await expect.poll(pageViewport, { timeout: 15_000 }).toBe(`${finalBox.w}x${finalBox.h}`)
    await page.screenshot({ path: path.join(EVIDENCE, '24-browser-resolution-auto.png') })
  } finally {
    await closeJeff(app)
    await site.close()
  }
})
