import { test, expect } from '@playwright/test'
import path from 'node:path'
import { closeJeff, launchJeff, loadE2eEnv, REPO_ROOT } from './helpers/launch.js'

test.describe.configure({ mode: 'serial' })

test.describe('Jeff UI 封闭清单', () => {
  test('导航轨 / 主题 / 通讯录模型保存 / 设置 / 私聊 / 建群 / mermaid', async () => {
    test.setTimeout(720_000)
    const home = path.join(REPO_ROOT, '.tmp/jeff-e2e-ui-home')
    const env = loadE2eEnv()
    const { app, page } = await launchJeff({
      home,
      seed: {
        apiKey: process.env.SILICONFLOW_API_KEY || env.SILICONFLOW_API_KEY || '',
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

      // ---- 设置：通知与提醒（试听/测试通知不报错；开关真的落库，关闭的 false 不被默认值吃掉）----
      await page.getByTestId('settings-nav-notification').click()
      await expect(page.getByTestId('notification-settings')).toBeVisible()
      await page.getByTestId('notify-try-sound').click()
      await page.getByTestId('notify-try-desktop').click()
      const readSetting = (key: string) =>
        page.evaluate(
          (k) =>
            (window as unknown as { jeff: { invoke: (c: string) => Promise<Record<string, unknown>> } }).jeff
              .invoke('settings:get')
              .then((s) => s[k]),
          key,
        )
      for (const [testid, key] of [
        ['notify-sound', 'notifySound'],
        ['notify-only-background', 'notifyOnlyBackground'],
      ] as const) {
        await page.getByTestId(testid).uncheck()
        await expect.poll(() => readSetting(key), { timeout: 15000 }).toBe(false)
        await page.getByTestId(testid).check()
        await expect.poll(() => readSetting(key), { timeout: 15000 }).toBe(true)
      }

      // ---- 设置：引擎 / 记忆 ----
      await page.getByTestId('settings-nav-engine').click()
      await expect(page.getByTestId('engine-settings')).toBeVisible()
      await expect(page.locator('.tag').filter({ hasText: /运行中|启动中|已停止|异常/ })).toBeVisible({ timeout: 45000 })

      await page.getByTestId('settings-nav-memory').click()
      await expect(page.getByTestId('memory-settings')).toBeVisible()

      // ---- MCP 导入（确认后会重启引擎，给足时间）----
      // 凭据不进仓库：只从环境变量注入（E2E_MCP_MYSQL_JSON = 完整 mcpServers JSON）；未提供则跳过该段
      const mcpJson = process.env.E2E_MCP_MYSQL_JSON || ''
      if (mcpJson.trim()) {
        await page.getByTestId('settings-nav-mcp').click()
        await expect(page.getByTestId('mcp-settings')).toBeVisible()
        await page.getByTestId('mcp-import').click()
        await page.getByTestId('mcp-import-json').fill(mcpJson)
        await page.getByTestId('mcp-parse').click()
        await page.getByTestId('mcp-import-confirm').click()
        // 等待导入弹层关闭（保存会重启引擎，可能较慢）
        await expect(page.getByTestId('mcp-import-json')).toHaveCount(0, { timeout: 90000 })
      }

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
      const chatDraft = page.getByTestId('chat-draft')
      const resizeHandle = page.getByTestId('chat-resize-handle')
      await expect(resizeHandle).toBeVisible()
      const initialDraftHeight = await chatDraft.evaluate((el) => el.getBoundingClientRect().height)
      const handleBox = await resizeHandle.boundingBox()
      expect(handleBox).not.toBeNull()
      await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
      await page.mouse.down()
      await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y - 80)
      await page.mouse.up()
      await expect.poll(async () => chatDraft.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(initialDraftHeight)
      await chatDraft.fill('你好，这是 E2E 冒烟，请只回复「收到」两个字。')
      await page.getByTestId('chat-profile').click()
      await expect(page.getByTestId('agent-profile-drawer')).toBeVisible()
      await expect(page.getByTestId('agent-save')).toBeVisible()
      await page.getByTestId('agent-profile-drawer').locator('.drawer-head .icon-btn').click()
      await expect(page.getByTestId('agent-profile-drawer')).toHaveCount(0)

      await page.getByTestId('chat-model-chip').click()
      await expect(page.getByTestId('agent-profile-drawer')).toBeVisible({ timeout: 15000 })
      await expect(page.getByTestId('chat-model-menu')).toHaveCount(0)
      await expect(page.getByTestId('chat-thinking-chip')).toHaveCount(0)
      await page.getByTestId('agent-profile-drawer').locator('.drawer-head .icon-btn').click()
      await expect(page.getByTestId('agent-profile-drawer')).toHaveCount(0)

      await chatDraft.fill('你好，这是 E2E 冒烟，请只回复「收到」两个字。')
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
      await expect(page.getByTestId('group-model-chip')).toHaveCount(0)

      // ---- 群资料设置 ----
      await page.getByTestId('group-info-btn').click()
      await expect(page.getByTestId('group-info-drawer')).toBeVisible()
      await expect(page.getByTestId('group-settings')).toBeVisible()
      await expect(page.getByTestId('group-settings-desc')).toBeVisible()
      // 简介应是多行 textarea，且无看板
      await expect(page.getByTestId('group-settings-desc')).toHaveJSProperty('tagName', 'TEXTAREA')
      await expect(page.getByText('任务看板')).toHaveCount(0)
      await expect(page.getByText('每个成员下的会话')).toHaveCount(0)
      // 会话记录（原「任务看板」）现在是独立 Tab，切过去才可见
      await page.getByTestId('group-tab-history').click()
      await expect(page.getByTestId('group-chat-history')).toBeVisible()
      // 共用面板的行内改名（群侧一定有会话，稳定覆盖这条交互）
      await page.locator('[data-testid^="session-rename-"]').first().click()
      await expect(page.getByTestId('session-rename-input')).toBeVisible()
      await page.getByTestId('session-rename-input').fill('E2E群会话改名')
      await page.getByTestId('session-rename-input').press('Enter')
      await expect(page.getByText('E2E群会话改名')).toBeVisible({ timeout: 10000 })
      await page.getByTestId('group-tab-settings').click()
      await page.getByTestId('group-settings-title').fill('E2E改名群')
      await page.getByTestId('group-settings-desc').fill('E2E 项目背景：验证群简介注入。')
      await page.getByTestId('group-settings-save').click()
      await expect(page.getByText('已保存')).toBeVisible({ timeout: 10000 })
      await page.getByTestId('group-info-drawer').locator('.drawer-head .icon-btn').click()
      await expect(page.getByTestId('group-info-drawer')).toHaveCount(0)
      await expect(page.getByTestId('chat-group-E2E改名群')).toBeVisible({ timeout: 15000 })

      // ---- 新会话清空主窗 ----
      await page.getByTestId('group-new-session').click()
      await expect(page.getByText(/这是项目/)).toBeVisible({ timeout: 10000 })

      // ---- 私聊历史：并入「资料 → 聊天记录」，与群「会话记录」共用同一面板 ----
      await page.getByTestId('chat-agent-小杰').click()
      await page.getByTestId('chat-profile').click()
      await expect(page.getByTestId('agent-profile-drawer')).toBeVisible({ timeout: 15000 })
      await page.getByTestId('agent-tab-history').click()
      await expect(page.getByTestId('agent-chat-history')).toBeVisible()
      const renameBtn = page.locator('[data-testid^="session-rename-"]').first()
      if ((await renameBtn.count()) > 0) {
        await renameBtn.click()
        await expect(page.getByTestId('session-rename-input')).toBeVisible()
        await page.getByTestId('session-rename-input').fill('E2E改名会话')
        await page.getByTestId('session-rename-input').press('Enter')
        await expect(page.getByText('E2E改名会话')).toBeVisible({ timeout: 10000 })
      }
      await page.getByTestId('agent-profile-drawer').locator('.drawer-head .icon-btn').click()
      await expect(page.getByTestId('agent-profile-drawer')).toHaveCount(0)

      await page.getByTestId('chat-group-E2E改名群').click()
      const groupDraft = page.getByTestId('chat-draft')
      const groupHandle = page.getByTestId('chat-resize-handle')
      await expect(groupHandle).toBeVisible()
      const groupInitialHeight = await groupDraft.evaluate((el) => el.getBoundingClientRect().height)
      const groupHandleBox = await groupHandle.boundingBox()
      expect(groupHandleBox).not.toBeNull()
      await page.mouse.move(groupHandleBox!.x + groupHandleBox!.width / 2, groupHandleBox!.y + groupHandleBox!.height / 2)
      await page.mouse.down()
      await page.mouse.move(groupHandleBox!.x + groupHandleBox!.width / 2, groupHandleBox!.y + 80)
      await page.mouse.up()
      await expect.poll(async () => groupDraft.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(groupInitialHeight)
      // ---- @ 提及键盘选择：弹窗打开时 Enter 只补全成员、不发送 ----
      await groupDraft.fill('@')
      const mentionPop = page.getByTestId('mention-pop')
      await expect(mentionPop).toBeVisible()
      await expect(page.getByTestId('mention-item-0')).toHaveClass(/active/)
      await groupDraft.press('ArrowDown')
      await groupDraft.press('ArrowUp')
      await groupDraft.press('Enter')
      await expect(mentionPop).toHaveCount(0)
      const picked = await groupDraft.inputValue()
      expect(picked.startsWith('@')).toBe(true)
      expect(picked.endsWith(' ')).toBe(true)
      expect(picked.trim().length).toBeGreaterThan(1)

      await groupDraft.fill('群聊 E2E：只回「收到」。')
      await page.getByTestId('chat-send').click()
      await expect(page.getByTestId('chat-draft')).toHaveValue('', { timeout: 10000 })

      // ---- mermaid：模型输出图表 → 图标工具栏 / 放大灯箱不小于原图（回归「放大反而变小」）/ 滚轮缩放 ----
      await page.getByTestId('chat-agent-小杰').click()
      await expect(page.getByTestId('chat-window')).toBeVisible()
      await page.getByTestId('chat-stop').waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
      await expect(page.getByTestId('chat-stop')).toHaveCount(0, { timeout: 300_000 })
      await chatDraft.fill(
        '请原样只输出下面这段代码，不要任何解释或修改：\n```mermaid\ngraph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n  B -->|否| A\n```',
      )
      await page.getByTestId('chat-send').click()
      await page.getByTestId('chat-stop').waitFor({ state: 'visible', timeout: 60_000 })
      await expect(page.getByTestId('chat-stop')).toHaveCount(0, { timeout: 300_000 })
      const mmBlock = page.getByTestId('md-mermaid').first()
      await expect(mmBlock.locator('.md-mermaid-fig svg')).toBeVisible({ timeout: 60_000 })
      // 工具栏改为图标（无文字按钮），图标按钮在位
      await expect(mmBlock.locator('.md-mermaid-bar')).toHaveText('')
      await expect(page.getByTestId('md-mermaid-toggle-src')).toBeVisible()
      await expect(page.getByTestId('md-mermaid-zoom')).toBeVisible()
      // 查看源码 ⇄ 查看图形
      await page.getByTestId('md-mermaid-toggle-src').click()
      await expect(mmBlock.locator('.md-mermaid-src')).toBeVisible()
      await page.getByTestId('md-mermaid-toggle-src').click()
      await expect(mmBlock.locator('.md-mermaid-fig svg')).toBeVisible()
      // 放大灯箱：宽度必须不小于聊天气泡里的内联图，且至少一维填满视口（窄高图按高度填满，宽扁图按宽度填满）
      const inlineW = await mmBlock.locator('.md-mermaid-fig svg').evaluate((el) => el.getBoundingClientRect().width)
      await page.getByTestId('md-mermaid-zoom').click()
      const lightbox = page.getByTestId('mermaid-lightbox')
      await expect(lightbox).toBeVisible()
      const lbSvg = lightbox.locator('.mermaid-lightbox-fig svg')
      const lb0 = await lbSvg.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { w: r.width, h: r.height, iw: window.innerWidth, ih: window.innerHeight }
      })
      expect(lb0.w, `放大后宽（${lb0.w}）应不小于内联图（${inlineW}）——回归「放大反而变小」`).toBeGreaterThanOrEqual(inlineW)
      expect(
        Math.max(lb0.w / (0.88 * lb0.iw), lb0.h / (0.78 * lb0.ih)),
        '放大后至少一维应填到视口约束的 80% 以上',
      ).toBeGreaterThanOrEqual(0.8)
      // 滚轮放大 → 变宽；滚轮缩小 → 变窄（preventDefault，不滚动页面）
      const figBox = await lightbox.locator('.mermaid-lightbox-fig').boundingBox()
      await page.mouse.move(figBox!.x + figBox!.width / 2, figBox!.y + figBox!.height / 2)
      await page.mouse.wheel(0, -240)
      await expect.poll(async () => lbSvg.evaluate((el) => el.getBoundingClientRect().width), { timeout: 10_000 }).toBeGreaterThan(lb0.w)
      const wZoomIn = await lbSvg.evaluate((el) => el.getBoundingClientRect().width)
      await page.mouse.wheel(0, 480)
      await expect.poll(async () => lbSvg.evaluate((el) => el.getBoundingClientRect().width), { timeout: 10_000 }).toBeLessThan(wZoomIn)
      // 双击复位 → 点击空白处关闭
      await lightbox.locator('.mermaid-lightbox-fig').dblclick()
      await expect.poll(async () => lbSvg.evaluate((el) => el.getBoundingClientRect().width), { timeout: 10_000 }).toBeCloseTo(lb0.w, -1)
      await page.mouse.click(15, 15)
      await expect(lightbox).toHaveCount(0)
    } finally {
      await closeJeff(app)
    }
  })
})
