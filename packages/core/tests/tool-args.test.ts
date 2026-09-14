import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { agentRepo, projectAgentRepo, projectRepo, taskRepo } from '../src/db/repos.js'
import { buildPaths } from '../src/paths.js'
import type { DB } from '../src/db/db.js'
import { ToolBridge } from '../src/tools/bridge.js'
import { registerAdminTools } from '../src/tools/adminTools.js'
import { registerProjectTools } from '../src/tools/projectTools.js'
import { allToolDefs } from '../src/tools/definitions.js'

let tmp: string
let db: DB
let changed = 0

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-toolargs-'))
  db = openDb(buildPaths(tmp))
  changed = 0
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** 工具桥的 handler 存在私有 map 里，这里直接取出调用（HTTP 太重且与单测无关） */
function callFactory(register: (b: ToolBridge) => void) {
  const bridge = new ToolBridge()
  register(bridge)
  return async <T = unknown>(name: string, args: unknown): Promise<T> => {
    const h = (bridge as unknown as { handlers: Map<string, (a: unknown) => Promise<unknown>> }).handlers.get(name)
    if (!h) throw new Error(`未注册的工具：${name}`)
    return (await h(args)) as T
  }
}

const adminCall = () => callFactory((b) => registerAdminTools(b, { db, onChanged: () => (changed += 1) }))
const projCall = () =>
  callFactory((b) =>
    registerProjectTools(b, {
      db,
      onTaskChanged: () => (changed += 1),
      onProjectChanged: () => (changed += 1),
    }),
  )

describe('工具定义与实现的一致性', () => {
  it('jeff_agent_create / jeff_agent_update 必须声明 category（v1.8.3 修：实现支持但定义漏了，小杰于是没法分组）', () => {
    const defs = allToolDefs()
    for (const name of ['jeff_agent_create', 'jeff_agent_update']) {
      const d = defs.find((x) => x.name === name)
      expect(d, `缺少工具定义：${name}`).toBeTruthy()
      expect(Object.keys(d!.args), `${name} 应声明 category`).toContain('category')
    }
  })

  it('会改数据的工具都要声明 id/必填参数说明（防止「模型看不到字段」这类漂移）', () => {
    for (const d of allToolDefs()) {
      if (!/(_update|_delete|_enable)$/.test(d.name)) continue
      expect(Object.keys(d.args).length, `${d.name} 应有参数声明`).toBeGreaterThan(0)
    }
  })
})

describe('小杰改智能体：空值不抹字段', () => {
  it('只改 category 时，名字/头像/指令都不受影响', async () => {
    const call = adminCall()
    const a = agentRepo(db).create({ name: '康复师', avatar: '🩺', description: '随访', instructions: '你是康复师', category: '医疗场景' })
    const r = await call<{ changed: string[] }>('jeff_agent_update', { id: a.id, category: '项目开发', name: '', description: '', instructions: '', avatar: '' })
    expect(r.changed).toEqual(['category'])
    const row = agentRepo(db).get(a.id)!
    expect(row).toMatchObject({ name: '康复师', avatar: '🩺', description: '随访', instructions: '你是康复师', category: '项目开发' })
  })

  it('一个字段都没传（或全是空串）时明确报错，而不是「静默成功」', async () => {
    const call = adminCall()
    const a = agentRepo(db).create({ name: '资讯助手' })
    await expect(call('jeff_agent_update', { id: a.id })).rejects.toThrow(/没有要修改的字段/)
    await expect(call('jeff_agent_update', { id: a.id, name: '  ', thinking: '' })).rejects.toThrow(/没有要修改的字段/)
  })

  it('小杰不可编辑/删除（内置管家身份）', async () => {
    const call = adminCall()
    const xj = agentRepo(db).create({ name: '小杰', builtin: 1, id: 'agt_xiaojie' })
    await expect(call('jeff_agent_update', { id: xj.id, name: '老杰' })).rejects.toThrow(/不可编辑/)
    await expect(call('jeff_agent_delete', { id: xj.id })).rejects.toThrow(/不可删除/)
  })
})

