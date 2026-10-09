import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeJeff, launchJeff, REPO_ROOT } from './helpers/launch.js'

const HOME = path.join(REPO_ROOT, '.tmp/file-links-home')

function dbExec(sql: string, ...params: unknown[]): void {
  let lastErr: unknown
  for (let i = 0; i < 8; i++) {
    const db = new DatabaseSync(path.join(HOME, 'jeff.db'))
    try {
      db.prepare(sql).run(...(params as never[]))
      return
    } catch (err) {
      lastErr = err
    } finally {
      db.close()
    }
  }
  throw lastErr
}

test('聊天里的真实文件可点击打开，右键复制完整路径', async () => {
  fs.rmSync(HOME, { recursive: true, force: true })
  const workspace = path.join(HOME, 'workspace')
  const docx = path.join(workspace, 'out', '报告.docx')
  const notes = path.join(workspace, 'nested', 'notes.txt')
  const script = path.join(workspace, 'run.sh')
  const spaced = path.join(workspace, 'out', 'my report.pdf')
  fs.mkdirSync(path.dirname(docx), { recursive: true })
  fs.mkdirSync(path.dirname(notes), { recursive: true })
  fs.writeFileSync(docx, 'docx')
  fs.writeFileSync(notes, 'notes')
  fs.writeFileSync(script, '#!/bin/sh\necho hi\n')
  fs.writeFileSync(spaced, 'pdf')

  const first = await launchJeff({ home: HOME, seed: { apiKey: 'test-key' } })
  await closeJeff(first.app)
  fs.mkdirSync(path.dirname(docx), { recursive: true })
  fs.mkdirSync(path.dirname(notes), { recursive: true })
  fs.writeFileSync(docx, 'docx')
  fs.writeFileSync(notes, 'notes')
  fs.writeFileSync(script, '#!/bin/sh\necho hi\n')
  fs.writeFileSync(spaced, 'pdf')

  const now = Date.now()
  dbExec(
    `INSERT INTO project (id, title, description, system_prompt, icon, status, leader_agent_id, workspace_dir, siyuan_notebook_id, siyuan_parent_doc_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, '', '', '📁', 'in_progress', 'agt_xiaojie', ?, '', '', ?, ?, NULL)`,
    'prj_filelink',
    '文件链接',
    workspace,
    now,
    now,
  )
  dbExec(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)`,
    'group:thread:prj_filelink:thr_filelink',
    JSON.stringify({ id: 'thr_filelink', title: '文件链接', createdAt: now, updatedAt: now }),
    now,
  )
  dbExec(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)`, 'group:activeThread:prj_filelink', 'thr_filelink', now)
  const body = [
    `已生成 ${docx}`,
    '代码里的 `out/报告.docx`',
    '带空格 "out/my report.pdf"',
    '仅文件名 notes.txt',
    '脚本 run.sh',
    '不存在 ghost.docx',
  ].join('\n')
  dbExec(
    `INSERT INTO chat_message (id, scope, sender_type, sender_id, content, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
    'msg_filelink',
    'group:prj_filelink:thr_filelink',
    'agent',
    'agt_xiaojie',
    body,
    '{}',
    now,
  )

  const launched = await launchJeff({ home: HOME })
  const { app, page } = launched
  try {
    await page.getByTestId('chat-group-文件链接').click()
    await expect(page.getByTestId('group-info-btn')).toBeVisible()
    const links = page.getByTestId('md-file-link')
    await expect(links).toHaveCount(5)
    await expect(page.getByText('ghost.docx')).toBeVisible()
    await expect(page.locator('[data-testid="md-file-link"][title$="ghost.docx"]')).toHaveCount(0)

    const notesLink = page.locator(`[data-testid="md-file-link"][title="${notes}"]`)
    const box = await notesLink.boundingBox()
    if (!box) throw new Error('file link has no box')
    // 用 Electron 自己的输入事件右键，才会走到主进程 context-menu（Playwright 的合成点击不会）。
    await app.evaluate(({ BrowserWindow }, point) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
      if (!win) throw new Error('no window')
      win.focus()
      const input = { x: point.x, y: point.y, button: 'right' as const, clickCount: 1 }
      win.webContents.sendInputEvent({ ...input, type: 'mouseDown' })
      win.webContents.sendInputEvent({ ...input, type: 'mouseUp' })
    }, { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) })
    const menu = page.getByTestId('file-link-menu')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('file-link-open')).toHaveText('打开')
    await expect(page.getByTestId('file-link-reveal')).toHaveText('在文件夹中显示')
    await expect(page.getByTestId('file-link-copy')).toHaveText('复制路径')
    // Windows 右键会在 contextmenu 之后再送一次 pointerdown。这次事件不能把菜单关掉。
    await page.evaluate(() => {
      document.dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true, cancelable: true }))
    })
    await expect(menu).toBeVisible()
    const menuShot = path.join(REPO_ROOT, '.tmp/file-links-evidence')
    fs.mkdirSync(menuShot, { recursive: true })
    await page.screenshot({ path: path.join(menuShot, 'menu.png') })
    await page.getByTestId('file-link-copy').click()
    await expect.poll(async () => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(notes)
    await expect(page.getByTestId('preview-toast')).toContainText('已复制路径')

    await page.locator(`[data-testid="md-file-link"][title="${docx}"]`).first().click()
    await page.locator(`[data-testid="md-file-link"][title="${script}"]`).click()
    const log = path.join(HOME, 'fs-open.log')
    await expect.poll(() => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')).toContain(script)
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { target: string; decision: string })
    expect(rows).toContainEqual({ target: docx, decision: 'open' })
    expect(rows).toContainEqual({ target: script, decision: 'block-reveal' })
    await expect(page.getByTestId('preview-toast')).toContainText('可执行文件不会直接运行')

    const shotDir = path.join(REPO_ROOT, '.tmp/file-links-evidence')
    fs.mkdirSync(shotDir, { recursive: true })
    await page.screenshot({ path: path.join(shotDir, 'light.png') })
    await page.getByTestId('nav-theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.screenshot({ path: path.join(shotDir, 'dark.png') })
  } finally {
    await closeJeff(app)
  }
})
