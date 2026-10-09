import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { closeJeff, launchJeff, loadE2eEnv, REPO_ROOT } from './helpers/launch.js'

const env = loadE2eEnv()
const hasLive = !!(env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_API_KEY)

;(hasLive ? test : test.skip)('真模型写出的文件能在回复里点开并复制完整路径', async () => {
  test.setTimeout(360_000)
  const home = path.join(REPO_ROOT, '.tmp/jeff-e2e-live-file-home')
  const marker = `FILELINK_LIVE_${Date.now()}`
  const { app, page } = await launchJeff({
    home,
    seed: {
      apiKey: env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_API_KEY,
      baseURL: env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
      modelId: env.SILICONFLOW_MODEL || 'Qwen/Qwen3.5-9B',
      testAgent: true,
    },
  })
  try {
    await page.getByTestId('chat-agent-E2E探路者').click()
    await expect(page.getByTestId('chat-window')).toBeVisible()
    await page.getByTestId('chat-draft').fill(
      `请在当前工作目录创建文本文件 out/filelink-live.txt，文件内容只有一行 ${marker}。完成后回复必须包含该文件的绝对路径，以及反引号形式的相对路径 out/filelink-live.txt。不要创建其他文件。`,
    )
    await page.getByTestId('chat-send').click()
    await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 240_000 })
    const file = path.join(home, 'workspace', 'out', 'filelink-live.txt')
    await expect.poll(() => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''), { timeout: 20_000 }).toContain(marker)
    const link = page.locator('.bubble.assistant [data-testid="md-file-link"]').filter({ hasText: 'filelink-live.txt' }).last()
    await expect(link).toBeVisible({ timeout: 20_000 })
    const title = await link.getAttribute('title')
    expect(title).toBe(fs.realpathSync(file))
    await link.click({ button: 'right' })
    await page.getByTestId('file-link-copy').click()
    await expect.poll(async () => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(fs.realpathSync(file))
    const shotDir = path.join(REPO_ROOT, '.tmp/file-links-evidence')
    fs.mkdirSync(shotDir, { recursive: true })
    await page.screenshot({ path: path.join(shotDir, 'live.png'), fullPage: true })
  } finally {
    await closeJeff(app)
  }
})
