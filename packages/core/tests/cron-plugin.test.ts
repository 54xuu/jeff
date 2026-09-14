import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { agentRepo, cronRunRepo, cronTaskRepo, projectAgentRepo, projectRepo } from '../src/db/repos.js'
import { buildPaths } from '../src/paths.js'
import type { DB } from '../src/db/db.js'
import { CronScheduler } from '../src/cron/scheduler.js'
import { PluginManager } from '../src/plugins/manager.js'
import type { CronTaskRow } from '../src/db/repos.js'

let tmp: string
let db: DB

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-cron-'))
  db = openDb(buildPaths(tmp))
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** 搭一个「agent 目标」的任务 */
function seedAgentTask(expr = '0 8 * * *', extra: Record<string, unknown> = {}): string {
  const a = agentRepo(db).create({ name: '资讯助手' })
  const t = cronTaskRepo(db).create({ name: 'AI 资讯早报', target_type: 'agent', target_id: a.id, cron_expr: expr, prompt: '请报最新 AI 资讯', ...extra })
  return t.id
}

describe('cronTaskRepo', () => {
  it('创建/更新/软删除 + 分类聚合在 agent 上可用', () => {
    const id = seedAgentTask()
    const repo = cronTaskRepo(db)
    expect(repo.get(id)?.miss_policy).toBe('catchup')
    expect(repo.get(id)?.enabled).toBe(1)
    repo.setNextRun(id, 123)
    expect(repo.get(id)?.next_run_at).toBe(123)
    repo.setLastRun(id, 456)
    expect(repo.get(id)?.last_run_at).toBe(456)
    expect(repo.listEnabled().length).toBe(1)
    repo.update(id, { enabled: 0 })
    expect(repo.listEnabled().length).toBe(0)
    expect(repo.softDelete(id)).toBe(true)
    expect(repo.list().length).toBe(0)
    expect(repo.list(true).length).toBe(1)
  })

  it('cron_run 记录状态与按任务裁剪', () => {
    const id = seedAgentTask()
    const runs = cronRunRepo(db)
    const r = runs.start(id, true)
    expect(r.status).toBe('running')
    runs.finish(r.id, 'ok')
    expect(runs.listByTask(id)[0].status).toBe('ok')
    expect(runs.listByTask(id)[0].is_catchup).toBe(1)
    runs.log(id, 'missed', '错过')
    expect(runs.lastStatusMap()[id].status).toBe('missed')
    for (let i = 0; i < 8; i++) runs.log(id, 'skipped')
    runs.prune(3)
    expect(runs.listByTask(id, 100).length).toBe(3)
  })

  it('failStale：残留的 running 记录被收尾为 failed（应用退出打断的回合）', () => {
    const id = seedAgentTask()
    const runs = cronRunRepo(db)
    const stale = runs.start(id)
    const kept = runs.start(id)
    runs.finish(kept.id, 'ok')
    expect(runs.failStale()).toBe(1)
    const rows = runs.listByTask(id)
    expect(rows.find((x) => x.id === stale.id)).toMatchObject({ status: 'failed' })
    expect(rows.find((x) => x.id === stale.id)!.error).toContain('中断')
    expect(rows.find((x) => x.id === kept.id)!.status).toBe('ok')
    // 幂等：再调一次没有可收尾的行
    expect(runs.failStale()).toBe(0)
  })
})

/** 等条件成立（调度器是异步的：入队→pump→execute） */
async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('waitFor 超时')
}