describe('小杰改项目群 / 任务：空值不抹字段', () => {
  it('改群名时空串字段不覆盖已有值；工作空间目录传空串才是「清除」', async () => {
    const call = projCall()
    const leader = agentRepo(db).create({ name: '护士长' })
    const p = await call<{ id: string }>('jeff_project_create', {
      title: '护士站',
      description: '晨间协作',
      icon: '🏥',
      leader_agent_id: leader.id,
      workspace_dir: '/tmp/ws',
    })
    const r = await call<{ changed: string[] }>('jeff_project_update', { id: p.id, title: '护士站二期', description: '', icon: '' })
    expect(r.changed).toEqual(['title'])
    expect(projectRepo(db).get(p.id)).toMatchObject({ title: '护士站二期', description: '晨间协作', icon: '🏥', workspace_dir: '/tmp/ws' })
    await call('jeff_project_update', { id: p.id, workspace_dir: '' })
    expect(projectRepo(db).get(p.id)!.workspace_dir).toBe('')
    await expect(call('jeff_project_update', { id: p.id, title: '' })).rejects.toThrow(/没有要修改的字段/)
  })

  it('任务状态流转时标题/描述不被空值清掉；指派传空串 = 取消指派', async () => {
    const call = projCall()
    const leader = agentRepo(db).create({ name: '护士长' })
    const nurse = agentRepo(db).create({ name: '责任护士' })
    const p = await call<{ id: string }>('jeff_project_create', { title: '护士站', leader_agent_id: leader.id, members: [{ agentId: nurse.id }] })
    expect(projectAgentRepo(db).listByProject(p.id).map((m) => m.agent_id).sort()).toEqual([leader.id, nurse.id].sort())
    const t = await call<{ id: string; key: string }>('jeff_task_create', { project_id: p.id, title: '随访名单', description: '整理本周名单', priority: 'high', assignee_agent_id: nurse.id })
    expect(t.key).toMatch(/^JEF-\d+$/)

    const r = await call<{ changed: string[] }>('jeff_task_update', { id: t.id, status: 'in_progress', title: '', description: '', priority: '' })
    expect(r.changed).toEqual(['status'])
    expect(taskRepo(db).get(t.id)).toMatchObject({ title: '随访名单', description: '整理本周名单', priority: 'high', status: 'in_progress', assignee_id: nurse.id })

    await call('jeff_task_update', { id: t.id, assignee_agent_id: '' })
    expect(taskRepo(db).get(t.id)).toMatchObject({ assignee_type: 'none', assignee_id: '' })
    await expect(call('jeff_task_update', { id: t.id, title: '   ' })).rejects.toThrow(/没有要修改的字段/)
    // 非法枚举值要有能读懂的报错（而不是 repo 返回 undefined 后抛内部 TypeError）
    await expect(call('jeff_task_update', { id: t.id, status: 'nope' })).rejects.toThrow(/status 非法/)
    await expect(call('jeff_task_update', { id: t.id, priority: 'ASAP' })).rejects.toThrow(/priority 非法/)
    expect(taskRepo(db).get(t.id)).toMatchObject({ status: 'in_progress' })
  })

  it('项目群删除是软删；成员移除不能踢群主', async () => {
    const call = projCall()
    const leader = agentRepo(db).create({ name: '护士长' })
    const nurse = agentRepo(db).create({ name: '责任护士' })
    const p = await call<{ id: string }>('jeff_project_create', { title: '护士站', leader_agent_id: leader.id, members: [{ agentId: nurse.id }] })
    await expect(call('jeff_project_remove_member', { project_id: p.id, agent_id: leader.id })).rejects.toThrow(/不能移除群主/)
    await call('jeff_project_remove_member', { project_id: p.id, agent_id: nurse.id })
    expect(projectAgentRepo(db).listByProject(p.id).map((m) => m.agent_id)).toEqual([leader.id])
    await call('jeff_project_delete', { id: p.id })
    expect(projectRepo(db).get(p.id)!.deleted_at).toBeTruthy()
    expect(changed).toBeGreaterThan(0)
  })
})
