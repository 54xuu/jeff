import { test, expect } from '@playwright/test'
for (const entry of ['messages', 'me']) test(`绑定待确认在 ${entry} 页明确提示电脑、安全码和操作`, async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    let phone: any
    Object.defineProperty(window, '__phone', { configurable: true, get: () => phone, set: (value) => {
      phone = value; value.init = async () => {}
      value.pair = async (_raw: string, _name: string, progress: (value: unknown) => void) => {
        progress({ stage: 'confirming', desktopName: 'yh-dev16-01', safety: '482319' })
        await new Promise(() => {})
      }
    } })
  })
  await page.goto('/')
  if (entry === 'me') await page.getByTestId('tab-me').click()
  await page.getByTestId('pair-paste').fill('模拟待确认请求')
  await page.getByTestId('pair-go').click()
  await expect(page.getByTestId('pair-progress')).toContainText('等待电脑确认绑定')
  await expect(page.getByTestId('pair-progress')).toContainText('yh-dev16-01')
  await expect(page.getByTestId('pair-progress')).toContainText('确认绑定')
  await expect(page.getByTestId('pair-safety')).toHaveText('482319')
  await expect(page.getByTestId('pair-go')).toHaveText('等待电脑确认…')
  await page.screenshot({ path: `../../.tmp/pair-stall/mobile-${entry}-waiting.png` })
})
