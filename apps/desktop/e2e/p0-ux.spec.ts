import { test, expect } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeJeff, launchJeff, loadE2eEnv, REPO_ROOT } from './helpers/launch.js'
import { readBridge } from './helpers/bridge.js'

/**
 * ZCode P0 交互封闭测试（不需要模型成功回复）：
 * 小杰推荐、草稿跨会话、Esc 后斜杠不复弹、插件试一下、回底、会话内查找、
 * 定时卡片上次状态、浏览器被操作时的顶栏。
 */
const HOME = path.join(REPO_ROOT, '.tmp/jeff-e2e-p0-home')

function dbQuery<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(path.join(HOME, 'jeff.db'), { readOnly: true })
  try {
    return db.prepare(sql).all(...(params as never[])) as T[]
  } finally {
    db.close()
  }
}

function dbExec(sql: string, ...params: unknown[]): void {
  let lastErr: unknown
  for (let i = 0; i < 5; i++) {
    const db = new DatabaseSync(path.join(HOME, 'jeff.db'))
    try {
      db.prepare(sql).run(...(params as never[]))
      return
    } catch (err) {
      lastErr = err
      const until = Date.now() + 400
      while (Date.now() < until) {
        /* 忙等再重试，避开应用持锁 */
      }
    } finally {
      db.close()
    }
  }
  throw lastErr
}

function seedPlugin(): void {
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
        description: 'P0 试一下与斜杠',
        commands: [{ name: '/e2e', description: '向插件提问', prompt: '请通过测试插件查询。' }],
      },
      null,
      2,
    ),
  )
}

