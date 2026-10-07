import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launchJeff, closeJeff, REPO_ROOT } from './helpers/launch.js'

test('多引擎设置、智能体保存与受限身份', async () => {
  const { app, page } = await launchJeff({ home: path.join(REPO_ROOT, '.tmp/engines-ui-home'), seed: { testAgent: true } })
  try {
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-nav-engine').click()
    for (const id of ['codex', 'cursor', 'claude']) await expect(page.getByTestId(`engine-${id}`)).toBeVisible()
    const created = await page.evaluate(async () => {
      return window.jeff.invoke('agents:upsert', { name: '多引擎验收', execution_engine: 'codex', engine_model: 'test-model', thinking: '' }) as Promise<{ id: string }>
    })
    await page.getByTestId('nav-contacts').click()
    await page.getByText('多引擎验收', { exact: true }).first().click()
    await expect(page.getByTestId('agent-engine')).toHaveValue('codex')
    await expect(page.getByTestId('agent-engine-model')).toHaveValue('test-model')
    await page.getByTestId('agent-engine').selectOption('claude')
    await page.getByTestId('agent-engine-model').fill('sonnet')
    await page.getByTestId('agent-save').click()
    const stored = await page.evaluate(async (id) => window.jeff.invoke('agents:get', { id }), created.id)
    expect(stored).toMatchObject({ execution_engine: 'claude', engine_model: 'sonnet' })
    const restricted = await page.evaluate(async () => {
      try { await window.jeff.invoke('agents:upsert', { name: '医护助手', execution_engine: 'cursor' }); return '' }
      catch (error) { return String((error as Error).message) }
    })
    expect(restricted).toContain('禁用规则')
    const evidence = path.join(REPO_ROOT, '.tmp/engine-evidence')
    fs.mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: path.join(evidence, 'desktop-engine-editor.png'), fullPage: true })
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
