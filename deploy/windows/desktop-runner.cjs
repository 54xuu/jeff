const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

async function connectOverCDP(endpoint, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(endpoint, { timeout: 5_000 })
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(`Installed Jeff DevTools endpoint did not become ready: ${lastError?.message || endpoint}`)
}

async function main() {
  const [endpoint, evidenceDir] = process.argv.slice(2)
  const suitePath = process.env.JEFF_DEPLOY_SUITE_FILE
  const expectedVersion = process.env.JEFF_DEPLOY_EXPECTED_VERSION
  const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'))
  const browser = await connectOverCDP(endpoint)
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
      else if (action.type === 'select-option-containing') {
        const option = locator.locator('option').filter({ hasText: action.value })
        const value = await option.first().getAttribute('value')
        if (!value) throw new Error(`${action.selector} has no option containing: ${action.value}`)
        await locator.selectOption(value)
      }
      else if (action.type === 'expect-visible') await locator.waitFor({ state: 'visible', timeout: 30_000 })
      else if (action.type === 'expect-hidden') await locator.waitFor({ state: 'hidden', timeout: 30_000 })
      else if (action.type === 'expect-text') {
        const actual = await locator.innerText()
        if (!actual.includes(action.value ?? '')) throw new Error(`${action.selector} did not contain expected text: ${action.value ?? ''}`)
      }
      else if (action.type === 'expect-engine-options') {
        const statuses = await page.evaluate(() => window.jeff.invoke('engines:list'))
        const expected = statuses.filter((engine) => engine.id === 'opencode' || engine.available || !!engine.configuredPath).map((engine) => engine.id)
        const actual = await page.getByTestId('engine-service-select').locator('option').evaluateAll((options) => options.map((option) => option.value))
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Engine options mismatch: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
      }
      else if (action.type === 'expect-task-record') {
        const actual = await page.evaluate(async ({ projectTitle, task }) => {
          const projects = await window.jeff.invoke('projects:list')
          const project = projects.find((item) => item.title === projectTitle)
          if (!project) throw new Error(`Project not found: ${projectTitle}`)
          const tasks = await window.jeff.invoke('tasks:list', { projectId: project.id })
          const record = tasks.find((item) => item.title === task.title)
          if (!record) throw new Error(`Task not found: ${task.title}`)
          const runs = await window.jeff.invoke('task:runs', { id: record.id })
          return { record, runs }
        }, action)
        for (const [key, value] of Object.entries(action.task)) {
          if (actual.record[key] !== value) throw new Error(`Task ${key} mismatch: actual=${actual.record[key]} expected=${value}`)
        }
        if (actual.runs.length !== 0) throw new Error(`Saving the task started execution unexpectedly: ${JSON.stringify(actual.runs)}`)
      }
      else if (action.type === 'expect-group-prompt-context') {
        const actual = await page.evaluate(async ({ projectTitle }) => {
          const projects = await window.jeff.invoke('projects:list')
          const project = projects.find((item) => item.title === projectTitle)
          if (!project?.leader_agent_id) throw new Error(`Project or leader not found: ${projectTitle}`)
          return window.jeff.invoke('context:prompt-details', { agentId: project.leader_agent_id, projectId: project.id })
        }, action)
        const blocks = actual.promptContext?.blocks || []
        for (const item of action.blocks || []) {
          const block = blocks.find((candidate) => candidate.id === item.id)
          if (!block) throw new Error(`Prompt block not found: ${item.id}`)
          if (item.contains && !block.content.includes(item.contains)) throw new Error(`Prompt block ${item.id} does not contain expected text: ${item.contains}`)
          if (item.scope && block.scope !== item.scope) throw new Error(`Prompt block ${item.id} scope mismatch: ${block.scope}`)
        }
      }
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
