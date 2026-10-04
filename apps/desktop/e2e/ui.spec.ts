import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { closeJeff, launchJeff, loadE2eEnv, REPO_ROOT } from './helpers/launch.js'

test.describe.configure({ mode: 'serial' })

/** 测试进程直连 e2e home 的 jeff.db（读多写少：mermaid 段往群里直插一条预置消息） */
const UI_HOME = path.join(REPO_ROOT, '.tmp/jeff-e2e-ui-home')

function dbQuery(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path.join(UI_HOME, 'jeff.db'), { readOnly: true })
  try {
    return db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>
  } finally {
    db.close()
  }
}

function dbExec(sql: string, ...params: unknown[]): void {
  // 应用进程可能正持锁（写入瞬时），简单重试避免偶发 database is locked
  let lastErr: unknown
  for (let i = 0; i < 5; i++) {
    const db = new DatabaseSync(path.join(UI_HOME, 'jeff.db'))
    try {
      db.prepare(sql).run(...(params as never[]))
      return
    } catch (err) {
      lastErr = err
      const until = Date.now() + 500
      while (Date.now() < until) {
        /* 忙等一小会儿再重试 */
      }
    } finally {
      db.close()
    }
  }
  throw lastErr
}

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
      await page.getByTestId('theme-pack-cue').click()
      await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.themePack)).toBe('cue')
      await page.getByTestId('theme-pack-catppuccin').click()
      await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.themePack)).toBe('catppuccin')
      await page.getByTestId('theme-pack-weui').click()
      await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.themePack)).toBe('weui')
      await page.getByTestId('theme-mode-light').click()
      await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')

      // ---- 设置：通知与提醒（试听/测试通知不报错；开关真的落库，关闭的 false 不被默认值吃掉）----
      await page.getByTestId('settings-nav-notification').click()
      await expect(page.getByTestId('notification-settings')).toBeVisible()
      await page.getByTestId('notify-try-sound').click()
      await page.getByTestId('notify-try-desktop').click()
      const notifyResult = await page.evaluate(() =>
        (
          window as unknown as {
            jeff: { invoke: (c: string, p?: unknown) => Promise<{ ok: boolean; error?: string }> }
          }
        ).jeff.invoke('notify:desktop', { title: 'e2e 桌面通知', body: 'Linux 系统通知通路' }),
      )
      expect(notifyResult.ok, notifyResult.error).toBe(true)
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
      // 简介仍为多行 textarea；项目管理作为独立入口呈现任务看板。
      await expect(page.getByTestId('group-settings-desc')).toHaveJSProperty('tagName', 'TEXTAREA')
      await page.getByTestId('group-tab-tasks').click()
      await expect(page.getByTestId('project-task-board')).toBeVisible()
      await page.getByTestId('project-task-title').fill('先完成接口联调')
      await page.getByTestId('project-task-create').click()
      const firstTask = page.locator('[data-testid^="project-task-task_"]').first()
      await expect(firstTask).toContainText('先完成接口联调')
      await page.getByTestId('project-task-title').fill('再做现场验收')
      await page.getByTestId('project-task-dependencies').selectOption({ index: 0 })
      await page.getByTestId('project-task-criteria').fill('护士站现场呼叫通过')
      await page.getByTestId('project-task-create').click()
      const secondTask = page.locator('[data-testid^="project-task-task_"]').filter({ hasText: '再做现场验收' })
      await expect(secondTask).toContainText('等待前置任务')
      await expect(secondTask.getByRole('combobox')).toBeDisabled()
      await expect(page.getByText('每个成员下的会话')).toHaveCount(0)
      // 项目工作台资料通过结构化项目配置保存，切换/关闭后再次打开仍可读。
      await page.getByTestId('group-tab-workspace').click()
      await page.getByTestId('project-workspace-goal').fill('每周产出一批无声智慧病房宣传内容')
      await page.getByTestId('project-workspace-sales-audience').fill('渠道商与集成商')
      await page.getByTestId('project-workspace-story-audience').fill('一线医护人员')
      await page.getByTestId('project-workspace-channels').fill('微信私聊\n渠道群转发\n现场讲解')
      await page.getByTestId('project-workspace-outline').fill('整体方案\n病房呼叫\n门诊叫号')
      await page.getByTestId('project-workspace-save').click()
      await expect(page.getByTestId('project-workspace-save-result')).toHaveText('已保存', { timeout: 10000 })
      await page.getByTestId('project-document-charter').click()
      await expect(page.getByTestId('project-document-result')).toContainText('/项目文档/立项/charter-')
      const charterPath = (await page.getByTestId('project-document-result').innerText()).replace(/^已生成草稿：/, '').split('；')[0]
      expect(fs.readFileSync(charterPath, 'utf8')).toContain('每周产出一批无声智慧病房宣传内容')
      await page.getByTestId('group-tab-settings').click()
      await page.getByTestId('group-tab-workspace').click()
      await expect(page.getByTestId('project-workspace-goal')).toHaveValue('每周产出一批无声智慧病房宣传内容')
      await expect(page.getByTestId('project-workspace-outline')).toHaveValue('整体方案\n病房呼叫\n门诊叫号')
      fs.mkdirSync(path.join(home, 'workspace', '素材', '待整理'), { recursive: true })
      fs.writeFileSync(path.join(home, 'workspace', '素材', '待整理', '护士站.png'), Buffer.from('candidate image'))
      await page.getByTestId('asset-scan-directory').fill('素材/待整理')
      await page.getByTestId('asset-scan').click()
      const candidateCard = page.locator('[data-testid^="asset-asset_"]').filter({ hasText: '护士站' })
      await expect(candidateCard).toContainText('扫描候选·来源待核实')
      await expect(candidateCard).toContainText('待确认')
      const scanTraversalError = await page.evaluate(async (projectId) => {
        const jeff = (window as unknown as { jeff: { invoke: (channel: string, payload?: unknown) => Promise<any> } }).jeff
        return jeff.invoke('project:campaign', { projectId, action: 'scan_asset_candidates', directory: '../' }).then(() => '').catch((error) => String(error.message))
      }, String((dbQuery(`SELECT id FROM project WHERE title=? AND deleted_at IS NULL`, 'E2E测试群')[0] as { id?: string } | undefined)?.id || ''))
      expect(scanTraversalError).toContain('相对路径')
      fs.mkdirSync(path.join(home, 'workspace', '产品资料'), { recursive: true })
      fs.writeFileSync(path.join(home, 'workspace', '产品资料', '腕表.png'), Buffer.from('image placeholder'))
      await page.getByTestId('asset-title').fill('腕表实拍')
      await page.getByTestId('asset-path').fill('产品资料/腕表.png')
      await page.getByTestId('asset-feature').fill('腕表病房呼叫')
      await page.getByTestId('asset-real').check()
      await page.getByTestId('asset-register').click()
      const assetCard = page.locator('[data-testid^="asset-asset_"]').first()
      await expect(assetCard).toContainText('腕表实拍')
      const assetId = (await assetCard.getAttribute('data-testid'))!.slice('asset-'.length)
      await assetCard.getByRole('button', { name: '确认可用' }).click()
      await expect(assetCard).toContainText('已确认')

      // 宣传选题必须先由用户确认，缺素材时挡住制作任务；成品按不同路径形成可追溯版本。
      await page.getByTestId('campaign-title').fill('腕表让护士不错过病房呼叫')
      await page.getByTestId('campaign-feature').fill('腕表病房呼叫')
      await page.getByTestId('campaign-story').fill('护士忙碌时通过腕表接收呼叫')
      await page.getByTestId('campaign-points').fill('腕表及时接收病房呼叫')
      await page.getByTestId('campaign-materials').fill('腕表实拍')
      await page.getByTestId('campaign-create').click()
      const campaignCard = page.locator('[data-testid^="campaign-cmp_"]').first()
      await expect(campaignCard).toBeVisible()
      const campaignTestId = await campaignCard.getAttribute('data-testid')
      const campaignId = campaignTestId!.slice('campaign-'.length)
      const campaignProjectId = String((dbQuery(`SELECT id FROM project WHERE title=? AND deleted_at IS NULL`, 'E2E测试群')[0] as { id?: string } | undefined)?.id || '')
      expect(campaignProjectId).toBeTruthy()
      await page.getByTestId(`campaign-approve-${campaignId}`).click()
      const taskButton = page.getByTestId(`campaign-task-${campaignId}`)
      await expect(taskButton).toBeVisible()
      await expect(taskButton).toBeDisabled()
      await page.getByTestId(`campaign-edit-${campaignId}`).click()
      await page.getByTestId('campaign-create').click()
      await expect(campaignCard).toContainText('方向 v2 · 待确认')
      await expect(taskButton).toHaveCount(0)
      await page.getByTestId(`campaign-approve-${campaignId}`).click()
      const taskV2Button = page.getByTestId(`campaign-task-${campaignId}`)
      await expect(taskV2Button).toBeDisabled()
      await page.getByTestId(`campaign-asset-select-${campaignId}`).selectOption(assetId)
      await page.getByTestId(`campaign-material-resolve-${campaignId}`).click()
      await expect(taskV2Button).toBeEnabled()
      const directionAfterTamper = await page.evaluate(async (projectId) => {
        const jeff = (window as unknown as { jeff: { invoke: (channel: string, payload?: unknown) => Promise<any> } }).jeff
        const project = (await jeff.invoke('projects:list')).find((item: any) => item.id === projectId)
        const forged = JSON.parse(project.workspace_state)
        forged.campaigns[0].approvedRevision = null
        forged.campaigns[0].productionTaskId = 'forged-task'
        forged.campaigns[0].deliveries = [{ id: 'forged', revision: 1, path: 'fake.mp4', status: 'accepted', submittedAt: Date.now() }]
        forged.assets[0].confirmed = false
        const updated = await jeff.invoke('project:save', { ...project, memberAgentIds: [project.leader_agent_id], workspace_state: JSON.stringify(forged) })
        const saved = JSON.parse(updated.workspace_state)
        return { campaign: saved.campaigns[0], asset: saved.assets[0] }
      }, campaignProjectId)
      expect(directionAfterTamper.campaign).toMatchObject({ approvedRevision: 2, productionTaskId: '', deliveries: [], materialsNeeded: [], assetIds: [assetId] })
      expect(directionAfterTamper.asset).toMatchObject({ confirmed: true, isReal: true, source: 'user_provided' })
      await page.getByTestId(`campaign-task-${campaignId}`).click()
      await expect(page.getByTestId(`campaign-task-linked-${campaignId}`)).toContainText('已关联制作任务')
      await page.evaluate(async ({ projectId, campaignId }) => {
        const jeff = (window as unknown as { jeff: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }).jeff
        await jeff.invoke('project:campaign', { projectId, action: 'create_task', campaignId })
        await jeff.invoke('project:campaign', { projectId, action: 'create_task', campaignId })
      }, { projectId: campaignProjectId, campaignId })
      const taskRows = dbQuery(`SELECT id, title, description FROM task WHERE project_id=? AND deleted_at IS NULL`, campaignProjectId)
      const campaignTasks = taskRows.filter((row) => String(row.description).includes(`campaign_ref:${campaignId}:v2`))
      expect(campaignTasks).toHaveLength(1)
      const outsidePathError = await page.evaluate(async ({ projectId, campaignId }) => {
        const jeff = (window as unknown as { jeff: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }).jeff
        return jeff.invoke('project:campaign', { projectId, action: 'submit_delivery', campaignId, path: '/etc/hosts' }).then(() => '').catch((err) => String(err.message))
      }, { projectId: campaignProjectId, campaignId })
      expect(outsidePathError).toContain('必须位于该项目工作区内')

      const outputRoot = path.join(home, 'workspace')
      const outputDir = path.join(outputRoot, '宣传', '腕表呼叫')
      fs.mkdirSync(outputDir, { recursive: true })
      fs.writeFileSync(path.join(outputDir, 'v1.mp4'), Buffer.from('e2e media placeholder'))
      await page.getByTestId(`campaign-path-${campaignId}`).fill('宣传/腕表呼叫/v1.mp4')
      await page.getByTestId(`campaign-submit-${campaignId}`).click()
      const deliveryRow = campaignCard.locator('[data-testid^="campaign-delivery-"]').first()
      await expect(deliveryRow).toContainText('待验收')
      const deliveryId = (await deliveryRow.getAttribute('data-testid'))!.slice('campaign-delivery-'.length)
      await deliveryRow.getByTestId(`delivery-feedback-${deliveryId}`).fill('请统一视频字幕里的功能名称')
      await deliveryRow.getByTestId(`delivery-request-changes-${deliveryId}`).click()
      await expect(deliveryRow).toContainText('要求修改')

      fs.writeFileSync(path.join(outputDir, 'v2.mp4'), Buffer.from('e2e media placeholder v2'))
      await page.getByTestId(`campaign-path-${campaignId}`).fill('宣传/腕表呼叫/v2.mp4')
      await page.getByTestId(`campaign-submit-${campaignId}`).click()
      const latestDelivery = campaignCard.locator('[data-testid^="campaign-delivery-"]').first()
      await expect(latestDelivery).toContainText('v2 · 宣传/腕表呼叫/v2.mp4 · 待验收')
      const latestDeliveryId = (await latestDelivery.getAttribute('data-testid'))!.slice('campaign-delivery-'.length)
      await latestDelivery.getByTestId(`delivery-accept-${latestDeliveryId}`).click()
      await expect(latestDelivery).toContainText('已验收')
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
      await expect(page.getByTestId('group-settings').getByText('已保存')).toBeVisible({ timeout: 10000 })
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

      // ---- mermaid：往「E2E改名群」直插一条带 mermaid 的群消息（确定性，不赌模型按格式输出）----
      // 群消息来自 chat_message 表，测试进程直连 jeff.db 写入后重开群即可渲染
      await page.getByTestId('nav-chats').click()
      await page.waitForTimeout(1500) // 等上一轮群发送把 active thread 落进 kv
      const projRow = dbQuery(`SELECT id FROM project WHERE title=? AND deleted_at IS NULL`, 'E2E改名群')[0] as
        | { id?: string }
        | undefined
      const prjId = String(projRow?.id || '')
      expect(prjId, 'mermaid 段应能查到群 id').toBeTruthy()
      const thrRow = dbQuery(`SELECT value FROM kv WHERE key=?`, `group:activeThread:${prjId}`)[0] as
        | { value?: string }
        | undefined
      const thrId = String(thrRow?.value || '')
      expect(thrId, 'mermaid 段应能查到群当前会话').toBeTruthy()
      const mmId = `msg-e2e-mmd-${Date.now()}`
      dbExec(
        `INSERT INTO chat_message (id, scope, sender_type, sender_id, content, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
        mmId,
        `group:${prjId}:${thrId}`,
        'agent',
        'agt_xiaojie',
        'E2E 预置图表，用于灯箱回归：\n\n```mermaid\ngraph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n  B -->|否| A\n```\n',
        '{}',
        Date.now(),
      )
      // 切走再切回：重开群触发 group:history 重载
      await page.getByTestId('chat-agent-小杰').click()
      await expect(page.getByTestId('chat-window')).toBeVisible()
      await page.getByTestId(`chat-group-${'E2E改名群'}`).click()
      await expect(page.getByTestId('group-info-btn')).toBeVisible({ timeout: 20_000 })
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

      // 拖拽平移：放大到溢出后左键拖动应能看全溢出部分（内容跟手走），且拖完不关闭灯箱
      for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -240)
      const room = await lightbox.evaluate((el) => {
        el.scrollTop = 0
        el.scrollLeft = 0
        return { x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight, cursor: getComputedStyle(el).cursor }
      })
      expect(Math.max(room.x, room.y), `放大后应出现可平移的溢出（x=${room.x}, y=${room.y}）`).toBeGreaterThan(10)
      expect(room.cursor, '可拖拽时灯箱光标应为抓手').toBe('grab')
      const dragBox = await lightbox.locator('.mermaid-lightbox-fig').boundingBox()
      const dx = room.x > 10 ? -80 : 0
      const dy = room.y > 10 ? -120 : 0
      await page.mouse.move(dragBox!.x + dragBox!.width / 2, dragBox!.y + dragBox!.height / 2)
      await page.mouse.down()
      expect(await lightbox.evaluate((el) => getComputedStyle(el).cursor), '拖拽中光标应为抓住').toBe('grabbing')
      await page.mouse.move(dragBox!.x + dragBox!.width / 2 + dx, dragBox!.y + dragBox!.height / 2 + dy, { steps: 8 })
      const panned = await lightbox.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }))
      expect(panned.x + panned.y, `拖拽应平移内容到溢出区域（x=${panned.x}, y=${panned.y}）`).toBeGreaterThan(0)
      await page.mouse.up()
      await expect(lightbox, '拖拽结束不应关闭灯箱').toBeVisible()

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