describe('CronScheduler', () => {
  it('启动时 missed 策略：skip 顺延并记 missed，catchup 入队补跑', async () => {
    const skipId = seedAgentTask('0 8 * * *', { name: '跳过的' })
    const catchId = seedAgentTask('0 8 * * *', { name: '补跑的' })
    const repo = cronTaskRepo(db)
    repo.update(skipId, { miss_policy: 'skip', next_run_at: Date.now() - 60_000 })
    repo.update(catchId, { miss_policy: 'catchup', next_run_at: Date.now() - 60_000 })

    const ran: Array<{ id: string; isCatchup: boolean }> = []
    const sched = new CronScheduler({
      db,
      runTask: async (t, isCatchup) => {
        ran.push({ id: t.id, isCatchup })
      },
    })
    sched.start()
    sched.stop()
    await waitFor(() => ran.length === 1)
    expect(ran[0]).toEqual({ id: catchId, isCatchup: true })
    // 两条任务的 next_run_at 都被推到未来
    expect(repo.get(skipId)!.next_run_at!).toBeGreaterThan(Date.now())
    expect(repo.get(catchId)!.next_run_at!).toBeGreaterThan(Date.now())
    // skip 任务留下 missed 记录，且从未执行
    expect(cronRunRepo(db).listByTask(skipId)[0].status).toBe('missed')
  })

  it('到点触发一次并记录 ok + last_run_at', async () => {
    const id = seedAgentTask()
    cronTaskRepo(db).update(id, { next_run_at: Date.now() - 1000 })
    const ran: string[] = []
    const sched = new CronScheduler({ db, runTask: async (t) => void ran.push(t.id) })
    sched.tick()
    await waitFor(() => ran.length === 1)
    await waitFor(() => cronRunRepo(db).listByTask(id)[0]?.status === 'ok')
    expect(cronRunRepo(db).lastStatusMap()[id].status).toBe('ok')
    expect(cronTaskRepo(db).get(id)!.last_run_at).toBeTruthy()
  })

  it('执行失败记 failed + 原因，且不重试', async () => {
    const id = seedAgentTask()
    cronTaskRepo(db).update(id, { next_run_at: Date.now() - 1000 })
    let calls = 0
    const sched = new CronScheduler({
      db,
      runTask: async () => {
        calls += 1
        throw new Error('模型 401')
      },
    })
    sched.tick()
    await waitFor(() => calls === 1)
    await waitFor(() => cronRunRepo(db).listByTask(id)[0]?.status === 'failed')
    const run = cronRunRepo(db).listByTask(id)[0]
    expect(run.error).toContain('模型 401')
    // 再 tick 一次不会重试（next_run_at 已在未来）
    sched.tick()
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toBe(1)
  })

  it('上一轮未结束时跳过本次并记 skipped', async () => {
    const id = seedAgentTask()
    const repo = cronTaskRepo(db)
    repo.update(id, { next_run_at: Date.now() - 1000 })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let started = 0
    const sched = new CronScheduler({
      db,
      runTask: async () => {
        started += 1
        await gate
      },
    })
    sched.tick()
    await waitFor(() => started === 1)
    // 上一轮还在跑时又到点 → 跳过
    repo.update(id, { next_run_at: Date.now() - 500 })
    sched.tick()
    await waitFor(() => cronRunRepo(db).listByTask(id).some((r) => r.status === 'skipped'))
    expect(started).toBe(1)
    release()
  })

  it('并发上限：同刻多个任务排队串行执行', async () => {
    const ids = [seedAgentTask('0 8 * * *', { name: 'A' }), seedAgentTask('0 8 * * *', { name: 'B' }), seedAgentTask('0 8 * * *', { name: 'C' })]
    const repo = cronTaskRepo(db)
    for (const id of ids) repo.update(id, { next_run_at: Date.now() - 1000 })
    let peak = 0
    let live = 0
    const sched = new CronScheduler({
      db,
      runTask: async () => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 30))
        live -= 1
      },
    })
    sched.maxConcurrent = 2
    sched.tick()
    await waitFor(() => cronRunRepo(db).listByTask(ids[2]).length > 0 && ids.every((id) => cronRunRepo(db).lastStatusMap()[id]?.status === 'ok'), 5000)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('目标被删 → 任务自动停用并记 failed 原因', async () => {
    const a = agentRepo(db).create({ name: '临时助手' })
    const t = cronTaskRepo(db).create({ name: '会失效的任务', target_type: 'agent', target_id: a.id, cron_expr: '0 8 * * *', prompt: 'x', next_run_at: Date.now() - 1000 })
    agentRepo(db).softDelete(a.id)
    const sched = new CronScheduler({ db, runTask: async () => { throw new Error('不应执行') } })
    sched.runNow(t.id)
    await waitFor(() => cronTaskRepo(db).get(t.id)!.enabled === 0)
    const run = cronRunRepo(db).listByTask(t.id)[0]
    expect(run.status).toBe('failed')
    expect(run.error).toContain('已被删除')
  })

  it('群目标未设群主时不执行（直接失败）', async () => {
    const p = projectRepo(db).create({ title: '护士站', leader_agent_id: null })
    const t = cronTaskRepo(db).create({ name: '晨间问询', target_type: 'project', target_id: p.id, cron_expr: '0 8 * * *', prompt: '今天病区动态？' })
    const sched = new CronScheduler({ db, runTask: async () => { throw new Error('不应执行') } })
    sched.runNow(t.id)
    await waitFor(() => cronRunRepo(db).listByTask(t.id)[0]?.status === 'failed')
    expect(cronRunRepo(db).listByTask(t.id)[0].error).toContain('未设置群主')
  })

  it('runNow 对执行中的任务拒绝重复触发', async () => {
    const id = seedAgentTask()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const sched = new CronScheduler({ db, runTask: async () => void (await gate) })
    sched.runNow(id)
    expect(() => sched.runNow(id)).toThrow(/正在执行/)
    release()
  })
})

