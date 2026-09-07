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
