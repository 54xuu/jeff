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
import { ToolBridge } from '../src/tools/bridge.js'
import { PLUGIN_TOOL_NAMES, registerPluginTools } from '../src/tools/pluginTools.js'
import { registerCronTools } from '../src/tools/cronTools.js'
import { XIAOJIE_DISABLED_TOOLS, XIAOJIE_ONLY_TOOLS, renderAgentMd } from '../src/agents/registry.js'
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
    // 调度/执行是本机状态，不是「定义被改」：updated_at 是同步的 LWW 版本号，这些写入一律不许推它，
    // 否则「跑了一次任务」或「同步落地一次」就会顶掉另一台机器上真实的编辑
    const version = repo.get(id)!.updated_at
    repo.setNextRun(id, 789)
    repo.markRun(id, 1000, 2000)
    repo.setLastRun(id, 3000)
    expect(repo.get(id)!.updated_at).toBe(version)
    // 改定义才推进版本号（先把版本钉到一个确定的过去值，避免依赖毫秒级时间差）
    db.prepare('UPDATE cron_task SET updated_at = 1 WHERE id = ?').run(id)
    repo.update(id, { name: '改了定义' })
    expect(repo.get(id)!.updated_at).toBeGreaterThan(1)
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

/** 手工往插件目录丢一个清单（模拟用户放置插件） */
function writePlugin(id: string, manifest: unknown, extraFiles: Record<string, string> = {}): string {
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

const mgr = (): PluginManager => new PluginManager(db, path.join(tmp, 'plugins'))

describe('PluginManager', () => {
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

  it('同名指令跨插件全局唯一：后装者标 error；write 直接拒绝', () => {
    writePlugin('first', { id: 'first', name: '甲插件', commands: [{ name: '/foo', prompt: 'p1' }] })
    writePlugin('second', { id: 'second', name: '乙插件', commands: [{ name: '/foo', prompt: 'p2' }] })
    const list = mgr().list()
    expect(list.find((p) => p.id === 'first')?.error).toBeUndefined()
    expect(list.find((p) => p.id === 'second')?.error).toMatch(/已被插件「甲插件」占用/)

    const m = mgr()
    expect(() =>
      m.write({ id: 'third', name: '丙', commands: [{ name: '/foo', prompt: 'p3' }] }),
    ).toThrow(/已被插件/)
  })

  it('每插件最多一条指令；指令名须英文或拼音', () => {
    writePlugin('two-cmds', {
      id: 'two-cmds',
      name: '两条',
      commands: [
        { name: '/a', prompt: 'p1' },
        { name: '/b', prompt: 'p2' },
      ],
    })
    expect(mgr().list().find((p) => p.id === 'two-cmds')?.error).toMatch(/只能有一条快捷指令/)

    writePlugin('zh-cmd', {
      id: 'zh-cmd',
      name: '中文指令',
      commands: [{ name: '/入院', prompt: '查入院' }],
    })
    expect(mgr().list().find((p) => p.id === 'zh-cmd')?.error).toMatch(/英文或拼音/)

    writePlugin('ok-cmd', {
      id: 'ok-cmd',
      name: '合法',
      commands: [{ name: '/zhbf', prompt: '查看板' }],
    })
    expect(mgr().list().find((p) => p.id === 'ok-cmd')?.error).toBeUndefined()
  })

  it('icon.svg 挂到 PluginInfo.iconSvg', () => {
    writePlugin('svg-icon', { id: 'svg-icon', name: '带图标', commands: [{ name: '/svg', prompt: 'p' }] })
    fs.writeFileSync(
      path.join(tmp, 'plugins', 'svg-icon', 'icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#10B981"/></svg>',
    )
    const p = mgr().get('svg-icon')
    expect(p?.iconSvg).toContain('<svg')
  })

  it('setHomepage 写回 plugin.json；非法协议拒绝', () => {
    writePlugin('home', { id: 'home', name: '首页', homepage: 'http://old.example/' })
    const m = mgr()
    const after = m.setHomepage('home', 'https://new.example/dash')
    expect(after.homepage).toBe('https://new.example/dash')
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'plugins', 'home', 'plugin.json'), 'utf8'))
    expect(raw.homepage).toBe('https://new.example/dash')
    m.setHomepage('home', '')
    expect(m.get('home')!.homepage).toBeFalsy()
    expect(() => m.setHomepage('home', 'file:///etc/passwd')).toThrow(/http\/https/)
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

  it('write()：小杰对话式落盘插件（含附带文件），默认不启用', () => {
    const m = mgr()
    const info = m.write({
      id: 'news-daily',
      name: 'AI 资讯',
      description: '每天抓 AI 资讯',
      homepage: 'http://localhost:3000',
      commands: [{ name: '/news', prompt: '今天的 AI 资讯' }],
      mcp: { url: 'http://127.0.0.1:9000/mcp' },
      files: { 'README.md': '# AI 资讯\n用法…', 'docs/usage.md': '细则' },
    })
    expect(info.id).toBe('news-daily')
    expect(info.enabled).toBe(false)
    expect(fs.readFileSync(path.join(tmp, 'plugins', 'news-daily', 'README.md'), 'utf8')).toContain('AI 资讯')
    expect(fs.readFileSync(path.join(tmp, 'plugins', 'news-daily', 'docs', 'usage.md'), 'utf8')).toBe('细则')
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'plugins', 'news-daily', 'plugin.json'), 'utf8'))
    expect(raw.mcp.url).toBe('http://127.0.0.1:9000/mcp')
  })

  it('write()：校验失败不留残骸，已有插件原清单被还原', () => {
    const m = mgr()
    m.write({ id: 'keep', name: '原先生效的', description: '原始简介', mcp: { url: 'http://ok/mcp' } })
    const before = fs.readFileSync(path.join(tmp, 'plugins', 'keep', 'plugin.json'), 'utf8')
    // homepage 非法 → 整次写入回滚
    expect(() => m.write({ id: 'keep', name: '改坏的', homepage: 'file:///etc/passwd' })).toThrow(/homepage/)
    expect(fs.readFileSync(path.join(tmp, 'plugins', 'keep', 'plugin.json'), 'utf8')).toBe(before)
    expect(m.get('keep')!.description).toBe('原始简介')
    // 全新插件校验失败 → 目录被清掉（不留下半个坏插件）
    expect(() => m.write({ id: 'brand-new', name: 'x', homepage: 'file:///tmp' })).toThrow()
    expect(fs.existsSync(path.join(tmp, 'plugins', 'brand-new'))).toBe(false)
    expect(m.list().length).toBe(1)
  })

  it('write()：files 的路径不能逃出插件目录', () => {
    const m = mgr()
    expect(() => m.write({ id: 'esc', name: '逃逸', files: { '../evil.txt': 'x' } })).toThrow(/必须位于插件目录内/)
    expect(fs.existsSync(path.join(tmp, 'plugins', 'evil.txt'))).toBe(false)
  })

  it('read()：返回原始清单文本与文件清单', () => {
    const m = mgr()
    m.write({ id: 'r1', name: '读我', files: { 'a.md': 'A', 'sub/b.md': 'B' } })
    const r = m.read('r1')
    expect(JSON.parse(r.manifest).name).toBe('读我')
    expect(r.files).toEqual(['a.md', 'plugin.json', 'sub/b.md'])
    expect(() => m.read('nope')).toThrow(/不存在/)
    expect(() => m.read('../etc')).toThrow(/id 非法/)
  })

  it('write() 保留已启用状态与密钥（改清单不掉开关）', () => {
    const m = mgr()
    m.write({ id: 'on', name: '已启用', mcp: { url: 'http://ok/mcp' } })
    m.saveSecret('on', 'tok')
    m.setEnabled('on', true)
    const after = m.write({ id: 'on', name: '改了名字', description: '新简介' })
    expect(after.enabled).toBe(true)
    expect(after.hasSecret).toBe(true)
    expect(after.name).toBe('改了名字')
  })
})

