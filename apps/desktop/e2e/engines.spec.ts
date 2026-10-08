import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launchJeff, closeJeff, REPO_ROOT } from './helpers/launch.js'

function writeCliFixture(file: string, kind: 'codex' | 'opencode'): void {
  const script = kind === 'codex'
    ? `#!/usr/bin/env node
const args=process.argv.slice(2)
if(args[0]==='--version') console.log('codex-fixture 1.0')
else if(args[0]==='app-server'&&args[1]==='--help') console.log('Usage: app-server --listen stdio://')
else { console.error('unsupported fixture call'); process.exit(1) }
`
    : `#!/usr/bin/env node
const args=process.argv.slice(2)
if(args[0]==='--version') console.log('opencode-fixture 1.0')
else if(args[0]==='run'&&args[1]==='--help') console.log('Usage: run --format json --agent --session --model --variant')
else { console.error('unsupported fixture call'); process.exit(1) }
`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, script, { mode: 0o755 })
}

test('引擎服务单一选择器、系统 OpenCode 隔离和提供商切换保护', async () => {
  test.setTimeout(180_000)
  const home = path.join(REPO_ROOT, '.tmp/engines-ui-home')
  const codex = path.join(home, 'fixtures/codex')
  const systemOpenCode = path.join(home, 'fixtures/opencode')
  const { app, page } = await launchJeff({ home, seed: { testAgent: true } })
  try {
    writeCliFixture(codex, 'codex')
    writeCliFixture(systemOpenCode, 'opencode')
    const codexStatus = await page.evaluate((binary) => window.jeff.invoke('engines:pathSave', { engine: 'codex', path: binary }), codex)
    expect(codexStatus).toMatchObject({ available: true, path: codex })
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-nav-engine').click()
    const engineSelect = page.getByTestId('engine-service-select')
    await page.getByTestId('engine-path-manager').locator('summary').click()
    await page.getByTestId('engine-path-opencode-system').fill(systemOpenCode)
    await page.getByTestId('engine-path-save-opencode-system').click()
    await expect(engineSelect.locator('option[value="opencode-system"]')).toBeAttached()
    const statuses = await page.evaluate(() => window.jeff.invoke('engines:list')) as Array<{ id: string; available: boolean; configuredPath?: string }>
    const expectedOptions = statuses.filter((engine) => engine.id === 'opencode' || engine.available || !!engine.configuredPath).map((engine) => engine.id)
    const actualOptions = await engineSelect.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
    expect(actualOptions).toEqual(expectedOptions)
    await expect(page.getByTestId('settings-nav-providers')).toHaveCount(0)

    await engineSelect.selectOption('opencode-system')
    await expect(page.getByTestId('engine-opencode-system')).toBeVisible()
    await expect(page.getByTestId('providers-save')).toHaveCount(0)
    const evidence = path.join(REPO_ROOT, '.tmp/engine-evidence')
    fs.mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: path.join(evidence, 'system-opencode-settings.png'), fullPage: true })

    await engineSelect.selectOption('opencode')
    await expect(page.getByTestId('providers-save')).toBeVisible()
    const providerName = page.getByLabel('名称')
    const originalName = await providerName.inputValue()
    await providerName.fill(`${originalName} 临时更改`)
    await engineSelect.selectOption('opencode-system')
    await expect(page.getByTestId('engine-switch-confirm')).toBeVisible()
    await page.getByTestId('engine-switch-cancel').click()
    await expect(engineSelect).toHaveValue('opencode')

    await engineSelect.selectOption('opencode-system')
    await page.getByTestId('engine-switch-discard').click()
    await expect(engineSelect).toHaveValue('opencode-system')
    await engineSelect.selectOption('opencode')
    await expect(providerName).toHaveValue(originalName)
    await providerName.fill(`${originalName} 已保存`)
    await engineSelect.selectOption('opencode-system')
    await page.getByTestId('engine-switch-save').click()
    await expect(engineSelect).toHaveValue('opencode-system', { timeout: 90_000 })
    const providers = await page.evaluate(() => window.jeff.invoke('providers:list')) as { providers: Array<{ name: string }> }
    expect(providers.providers[0]?.name).toBe(`${originalName} 已保存`)
    await page.screenshot({ path: path.join(evidence, 'engine-selector-and-paths.png'), fullPage: true })
  } finally { await closeJeff(app) }
})

