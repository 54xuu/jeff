import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { buildPaths } from '../src/paths.js'
import { agentRepo, projectRepo, projectAgentRepo, chatMessageRepo } from '../src/db/repos.js'
import { GroupChat } from '../src/orchestrator/group.js'
import { Delegator } from '../src/orchestrator/delegate.js'
import { XIAOJIE_ID, agentSlug } from '../src/index.js'
import type { DB } from '../src/db/db.js'
import type { OcClient } from '../src/oc/client.js'

let tmp: string
let db: DB
let group: GroupChat
let delegator: Delegator
let leaderId: string
let devId: string
let projectId: string
let sentTo: Array<{ sessionId: string; agent?: string; text?: string; system?: string }>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-del-'))
  db = openDb(buildPaths(tmp))
  const agents = agentRepo(db)
  agents.create({ id: XIAOJIE_ID, name: '小杰', builtin: 1 })
  const leader = agents.create({ name: '架构师老王', instructions: '统筹' })
  devId = agents.create({ name: '开发小李', instructions: '前端' }).id
  leaderId = leader.id
  projectId = projectRepo(db).create({ title: '官网群', leader_agent_id: leaderId }).id
  const pa = projectAgentRepo(db)
  pa.add(projectId, leaderId, 'leader', 0)
  pa.add(projectId, devId, 'worker', 1)

  group = new GroupChat(db, () => ocStub, {})
  delegator = new Delegator(db, () => ocStub, group, () => {})
})

