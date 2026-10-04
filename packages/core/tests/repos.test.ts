import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, migrate } from '../src/db/db.js'
import { agentRepo, projectRepo, projectAgentRepo, taskRepo, chatMessageRepo, kvRepo } from '../src/db/repos.js'
import { buildPaths } from '../src/paths.js'
import type { DB } from '../src/db/db.js'

let tmp: string
let db: DB

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-test-'))
  db = openDb(buildPaths(tmp))
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('agentRepo', () => {
  it('创建、读取、更新、软删除', () => {
    const agents = agentRepo(db)
    const a = agents.create({ name: '架构师阿伟', avatar: '🧱', description: '擅长架构设计', instructions: '你是架构师' })
    expect(a.id).toMatch(/^agt_/)
    expect(agents.get(a.id)?.name).toBe('架构师阿伟')

    agents.update(a.id, { instructions: '你是资深架构师' })
    expect(agents.get(a.id)?.instructions).toBe('你是资深架构师')

    expect(agents.softDelete(a.id)).toBe(true)
    expect(agents.get(a.id)?.deleted_at).not.toBeNull()
    expect(agents.list()).toHaveLength(0)
    expect(agents.list(true)).toHaveLength(1)
  })

  it('内置 agent 不可软删除', () => {
    const agents = agentRepo(db)
    const a = agents.create({ name: '小杰', builtin: 1 })
    expect(agents.softDelete(a.id)).toBe(false)
    expect(agents.get(a.id)).toBeDefined()
  })
})

describe('taskRepo', () => {
  it('项目内编号递增（JEF-n），跨项目独立', () => {
    const projects = projectRepo(db)
    const p1 = projects.create({ title: ' Jeff 本体' })
    const p2 = projects.create({ title: '另一个项目' })
    const tasks = taskRepo(db)
    const t1 = tasks.create({ project_id: p1.id, title: '登录超时' })
    const t2 = tasks.create({ project_id: p1.id, title: '首页样式' })
    const t3 = tasks.create({ project_id: p2.id, title: '别的活' })
    expect(t1.number).toBe(1)
    expect(t2.number).toBe(2)
    expect(t3.number).toBe(1)
    expect(`${t2.number}`).toBeTruthy()
  })

  it('状态与优先级白名单校验', () => {
    const projects = projectRepo(db)
    const p = projects.create({ title: 'x' })
    const tasks = taskRepo(db)
    const t = tasks.create({ project_id: p.id, title: 't', status: 'in_progress' })
    expect(tasks.update(t.id, { status: 'bogus' as never })).toBeUndefined()
    expect(tasks.update(t.id, { status: 'done' })?.status).toBe('done')
    expect(tasks.update(t.id, { priority: 'urgent' })?.priority).toBe('urgent')
  })

  it('软删除后编号不复用', () => {
    const projects = projectRepo(db)
    const p = projects.create({ title: 'x' })
    const tasks = taskRepo(db)
    const t1 = tasks.create({ project_id: p.id, title: 'a' })
    tasks.softDelete(t1.id)
    const t2 = tasks.create({ project_id: p.id, title: 'b' })
    expect(t2.number).toBe(2)
  })

  it('任务依赖限定在同项目、禁止循环，并阻止前置未完成时结项', () => {
    const projects = projectRepo(db)
    const tasks = taskRepo(db)
    const p = projects.create({ title: '依赖项目' })
    const other = projects.create({ title: '其他项目' })
    const first = tasks.create({ project_id: p.id, title: '先行任务' })
    const second = tasks.create({ project_id: p.id, title: '后续任务', depends_on: [first.id], acceptance_criteria: '现场验证通过' })
    expect(() => tasks.update(second.id, { status: 'done' })).toThrow('依赖任务尚未完成')
    expect(() => tasks.update(first.id, { depends_on: JSON.stringify([second.id]) })).toThrow('不能形成循环')
    expect(() => tasks.create({ project_id: p.id, title: '跨项目依赖', depends_on: [tasks.create({ project_id: other.id, title: '异项目' }).id] })).toThrow('属于同一项目')
    tasks.update(first.id, { status: 'done' })
    expect(tasks.update(second.id, { status: 'done' })?.status).toBe('done')
  })
})

