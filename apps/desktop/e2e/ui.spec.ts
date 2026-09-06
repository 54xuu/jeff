import { test, expect } from '@playwright/test'
import path from 'node:path'
import { closeJeff, launchJeff, REPO_ROOT } from './helpers/launch.js'

test.describe.configure({ mode: 'serial' })

test.describe('Jeff UI 封闭清单', () => {
  test('导航轨 / 主题 / 通讯录模型保存 / 设置 / 私聊 / 建群', async () => {
    test.setTimeout(240_000)
    const home = path.join(REPO_ROOT, '.tmp/jeff-e2e-ui-home')
    const { app, page } = await launchJeff({
      home,
      seed: {
        apiKey: process.env.SILICONFLOW_API_KEY || '',
      },
    })

    try {
      // ---- 导航轨 ----
      await expect(page.getByTestId('nav-rail')).toBeVisible()
      await page.getByTestId('nav-contacts').click()
      await expect(page.getByTestId('agents-page')).toBeVisible()
      await page.getByTestId('nav-settings').click()
      await expect(page.getByTestId('settings-nav-providers')).toBeVisible()
      await page.getByTestId('nav-chats').click()

      // ---- 主题快捷切换 ----
      const before = await page.evaluate(() => document.documentElement.dataset.theme)
      await page.getByTestId('nav-theme-toggle').click()
      await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(before)

      // ---- 通讯录：选模型 + 保存复位 ----
      await page.getByTestId('nav-contacts').click()
      await expect(page.getByTestId('agent-editor')).toBeVisible({ timeout: 15000 })
      await page.getByTestId('model-picker-trigger').click()
      const menu = page.getByTestId('model-picker-menu')
      await expect(menu).toBeVisible({ timeout: 45000 })
      const option = menu.locator('button.combo-item').filter({ hasText: /Qwen/ }).first()
      if ((await option.count()) > 0) {
        await option.click()
        const triggerText = await page.getByTestId('model-picker-trigger').innerText()
        expect(triggerText).toMatch(/硅基流动|Qwen|跟随默认/)
        expect(triggerText).not.toMatch(/^siliconflow-cn\/Qwen\/Qwen/)
      } else {
        await menu.locator('button.combo-item').first().click()
      }

      // Esc 关闭（重新打开后再关）
      await page.getByTestId('model-picker-trigger').click()
      await expect(page.getByTestId('model-picker-menu')).toBeVisible({ timeout: 10000 })
      await page.getByTestId('model-picker-menu').locator('input').focus()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('model-picker-menu')).toHaveCount(0, { timeout: 5000 })

      await page.getByTestId('agent-thinking').selectOption('high')
      const saveBtn = page.getByTestId('agent-save')
      await saveBtn.click()
      await expect(saveBtn).toHaveText('保存', { timeout: 20000 })
      await expect(saveBtn).toBeEnabled()

      // ---- 设置：外观主题包 ----
      await page.getByTestId('nav-settings').click()
      await page.getByTestId('settings-nav-appearance').click()
      await expect(page.getByTestId('appearance-settings')).toBeVisible()
      await page.getByTestId('theme-pack-weui').click()
      await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.themePack)).toBe('weui')
      await page.getByTestId('theme-mode-light').click()
      await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')

      // ---- 设置：引擎 / 记忆 ----
      await page.getByTestId('settings-nav-engine').click()
      await expect(page.getByTestId('engine-settings')).toBeVisible()
      await expect(page.locator('.tag').filter({ hasText: /运行中|启动中|已停止|异常/ })).toBeVisible({ timeout: 45000 })

      await page.getByTestId('settings-nav-memory').click()
      await expect(page.getByTestId('memory-settings')).toBeVisible()

      // ---- MCP 导入（确认后会重启引擎，给足时间）----
      await page.getByTestId('settings-nav-mcp').click()
      await expect(page.getByTestId('mcp-settings')).toBeVisible()
      await page.getByTestId('mcp-import').click()
      const mcpJson = JSON.stringify({
        mcpServers: {
          'mysql-test': {
            command: 'npx',
            args: ['-y', '@benborla29/mcp-server-mysql'],
            env: {
              MYSQL_HOST: '192.168.3.249',
              MYSQL_PORT: '3306',
              MYSQL_USER: 'root',
              MYSQL_PASS: 'Admin@123',
              MYSQL_DB: '',
              ALLOW_INSERT_OPERATION: 'false',
              ALLOW_UPDATE_OPERATION: 'false',
              ALLOW_DELETE_OPERATION: 'false',
              ALLOW_DDL_OPERATION: 'false',
            },
          },
        },
      })
      await page.getByTestId('mcp-import-json').fill(mcpJson)
      await page.getByTestId('mcp-parse').click()
      await page.getByTestId('mcp-import-confirm').click()
      // 等待导入弹层关闭（保存会重启引擎，可能较慢）
      await expect(page.getByTestId('mcp-import-json')).toHaveCount(0, { timeout: 90000 })
      await expect(page.locator('.provider-name').filter({ hasText: 'mysql-test' })).toBeVisible({ timeout: 15000 })

      // ---- 供应商保存复位 ----
      await page.getByTestId('settings-nav-providers').click()
      const nameInput = page.locator('.pv-detail input').first()
      if ((await nameInput.count()) > 0) {
        const cur = await nameInput.inputValue()
        await nameInput.fill(cur.endsWith(' ') ? cur.trim() : `${cur} `)
        const pSave = page.getByTestId('providers-save')
        await expect(pSave).toBeEnabled()
        await pSave.click()
        await expect(pSave).not.toHaveText(/保存中/, { timeout: 60000 })
      }

      // ---- 私聊 ----
      await page.getByTestId('nav-chats').click()
      await page.getByTestId('chat-agent-小杰').click()
      await expect(page.getByTestId('chat-window')).toBeVisible()
      await page.getByTestId('chat-model-chip').click()
      await expect(page.getByTestId('chat-model-menu')).toBeVisible({ timeout: 15000 })
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('chat-model-menu')).toHaveCount(0)

      const thinkChip = page.getByTestId('chat-thinking-chip')
      if ((await thinkChip.count()) > 0) {
        await thinkChip.click()
        await expect(page.getByTestId('chat-thinking-menu')).toBeVisible()
        const high = page.getByTestId('thinking-high')
        if ((await high.count()) > 0) await high.click()
        else await page.keyboard.press('Escape')
      }

      await page.getByTestId('chat-draft').fill('你好，这是 E2E 冒烟，请只回复「收到」两个字。')
      await page.getByTestId('chat-send').click()
      await expect(page.getByTestId('chat-draft')).toHaveValue('', { timeout: 10000 })

      // ---- 建群 ----
      await page.getByTestId('chat-list-plus').click()
      await page.getByTestId('create-group-btn').click()
      await expect(page.getByTestId('create-group-modal')).toBeVisible()
      await page.getByTestId('group-title').fill('E2E测试群')
      const leader = page.getByTestId('group-leader')
      const leaderValue = await leader.locator('option').filter({ hasText: '小杰' }).first().getAttribute('value')
      expect(leaderValue).toBeTruthy()
      await leader.selectOption(leaderValue!)
      await page.getByTestId('group-create-confirm').click()
      await expect(page.getByTestId('create-group-modal')).toHaveCount(0, { timeout: 15000 })
      await expect(page.getByTestId('chat-group-E2E测试群')).toBeVisible({ timeout: 15000 })
      await page.getByTestId('chat-group-E2E测试群').click()
      await page.getByTestId('chat-draft').fill('群聊 E2E：只回「收到」。')
      await page.getByTestId('chat-send').click()
      await expect(page.getByTestId('chat-draft')).toHaveValue('', { timeout: 10000 })
    } finally {
      await closeJeff(app)
    }
  })
})