test('Agent 独立选引擎，项目群独立保存规则和逐成员配置', async () => {
  test.setTimeout(90_000)
  const home = path.join(REPO_ROOT, '.tmp/engine-group-ui-home')
  const codex = path.join(home, 'fixtures/codex')
  const { app, page } = await launchJeff({ home, seed: { testAgent: true } })
  try {
    writeCliFixture(codex, 'codex')
    await page.evaluate((binary) => window.jeff.invoke('engines:pathSave', { engine: 'codex', path: binary }), codex)
    const agent = await page.evaluate(() => window.jeff.invoke('agents:upsert', {
      name: '医护助手', description: '医护流程助手', instructions: '个人 Prompt 只描述专业能力。', category: '智慧病房',
      execution_engine: 'codex', engine_model: 'personal-model', thinking: 'low',
    })) as { id: string }
    const leader = await page.evaluate(() => window.jeff.invoke('agents:upsert', { name: '群主E2E', description: '个人协调能力' })) as { id: string }
    const member = await page.evaluate(() => window.jeff.invoke('agents:upsert', { name: '成员E2E', execution_engine: 'codex', engine_model: 'personal-cheap', thinking: 'low' })) as { id: string }
    const project = await page.evaluate(({ leaderId, memberId }) => window.jeff.invoke('project:save', {
      title: '引擎配置验收群', description: 'UI 封闭验收', system_prompt: '本群规则初始值', leader_agent_id: leaderId,
      memberAgentIds: [leaderId, memberId],
    }), { leaderId: leader.id, memberId: member.id }) as { id: string }

    await page.getByTestId('nav-contacts').click()
    await page.getByText('医护助手', { exact: true }).first().click()
    await expect(page.getByTestId('agent-engine')).toHaveValue('codex')
    await page.getByTestId('agent-engine').selectOption('opencode')
    await page.getByTestId('agent-engine').selectOption('codex')
    await page.getByTestId('agent-engine-model').fill('personal-model-updated')
    await page.getByTestId('agent-save').click()
    await expect.poll(async () => page.evaluate((id) => window.jeff.invoke('agents:get', { id }), agent.id)).toMatchObject({ execution_engine: 'codex', engine_model: 'personal-model-updated' })

    await page.getByTestId('nav-chats').click()
    await expect(page.getByTestId('chat-group-引擎配置验收群')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('chat-group-引擎配置验收群').click()
    await page.getByTestId('group-info-btn').click()
    await expect(page.getByTestId('group-info-drawer')).toBeVisible()
    await page.getByTestId('group-settings-rules').fill('群规则：群主协调；医护助手负责专业流程。')
    await page.getByTestId('group-settings-save').click()
    await expect(page.getByTestId('group-settings').getByText('已保存')).toBeVisible()
    await page.getByTestId('group-tab-members').click()
    await page.getByTestId(`group-member-${member.id}`).getByRole('button', { name: '成员E2E' }).click()
    await page.getByTestId('group-member-duties').fill('本群负责资料整理与提交')
    await page.getByTestId('group-member-model').fill('group-cheap-model')
    await page.getByTestId('group-member-thinking').selectOption('high')
    await page.getByTestId('group-member-config-save').click()
    await expect(page.getByTestId('group-member-config').getByText('已保存')).toBeVisible()

    const allProjects = await page.evaluate(() => window.jeff.invoke('projects:list')) as Array<{ id: string; system_prompt: string }>
    const savedProject = allProjects.find((row) => row.id === project.id)
    expect(savedProject).toBeDefined()
    const savedMembers = await page.evaluate((id) => window.jeff.invoke('project:members', { projectId: id }), project.id) as Array<Record<string, unknown>>
    const savedMember = savedMembers.find((row) => row.agent_id === member.id)
    expect(savedProject!.system_prompt).toContain('医护助手负责专业流程')
    expect(savedMember).toMatchObject({ duties: '本群负责资料整理与提交', model_override: 'group-cheap-model', thinking_override: 'high' })
    expect(await page.evaluate((id) => window.jeff.invoke('agents:get', { id }), member.id)).toMatchObject({ engine_model: 'personal-cheap', thinking: 'low' })
    expect(await page.evaluate((id) => window.jeff.invoke('agents:get', { id }), agent.id)).toMatchObject({ instructions: '个人 Prompt 只描述专业能力。' })
    const evidence = path.join(REPO_ROOT, '.tmp/engine-evidence')
    fs.mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: path.join(evidence, 'group-member-config.png'), fullPage: true })
  } finally { await closeJeff(app) }
})

test('记忆范围和规则文件大量数据时可搜索，列表独立滚动', async () => {
  const { app, page } = await launchJeff({ home: path.join(REPO_ROOT, '.tmp/memory-ui-home'), seed: { testAgent: true } })
  try {
    await page.evaluate(async () => {
      const leader = await window.jeff.invoke('agents:upsert', { name: '范围群主' }) as { id: string }
      for (let i = 0; i < 35; i++) await window.jeff.invoke('agents:upsert', { name: `范围智能体 ${i}` })
      for (let i = 0; i < 25; i++) await window.jeff.invoke('project:save', { title: `范围项目 ${i}`, leader_agent_id: leader.id, memberAgentIds: [leader.id] })
    })
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-nav-memory').click()
    await expect(page.getByRole('button', { name: '范围智能体 34', exact: false })).toBeAttached()
    const layout = await page.locator('.memory-scope-results').evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }))
    expect(layout.height).toBeLessThanOrEqual(360)
    expect(layout.scroll).toBeGreaterThan(layout.height)
    await page.getByRole('textbox', { name: '搜索记忆范围', exact: true }).fill('范围智能体 34')
    await expect(page.locator('.memory-chip')).toHaveCount(1)
    await page.locator('.memory-chip').click()
    await expect(page.locator('.memory-editor-head')).toContainText('范围智能体 34')
    await page.getByRole('textbox', { name: '搜索规则文件' }).fill('范围项目 24')
    await expect(page.locator('.memory-rules-list .provider-row')).toHaveCount(1)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByTestId('agentsmd-textarea').fill('# 项目规则\n每周五验收')
    await page.getByTestId('agentsmd-save').click()
    await expect(page.getByTestId('agentsmd-editor')).toBeHidden()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(page.getByTestId('agentsmd-textarea')).toHaveValue('# 项目规则\n每周五验收')
    await page.getByTestId('agentsmd-cancel').click()
    await page.getByRole('textbox', { name: '搜索记忆范围', exact: true }).fill('')
    await page.screenshot({ path: path.join(REPO_ROOT, '.tmp/engine-evidence/memory-many-scopes.png'), fullPage: true })
  } finally { await closeJeff(app) }
})
