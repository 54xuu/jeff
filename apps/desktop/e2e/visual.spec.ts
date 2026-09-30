import { test, expect } from '@playwright/test'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeJeff, launchJeff, REPO_ROOT } from './helpers/launch.js'

test.describe.configure({ mode: 'serial' })

/**
 * 1.11 统一风格桌面端截图：在 ui home 的「E2E改名群」里直插一轮对话
 * （用户 → 助手带工具/思考 → 用户），亮暗两套主题各截一张，人工目检新样式。
 * 前置：先跑过 --project=ui（生成 .tmp/jeff-e2e-ui-home 与群、thread）。
 * 注意：home 已有 jeff.db，launchJeff 不传 seed（传了会先整目录删掉重种）。
 */
const UI_HOME = path.join(REPO_ROOT, '.tmp/jeff-e2e-ui-home')

function dbExec(sql: string, ...params: unknown[]): void {
  let lastErr: unknown
  for (let i = 0; i < 5; i++) {
    const db = new DatabaseSync(path.join(UI_HOME, 'jeff.db'))
    try {
      db.prepare(sql).run(...(params as never[]))
      return
    } catch (err) {
      lastErr = err
    } finally {
      db.close()
    }
    const until = Date.now() + 500
    while (Date.now() < until) {
      /* 忙等 */
    }
  }
  throw lastErr
}

function dbQuery(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path.join(UI_HOME, 'jeff.db'), { readOnly: true })
  try {
    return db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>
  } finally {
    db.close()
  }
}

test('桌面端统一风格截图（亮/暗 + 私聊 + 设置）', async () => {
  test.setTimeout(300_000)
  const projRow = dbQuery(`SELECT id FROM project WHERE title=? AND deleted_at IS NULL`, 'E2E改名群')[0] as { id?: string } | undefined
  test.skip(!projRow?.id, 'ui home 不存在（先跑 --project=ui）')
  const prjId = String(projRow!.id)
  const thrRow = dbQuery(`SELECT value FROM kv WHERE key=?`, `group:activeThread:${prjId}`)[0] as { value?: string } | undefined
  test.skip(!thrRow?.value, '群 active thread 不存在')
  const thrId = String(thrRow!.value)
  const scope = `group:${prjId}:${thrId}`
  // 重复跑会累积上一次的直插消息，先清掉本 spec 的痕迹（id 固定，不用时间戳后缀）
  dbExec(`DELETE FROM chat_message WHERE id LIKE 'msg-vis-%'`)
  const t = Date.now() - 600000
  dbExec(
    `INSERT OR REPLACE INTO chat_message (id, scope, sender_type, sender_id, content, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
    `msg-vis-u1`, scope, 'user', '', '帮我看下今天病房的巡检结论', '{}', t,
  )
  dbExec(
    `INSERT OR REPLACE INTO chat_message (id, scope, sender_type, sender_id, content, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
    `msg-vis-a1`, scope, 'agent', 'agt_xiaojie',
    '## 巡检结论\n\n3 床今日**平稳**，未见新发异常；5 床血氧偏低，建议复查。\n\n- 体温 36.7℃ · 血压 120/80\n- 已完成换药与输液巡签\n',
    JSON.stringify({ reasoning: ['先核对今天有没有未闭环的异常项'], tools: [{ tool: 'jeff_project_list', status: 'completed', output: 'ok' }, { tool: 'bash', status: 'completed', output: 'done' }] }),
    t + 1000,
  )
  dbExec(
    `INSERT OR REPLACE INTO chat_message (id, scope, sender_type, sender_id, content, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
    `msg-vis-u2`, scope, 'user', '', '把结论发到群里', '{}', t + 2000,
  )
  dbExec(
    `INSERT OR REPLACE INTO chat_message (id, scope, sender_type, sender_id, content, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
    `msg-vis-a2`, scope, 'agent', 'agt_xiaojie', '已发到「E2E改名群」，群主已确认收到。', '{}', t + 3000,
  )

  const { app, page } = await launchJeff({ home: UI_HOME })

  try {
    await expect(page.getByTestId('nav-rail')).toBeVisible()
    await page.getByTestId('nav-chats').click()
    await page.getByTestId(`chat-group-${'E2E改名群'}`).click()
    await expect(page.getByTestId('group-info-btn')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('heading', { name: '巡检结论' })).toBeVisible({ timeout: 30_000 })
    // 助手消息应为通栏（去气泡）：bubble.assistant 背景透明
    const assistantBg = await page.evaluate(() => {
      const el = document.querySelector('.bubble.assistant')
      return el ? getComputedStyle(el).backgroundColor : 'missing'
    })
    expect(assistantBg).toBe('rgba(0, 0, 0, 0)')
    await page.screenshot({ path: '../../.tmp/e2e-screens/desktop-chat-light.png' })

    // 暗色
    await page.getByTestId('nav-theme-toggle').click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: '../../.tmp/e2e-screens/desktop-chat-dark.png' })
    await page.getByTestId('nav-theme-toggle').click()

    // 私聊窗口（小杰）与设置页各一张
    await page.getByTestId('chat-agent-小杰').click()
    await expect(page.getByTestId('chat-window')).toBeVisible()
    await page.screenshot({ path: '../../.tmp/e2e-screens/desktop-private.png' })
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('settings-nav-appearance')).toBeVisible()
    await page.screenshot({ path: '../../.tmp/e2e-screens/desktop-settings.png' })
  } finally {
    await closeJeff(app)
  }
})