describe('cron tools（小杰代操定时任务）', () => {
  const tools = () => {
    const bridge = new ToolBridge()
    let changed = 0
    registerCronTools(bridge, { db, onChanged: () => (changed += 1) })
    const call = async (name: string, args: unknown) => {
      const h = (bridge as unknown as { handlers: Map<string, (a: unknown) => Promise<unknown>> }).handlers.get(name)
      if (!h) throw new Error(`未注册的工具：${name}`)
      return h(args)
    }
    return { call, changed: () => changed }
  }

  it('create：合法参数落库，非法表达式/空 prompt 被拒', async () => {
    const { call, changed } = tools()
    const a = agentRepo(db).create({ name: '资讯助手' })
    const created = (await call('jeff_cron_create', {
      name: '科技早报',
      target_type: 'agent',
      target_id: a.id,
      cron_expr: '30 9 * * *',
      prompt: '请汇报一条科技动态',
      miss_policy: 'skip',
    })) as { id: string; schedule: string; next_run_at: number }
    expect(created.schedule).toContain('09:30')
    expect(created.next_run_at).toBeGreaterThan(Date.now())
    const row = cronTaskRepo(db).get(created.id)!
    expect(row).toMatchObject({ miss_policy: 'skip', enabled: 1, target_id: a.id })
    await expect(call('jeff_cron_create', { name: 'x', target_type: 'agent', target_id: a.id, cron_expr: '99 9 * * *', prompt: 'p' })).rejects.toThrow(/cron 表达式非法/)
    await expect(call('jeff_cron_create', { name: 'x', target_type: 'agent', target_id: a.id, cron_expr: '0 9 * * *', prompt: '  ' })).rejects.toThrow(/prompt 不能为空/)
    await expect(call('jeff_cron_create', { name: 'x', target_type: 'agent', target_id: '不存在', cron_expr: '0 9 * * *', prompt: 'p' })).rejects.toThrow(/智能体不存在/)
    expect(changed()).toBe(1)
  })

  it('update：空串/空值一律当作没传，不能停用任务、不能改错过策略、不能抹掉名字与提示词', async () => {
    const id = seedAgentTask('0 8 * * *', { miss_policy: 'skip' })
    const { call } = tools()
    // 真模型「只改时间」时的典型形状：其余字段补空
    await call('jeff_cron_update', { id, cron_expr: '0 10 * * *', name: '', prompt: '', miss_policy: '', enabled: '' })
    const row = cronTaskRepo(db).get(id)!
    expect(row.cron_expr).toBe('0 10 * * *')
    expect(row.name).toBe('AI 资讯早报') // 没被空串抹掉
    expect(row.prompt).toBe('请报最新 AI 资讯')
    expect(row.miss_policy).toBe('skip') // 没被空串改回 catchup
    expect(row.enabled).toBe(1) // 没被空串静默停用
  })

  it('update：enabled 接受布尔与常见字符串写法；全空参数直接报错而不是静默什么都没做', async () => {
    const id = seedAgentTask()
    const { call } = tools()
    const off = (await call('jeff_cron_update', { id, enabled: 'false' })) as { enabled: boolean; changed: string[] }
    expect(off.enabled).toBe(false)
    expect(off.changed).toEqual(['enabled'])
    expect(cronTaskRepo(db).get(id)!.enabled).toBe(0)
    const on = (await call('jeff_cron_update', { id, enabled: true })) as { enabled: boolean }
    expect(on.enabled).toBe(true)
    await expect(call('jeff_cron_update', { id, name: '', prompt: '' })).rejects.toThrow(/没有要修改的字段/)
    // 不存在的 id 不能悄悄造出新任务
    await expect(call('jeff_cron_update', { id: 'cron_nope', name: 'x' })).rejects.toThrow(/定时任务不存在/)
  })
})

