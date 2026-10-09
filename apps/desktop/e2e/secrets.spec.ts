import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeJeff, launchJeff, REPO_ROOT } from './helpers/launch.js'

const HOME = path.join(REPO_ROOT, '.tmp/jeff-e2e-secrets')
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version as string
const SECRET = 'probe-secret-value-9f3a'

function hash8(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function vaultJson(): string {
  const db = new DatabaseSync(path.join(HOME, 'jeff.db'), { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'secrets:vault'").get() as { value?: string } | undefined
    return row?.value || ''
  } finally {
    db.close()
  }
}

test('标题带版本号，密码页可保存、默认不回显，重启后注入引擎', async () => {
  fs.rmSync(HOME, { recursive: true, force: true })
  const launched = await launchJeff({ home: HOME, seed: {}, envExtra: { PROBE_SECRET: 'from-system' } })
  let app = launched.app
  let page = launched.page
  try {
    const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
    expect(title).toBe(`Jeff v${VERSION}`)

    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-nav-secrets').click()
    await expect(page.getByTestId('secrets-empty')).toBeVisible()
    await page.getByTestId('nav-theme-toggle').click()
    const titleAfterTheme = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
    expect(titleAfterTheme).toBe(`Jeff v${VERSION}`)

    await page.getByTestId('secrets-add').click()
    await page.getByTestId('secret-name').fill('PATH')
    await page.getByTestId('secret-value').fill(SECRET)
    await page.getByTestId('secret-save').click()
    await expect(page.getByTestId('secret-form-error')).toContainText('保留名')
    await expect(page.getByTestId('secret-value')).toHaveValue(SECRET)

    await page.getByTestId('secret-name').fill('PROBE_SECRET')
    await page.getByTestId('secret-note').fill('探针')
    await page.getByTestId('secret-save').click()
    await expect(page.getByTestId('secret-row-PROBE_SECRET')).toBeVisible()
    await expect(page.getByTestId('secret-mask-PROBE_SECRET')).toContainText(`••••${SECRET.slice(-4)}`)
    await expect(page.getByTestId('secrets-settings')).not.toContainText(SECRET)
    await expect(page.getByTestId('secrets-restart-banner')).toBeVisible()

    const stored = vaultJson()
    const encryption = await page.getByTestId('secrets-encryption').innerText()
    if (encryption.includes('明文')) expect(stored).toContain(`plain:${SECRET}`)
    else expect(stored).not.toContain(SECRET)

    for (let i = 0; i < 8; i++) {
      await page.evaluate(async (index) => {
        await window.jeff.invoke('secrets:save', { name: `EXTRA_TOKEN_${index}`, value: `extra-token-value-${index}`, note: '批量', enabled: true })
      }, i)
    }
    await expect(page.getByTestId('secrets-search')).toBeVisible()
    await page.getByTestId('secrets-search').fill('PROBE')
    await expect(page.getByTestId('secret-row-PROBE_SECRET')).toBeVisible()
    await expect(page.getByTestId('secret-row-EXTRA_TOKEN_0')).toHaveCount(0)
    await page.getByTestId('secrets-search').fill('')

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
    expect(overflow).toBe(false)

    await page.getByTestId('secret-show-PROBE_SECRET').click()
    await expect(page.getByTestId('secret-mask-PROBE_SECRET')).toHaveText(SECRET)
    await page.getByTestId('secret-show-PROBE_SECRET').click()
    await expect(page.getByTestId('secret-mask-PROBE_SECRET')).not.toHaveText(SECRET)

    await page.getByTestId('secret-toggle-PROBE_SECRET').click()
    await expect(page.getByTestId('secret-row-PROBE_SECRET')).toContainText('已停用')
    await page.getByTestId('secret-toggle-PROBE_SECRET').click()
    await page.getByTestId('secret-delete-EXTRA_TOKEN_0').click()
    await page.getByTestId('secret-delete-yes-EXTRA_TOKEN_0').click()
    await expect(page.getByTestId('secret-row-EXTRA_TOKEN_0')).toHaveCount(0)

    await page.getByTestId('secrets-restart').click()
    await expect(page.getByTestId('secrets-restart-banner')).toBeHidden({ timeout: 40000 })
    const probe = await page.evaluate(async () => window.jeff.invoke('debug:sidecarEnvKeys') as Promise<{ items: Array<{ name: string; hash8: string }> }>)
    expect(probe.items.find((item) => item.name === 'PROBE_SECRET')?.hash8).toBe(hash8(SECRET))
  } finally {
    await closeJeff(app)
  }

  const again = await launchJeff({ home: HOME, envExtra: { PROBE_SECRET: 'from-system' } })
  app = again.app
  page = again.page
  try {
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-nav-secrets').click()
    await expect(page.getByTestId('secret-row-PROBE_SECRET')).toBeVisible()
    await expect(page.getByTestId('settings-nav-sync')).toBeVisible()
    await page.getByTestId('settings-nav-sync').click()
    await expect(page.getByTestId('secrets-backup')).toHaveCount(0)
  } finally {
    await closeJeff(app)
  }
})
