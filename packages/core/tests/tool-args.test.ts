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

const adminCall = () => callFactory((b) => registerAdminTools(b, { db, paths: buildPaths(tmp), onChanged: () => (changed += 1) }))
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

  it('群规则与群成员覆盖必须在对应配置工具中声明', () => {
    const d = allToolDefs().find((x) => x.name === 'jeff_project_update')
    expect(d?.args.system_prompt?.type).toBe('string')
    const member = allToolDefs().find((x) => x.name === 'jeff_project_member_config')
    expect(member?.args).toMatchObject({
      duties: { type: 'string' }, model_override: { type: 'string' }, thinking_override: { type: 'string' },
      reset_model: { type: 'boolean' }, reset_thinking: { type: 'boolean' },
    })
    expect(d?.args).toMatchObject({ siyuan_notebook_id: { type: 'string' }, siyuan_parent_doc_id: { type: 'string' }, clear_siyuan_target: { type: 'boolean' } })
  })

  it('思源内置能力工具已暴露，模型参数保持平铺', () => {
    const defs = allToolDefs()
    for (const name of ['jeff_siyuan_list_notebooks', 'jeff_siyuan_search', 'jeff_siyuan_read', 'jeff_siyuan_create', 'jeff_siyuan_append']) {
      const def = defs.find((item) => item.name === name)
      expect(def, `缺少工具定义 ${name}`).toBeTruthy()
      expect(Object.values(def!.args).every((arg) => ['string', 'boolean', 'number', 'array'].includes(arg.type))).toBe(true)
    }
    expect(defs.find((item) => item.name === 'jeff_siyuan_search')?.args.scope?.enum).toEqual(['project', 'all'])
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

  it('小杰的保留身份固定，但个人 Prompt 可编辑且不可删除', async () => {
    const call = adminCall()
    const xj = agentRepo(db).create({ name: '小杰', builtin: 1, id: 'agt_xiaojie', instructions: '旧 Prompt' })
    await expect(call('jeff_agent_update', { id: xj.id, name: '老杰' })).rejects.toThrow(/内置名称/)
    await call('jeff_agent_update', { id: xj.id, instructions: '新的个人 Prompt' })
    expect(agentRepo(db).get(xj.id)?.instructions).toBe('新的个人 Prompt')
    await expect(call('jeff_agent_delete', { id: xj.id })).rejects.toThrow(/不可删除/)
  })
})

