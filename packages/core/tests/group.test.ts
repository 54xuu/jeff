import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { agentSlug } from '../src/agents/registry.js'
import { agentRepo, projectAgentRepo, projectRepo, taskRepo } from '../src/db/repos.js'
import { buildPaths } from '../src/paths.js'
import { GroupChat } from '../src/orchestrator/group.js'
import { taskCardMessage, statusLabel } from '../src/tools/projectTools.js'
import { XIAOJIE_ID } from '../src/ipc/contract.js'
import type { DB } from '../src/db/db.js'
import type { OcClient } from '../src/oc/client.js'

let tmp: string
let db: DB
let group: GroupChat

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-group-'))
  db = openDb(buildPaths(tmp))
  const ocStub = { getSession: async () => ({ id: 'x' }) } as unknown as OcClient
  group = new GroupChat(db, () => ocStub)
  // 种子：小杰 + leader + 两个成员
  const agents = agentRepo(db)
  agents.create({ id: XIAOJIE_ID, name: '小杰', builtin: 1 })
  const leader = agents.create({ name: '架构师', instructions: '统筹' })
  const dev = agents.create({ name: '开发', instructions: '写代码' })
  const ui = agents.create({ name: 'UI', instructions: '画图' })
  const p = projectRepo(db).create({ title: '官网项目', leader_agent_id: leader.id })
  const pa = projectAgentRepo(db)
  pa.add(p.id, leader.id, 'leader', 0)
  pa.add(p.id, dev.id, 'worker')
  pa.add(p.id, ui.id, 'ui')
  db.prepare('UPDATE project SET leader_agent_id = ? WHERE id = ?').run(leader.id, p.id)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('GroupChat', () => {
  it('@提及解析：精确与最长名优先', () => {
    const members = [
      { agent_id: 'a1', name: '开发' },
      { agent_id: 'a2', name: '开发-后端' },
    ]
    expect(group.parseMention('@开发 把 xx 改了', members)).toBe('a1')
    expect(group.parseMention('@开发-后端 改', members)).toBe('a2')
    expect(group.parseMention('没有提及', members)).toBeNull()
  })

  it('briefing 包含名册与 leader 指示', () => {
    const p = projectRepo(db).list()[0]
    const leaderId = projectRepo(db).list()[0].leader_agent_id as string
    const briefing = group.buildBriefing(p.id, leaderId)
    expect(briefing).toContain('官网项目')
    expect(briefing).toContain('项目背景（群简介）')
    expect(briefing).toContain('架构师')
    expect(briefing).toContain('群主/leader')
    expect(briefing).toContain('工作者/worker')
    expect(briefing).toContain('@')
    // 新版协作规范：技能清单 + 串行派发指示
    expect(briefing).toContain('群成员名册与技能清单')
    expect(briefing).toContain('写代码')
    expect(briefing).toContain('画图')
    expect(briefing).toContain('按执行顺序')
    const workerBriefing = group.buildBriefing(p.id, agentRepo(db).list().find((a) => a.name === '开发')!.id)
    expect(workerBriefing).toContain('@架构师 汇报')
  })

  it('briefing 空简介时仍写入项目背景占位', () => {
    const empty = projectRepo(db).create({ title: '空简介群', description: '', leader_agent_id: agentRepo(db).list()[0].id })
    const briefing = group.buildBriefing(empty.id, empty.leader_agent_id as string)
    expect(briefing).toContain('项目背景（群简介）：（未填写，请在群资料补充）')
  })

  it('send：默认路由 leader，@直达成员，消息入群记录', async () => {
    const p = projectRepo(db).list()[0]
    const sent: Array<{ sessionId: string; agent?: string; text?: string; system?: string }> = []
    const ocStub = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_new' }),
      sendMessage: async (input: { sessionId: string; agent?: string; text?: string; system?: string }) => {
        sent.push(input)
        return { id: 'msg_reply', parts: [{ type: 'text', text: `好的（${input.agent}）` }] }
      },
    } as unknown as OcClient
    group = new GroupChat(db, () => ocStub)

    await group.send({ projectId: p.id, text: '大家好，这需求怎么排？' })
    expect(sent[0].agent).toBe(agentSlug(agentRepo(db).list().find((a) => a.name === '架构师')!.id))
    expect(sent[0].system).toContain('群主')

    await group.send({ projectId: p.id, text: '@开发 把登录页改一下' })
    expect(sent[1].system).toContain('成员')

    const history = group.history(p.id)
    expect(history.length).toBe(4)
    expect(history[0].role).toBe('user')
    expect(history[1].sender_name).toBe('架构师')
    expect(history[3].sender_name).toBe('开发')
  })

  it('send：@成员使用该成员的 model/variant，忽略入参覆盖', async () => {
    const agents = agentRepo(db)
    const p = projectRepo(db).list()[0]
    const leader = agents.list().find((a) => a.name === '架构师')!
    const dev = agents.list().find((a) => a.name === '开发')!
    agents.update(leader.id, { model_provider: 'prov-leader', model_id: 'model-l', thinking: 'low' })
    agents.update(dev.id, { model_provider: 'prov-dev', model_id: 'model-d', thinking: 'high' })

    const sent: Array<{ model?: { providerID: string; modelID: string }; variant?: string; agent?: string }> = []
    const ocStub = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_model' }),
      sendMessage: async (input: { model?: { providerID: string; modelID: string }; variant?: string; agent?: string }) => {
        sent.push(input)
        return { id: 'msg_m', parts: [{ type: 'text', text: 'ok' }] }
      },
    } as unknown as OcClient
    group = new GroupChat(db, () => ocStub, {
      defaultModel: () => ({ providerID: 'fallback', modelID: 'fb' }),
    })

    await group.send({
      projectId: p.id,
      text: '排期',
      model: { providerID: 'hack', modelID: 'ignored' },
      variant: 'max',
    })
    expect(sent[0].model).toEqual({ providerID: 'prov-leader', modelID: 'model-l' })
    expect(sent[0].variant).toBe('low')

    await group.send({
      projectId: p.id,
      text: '@开发 改登录',
      model: { providerID: 'hack', modelID: 'ignored' },
      variant: 'none',
    })
    expect(sent[1].model).toEqual({ providerID: 'prov-dev', modelID: 'model-d' })
    expect(sent[1].variant).toBe('high')
    expect(sent[1].agent).toBe(agentSlug(dev.id))
  })

  it('send：未设 leader 报错', async () => {
    const p2 = projectRepo(db).create({ title: '无主群', leader_agent_id: null })
    await expect(group.send({ projectId: p2.id, text: 'hi' })).rejects.toThrow('群主')
  })

  it('send：图片随消息入 meta，历史回放还原 images 并透传给会话', async () => {
    const p = projectRepo(db).list()[0]
    const sent: Array<{ images?: Array<{ mime: string; dataUrl: string }> }> = []
    const ocStub = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_img' }),
      sendMessage: async (input: { images?: Array<{ mime: string; dataUrl: string }> }) => {
        sent.push(input)
        return { id: 'msg_img', parts: [{ type: 'text', text: '收到图' }] }
      },
    } as unknown as OcClient
    group = new GroupChat(db, () => ocStub)

    const img = { mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }
    await group.send({ projectId: p.id, text: '看这张图', images: [img] })
    expect(sent[0].images?.length).toBe(1)
    expect(sent[0].images?.[0].mime).toBe('image/png')

    const history = group.history(p.id)
    const userMsg = history.find((m) => m.role === 'user')
    expect(userMsg?.images?.length).toBe(1)
    expect(userMsg?.images?.[0].dataUrl).toBe(img.dataUrl)
  })

  it('parseAllMentions：按出现顺序返回全部提及并去重', () => {
    const members = [
      { agent_id: 'a_dev', name: '开发' },
      { agent_id: 'a_ui', name: 'UI' },
      { agent_id: 'a_qa', name: '测试' },
    ]
    const r = group.parseAllMentions('先 @开发 做A，再 @UI 画B，最后 @开发 复查', members)
    expect(r.map((m) => m.agent_id)).toEqual(['a_dev', 'a_ui'])
    expect(group.parseAllMentions('无提及', members)).toEqual([])
  })

  it('extractMentionTask：按下一个 @ 切分各自的任务说明', () => {
    const members = [
      { agent_id: 'a_dev', name: '开发' },
      { agent_id: 'a_ui', name: 'UI' },
    ]
    const text = '方案如下 @开发 实现登录接口， @UI 出登录页设计稿'
    expect(group.extractMentionTask(text, '开发', members)).toBe('实现登录接口，')
    expect(group.extractMentionTask(text, 'UI', members)).toBe('出登录页设计稿')
    expect(group.extractMentionTask('没有派发', '开发', members)).toBe('')
  })

  it('send：leader 拆解 @派发 → worker 串行执行并汇报 → leader 自动总结闭环', async () => {
    const p = projectRepo(db).list()[0]
    const agents = agentRepo(db)
    const leader = agents.list().find((a) => a.name === '架构师')!
    const dev = agents.list().find((a) => a.name === '开发')!
    const ui = agents.list().find((a) => a.name === 'UI')!
    const slugToName = new Map([
      [agentSlug(leader.id), '架构师'],
      [agentSlug(dev.id), '开发'],
      [agentSlug(ui.id), 'UI'],
    ])
    const order: string[] = []
    const texts: Array<{ agent?: string; text?: string }> = []
    const ocStub = {
      getSession: async () => ({ id: 'x' }),
      createSession: async (input: { title?: string }) => ({ id: `ses_${Math.random().toString(36).slice(2, 8)}`, title: input?.title }),
      sendMessage: async (input: { agent?: string; text?: string }) => {
        const name = slugToName.get(input.agent || '') || ''
        order.push(name)
        texts.push(input)
        if (name === '架构师' && order.filter((n) => n === '架构师').length === 1) {
          return { id: 'm1', parts: [{ type: 'text', text: '我来拆解：@开发 实现登录接口；@UI 出登录页设计稿' }] }
        }
        if (name === '开发') return { id: 'm2', parts: [{ type: 'text', text: '@架构师 汇报：登录接口已完成' }] }
        if (name === 'UI') return { id: 'm3', parts: [{ type: 'text', text: '@架构师 汇报：设计稿已产出' }] }
        return { id: 'm4', parts: [{ type: 'text', text: '总结：登录功能前后端均已完成' }] }
      },
    } as unknown as OcClient
    group = new GroupChat(db, () => ocStub)

    const r = await group.send({ projectId: p.id, text: '做个登录功能' })
    // 执行顺序：leader 拆解 → 开发 → UI → leader 总结
    expect(order).toEqual(['架构师', '开发', 'UI', '架构师'])
    expect(r.routedTo).toBe(leader.id)
    // worker 收到的是带指派前缀与汇报要求的派发指令
    expect(texts[1].text).toContain('群主 架构师 在群里指派')
    expect(texts[1].text).toContain('实现登录接口')
    expect(texts[2].text).toContain('出登录页设计稿')
    // 总结回合是系统唤醒提示
    expect(texts[3].text).toContain('系统通知')
    // 群记录：公告 + 各成员消息 + 总结
    const history = group.history(p.id)
    expect(history.some((m) => m.role === 'system' && m.text.includes('已拆解任务'))).toBe(true)
    expect(history.some((m) => m.sender_name === '开发' && m.text.includes('登录接口已完成'))).toBe(true)
    expect(history.some((m) => m.sender_name === 'UI' && m.text.includes('设计稿已产出'))).toBe(true)
    expect(history.some((m) => m.sender_name === '架构师' && m.text.includes('总结：'))).toBe(true)
  })

  it('send：用户直连 @worker，worker 汇报后 leader 自动验收总结', async () => {
    const p = projectRepo(db).list()[0]
    const agents = agentRepo(db)
    const leader = agents.list().find((a) => a.name === '架构师')!
    const dev = agents.list().find((a) => a.name === '开发')!
    const slugToName = new Map([
      [agentSlug(leader.id), '架构师'],
      [agentSlug(dev.id), '开发'],
    ])
    const order: string[] = []
    const ocStub = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: `ses_${Math.random().toString(36).slice(2, 8)}` }),
      sendMessage: async (input: { agent?: string }) => {
        const name = slugToName.get(input.agent || '') || ''
        order.push(name)
        if (name === '开发') return { id: 'w1', parts: [{ type: 'text', text: '@架构师 汇报：已修好 bug' }] }
        return { id: 'w2', parts: [{ type: 'text', text: '已验收，问题解决' }] }
      },
    } as unknown as OcClient
    group = new GroupChat(db, () => ocStub)

    const r = await group.send({ projectId: p.id, text: '@开发 修复登录 bug' })
    expect(order).toEqual(['开发', '架构师'])
    expect(r.routedTo).toBe(leader.id)
  })

  it('send：协作步数达到上限后停止派发，由 leader 汇总兜底', async () => {
    const p = projectRepo(db).list()[0]
    const agents = agentRepo(db)
    const leader = agents.list().find((a) => a.name === '架构师')!
    const dev = agents.list().find((a) => a.name === '开发')!
    const ui = agents.list().find((a) => a.name === 'UI')!
    const slugToName = new Map([
      [agentSlug(leader.id), '架构师'],
      [agentSlug(dev.id), '开发'],
      [agentSlug(ui.id), 'UI'],
    ])
    let workerTurns = 0
    const ocStub = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: `ses_${Math.random().toString(36).slice(2, 8)}` }),
      sendMessage: async (input: { agent?: string }) => {
        const name = slugToName.get(input.agent || '') || ''
        if (name === '架构师') {
          if (workerTurns === 0) return { id: 'l1', parts: [{ type: 'text', text: '@开发 开始干活' }] }
          return { id: 'l2', parts: [{ type: 'text', text: '步数超限，汇总当前进展' }] }
        }
        // worker 之间互相无限转派，制造死循环场景
        workerTurns += 1
        return { id: `t${workerTurns}`, parts: [{ type: 'text', text: workerTurns % 2 === 1 ? '@UI 继续推进' : '@开发 继续推进' }] }
      },
    } as unknown as OcClient
    group = new GroupChat(db, () => ocStub)

    await group.send({ projectId: p.id, text: '一个会循环派发的任务' })
    expect(workerTurns).toBe(5)
    const history = group.history(p.id)
    expect(history.some((m) => m.role === 'system' && m.text.includes('已达上限'))).toBe(true)
  })

  it('send：leader 直答（无派发）不触发总结回合', async () => {
    const p = projectRepo(db).list()[0]
    const agents = agentRepo(db)
    const leader = agents.list().find((a) => a.name === '架构师')!
    const order: string[] = []
    const ocStub = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_hi' }),
      sendMessage: async (input: { agent?: string }) => {
        order.push(agentSlug(leader.id) === input.agent ? 'leader' : (input.agent as string))
        return { id: 'hi', parts: [{ type: 'text', text: '你好，我是群主' }] }
      },
    } as unknown as OcClient
    group = new GroupChat(db, () => ocStub)

    await group.send({ projectId: p.id, text: '在吗？' })
    expect(order).toEqual(['leader'])
  })
})

describe('taskCardMessage / statusLabel', () => {
  it('卡片消息与状态中文', () => {
    const p = projectRepo(db).list()[0]
    const t = taskRepo(db).create({ project_id: p.id, title: '修复登录', assignee_type: 'agent', assignee_id: XIAOJIE_ID })
    const card = taskCardMessage(db, p.id, t.id)
    expect(card.content).toContain('JEF-1')
    expect(card.content).toContain('修复登录')
    expect(card.content).toContain('小杰')
    expect((card.meta as { type?: string }).type).toBe('task')
    expect(statusLabel('in_progress')).toBe('进行中')
  })
})