describe('projectAgentRepo', () => {
  it('旧版本项目表迁移后得到空工作台配置', () => {
    const p = projectRepo(db).create({ title: '旧项目' })
    db.exec('ALTER TABLE project DROP COLUMN workspace_state')
    migrate(db)
    expect(projectRepo(db).get(p.id)?.workspace_state).toBe('{}')
  })

  it('成员增删与角色', () => {
    const projects = projectRepo(db)
    const agents = agentRepo(db)
    const p = projects.create({ title: '群', leader_agent_id: null })
    const dev = agents.create({ name: '开发' })
    const ui = agents.create({ name: 'UI' })
    const pa = projectAgentRepo(db)
    pa.add(p.id, dev.id, '开发')
    pa.add(p.id, ui.id, 'ui')
    expect(pa.listByProject(p.id)).toHaveLength(2)
    expect(pa.getRole(p.id, dev.id)).toBe('worker')
    expect(pa.getRole(p.id, ui.id)).toBe('worker')
    pa.add(p.id, ui.id, 'leader')
    expect(pa.getRole(p.id, ui.id)).toBe('leader')
    pa.remove(p.id, ui.id)
    expect(pa.listByProject(p.id)).toHaveLength(1)
  })

  it('setLeader：旧群主降级为 worker，唯一 leader', () => {
    const projects = projectRepo(db)
    const agents = agentRepo(db)
    const pa = projectAgentRepo(db)
    const p = projects.create({ title: '群', leader_agent_id: null })
    const a1 = agents.create({ name: '甲' })
    const a2 = agents.create({ name: '乙' })
    pa.add(p.id, a1.id, 'leader')
    pa.add(p.id, a2.id, 'worker')
    pa.setLeader(p.id, a2.id)
    expect(pa.getRole(p.id, a2.id)).toBe('leader')
    expect(pa.getRole(p.id, a1.id)).toBe('worker')
  })

  it('replaceMembers：完整快照、差集删除、群主必在群且唯一', () => {
    const projects = projectRepo(db)
    const agents = agentRepo(db)
    const pa = projectAgentRepo(db)
    const p = projects.create({ title: '群', leader_agent_id: null })
    const l = agents.create({ name: '群主' })
    const w1 = agents.create({ name: '甲' })
    const w2 = agents.create({ name: '乙' })
    const w3 = agents.create({ name: '丙' })
    pa.add(p.id, l.id, 'leader')
    pa.add(p.id, w1.id, 'worker')
    pa.add(p.id, w2.id, 'worker')
    pa.add(p.id, w3.id, 'worker')
    // 新快照只保留 群主+乙：甲/丙被差集删除；不传群主也会自动并入
    pa.replaceMembers(p.id, l.id, [w2.id])
    const rows = pa.listByProject(p.id)
    expect(rows.map((r) => r.agent_id).sort()).toEqual([l.id, w2.id].sort())
    expect(pa.getRole(p.id, l.id)).toBe('leader')
    expect(pa.getRole(p.id, w2.id)).toBe('worker')
    // 换群主（快照保留两人）：旧群主降 worker，唯一 leader
    pa.replaceMembers(p.id, w1.id, [l.id])
    expect(pa.getRole(p.id, w1.id)).toBe('leader')
    expect(pa.getRole(p.id, l.id)).toBe('worker')
    const leaders = pa.listByProject(p.id).filter((r) => r.role === 'leader')
    expect(leaders).toHaveLength(1)
  })

  it('项目工作台配置跨更新保留并可同步读写', () => {
    const projects = projectRepo(db)
    const p = projects.create({ title: '宣传项目', workspace_state: JSON.stringify({ goal: '腕表呼叫', audience: '渠道商' }) })
    expect(JSON.parse(projects.get(p.id)!.workspace_state)).toEqual({ goal: '腕表呼叫', audience: '渠道商' })
    const updated = projects.update(p.id, { description: '第一期' })!
    expect(JSON.parse(updated.workspace_state)).toEqual({ goal: '腕表呼叫', audience: '渠道商' })
    projects.update(p.id, { workspace_state: JSON.stringify({ outline: ['系统介绍', '病房呼叫'] }) })
    expect(JSON.parse(projects.get(p.id)!.workspace_state)).toEqual({ outline: ['系统介绍', '病房呼叫'] })
  })
})

describe('chatMessageRepo', () => {
  it('按域存储与时间序读取', async () => {
    const repo = chatMessageRepo(db)
    repo.add({ scope: 'group:p1', sender_type: 'user', content: '你好' })
    await new Promise((r) => setTimeout(r, 5))
    repo.add({ scope: 'group:p1', sender_type: 'agent', sender_id: 'agt_x', content: '收到', meta: { foo: 1 } })
    const msgs = repo.listByScope('group:p1')
    expect(msgs).toHaveLength(2)
    expect(msgs[0].sender_type).toBe('user')
    expect(JSON.parse(msgs[1].meta)).toEqual({ foo: 1 })
  })

  it('listByScopePrefix：跨 thread 取同项目消息，且不误伤其它项目', async () => {
    // 回归：群消息 scope 是 group:<pid>:<tid>，按 group:<pid> 精确查永远为空 → 群聊进不了记忆库
    const repo = chatMessageRepo(db)
    repo.add({ scope: 'group:prjA:t1', sender_type: 'user', content: 'A 的会话1' })
    await new Promise((r) => setTimeout(r, 5))
    repo.add({ scope: 'group:prjA:t2', sender_type: 'agent', sender_id: 'agt_x', content: 'A 的会话2' })
    await new Promise((r) => setTimeout(r, 5))
    repo.add({ scope: 'group:prjAB:t1', sender_type: 'user', content: '另一个项目' })
    const msgs = repo.listByScopePrefix('group:prjA:')
    expect(msgs.map((m) => m.content)).toEqual(['A 的会话1', 'A 的会话2'])
    // 下划线/百分号要按字面匹配（LIKE 通配符已转义）
    repo.add({ scope: 'group:prj_t:t1', sender_type: 'user', content: '下划线项目' })
    const escaped = repo.listByScopePrefix('group:prj_t:')
    expect(escaped.map((m) => m.content)).toEqual(['下划线项目'])
  })
})

describe('kvRepo', () => {
  it('JSON 读写与容错', () => {
    const kv = kvRepo(db)
    kv.setJSON('settings:providers', [{ id: 'x' }])
    expect(kv.getJSON<Array<{ id: string }>>('settings:providers', [])).toEqual([{ id: 'x' }])
    kv.set('bad', '{broken')
    expect(kv.getJSON('bad', 'fallback')).toBe('fallback')
    kv.delete('bad')
    expect(kv.get('bad')).toBeNull()
  })
})