async function startSlowPage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>slow</title><p>slow page</p>')
    }, 1800)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/p0-slow`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

test('P0：草稿 / 斜杠 / 试一下 / 回底 / 查找 / 定时状态 / 浏览器忙', async () => {
  test.setTimeout(240_000)
  const env = loadE2eEnv()
  const slow = await startSlowPage()
  const { app, page } = await launchJeff({
    home: HOME,
    seed: { apiKey: process.env.SILICONFLOW_API_KEY || env.SILICONFLOW_API_KEY || 'sk-e2e-invalid', testAgent: true },
  })
  seedPlugin()

  try {
    await expect(page.getByTestId('nav-rail')).toBeVisible()

    // ---------- 小杰空会话推荐：只写入草稿 ----------
    await page.getByTestId('nav-chats').click()
    await page.getByTestId('chat-agent-小杰').click()
    await expect(page.getByTestId('xiaojie-suggests')).toBeVisible()
    await page.getByTestId('xiaojie-suggest-0').click()
    const suggestText = '帮我建一个每天早上 8 点的资讯早报'
    await expect(page.getByTestId('chat-draft')).toHaveValue(suggestText)
    await expect(page.getByTestId('chat-stop')).toHaveCount(0)

    // ---------- 草稿在切会话后还在（先有 session，键才稳定） ----------
    await page.getByTestId('chat-new-session').click()
    await expect(page.getByTestId('chat-compress')).toBeEnabled({ timeout: 30_000 })
    const draftText = 'P0草稿还在-9821'
    await page.getByTestId('chat-draft').fill(draftText)
    await page.getByTestId('chat-agent-E2E探路者').click()
    await expect(page.getByTestId('chat-window')).toBeVisible()
    await expect(page.getByTestId('chat-draft')).toHaveValue('')
    await page.getByTestId('chat-agent-小杰').click()
    await expect(page.getByTestId('chat-draft')).toHaveValue(draftText, { timeout: 15_000 })

    // ---------- 插件启用后：Esc 关掉斜杠，同一查询不再弹出 ----------
    await page.getByTestId('nav-plugins').click()
    await expect(page.getByTestId('plugin-card-e2e-plugin')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('plugin-toggle-e2e-plugin').click()
    await page.getByTestId('nav-chats').click()
    await page.getByTestId('chat-agent-小杰').click()
    await page.getByTestId('chat-draft').fill('')
    const draft = page.getByTestId('chat-draft')
    await draft.click()
    await draft.fill('/')
    await expect(page.getByTestId('slash-pop')).toBeVisible({ timeout: 15_000 })
    await draft.press('Escape')
    await expect(page.getByTestId('slash-pop')).toHaveCount(0)
    await draft.press('Escape')
    await expect(page.getByTestId('slash-pop')).toHaveCount(0)
    await draft.press('e')
    await expect(page.getByTestId('slash-pop')).toBeVisible({ timeout: 10_000 })
    await draft.press('Escape')

    // ---------- 插件「试一下」预填小杰筹码，不覆盖已有正文 ----------
    await draft.fill('保留这段')
    await page.getByTestId('nav-plugins').click()
    await page.getByTestId('plugin-detail-e2e-plugin').click()
    await page.getByTestId('plugin-try-/e2e').click()
    await expect(page.getByTestId('chat-window')).toBeVisible()
    await expect(page.getByTestId('composer-plugin-chip')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('composer-plugin-chip')).toContainText('测试插件')
    await expect(page.getByTestId('chat-draft')).toHaveValue('保留这段')

    // ---------- 群消息：回底 + 当前会话查找下一条 ----------
    await page.getByTestId('chat-list-plus').click()
    await page.getByTestId('create-group-btn').click()
    await page.getByTestId('group-title').fill('P0查找群')
    const leader = page.getByTestId('group-leader')
    const leaderValue = await leader.locator('option').filter({ hasText: '小杰' }).first().getAttribute('value')
    expect(leaderValue).toBeTruthy()
    await leader.selectOption(leaderValue!)
    await page.getByTestId('group-create-confirm').click()
    await expect(page.getByTestId('chat-group-P0查找群')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('chat-group-P0查找群').click()
    await expect(page.locator('.group-window')).toBeVisible()
    const projectId = dbQuery<{ id: string }>("SELECT id FROM project WHERE title = ? AND deleted_at IS NULL", 'P0查找群')[0]?.id
    expect(projectId).toBeTruthy()
    await expect
      .poll(() => dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `group:activeThread:${projectId}`)[0]?.value || '', { timeout: 15_000 })
      .not.toBe('')
    const threadId = dbQuery<{ value: string }>('SELECT value FROM kv WHERE key = ?', `group:activeThread:${projectId}`)[0].value
    const scope = `group:${projectId}:${threadId}`
    const base = Date.now() - 40_000
    for (let i = 0; i < 36; i++) {
      const text = i === 1 ? 'FINDME-TOP 在很上面' : i === 30 ? 'FINDME-BOTTOM 在比较下面' : `填充行 ${i}\n${'滚动用的长文本。'.repeat(12)}`
      dbExec(
        'INSERT INTO chat_message (id, scope, sender_type, sender_id, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        `p0m${i}`,
        scope,
        'user',
        '',
        text,
        '{}',
        base + i * 1000,
      )
    }
    await page.getByTestId('chat-agent-小杰').click()
    await page.getByTestId('chat-group-P0查找群').click()
    await expect(page.getByText('FINDME-BOTTOM')).toBeVisible({ timeout: 15_000 })
    const body = page.locator('.group-window .chat-body, .chat-window .chat-body').last()
    await body.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(page.getByTestId('chat-back-bottom')).toBeVisible()
    await page.getByTestId('chat-back-bottom').click()
    await expect(page.getByTestId('chat-back-bottom')).toHaveCount(0)
    await page.keyboard.press('Control+f')
    await expect(page.getByTestId('chat-find')).toBeVisible()
    await page.getByTestId('chat-find-input').fill('FINDME')
    await expect(page.locator('.conv-find-count')).toHaveText('1/2')
    await page.getByTestId('chat-find-next').click()
    await expect(page.locator('.conv-find-count')).toHaveText('2/2')
    await expect(page.locator('.find-hit, [data-find-hit="1"]')).toHaveCount(1)

    // ---------- 定时卡片始终显示上次状态 ----------
    const now = Date.now()
    const xiaojie = dbQuery<{ id: string }>("SELECT id FROM agent WHERE builtin = 1 AND deleted_at IS NULL")[0]?.id
    expect(xiaojie).toBeTruthy()
    const tasks: Array<{ id: string; status: string | null; at: number | null }> = [
      { id: 'cron_p0_ok', status: 'ok', at: now - 3_600_000 },
      { id: 'cron_p0_fail', status: 'failed', at: now - 7_200_000 },
      { id: 'cron_p0_miss', status: 'missed', at: now - 90_000_000 },
      { id: 'cron_p0_skip', status: 'skipped', at: now - 200_000_000 },
      { id: 'cron_p0_none', status: null, at: null },
    ]
    for (const t of tasks) {
      dbExec(
        `INSERT INTO cron_task (id, name, target_type, target_id, cron_expr, prompt, miss_policy, enabled, last_run_at, next_run_at, created_at, updated_at)
         VALUES (?, ?, 'agent', ?, '0 8 * * *', 'p0', 'skip', 1, ?, ?, ?, ?)`,
        t.id,
        t.id,
        xiaojie,
        t.at,
        now + 86_400_000,
        now,
        now,
      )
      if (t.status && t.at != null) {
        dbExec(
          'INSERT INTO cron_run (id, task_id, started_at, finished_at, status, is_catchup, error) VALUES (?, ?, ?, ?, ?, 0, ?)',
          `run_${t.id}`,
          t.id,
          t.at,
          t.at,
          t.status,
          t.status === 'failed' ? 'boom' : '',
        )
      }
    }
    await page.getByTestId('nav-schedules').click()
    await expect(page.getByTestId('cron-last-cron_p0_ok')).toContainText('上次成功')
    await expect(page.getByTestId('cron-last-cron_p0_fail')).toContainText('上次失败')
    await expect(page.getByTestId('cron-last-cron_p0_miss')).toContainText('上次已错过')
    await expect(page.getByTestId('cron-last-cron_p0_skip')).toContainText('上次已跳过')
    await expect(page.getByTestId('cron-last-cron_p0_none')).toHaveText('尚未运行')

    // ---------- 浏览器被操作时顶栏提示 ----------
    await page.evaluate(() => localStorage.setItem('jeff-browser-last-url', 'http://127.0.0.1:1/should-not-load'))
    const bridge = readBridge(HOME)
    const pending = bridge.call('jeff_browser_navigate', { url: slow.url })
    await expect(page.getByTestId('browser-agent-busy')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('browser-agent-busy')).toContainText('小杰正在操作这个页面')
    const nav = await pending
    expect(nav.ok, nav.error).toBe(true)
    await expect(page.getByTestId('browser-agent-busy')).toHaveCount(0, { timeout: 10_000 })
  } finally {
    await closeJeff(app)
    await slow.close()
  }
})