const ocStub = {
  getSession: async () => ({ id: 'x' }),
  createSession: async (input: { title?: string }) => ({ id: `ses_${Math.random().toString(36).slice(2, 8)}`, title: input?.title }),
  sendMessage: async (input: { sessionId: string; agent?: string; text?: string; system?: string }) => {
    sentTo.push(input)
    return { id: `msg_${Math.random().toString(36).slice(2, 8)}`, parts: [{ type: 'text', text: `完成！[${input.agent}] 已处理：${input.text?.slice(0, 30)}` }] }
  },
} as unknown as OcClient

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Delegator', () => {
  it('leader 委派成员 → 成员执行 → 结果回群 → 工具输出带结果', async () => {
    sentTo = []
    const r = await delegator.delegate({ projectId, leaderAgentId: leaderId }, devId, '把首页 banner 改成新配色', 'msg_l1')
    expect(r.ok).toBe(true)
    expect(r.result).toContain('已处理')
    // 成员会话收到指派
    expect(sentTo).toHaveLength(1)
    expect(sentTo[0].agent).toBe(agentSlug(devId))
    expect(sentTo[0].text).toContain('群主 架构师老王 指派')
    expect(sentTo[0].system).toContain('官网群')
    // 群记录：leader 普通气泡派发（@我 + @成员 + 完整指令）+ worker 普通气泡结果（@我）
    const history = group.history(projectId)
    const dispatch = history.find((m) => (m.meta as { phase?: string })?.phase === 'dispatch')
    expect(dispatch?.role).toBe('assistant')
    expect(dispatch?.agentId).toBe(leaderId)
    expect(dispatch?.sender_name).toBe('架构师老王')
    expect(dispatch?.text).toContain('@我')
    expect(dispatch?.text).toContain('@开发小李')
    expect(dispatch?.text).toContain('把首页 banner 改成新配色')
    const result = history.find((m) => (m.meta as { phase?: string })?.phase === 'result')
    expect(result?.sender_name).toBe('开发小李')
    expect(result?.text.startsWith('@我')).toBe(true)
    expect(result?.text).toContain('已处理')
  })

  it('派发公告完整保留超长指令（不再 120 字截断）', async () => {
    sentTo = []
    const tail = '结尾标记-XYZ9'
    const instruction = `${'很长的任务说明。'.repeat(30)}${tail}`
    await delegator.delegate({ projectId, leaderAgentId: leaderId }, devId, instruction, 'msg_long')
    const dispatch = group.history(projectId).find((m) => (m.meta as { phase?: string })?.phase === 'dispatch')
    expect(dispatch?.text).toContain(tail)
  })

  it('委派失败：worker 普通气泡 @我 回群，完整错误 message 不截断', async () => {
    const longErr = 'E'.repeat(400)
    const failOc = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_fail' }),
      sendMessage: async () => {
        throw new Error(longErr)
      },
    } as unknown as OcClient
    const fd = new Delegator(db, () => failOc, group, () => {})
    const r = await fd.delegate({ projectId, leaderAgentId: leaderId }, devId, '会失败的任务', 'msg_fail')
    expect(r.ok).toBe(false)
    const failed = group.history(projectId).find((m) => (m.meta as { phase?: string })?.phase === 'failed')
    expect(failed?.role).toBe('assistant')
    expect(failed?.agentId).toBe(devId)
    expect(failed?.sender_name).toBe('开发小李')
    expect(failed?.text).toBe(`@我 任务执行失败：${longErr}`)
  })

  it('notify 携带冻结的 threadId（防切换会话后刷新错线）', async () => {
    sentTo = []
    const payloads: Array<{ projectId: string; threadId?: string }> = []
    const nid = new Delegator(db, () => ocStub, group, (pl) => payloads.push(pl))
    await nid.delegate({ projectId, leaderAgentId: leaderId, threadId: 'thr_fixed' }, devId, '带 thread 的委派', 'msg_tid')
    expect(payloads).toEqual([
      { projectId, threadId: 'thr_fixed' },
      { projectId, threadId: 'thr_fixed' },
    ])
  })

  it('非群主不可委派', async () => {
    const r = await delegator.delegate({ projectId, leaderAgentId: devId }, XIAOJIE_ID, '试试')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('群主')
  })

  it('不能委派给自己 / 群外成员不可委派', async () => {
    const r1 = await delegator.delegate({ projectId, leaderAgentId: leaderId }, leaderId, '自己')
    expect(r1.error).toContain('自己')
    const r2 = await delegator.delegate({ projectId, leaderAgentId: leaderId }, XIAOJIE_ID, '小杰不在群')
    expect(r2.error).toContain('不在本群')
  })

  it('并发防重：相同 (群,成员,指令) 进行中会被拒', async () => {
    sentTo = []
    // 手动占位：直接调用两次，第一次还没完成时第二次进来（用两个 promise 模拟并发）
    const p1 = delegator.delegate({ projectId, leaderAgentId: leaderId }, devId, '重复的指令', 'msg_x')
    const p2 = delegator.delegate({ projectId, leaderAgentId: leaderId }, devId, '重复的指令', 'msg_x')
    const [r1, r2] = await Promise.all([p1, p2])
    // 其中一个成功，另一个被防重拒绝
    expect([r1.ok, r2.ok]).toContain(false)
    const failed = r1.ok ? r2 : r1
    expect(failed.error).toContain('正在进行')
  })

  it('同一条消息最多委派 5 次（防失控循环）', async () => {
    sentTo = []
    for (let i = 0; i < 5; i++) {
      const r = await delegator.delegate({ projectId, leaderAgentId: leaderId }, devId, `第 ${i} 个不同任务`, 'msg_loop')
      expect(r.ok).toBe(true)
    }
    const r6 = await delegator.delegate({ projectId, leaderAgentId: leaderId }, devId, '第六个任务', 'msg_loop')
    expect(r6.ok).toBe(false)
    expect(r6.error).toContain('上限')
  })

  it('resolveDelegateScope：群主会话可委派，成员会话不行', () => {
    const leaderSession = `ses_leader_${Date.now()}`
    db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(`session:group:${projectId}:${leaderId}`, leaderSession, Date.now())
    const devSession = `ses_dev_${Date.now()}`
    db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(`session:group:${projectId}:${devId}`, devSession, Date.now())

    expect(delegator.resolveDelegateScope(leaderSession, leaderId)).toMatchObject({ projectId })
    expect(delegator.resolveDelegateScope(devSession, devId)).toBeNull()
  })

  it('委派回合注入规则/记忆（与普通群回合一致，briefing 在前）', async () => {
    sentTo = []
    delegator.buildMemory = (agentId, pid) => {
      expect(agentId).toBe(devId)
      expect(pid).toBe(projectId)
      return 'MEM-RULES-BLOCK'
    }
    const r = await delegator.delegate({ projectId, leaderAgentId: leaderId }, devId, '带规则的委派', 'msg_m1')
    expect(r.ok).toBe(true)
    const system = sentTo[0].system as string
    expect(system).toContain('官网群') // 群 briefing
    expect(system).toContain('MEM-RULES-BLOCK')
    expect(system.indexOf('官网群')).toBeLessThan(system.indexOf('MEM-RULES-BLOCK'))
    delegator.buildMemory = undefined
  })

  it('未注入 buildMemory 时退化为仅 briefing（向后兼容）', async () => {
    sentTo = []
    const r = await delegator.delegate({ projectId, leaderAgentId: leaderId }, devId, '不带规则的委派', 'msg_m2')
    expect(r.ok).toBe(true)
    expect(sentTo[0].system).toContain('官网群')
    expect(sentTo[0].system).not.toContain('MEM-RULES-BLOCK')
  })
})