describe('plugin tools（小杰对话式开发插件）', () => {
  const tools = () => {
    const bridge = new ToolBridge()
    const plugins = new PluginManager(db, path.join(tmp, 'plugins'))
    let changed = 0
    registerPluginTools(bridge, { db, plugins, onChanged: () => (changed += 1) })
    const call = async (name: string, args: unknown) => {
      // ToolBridge 的 handler 存在私有 map 里，用 HTTP 太重；这里直接走 register 的同一个入口
      const h = (bridge as unknown as { handlers: Map<string, (a: unknown) => Promise<unknown>> }).handlers.get(name)
      if (!h) throw new Error(`未注册的工具：${name}`)
      return h(args)
    }
    return { call, plugins, changed: () => changed }
  }

  it('create 写出插件但不启用，并给出下一步提示；update 保留未传字段', async () => {
    const { call } = tools()
    const created = (await call('jeff_plugin_create', {
      id: 'zhbf',
      name: '智慧病房',
      description: '病区动态',
      homepage: 'http://localhost:5173',
      command: '/zhbf',
      command_prompt: '查病区概况',
      mcp_url: 'http://127.0.0.1:8080/mcp',
      mcp_headers: '{"X-Agent-Token":"${SECRET}"}',
    })) as { enabled: boolean; next: string; mcp: { kind: string; target: string } }
    expect(created.enabled).toBe(false)
    expect(created.mcp).toEqual({ kind: 'remote', target: 'http://127.0.0.1:8080/mcp' })
    expect(created.next).toContain('jeff_plugin_enable')

    const updated = (await call('jeff_plugin_update', { id: 'zhbf', description: '新简介' })) as { name: string }
    expect(updated.name).toBe('智慧病房')
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'plugins', 'zhbf', 'plugin.json'), 'utf8'))
    expect(raw.description).toBe('新简介')
    expect(raw.commands).toEqual([{ name: '/zhbf', prompt: '查病区概况' }])
    expect(raw.mcp.headers).toEqual({ 'X-Agent-Token': '${SECRET}' })
  })

  it('create：mcp_url / mcp_command 平铺参数与 files 数组（真模型实测的形状）', async () => {
    const { call } = tools()
    const remote = (await call('jeff_plugin_create', {
      id: 'flat-remote',
      name: '平铺远程',
      mcp_url: 'http://127.0.0.1:9000/mcp',
      mcp_tools: ['ward_overview'],
      files: [{ path: 'README.md', content: '# 说明' }],
    })) as { mcp: { kind: string }; files: string[] }
    expect(remote.mcp.kind).toBe('remote')
    expect(remote.files).toEqual(['README.md', 'plugin.json'])
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'plugins', 'flat-remote', 'plugin.json'), 'utf8'))
    expect(raw.mcp.tools).toEqual(['ward_overview'])

    const local = (await call('jeff_plugin_create', {
      id: 'flat-local',
      name: '平铺本地',
      mcp_command: 'npx -y @xxx/mcp-server',
      mcp_env: '{"API_KEY":"k"}',
    })) as { mcp: { kind: string; target: string }; next: string }
    expect(local.mcp).toEqual({ kind: 'local', target: 'npx -y @xxx/mcp-server' })
    expect(local.next).toContain('「插件」页')
  })

  it('空串 / 空数组一律当作「没传」，不能抹掉已有配置（真模型会补默认空值）', async () => {
    const { call } = tools()
    await call('jeff_plugin_create', {
      id: 'keep2',
      name: '原名',
      icon: '🏥',
      description: '原简介',
      homepage: 'http://localhost:5173',
      command: '/k',
      command_prompt: 'p',
      mcp_url: 'http://ok/mcp',
    })
    // 模型典型的「全字段补空」调用
    await call('jeff_plugin_update', {
      id: 'keep2',
      name: '',
      version: '',
      icon: '',
      description: '',
      homepage: '',
      command: '',
      command_prompt: '',
      commands: [],
      mcp_url: '',
      mcp_command: '',
      mcp: '',
      files: '',
    })
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'plugins', 'keep2', 'plugin.json'), 'utf8'))
    expect(raw).toMatchObject({ name: '原名', icon: '🏥', description: '原简介', homepage: 'http://localhost:5173' })
    expect(raw.commands).toEqual([{ name: '/k', prompt: 'p' }])
    expect(raw.mcp.url).toBe('http://ok/mcp')
  })

  it('兼容老形状：mcp 整体传对象或 JSON 文本；指令名缺 / 自动补前缀', async () => {
    const { call } = tools()
    await call('jeff_plugin_create', { id: 'compat', name: '兼容', mcp: { url: 'http://ok/mcp' }, commands: [{ name: 'x', prompt: 'p' }] })
    let raw = JSON.parse(fs.readFileSync(path.join(tmp, 'plugins', 'compat', 'plugin.json'), 'utf8'))
    expect(raw.mcp.url).toBe('http://ok/mcp')
    expect(raw.commands).toEqual([{ name: '/x', prompt: 'p' }])

    await call('jeff_plugin_update', { id: 'compat', mcp: '{"url":"http://other/mcp"}' })
    raw = JSON.parse(fs.readFileSync(path.join(tmp, 'plugins', 'compat', 'plugin.json'), 'utf8'))
    expect(raw.mcp.url).toBe('http://other/mcp')
  })

  it('update 一个不存在的插件直接失败（防手滑造新插件）', async () => {
    const { call } = tools()
    await expect(call('jeff_plugin_update', { id: 'ghost', name: 'x' })).rejects.toThrow(/不存在/)
    // create 缺 name 也拒绝
    await expect(call('jeff_plugin_create', { id: 'noname' })).rejects.toThrow(/name 不能为空/)
  })

  it('enable 拒绝带本地命令的插件（必须由人点开关）', async () => {
    const { call } = tools()
    await call('jeff_plugin_create', {
      id: 'local-mcp',
      name: '本地命令插件',
      mcp_command: 'npx -y some-mcp',
      mcp_env: '{"K":"v"}',
    })
    await expect(call('jeff_plugin_enable', { id: 'local-mcp' })).rejects.toThrow(/不能由我开启/)
    // remote 插件可以启用/停用
    await call('jeff_plugin_create', { id: 'remote-mcp', name: '远程插件', mcp_url: 'http://ok/mcp' })
    const on = (await call('jeff_plugin_enable', { id: 'remote-mcp' })) as { enabled: boolean }
    expect(on.enabled).toBe(true)
    const off = (await call('jeff_plugin_enable', { id: 'remote-mcp', enabled: false })) as { enabled: boolean }
    expect(off.enabled).toBe(false)
  })

  it('read 返回清单与文件；delete 清目录；变更都会通知 UI', async () => {
    const { call, plugins, changed } = tools()
    await call('jeff_plugin_create', { id: 'p1', name: 'P1', files: [{ path: 'note.md', content: 'hi' }] })
    const read = (await call('jeff_plugin_read', { id: 'p1' })) as { manifest: string; files: string[]; enabled: boolean }
    expect(JSON.parse(read.manifest).name).toBe('P1')
    expect(read.files).toContain('note.md')
    await call('jeff_plugin_delete', { id: 'p1' })
    expect(plugins.list().length).toBe(0)
    await expect(call('jeff_plugin_delete', { id: 'p1' })).rejects.toThrow(/不存在/)
    // create + read(不通知) + delete → 至少 create 与 delete 各通知一次
    expect(changed()).toBeGreaterThanOrEqual(2)
  })

  it('without_mcp 明确表达「纯指令插件」', async () => {
    const { call } = tools()
    const r = (await call('jeff_plugin_create', {
      id: 'cmd-only',
      name: '纯指令',
      command: '/hello',
      command_prompt: '你好',
      without_mcp: true,
    })) as { mcp: unknown; next: string }
    expect(r.mcp).toBeNull()
    expect(r.next).toContain('jeff_plugin_enable')
  })

  it('files 的路径不能逃出插件目录（tools 层同样拦）', async () => {
    const { call } = tools()
    await expect(call('jeff_plugin_create', { id: 'esc2', name: '逃逸', files: [{ path: '../evil.txt', content: 'x' }] })).rejects.toThrow(/必须位于插件目录内/)
    expect(fs.existsSync(path.join(tmp, 'plugins', 'evil.txt'))).toBe(false)
  })
})

