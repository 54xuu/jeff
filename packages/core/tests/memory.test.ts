import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { buildPaths } from '../src/paths.js'
import { MemoryStore, matchUnique, parseEntries } from '../src/memory/store.js'
import { SessionIndex, buildMatchQuery, cjkSplit } from '../src/memory/indexer.js'
import { resolveMemoryScope } from '../src/tools/memoryTools.js'
import type { DB } from '../src/db/db.js'

let tmp: string
let db: DB
let store: MemoryStore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-mem-'))
  db = openDb(buildPaths(tmp))
  store = new MemoryStore(buildPaths(tmp))
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('MemoryStore', () => {
  it('add / list / 重复去重', () => {
    const s = { kind: 'agent', agentId: 'agt_1' } as const
    expect(store.add(s, '用户偏好 TypeScript')).toMatchObject({ ok: true })
    expect(store.add(s, '用户偏好 TypeScript')).toMatchObject({ ok: true }) // 精确去重
    expect(store.add(s, '项目用 pnpm')).toMatchObject({ ok: true })
    expect(store.list(s)).toHaveLength(2)
    expect(parseEntries(store.list(s).join('\n§\n'))).toHaveLength(2)
  })

  it('replace / remove 唯一子串匹配', () => {
    const s = { kind: 'agent', agentId: 'agt_1' } as const
    store.batch(s, [
      { action: 'add', text: '部署环境是 linux-x64 服务器' },
      { action: 'add', text: '用户喜欢简洁回复' },
    ])
    const r = store.replace(s, '简洁回复', '言简意赅的回复')
    expect(r.ok).toBe(true)
    expect(store.list(s)[1]).toContain('言简意赅')
    expect(store.remove(s, '部署环境').ok).toBe(true)
    expect(store.list(s)).toHaveLength(1)
  })

  it('匹配多条报错要求更精确', () => {
    const s = { kind: 'agent', agentId: 'agt_1' } as const
    store.batch(s, [
      { action: 'add', text: 'A 条目内容' },
      { action: 'add', text: 'B 条目内容' },
    ])
    const r = store.remove(s, '条目内容')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('唯一')
    expect(store.list(s)).toHaveLength(2)
  })

  it('预算超限报错并附带当前条目；batch 原子腾挪成功', () => {
    const s = { kind: 'agent', agentId: 'agt_1' } as const
    const big = 'x'.repeat(2200)
    store.add(s, big)
    const r1 = store.add(s, '再来一条就会超')
    expect(r1.ok).toBe(false)
    expect(r1.error).toContain('超预算')
    expect(r1.entries?.length).toBeGreaterThan(0)
    // batch：删旧 + 添新，最终状态在预算内
    const r2 = store.batch(s, [
      { action: 'remove', old_text: big },
      { action: 'add', text: '整合后的关键事实' },
    ])
    expect(r2.ok).toBe(true)
    expect(store.list(s)).toEqual(['整合后的关键事实'])
  })

  it('原子写：落盘内容可被重新解析', () => {
    const s = { kind: 'project', projectId: 'prj_1' } as const
    store.batch(s, [
      { action: 'add', text: '群里约定：周五发版' },
      { action: 'add', text: '代码仓库 github.com/x/y' },
    ])
    const raw = fs.readFileSync(store.file(s), 'utf8')
    expect(raw).toContain('§')
    const store2 = new MemoryStore(buildPaths(tmp))
    expect(store2.list(s)).toHaveLength(2)
  })

  it('renderBlock 含标签与条目；空记忆为 null', () => {
    const s = { kind: 'agent', agentId: 'agt_1' } as const
    expect(store.renderBlock(s)).toBeNull()
    store.add(s, '事实一')
    const block = store.renderBlock(s)!
    expect(block).toContain('agent agt_1 记忆')
    expect(block).toContain('事实一')
  })

  it('并发写：目录锁保证不丢条目', async () => {
    const s = { kind: 'agent', agentId: 'agt_lock' } as const
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => store.add(s, `并发条目 ${i}`))),
    )
    expect(store.list(s)).toHaveLength(10)
  })
})

