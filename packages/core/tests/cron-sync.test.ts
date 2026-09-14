import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMockWebdav } from './helpers/mock-webdav.mjs'
import { openDb } from '../src/db/db.js'
import { buildPaths, ensureDirs, type JeffPaths } from '../src/paths.js'
import { cronTaskRepo } from '../src/db/repos.js'
import { MemoryStore } from '../src/memory/store.js'
import { SyncEngine } from '../src/sync/engine.js'
import type { Server } from 'node:http'
import type { DB } from '../src/db/db.js'

/**
 * 定时任务的备份/恢复（设置 → 同步 里的显式入口）。
 * 与整库同步的区别：只动 cron_task，不碰其它实体；next_run_at 一律按本机时间重算。
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

describe('定时任务备份 / 恢复', () => {
  it('备份 → 另一台设备恢复：任务定义完整搬运，且只动定时任务', async () => {
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

    const bk = await a.engine.backupCronTasks()
    expect(bk.ok).toBe(true)
    expect(bk.count).toBe(1)
    expect(a.engine.lastCronBackup()?.count).toBe(1)

    expect(cronTaskRepo(b.db).list().length).toBe(0)
    const rs = await b.engine.restoreCronTasks()
    expect(rs.ok).toBe(true)
    expect(rs.applied).toBe(1)

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

    // 只动定时任务：b 上的其它实体不受影响（这里用「b 的 agent 表仍为空」验证没有误写）
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM agent').get()).toMatchObject({ n: 0 })

    fs.rmSync(a.home, { recursive: true, force: true })
    fs.rmSync(b.home, { recursive: true, force: true })
  })

  it('本地更新过的排期不会被旧备份覆盖（按 updatedAt 取新）', async () => {
    const a = makeSide('a', 'cron2')
    const b = makeSide('b', 'cron2')
    const t = cronTaskRepo(a.db).create({ name: '旧名字', target_type: 'agent', target_id: 'agt_x', cron_expr: '0 8 * * *', prompt: 'p' })
    await a.engine.backupCronTasks()

    // b 恢复一次后改成本地更新的版本
    await b.engine.restoreCronTasks()
    cronTaskRepo(b.db).update(t.id, { name: '本地改过的新名字' })
    const bUpdated = cronTaskRepo(b.db).get(t.id)!.updated_at
    expect(bUpdated).toBeGreaterThan(cronTaskRepo(a.db).get(t.id)!.updated_at)

    // a 侧又推了一次备份，b 再恢复：本地较新 → 不被覆盖
    await a.engine.backupCronTasks()
    const rs = await b.engine.restoreCronTasks()
    expect(rs.ok).toBe(true)
    expect(cronTaskRepo(b.db).get(t.id)!.name).toBe('本地改过的新名字')

    fs.rmSync(a.home, { recursive: true, force: true })
    fs.rmSync(b.home, { recursive: true, force: true })
  })

  it('恢复：备份为空时给出可读错误，而不是静默成功', async () => {
    const a = makeSide('a', 'cron3')
    const rs = await a.engine.restoreCronTasks()
    expect(rs.ok).toBe(false)
    expect(rs.error).toContain('没有定时任务')
    fs.rmSync(a.home, { recursive: true, force: true })
  })

  it('备份包含软删除的任务（墓碑随行），恢复端据此识别删除', async () => {
    const a = makeSide('a', 'cron4')
    const b = makeSide('b', 'cron4')
    const t = cronTaskRepo(a.db).create({ name: '待删任务', target_type: 'agent', target_id: 'agt_x', cron_expr: '0 8 * * *', prompt: 'p' })
    await a.engine.backupCronTasks()
    await b.engine.restoreCronTasks()
    expect(cronTaskRepo(b.db).list().length).toBe(1)

    cronTaskRepo(a.db).softDelete(t.id)
    await a.engine.backupCronTasks()
    const rs = await b.engine.restoreCronTasks()
    expect(rs.ok).toBe(true)
    expect(rs.removed).toBe(1)
    expect(cronTaskRepo(b.db).list().length).toBe(0)
    expect(cronTaskRepo(b.db).list(true).length).toBe(1)

    fs.rmSync(a.home, { recursive: true, force: true })
    fs.rmSync(b.home, { recursive: true, force: true })
  })
})