describe('XIAOJIE 工具隔离', () => {
  it('非内置 agent 的 md 里禁用全部小杰专属工具；内置小杰不受限但禁掉文件/命令工具', () => {
    const a = agentRepo(db).create({ name: '项目开发' })
    const md = renderAgentMd(agentRepo(db).get(a.id)!)
    for (const t of XIAOJIE_ONLY_TOOLS) expect(md).toContain(`${t}: false`)
    expect(md).toContain('jeff_plugin_create: false')
    expect(md).toContain('jeff_cron_create: false')

    const x = agentRepo(db).create({ name: '小杰', builtin: 1 })
    const xmd = renderAgentMd(agentRepo(db).get(x.id)!)
    expect(xmd).not.toContain('jeff_plugin_create: false')
    expect(xmd).toContain('jeff_plugin_create')
    // 小杰自己不能用文件/命令工具（指令里也这么说）
    for (const t of XIAOJIE_DISABLED_TOOLS) expect(xmd).toContain(`${t}: false`)
    expect(xmd).toContain('edit: false')
    // task 也必须禁：子代理带全套工具，不禁就等于把 bash/edit/write 全绕过去（live14 R6 实测）
    expect(XIAOJIE_DISABLED_TOOLS).toContain('task')
    expect(xmd).toContain('task: false')
  })
})

describe('PluginManager 校验', () => {
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
