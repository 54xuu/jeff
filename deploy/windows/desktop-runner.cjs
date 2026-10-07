const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

async function main() {
  const [endpoint, evidenceDir] = process.argv.slice(2)
  const suitePath = process.env.JEFF_DEPLOY_SUITE_FILE
  const expectedVersion = process.env.JEFF_DEPLOY_EXPECTED_VERSION
  const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'))
  const browser = await chromium.connectOverCDP(endpoint)
  try {
    const context = browser.contexts()[0]
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 60_000 })
    await page.waitForURL(/app\.asar/, { timeout: 60_000 })
    await page.waitForSelector('[data-testid=nav-rail]', { timeout: 60_000 })
    for (const selector of suite.desktop.visible || []) {
      await page.locator(selector).waitFor({ state: 'visible', timeout: 30_000 })
    }
    for (const assertion of suite.desktop.text || []) {
      const text = await page.locator(assertion.selector).innerText()
      if (assertion.contains && !text.includes(assertion.contains)) {
        throw new Error(`${assertion.selector} did not contain expected text: ${assertion.contains}`)
      }
      if (assertion.equals && text.trim() !== assertion.equals) {
        throw new Error(`${assertion.selector} text mismatch: ${text.trim()}`)
      }
    }
    for (const action of suite.desktop.actions || []) {
      const locator = page.locator(action.selector)
      if (action.type === 'click') await locator.click()
      else if (action.type === 'fill') await locator.fill(action.value ?? '')
      else if (action.type === 'expect-visible') await locator.waitFor({ state: 'visible', timeout: 30_000 })
      else throw new Error(`Unsupported desktop suite action: ${action.type}`)
    }
    const infoDeadline = Date.now() + 90_000
    let info
    while (Date.now() < infoDeadline) {
      info = await page.evaluate(() => window.jeff?.invoke?.('app:info'))
      if (info?.sidecarStatus === 'running') break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!info) throw new Error('Installed Jeff did not expose app:info')
    if (info.version !== expectedVersion) throw new Error(`Installed version ${info.version}; expected ${expectedVersion}`)
    if (path.resolve(info.dataDir || '') !== path.resolve(process.env.JEFF_HOME || '')) throw new Error('Installed Jeff is not using the isolated acceptance data directory.')
    if (!info.opencodeBinary || !fs.existsSync(info.opencodeBinary)) throw new Error('Installed Jeff cannot resolve bundled opencode.')
    if (info.sidecarStatus !== 'running') throw new Error(`Installed Jeff sidecar state is ${info.sidecarStatus}; expected running.`)
    if (!info.opencodeVersion) throw new Error('Installed Jeff sidecar did not report its bundled opencode version.')
    fs.writeFileSync(path.join(evidenceDir, 'installed-app-info.json'), JSON.stringify(info, null, 2))
    await page.screenshot({ path: path.join(evidenceDir, 'windows-jeff.png'), fullPage: true })
  } finally {
    await browser.close()
  }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
