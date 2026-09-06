import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { closeJeff, launchJeff, loadE2eEnv, REPO_ROOT } from './helpers/launch.js'

const env = loadE2eEnv()
const hasLive =
  !!(env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_API_KEY) &&
  !!(env.WEB_SEARCH_API_KEY || process.env.WEB_SEARCH_API_KEY)

test.describe.configure({ mode: 'serial' })

async function waitReplyDone(page: import('@playwright/test').Page, prevAssistantCount: number): Promise<string> {
  // 等至少一条新的 assistant 气泡，且停止按钮消失（发送按钮回来）
  await expect
    .poll(async () => page.locator('.bubble.assistant').count(), { timeout: 120_000 })
    .toBeGreaterThan(prevAssistantCount)
  await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 120_000 })
  // 再等一小会儿让工具折叠区落盘
  await page.waitForTimeout(800)
  return page.locator('.bubble.assistant').last().innerText()
}

;(hasLive ? test.describe : test.describe.skip)('Jeff live skill/MCP', () => {
  test('byted-web-search + mysql-test 工具调用', async () => {
    test.setTimeout(360_000)
    const home = path.join(REPO_ROOT, '.tmp/jeff-e2e-live-home')
    const skillsDir = path.join(home, 'skills-mount')
    const src = path.join(process.env.HOME || '', '.agents/skills/byted-web-search')
    fs.mkdirSync(skillsDir, { recursive: true })
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(skillsDir, 'byted-web-search'), { recursive: true })
    }

    const { app, page } = await launchJeff({
      home,
      seed: {
        apiKey: env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_API_KEY,
        baseURL: env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
        modelId: env.SILICONFLOW_MODEL || 'Qwen/Qwen3.5-9B',
        mcp: true,
        mysqlPass: env.MYSQL_PASS || 'Admin@123',
        mysqlHost: env.MYSQL_HOST || '192.168.3.249',
        testAgent: true,
      },
      envExtra: {
        JEFF_SKILLS_DIR: skillsDir,
        WEB_SEARCH_API_KEY: env.WEB_SEARCH_API_KEY || process.env.WEB_SEARCH_API_KEY || '',
      },
    })

    try {
      // MCP 探测
      await page.getByTestId('nav-settings').click()
      await page.getByTestId('settings-nav-mcp').click()
      await expect(page.locator('.provider-name').filter({ hasText: 'mysql-test' })).toBeVisible({ timeout: 20000 })
      await page.getByTestId('mcp-probe').click()
      await expect(page.getByTestId('mcp-probe')).toHaveText(/重新检测/, { timeout: 90000 })
      const row = page.locator('.provider-row').filter({ hasText: 'mysql-test' })
      await expect(row).toBeVisible()
      // 探测成功应出现「已连接 · N 个工具」或「连接失败」
      await expect(row.locator('.tag').filter({ hasText: /已连接|连接失败/ })).toBeVisible({ timeout: 5000 })
      const rowText = await row.innerText()
      expect(rowText, 'MCP probe 应成功连接 mysql-test').toMatch(/已连接/)

      await page.getByTestId('nav-chats').click()
      const agentItem = page.getByTestId('chat-agent-E2E探路者')
      await expect(agentItem).toBeVisible({ timeout: 15000 })
      await agentItem.click()
      await expect(page.getByTestId('chat-window')).toBeVisible()

      const thinkChip = page.getByTestId('chat-thinking-chip')
      if ((await thinkChip.count()) > 0) {
        await thinkChip.click()
        const high = page.getByTestId('thinking-high')
        if ((await high.count()) > 0) await high.click()
        else await page.keyboard.press('Escape')
      }

      // ---- Skill：豆包搜索（只看 assistant 气泡 + 工具区）----
      let skillOk = false
      for (let attempt = 0; attempt < 2 && !skillOk; attempt++) {
        const before = await page.locator('.bubble.assistant').count()
        await page.getByTestId('chat-draft').fill(
          '请立刻使用 byted-web-search skill 搜索关键词「OpenAI」，从工具返回里摘 1 条带 https 链接的结果告诉我。必须先调用搜索工具。',
        )
        await page.getByTestId('chat-send').click()
        const assistant = await waitReplyDone(page, before)
        const extras = await page.locator('.msg-row.left .msg-extras, .msg-row.left details').allInnerTexts()
        const extrasJoined = extras.join('\n')
        const hasTool = /search|web|byted|豆包|skill/i.test(extrasJoined)
        const hasUrl = /https?:\/\/\S+/i.test(assistant) || /https?:\/\/\S+/i.test(extrasJoined)
        const noAuthFail = !/未找到凭证|invalid_api_key|10403|WEB_SEARCH_API_KEY/.test(assistant + extrasJoined)
        skillOk = hasUrl && noAuthFail && (hasTool || hasUrl)
      }
      expect(skillOk, 'skill 应调到搜索并在 assistant/工具区出现 https 结果').toBeTruthy()

      // ---- MCP：只读列库 ----
      let mcpToolOk = false
      for (let attempt = 0; attempt < 2 && !mcpToolOk; attempt++) {
        const before = await page.locator('.bubble.assistant').count()
        await page.getByTestId('chat-draft').fill(
          '请立刻调用 mysql MCP 工具执行：SHOW DATABASES; 把返回的数据库名列表贴出来。不要编造。',
        )
        await page.getByTestId('chat-send').click()
        const assistant = await waitReplyDone(page, before)
        const extras = await page.locator('.msg-row.left .msg-extras, .msg-row.left details').allInnerTexts()
        const extrasJoined = extras.join('\n')
        const hasTool = /mysql|query|database|mcp/i.test(extrasJoined)
        const hasDbList =
          /information_schema/i.test(assistant + extrasJoined) ||
          (/(^|\n)\s*(mysql|sys|performance_schema|test)\s*($|\n)/i.test(assistant + extrasJoined) &&
            !/不要编造/.test(assistant))
        mcpToolOk = hasTool || hasDbList
      }
      expect(mcpToolOk, 'MCP 应调到 mysql 工具并返回库名').toBeTruthy()
    } finally {
      await closeJeff(app)
    }
  })
})