describe('PluginManager', () => {
  const writePlugin = (id: string, manifest: unknown, extraFiles: Record<string, string> = {}) => {
    const dir = path.join(tmp, 'plugins', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2))
    for (const [rel, content] of Object.entries(extraFiles)) {
      const f = path.join(dir, rel)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, content)
    }
    return dir
  }
  const mgr = () => new PluginManager(db, path.join(tmp, 'plugins'))

  it('读取清单：合法插件被列出且默认未启用', () => {
    writePlugin('zhbf-night', {
      id: 'zhbf-night',
      name: '智慧病房',
      version: '1.0.0',
      icon: '🏥',
      description: '病区动态与检验异常',
      homepage: 'http://localhost:5173/dashboard',
      commands: [{ name: '/zhbf', prompt: '查病区概况', description: '病区总览' }],
      mcp: { url: 'http://127.0.0.1:8080/mcp', headers: { 'X-Agent-Token': '${SECRET}' }, tools: ['ward_overview'] },
    })
    const list = mgr().list()
    expect(list.length).toBe(1)
    expect(list[0]).toMatchObject({ id: 'zhbf-night', name: '智慧病房', enabled: false })
    expect(list[0].error).toBeUndefined()
    expect(list[0].commands[0].name).toBe('/zhbf')
    expect(list[0].hasSecret).toBe(false)
  })

  it('坏清单带 error 列出而不是静默消失', () => {
    writePlugin('broken', '{ not json')
    writePlugin('bad-id', { id: '../escape', name: 'x' })
    const list = mgr().list()
    const broken = list.find((p) => p.id === 'broken')
    expect(broken?.error).toMatch(/不是合法 JSON/)
    const escaped = list.find((p) => p.id === 'bad-id')
    expect(escaped?.error).toMatch(/id 非法/)
  })

  it('启用插件 → MCP 以 plugin- 前缀注入；停用后摘除；用户手配的 server 不受影响', () => {
    writePlugin('zhbf-night', { id: 'zhbf-night', name: '智慧病房', mcp: { url: 'http://127.0.0.1:8080/mcp', headers: { 'X-Agent-Token': '${SECRET}' } } })
    db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run('settings:mcp', JSON.stringify({ mine: { type: 'remote', enabled: true, url: 'http://x/mcp' } }), Date.now())
    const m = mgr()
    m.saveSecret('zhbf-night', 'tok-123')
    m.setEnabled('zhbf-night', true)
    let mcp = JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get('settings:mcp')!.value as string) as Record<string, { url?: string; headers?: Record<string, string> }>
    expect(Object.keys(mcp).sort()).toEqual(['mine', 'plugin-zhbf-night'])
    expect(mcp['plugin-zhbf-night'].url).toBe('http://127.0.0.1:8080/mcp')
    // ${SECRET} 被替换成本机保存的密钥
    expect(mcp['plugin-zhbf-night'].headers!['X-Agent-Token']).toBe('tok-123')

    m.setEnabled('zhbf-night', false)
    mcp = JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get('settings:mcp')!.value as string)
    expect(Object.keys(mcp)).toEqual(['mine'])
  })

  it('commands 只来自已启用插件', () => {
    writePlugin('a', { id: 'a', name: 'A 插件', commands: [{ name: '/a', prompt: 'p' }] })
    writePlugin('b', { id: 'b', name: 'B 插件', commands: [{ name: '/b', prompt: 'p' }] })
    const m = mgr()
    m.setEnabled('a', true)
    const cmds = m.commands()
    expect(cmds.map((c) => c.name)).toEqual(['/a'])
    expect(cmds[0].pluginName).toBe('A 插件')
  })

  it('删除插件：目录、启用状态与密钥一并清理', () => {
    writePlugin('gone', { id: 'gone', name: '待删' })
    const m = mgr()
    m.saveSecret('gone', 's')
    m.setEnabled('gone', true)
    m.delete('gone')
    expect(m.list().length).toBe(0)
    expect(fs.existsSync(path.join(tmp, 'plugins', 'gone'))).toBe(false)
  })

  it('导入插件：校验后落盘；无 plugin.json 的目录被拒绝', () => {
    const src = path.join(tmp, 'incoming', 'my-plugin')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'plugin.json'), JSON.stringify({ id: 'my-plugin', name: '导入的插件' }))
    const m = mgr()
    const info = m.import(src)
    expect(info.name).toBe('导入的插件')
    expect(fs.existsSync(path.join(tmp, 'plugins', 'my-plugin', 'plugin.json'))).toBe(true)

    const empty = path.join(tmp, 'incoming', 'empty')
    fs.mkdirSync(empty, { recursive: true })
    expect(() => m.import(empty)).toThrow(/没有 plugin.json/)
  })

  it('校验：homepage 与 mcp.url 必须是 http(s)，指令名必须以 / 开头', () => {
    writePlugin('h', { id: 'h', name: 'h', homepage: 'file:///etc/passwd' })
    writePlugin('c', { id: 'c', name: 'c', commands: [{ name: 'no-slash', prompt: 'p' }] })
    writePlugin('m', { id: 'm', name: 'm', mcp: { url: 'ftp://x' } })
    writePlugin('n', { id: 'n', name: 'n', mcp: { url: 'http://ok/mcp', command: [] } })
    const list = mgr().list()
    const byId = Object.fromEntries(list.map((p) => [p.id, p]))
    expect(byId['h'].error).toMatch(/homepage/)
    expect(byId['c'].error).toMatch(/必须以 \/ 开头/)
    expect(byId['m'].error).toMatch(/mcp.url/)
    expect(byId['n'].error).toBeUndefined()
  })
})
