import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { agentRepo } from '../src/db/repos.js'
import { buildPaths } from '../src/paths.js'
import { AgentRegistry, agentSlug, XIAOJIE_INSTRUCTIONS, XIAOJIE_LEGACY_TEMPLATE_SHA256S } from '../src/agents/registry.js'
import { XIAOJIE_ID } from '../src/ipc/contract.js'
import type { DB } from '../src/db/db.js'

let tmp: string
let db: DB
let registry: AgentRegistry

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-reg-'))
  const paths = buildPaths(tmp)
  fs.mkdirSync(paths.ocAgentsDir, { recursive: true })
  db = openDb(paths)
  registry = new AgentRegistry(db, paths)
  // 与 JeffCore.init 一致：种子内置小杰
  agentRepo(db).create({ id: XIAOJIE_ID, name: '小杰', builtin: 1, instructions: '管家' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AgentRegistry', () => {
  it('小杰的个人 Prompt 只定义项目群角色的适用范围，不预设具体群身份', () => {
    expect(XIAOJIE_INSTRUCTIONS).toContain('群内身份')
    expect(XIAOJIE_INSTRUCTIONS).toContain('对应群规则或成员职责')
    expect(XIAOJIE_INSTRUCTIONS).not.toContain('医疗销售群')
    expect(XIAOJIE_INSTRUCTIONS).not.toContain('销小美')
    expect(XIAOJIE_INSTRUCTIONS).not.toContain('销大中')
    expect(XIAOJIE_LEGACY_TEMPLATE_SHA256S).toHaveLength(2)
  })

  it('为每个 Agent 生成 md 文件，所有 Jeff 工具能力一致', () => {
    const agents = agentRepo(db)
    agents.create({ name: '开发', instructions: '写代码的' })
    registry.syncAll()

    const files = fs.readdirSync(buildPaths(tmp).ocAgentsDir)
    expect(files.some((f) => f.includes(agentSlug(XIAOJIE_ID)))).toBe(true)
    const xiaojieFile = files.find((f) => f.includes(agentSlug(XIAOJIE_ID)))!
    const content = fs.readFileSync(path.join(buildPaths(tmp).ocAgentsDir, xiaojieFile), 'utf8')
    expect(content).toContain('mode: all')
    expect(content).toContain('小杰')

    const devFile = files.find((f) => !f.includes(agentSlug(XIAOJIE_ID)))!
    const devContent = fs.readFileSync(path.join(buildPaths(tmp).ocAgentsDir, devFile), 'utf8')
    for (const t of ['jeff_agent_create', 'jeff_project_create', 'jeff_cron_create', 'jeff_plugin_create', 'jeff_self_update']) expect(devContent).not.toContain(`${t}: false`)
    expect(devContent).toContain('写代码的')
  })

  it('agent 带模型时写入 model frontmatter', () => {
    const agents = agentRepo(db)
    agents.create({ name: 'm', model_provider: 'mockai', model_id: 'mock-mini' })
    registry.syncAll()
    const dir = buildPaths(tmp).ocAgentsDir
    const file = fs.readdirSync(dir).find((f) => !f.includes(agentSlug(XIAOJIE_ID)))!
    expect(fs.readFileSync(path.join(dir, file), 'utf8')).toContain('model: mockai/mock-mini')
  })

  it('软删除后清理失效文件', () => {
    const agents = agentRepo(db)
    const a = agents.create({ name: '临时的' })
    registry.syncAll()
    const dir = buildPaths(tmp).ocAgentsDir
    expect(fs.readdirSync(dir).length).toBeGreaterThan(1)
    agents.softDelete(a.id)
    registry.syncAll()
    const files = fs.readdirSync(dir)
    expect(files.every((f) => f.includes(agentSlug(XIAOJIE_ID)))).toBe(true)
  })

  it('指令变更后重新同步', () => {
    const agents = agentRepo(db)
    const a = agents.create({ name: 'x', instructions: 'v1' })
    registry.syncAll()
    agents.update(a.id, { instructions: 'v2' })
    registry.syncAll()
    const dir = buildPaths(tmp).ocAgentsDir
    const file = fs.readdirSync(dir).find((f) => f.includes(agentSlug(a.id)))!
    expect(fs.readFileSync(path.join(dir, file), 'utf8')).toContain('v2')
  })
})