describe('小杰改项目群 / 任务：空值不抹字段', () => {
  it('群规则和成员模型覆盖属于项目群；恢复个人默认不会改 Agent 个人配置', async () => {
    const call = projCall()
    const leader = agentRepo(db).create({ name: '销小美', model_provider: 'personal-provider', model_id: 'personal-model', thinking: 'low' })
    const member = agentRepo(db).create({ name: '销大中', model_provider: 'member-provider', model_id: 'member-model', thinking: 'medium' })
    const project = await call<{ id: string }>('jeff_project_create', {
      title: '推广协作群', leader_agent_id: leader.id, members: [{ agentId: member.id }],
      system_prompt: '销小美负责统筹，其他成员按职责执行；此分工仅在本群有效。',
    })
    await call('jeff_project_member_config', {
      project_id: project.id, agent_id: leader.id, duties: '拆解需求、协调成员并验收',
      model_override: 'openai/gpt-5.1', thinking_override: 'high',
    })
    await call('jeff_project_member_config', {
      project_id: project.id, agent_id: member.id, duties: '负责渠道资料与文案执行',
      model_override: 'openai/gpt-5.1-mini', thinking_override: 'low',
    })

    expect(projectRepo(db).get(project.id)?.system_prompt).toContain('仅在本群有效')
    expect(projectAgentRepo(db).listByProject(project.id)).toMatchObject([
      { agent_id: leader.id, role: 'leader', duties: '拆解需求、协调成员并验收', model_override: 'openai/gpt-5.1', thinking_override: 'high' },
      { agent_id: member.id, role: 'worker', duties: '负责渠道资料与文案执行', model_override: 'openai/gpt-5.1-mini', thinking_override: 'low' },
    ])
    await expect(call('jeff_project_member_config', { project_id: project.id, agent_id: member.id, duties: '', model_override: '' })).rejects.toThrow(/请提供要修改的字段/)
    await call('jeff_project_member_config', { project_id: project.id, agent_id: member.id, reset_model: true, reset_thinking: true })
    expect(projectAgentRepo(db).listByProject(project.id).find((row) => row.agent_id === member.id)).toMatchObject({ model_override: null, thinking_override: null, duties: '负责渠道资料与文案执行' })
    expect(agentRepo(db).get(leader.id)).toMatchObject({ model_provider: 'personal-provider', model_id: 'personal-model', thinking: 'low' })
    expect(agentRepo(db).get(member.id)).toMatchObject({ model_provider: 'member-provider', model_id: 'member-model', thinking: 'medium' })

    await call('jeff_project_update', { id: project.id, clear_system_prompt: true })
    expect(projectRepo(db).get(project.id)?.system_prompt).toBe('')
  })

  it('任务分别保存目标、任务描述和验收标准，创建后不会由 Agent 直接改状态', async () => {
    const call = projCall()
    const leader = agentRepo(db).create({ name: '项目统筹' })
    const project = projectRepo(db).create({ title: '通用项目群', leader_agent_id: leader.id })
    const created = await call<{ id: string; status: string }>('jeff_task_create', {
      project_id: project.id, title: '检查交付物', goal: '确认关键流程可用',
      description: '启动应用并走一遍主要流程', acceptance_criteria: '流程通过且无错误记录',
    })
    expect(created.status).toBe('todo')
    expect(taskRepo(db).get(created.id)).toMatchObject({
      goal: '确认关键流程可用', description: '启动应用并走一遍主要流程',
      acceptance_criteria: '流程通过且无错误记录', status: 'todo',
    })
    await expect(call('jeff_task_update', { id: created.id, status: 'done' })).rejects.toThrow(/没有要修改的字段/)
    expect(taskRepo(db).get(created.id)?.status).toBe('todo')
  })

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

  it('任务字段更新时标题/要求不被空值清掉；指派传空串 = 取消指派', async () => {
    const call = projCall()
    const leader = agentRepo(db).create({ name: '护士长' })
    const nurse = agentRepo(db).create({ name: '责任护士' })
    const p = await call<{ id: string }>('jeff_project_create', { title: '护士站', leader_agent_id: leader.id, members: [{ agentId: nurse.id }] })
    expect(projectAgentRepo(db).listByProject(p.id).map((m) => m.agent_id).sort()).toEqual([leader.id, nurse.id].sort())
    const t = await call<{ id: string; key: string }>('jeff_task_create', { project_id: p.id, title: '随访名单', description: '整理本周名单', goal: '完成名单复核', acceptance_criteria: '主管确认', priority: 'high', assignee_agent_id: nurse.id })
    expect(t.key).toMatch(/^JEF-\d+$/)

    await expect(call('jeff_task_update', { id: t.id, title: '', goal: '', description: '', acceptance_criteria: '', priority: '' })).rejects.toThrow(/没有要修改的字段/)
    expect(taskRepo(db).get(t.id)).toMatchObject({ title: '随访名单', goal: '完成名单复核', description: '整理本周名单', acceptance_criteria: '主管确认', priority: 'high', status: 'todo', assignee_id: nurse.id })

    await call('jeff_task_update', { id: t.id, assignee_agent_id: '' })
    expect(taskRepo(db).get(t.id)).toMatchObject({ assignee_type: 'none', assignee_id: '' })
    await expect(call('jeff_task_update', { id: t.id, title: '   ' })).rejects.toThrow(/没有要修改的字段/)
    await expect(call('jeff_task_update', { id: t.id, priority: 'ASAP' })).rejects.toThrow(/priority 非法/)
    expect(taskRepo(db).get(t.id)).toMatchObject({ status: 'todo' })
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