describe('matchUnique', () => {
  it('命中 0/1/多', () => {
    const entries = ['alpha beta', 'gamma delta', 'alpha gamma']
    expect(matchUnique(entries, 'beta')).toBe(0)
    expect(matchUnique(entries, 'alpha')).toBe(-1)
    expect(matchUnique(entries, 'nothing')).toBe(-1)
  })
})

describe('SessionIndex', () => {
  it('中文子串检索（CJK 单字 token + phrase 查询）', () => {
    const idx = new SessionIndex(db)
    idx.index({ id: 'a', scope: 'private:agt_1', sender: 'user', ts: 1, text: '我们把登录超时从 30 秒改成 5 秒' })
    idx.index({ id: 'b', scope: 'group:prj_1', sender: '架构师', ts: 2, text: '数据库连接池调到 50' })
    idx.index({ id: 'c', scope: 'group:prj_1', sender: 'user', ts: 3, text: 'deploy to staging every friday' })

    const r1 = idx.search('登录超时')
    expect(r1.length).toBeGreaterThanOrEqual(1)
    expect(r1[0].snippet).toContain('「登 录 超 时」')
    expect(idx.search('连接池')[0]?.scope).toBe('group:prj_1')
    expect(idx.search('连接池')[0].snippet).toContain('「连 接 池」')
    expect(idx.search('friday')[0].id).toBe('c')
    // scope 过滤
    expect(idx.search('超时', { scope: 'group:prj_1' })).toHaveLength(0)
    expect(idx.search('超时', { scope: 'private:agt_1' })).toHaveLength(1)
    // 无命中
    expect(idx.search('完全无关词')).toHaveLength(0)
  })

  it('幂等更新（ON CONFLICT）', () => {
    const idx = new SessionIndex(db)
    idx.index({ id: 'a', scope: 's', sender: 'user', ts: 1, text: '第一版' })
    idx.index({ id: 'a', scope: 's', sender: 'user', ts: 2, text: '第二版内容' })
    expect(idx.search('第一版')).toHaveLength(0)
    expect(idx.search('第二版')).toHaveLength(1)
  })

  it('buildMatchQuery / cjkSplit', () => {
    expect(cjkSplit('登录超时')).toBe('登 录 超 时')
    expect(buildMatchQuery('登录超时 OR deploys')).toContain('"登 录 超 时"')
    expect(buildMatchQuery('deploys')).toContain('"deploys"*')
  })
})

describe('resolveMemoryScope', () => {
  it('user 仅小杰可写；project 需要成员身份', () => {
    db.exec(`INSERT INTO agent (id,name,avatar,builtin,created_at,updated_at) VALUES ('agt_xj','小杰','🧑',1,1,1),('agt_dev','开发','💻',0,1,1)`)
    db.exec(`INSERT INTO project (id,title,leader_agent_id,created_at,updated_at) VALUES ('prj_1','群','agt_xj',1,1)`)
    db.exec(`INSERT INTO project_agent (project_id,agent_id,role,created_at) VALUES ('prj_1','agt_dev','开发',1)`)

    const okUser = resolveMemoryScope(db, { agentId: 'agt_xj', resolved: null, explicit: 'user', builtin: true })
    expect(okUser).toMatchObject({ scope: { kind: 'user' } })
    const denyUser = resolveMemoryScope(db, { agentId: 'agt_dev', resolved: null, explicit: 'user', builtin: false })
    expect('error' in denyUser && denyUser.error).toContain('小杰')
    const okProject = resolveMemoryScope(db, { agentId: 'agt_dev', resolved: null, explicit: 'project:prj_1', builtin: false })
    expect(okProject).toMatchObject({ scope: { kind: 'project' } })
    const denyProject = resolveMemoryScope(db, { agentId: 'agt_stranger', resolved: null, explicit: 'project:prj_1', builtin: false })
    expect('error' in denyProject).toBe(true)
    // 群会话默认写项目记忆
    const groupDefault = resolveMemoryScope(db, { agentId: 'agt_dev', resolved: { kind: 'group', projectId: 'prj_1', agentId: 'agt_dev' }, builtin: false })
    expect(groupDefault).toMatchObject({ scope: { kind: 'project', projectId: 'prj_1' } })
  })
})
