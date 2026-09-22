import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMockWebdav } from './helpers/mock-webdav.mjs'
import { openDb } from '../src/db/db.js'
import { buildPaths, ensureDirs, type JeffPaths } from '../src/paths.js'
import { cronRunRepo, cronTaskRepo } from '../src/db/repos.js'
import { MemoryStore } from '../src/memory/store.js'
import { SyncEngine } from '../src/sync/engine.js'
import type { Server } from 'node:http'
import type { DB } from '../src/db/db.js'

/**
 * 定时任务与 WebDAV 同步：定义随「立即同步」双向合并（LWW + 墓碑），没有独立的备份/恢复入口。
 * 判定标准见仓库 AGENTS.md「备份与恢复入口」：纯配置数据（一条记录几行 JSON）不适用 skills / plugins 那套整目录镜像。
 * 覆盖点：定义搬运、enabled / 错过策略照搬、next_run_at 按本机重算、运行历史不参与、LWW、软删除传播。
 */
const PORT = 19031
let server: Server
let davRoot: string

interface Side {
  home: string
  db: DB
  engine: SyncEngine
  paths: JeffPaths
}

function makeSide(tag: string, remote: string): Side {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `jeff-cronsync-${tag}-`))
  const paths = buildPaths(home)
  ensureDirs(paths)
  const db = openDb(paths)
  const memory = new MemoryStore(paths)
  const engine = new SyncEngine(db, paths, memory, () => ({
    url: `http://127.0.0.1:${PORT}`,
    username: 'u',
    password: 'p',
    basePath: `/dav/${remote}`,
    autoSync: false,
  }))
  return { home, db, engine, paths }
}

beforeAll(async () => {
  davRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-cronsync-dav-'))
  server = await startMockWebdav(PORT, davRoot)
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(davRoot, { recursive: true, force: true })
})

