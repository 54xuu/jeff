import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { agentRepo, chatMessageRepo, kvRepo, projectAgentRepo, projectRepo } from '../src/db/repos.js'
import { buildPaths } from '../src/paths.js'
import { GroupChat } from '../src/orchestrator/group.js'
import { GroupThreadStore, groupMsgScope, legacyGroupMsgScope } from '../src/orchestrator/groupThreads.js'
import { XIAOJIE_ID } from '../src/ipc/contract.js'
import type { DB } from '../src/db/db.js'
import type { OcClient } from '../src/oc/client.js'

let tmp: string
let db: DB
let group: GroupChat
let threads: GroupThreadStore
let projectId: string
let leaderId: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-gthr-'))
  db = openDb(buildPaths(tmp))
  const ocStub = { getSession: async () => ({ id: 'x' }) } as unknown as OcClient
  group = new GroupChat(db, () => ocStub)
  threads = group.threads
  const agents = agentRepo(db)
  agents.create({ id: XIAOJIE_ID, name: '小杰', builtin: 1 })
  const leader = agents.create({ name: '架构师' })
  leaderId = leader.id
  const p = projectRepo(db).create({ title: '线程项目', leader_agent_id: leader.id })
  projectId = p.id
  projectAgentRepo(db).add(p.id, leader.id, 'leader', 0)
  db.prepare('UPDATE project SET leader_agent_id = ? WHERE id = ?').run(leader.id, p.id)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('GroupThreadStore', () => {
  it('迁移旧 scope 消息与 session 到默认会话', () => {
    const msgs = chatMessageRepo(db)
    msgs.add({ scope: legacyGroupMsgScope(projectId), sender_type: 'user', content: '旧群消息' })
    kvRepo(db).set(`session:group:${projectId}:${leaderId}`, 'oc-legacy-1')

    const active = threads.ensureActiveThread(projectId)
    expect(threads.getMeta(projectId, active)?.title).toBe('默认会话')
    expect(msgs.listByScope(legacyGroupMsgScope(projectId))).toHaveLength(0)
    expect(msgs.listByScope(groupMsgScope(projectId, active))).toHaveLength(1)
    expect(kvRepo(db).get(`session:group:${projectId}:${active}:${leaderId}`)).toBe('oc-legacy-1')
    expect(kvRepo(db).get(`session:group:${projectId}:${leaderId}`)).toBeNull()
  })

  it('新会话后 active 历史为空，旧 thread 仍有消息', async () => {
    const ocStub = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_new' }),
      sendMessage: async () => ({ id: 'msg', parts: [{ type: 'text', text: 'ok' }] }),
    } as unknown as OcClient
    group = new GroupChat(db, () => ocStub)
    threads = group.threads

    await group.send({ projectId, text: '第一段' })
    const first = group.activeThreadId(projectId)
    expect(group.history(projectId).some((m) => m.text.includes('第一段'))).toBe(true)

    const neu = threads.createThread(projectId)
    expect(neu.id).not.toBe(first)
    expect(group.activeThreadId(projectId)).toBe(neu.id)
    expect(group.history(projectId)).toHaveLength(0)
    expect(chatMessageRepo(db).listByScope(groupMsgScope(projectId, first)).length).toBeGreaterThan(0)
  })

  it('rename / activate 切换话题', () => {
    const t1 = threads.ensureActiveThread(projectId)
    chatMessageRepo(db).add({
      scope: groupMsgScope(projectId, t1),
      sender_type: 'user',
      content: '话题一',
    })
    const t2 = threads.createThread(projectId, '话题二')
    threads.rename(projectId, t2.id, '改名话题')
    expect(threads.getMeta(projectId, t2.id)?.title).toBe('改名话题')

    threads.setActive(projectId, t1)
    expect(group.activeThreadId(projectId)).toBe(t1)
    expect(group.history(projectId).some((m) => m.text === '话题一')).toBe(true)

    threads.setActive(projectId, t2.id)
    expect(group.history(projectId)).toHaveLength(0)
  })

  it('删除话题时清理指向它的 last-session 指针', async () => {
    const ocStub = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_del' }),
      sendMessage: async () => ({ id: 'msg', parts: [{ type: 'text', text: 'ok' }] }),
    } as unknown as OcClient
    group = new GroupChat(db, () => ocStub)
    threads = group.threads

    await group.send({ projectId, text: '将被删除的会话' })
    const tid = group.activeThreadId(projectId)
    // runTurn 会把最后会话指针指到该 thread 的 session
    expect(kvRepo(db).get(`session:group:last:${projectId}`)).toBe('ses_del')

    threads.deleteThread(projectId, tid)
    expect(kvRepo(db).get(`session:group:last:${projectId}`)).toBeNull()
  })
})

describe('会话默认命名 {YYYYMMDD-HHmm}-{任务中文名称}', () => {
  const ocStub = () =>
    ({
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_t' }),
      sendMessage: async () => ({ id: 'msg', parts: [{ type: 'text', text: 'ok' }] }),
    }) as unknown as OcClient

  it('新建自动命名会话先用「时间戳-新会话」占位', () => {
    const t = threads.createThread(projectId)
    expect(t.title).toMatch(/^\d{8}-\d{4}-新会话$/)
    expect(t.autoTitle).toBe(true)
  })

  it('显式命名的会话不参与自动命名', () => {
    const t = threads.createThread(projectId, '手工标题')
    expect(t.title).toBe('手工标题')
    expect(t.autoTitle).toBe(false)
  })

  it('首条用户消息补任务名，时间戳仍是创建时刻', async () => {
    group = new GroupChat(db, () => ocStub())
    threads = group.threads
    const tid = threads.createThread(projectId).id
    const created = threads.getMeta(projectId, tid)
    const stamp = created!.title.slice(0, 13)

    await group.send({ projectId, text: '@架构师 修复登录按钮' })

    const after = threads.getMeta(projectId, tid)
    expect(after?.title).toBe(`${stamp}-修复登录按钮`)
    expect(after?.autoTitle).toBe(false)
  })

  it('只有首条消息改名：后续消息与手动改名都不会再覆盖', async () => {
    group = new GroupChat(db, () => ocStub())
    threads = group.threads
    const tid = threads.createThread(projectId).id

    await group.send({ projectId, text: '第一件事' })
    expect(threads.getMeta(projectId, tid)?.title).toMatch(/^\d{8}-\d{4}-第一件事$/)

    await group.send({ projectId, text: '第二件事' })
    expect(threads.getMeta(projectId, tid)?.title).toMatch(/^\d{8}-\d{4}-第一件事$/)

    threads.rename(projectId, tid, '我自己起的名字')
    await group.send({ projectId, text: '第三件事' })
    expect(threads.getMeta(projectId, tid)?.title).toBe('我自己起的名字')
  })

  it('迁移承载旧数据的会话保持「默认会话」且不参与自动命名', async () => {
    const msgs = chatMessageRepo(db)
    msgs.add({ scope: legacyGroupMsgScope(projectId), sender_type: 'user', content: '旧群消息' })
    const active = threads.ensureActiveThread(projectId)
    expect(threads.getMeta(projectId, active)?.title).toBe('默认会话')
    expect(threads.getMeta(projectId, active)?.autoTitle).toBe(false)

    threads.autoTitleFromFirstMessage(projectId, active, '不该生效')
    expect(threads.getMeta(projectId, active)?.title).toBe('默认会话')
  })
})