describe('定时任务随整库同步', () => {
  it('A 建任务 → B 同步拿到定义：enabled / 错过策略照搬，next_run_at 按本机重算', async () => {
    const a = makeSide('a', 'cron1')
    const b = makeSide('b', 'cron1')
    const t = cronTaskRepo(a.db).create({
      name: '晨间病区动态',
      target_type: 'project',
      target_id: 'prj_missing', // 目标在 b 上不存在也没关系：定义照搬，调度器到点会自行判定失效
      cron_expr: '30 8 * * 1-5',
      prompt: '请点名让责任护士汇报今天的病区动态',
      miss_policy: 'skip',
      next_run_at: Date.now() - 60_000,
    })
    cronTaskRepo(a.db).update(t.id, { enabled: 0 })

    const ra = await a.engine.sync()
    expect(ra.ok).toBe(true)
    // 定义落在整库同步的 cron_tasks.json 里（这正是独立备份没有存在价值的证据）
    expect(fs.existsSync(path.join(davRoot, 'dav/cron1/cron_tasks.json'))).toBe(true)

    expect(cronTaskRepo(b.db).list().length).toBe(0)
    const rb = await b.engine.sync()
    expect(rb.ok).toBe(true)
    expect(rb.downloaded).toBeGreaterThan(0)

    const landed = cronTaskRepo(b.db).get(t.id)
    expect(landed).toMatchObject({
      name: '晨间病区动态',
      target_type: 'project',
      cron_expr: '30 8 * * 1-5',
      prompt: '请点名让责任护士汇报今天的病区动态',
      miss_policy: 'skip',
      enabled: 0,
    })
    // next_run_at 按本机重算（不等于源端的过去时间）
    expect(landed!.next_run_at!).toBeGreaterThan(Date.now())

    fs.rmSync(a.home, { recursive: true, force: true })
    fs.rmSync(b.home, { recursive: true, force: true })
  })

  it('一次性任务同步后仍停在绝对时刻，过点不会被重算成明年', async () => {
    const a = makeSide('a', 'cron-once')
    const b = makeSide('b', 'cron-once')
    const past = new Date(2020, 0, 2, 12, 0, 0, 0).getTime()
    const t = cronTaskRepo(a.db).create({
      name: '只跑一次的午间提醒',
      target_type: 'agent',
      target_id: 'agt_x',
      cron_expr: '0 12 2 1 *',
      run_at: past,
      prompt: '该吃饭了',
      next_run_at: past,
    })
    const ra = await a.engine.sync()
    expect(ra.ok).toBe(true)
    const rb = await b.engine.sync()
    expect(rb.ok).toBe(true)
    const landed = cronTaskRepo(b.db).get(t.id)
    expect(landed?.run_at).toBe(past)
    expect(landed?.next_run_at).toBeNull()
    fs.rmSync(a.home, { recursive: true, force: true })
    fs.rmSync(b.home, { recursive: true, force: true })
  })

  it('运行历史（cron_run）属本机日志：任务搬过去，历史不搬', async () => {
    const a = makeSide('a', 'cron2')
    const b = makeSide('b', 'cron2')
    const t = cronTaskRepo(a.db).create({ name: '夜间巡检', target_type: 'agent', target_id: 'agt_x', cron_expr: '0 2 * * *', prompt: 'p' })
    const run = cronRunRepo(a.db).start(t.id)
    cronRunRepo(a.db).finish(run.id, 'failed', '引擎超时')
    cronRunRepo(a.db).log(t.id, 'skipped', '上一轮仍在跑')

    await a.engine.sync()
    await b.engine.sync()

    expect(cronTaskRepo(b.db).get(t.id)).toBeTruthy()
    expect(cronRunRepo(b.db).listByTask(t.id)).toHaveLength(0)

    fs.rmSync(a.home, { recursive: true, force: true })
    fs.rmSync(b.home, { recursive: true, force: true })
  })

  it('LWW：本地改过的排期不被远端旧记录覆盖，且新版本反向回流', async () => {
    const a = makeSide('a', 'cron3')
    const b = makeSide('b', 'cron3')
    const t = cronTaskRepo(a.db).create({ name: '旧名字', target_type: 'agent', target_id: 'agt_x', cron_expr: '0 8 * * *', prompt: 'p' })
    await a.engine.sync()
    await b.engine.sync()

    // 同步落地只重算 next_run_at，不能把「接收」算成「改过定义」：
    // 否则本机版本号每次同步都前推，另一台机器上更早的真实编辑会被 LWW 顶掉（曾经的真 bug）
    const versionAfterFirstSync = cronTaskRepo(a.db).get(t.id)!.updated_at
    await a.engine.sync()
    expect(cronTaskRepo(a.db).get(t.id)!.updated_at).toBe(versionAfterFirstSync)

    // b 改成更新的版本；a 那边还是旧版本
    cronTaskRepo(b.db).update(t.id, { name: '本地改过的新名字' })
    const bUpdated = cronTaskRepo(b.db).get(t.id)!.updated_at
    expect(bUpdated).toBeGreaterThan(cronTaskRepo(a.db).get(t.id)!.updated_at)

    await a.engine.sync() // a 推的还是旧版本
    await b.engine.sync() // b 合并远端旧版本：本地较新 → 不被覆盖，且版本号不被同步推走
    expect(cronTaskRepo(b.db).get(t.id)!.name).toBe('本地改过的新名字')
    expect(cronTaskRepo(b.db).get(t.id)!.updated_at).toBe(bUpdated)

    await a.engine.sync() // 反向：a 取到 b 的新版本
    expect(cronTaskRepo(a.db).get(t.id)!.name).toBe('本地改过的新名字')
    expect(cronTaskRepo(a.db).get(t.id)!.updated_at).toBe(bUpdated)

    fs.rmSync(a.home, { recursive: true, force: true })
    fs.rmSync(b.home, { recursive: true, force: true })
  })

  it('软删除随同步传播：一台删了，另一台同步后也没了（墓碑留在库里）', async () => {
    const a = makeSide('a', 'cron4')
    const b = makeSide('b', 'cron4')
    const t = cronTaskRepo(a.db).create({ name: '待删任务', target_type: 'agent', target_id: 'agt_x', cron_expr: '0 8 * * *', prompt: 'p' })
    await a.engine.sync()
    await b.engine.sync()
    expect(cronTaskRepo(b.db).list().length).toBe(1)

    cronTaskRepo(a.db).softDelete(t.id)
    await a.engine.sync()
    await b.engine.sync()
    expect(cronTaskRepo(b.db).list().length).toBe(0)
    expect(cronTaskRepo(b.db).list(true).length).toBe(1)

    fs.rmSync(a.home, { recursive: true, force: true })
    fs.rmSync(b.home, { recursive: true, force: true })
  })

  it('表达式非法的任务也能同步过去（next_run_at 留空，不阻断整轮同步）', async () => {
    const a = makeSide('a', 'cron5')
    const b = makeSide('b', 'cron5')
    const t = cronTaskRepo(a.db).create({ name: '坏表达式', target_type: 'agent', target_id: 'agt_x', cron_expr: '不是表达式', prompt: 'p' })

    const ra = await a.engine.sync()
    expect(ra.ok).toBe(true)
    const rb = await b.engine.sync()
    expect(rb.ok).toBe(true)

    const landed = cronTaskRepo(b.db).get(t.id)
    expect(landed?.name).toBe('坏表达式')
    expect(landed!.next_run_at).toBeNull()

    fs.rmSync(a.home, { recursive: true, force: true })
    fs.rmSync(b.home, { recursive: true, force: true })
  })
})
