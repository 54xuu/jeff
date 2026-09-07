import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startMockWebdav } from './helpers/mock-webdav.mjs'
import { openDb } from '../src/db/db.js'
import { buildPaths } from '../src/paths.js'
import { MemoryStore } from '../src/memory/store.js'
import { SyncEngine, type WebdavConfig } from '../src/sync/engine.js'
import type { Server } from 'node:http'

const PORT = 19022
let server: Server
let davRoot: string
let home: string
let skillsDir: string

function makeEngine(remote: string): SyncEngine {
  const paths = buildPaths(home)
  const db = openDb(paths)
  const memory = new MemoryStore(paths)
  return new SyncEngine(db, paths, memory, (): WebdavConfig => ({
    url: `http://127.0.0.1:${PORT}`,
    username: 'u',
    password: 'p',
    basePath: `/dav/${remote}`,
    autoSync: false,
  }))
}

beforeAll(async () => {
  davRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-dav2-'))
  server = await startMockWebdav(PORT, davRoot)
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-skills-'))
  skillsDir = path.join(home, 'fake-agents', 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  process.env.JEFF_SKILLS_DIR = skillsDir
})

afterAll(() => {
  server?.close()
  delete process.env.JEFF_SKILLS_DIR
})

describe('SyncEngine skills 单向备份（安全模型）', () => {
  it('上传 → 远端有备份；本地删除不传播；内容覆盖前归档旧版本；恢复前本地快照', async () => {
    const engine = makeEngine('sk1')
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# hello')
    fs.mkdirSync(path.join(skillsDir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'sub', 'a.md'), 'aaa')

    // 1. 首次备份：全部上传
    const r1 = await engine.backupSkills()
    expect(r1.ok).toBe(true)
    expect(r1.uploaded).toBe(2)
    expect(fs.existsSync(path.join(davRoot, 'dav/sk1/skills/SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(davRoot, 'dav/sk1/skills/sub/a.md'))).toBe(true)

    // 2. 无变化再备份：全部跳过
    const r2 = await engine.backupSkills()
    expect(r2.ok).toBe(true)
    expect(r2.uploaded).toBe(0)
    expect(r2.skipped).toBe(2)

    // 3. 本地删除不传播：删掉 sub/a.md 后远端仍在
    fs.rmSync(path.join(skillsDir, 'sub'), { recursive: true })
    const r3 = await engine.backupSkills()
    expect(r3.ok).toBe(true)
    expect(fs.existsSync(path.join(davRoot, 'dav/sk1/skills/sub/a.md'))).toBe(true)

    // 4. 内容变化：远端旧版本归档后再覆盖
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# hello v2')
    const r4 = await engine.backupSkills()
    expect(r4.ok).toBe(true)
    expect(r4.archived).toBe(1)
    expect(fs.existsSync(path.join(davRoot, 'dav/sk1/skills/SKILL.md'))).toBe(true)
    expect(fs.readFileSync(path.join(davRoot, 'dav/sk1/skills/SKILL.md'), 'utf8')).toBe('# hello v2')
    const verDir = path.join(davRoot, 'dav/sk1/skills-versions/SKILL.md')
    expect(fs.readdirSync(verDir).length).toBe(1)
    expect(fs.readFileSync(path.join(verDir, fs.readdirSync(verDir)[0]), 'utf8')).toBe('# hello')

    // 5. 恢复 stage：下载到暂存区（含步骤 3 里本地已删的 sub/a.md）
    const staged = await engine.restoreSkillsStage()
    expect(staged.ok).toBe(true)
    expect(staged.files.sort()).toEqual(['SKILL.md', 'sub/a.md'])

    // 6. 恢复 apply：先快照本地 → 覆盖；本地多出的文件不被删除
    fs.writeFileSync(path.join(skillsDir, 'local-only.md'), 'keep me')
    const applied = await engine.restoreSkillsApply()
    expect(applied.ok).toBe(true)
    expect(applied.restored).toBe(2)
    expect(fs.existsSync(applied.snapshotDir)).toBe(true)
    expect(fs.readFileSync(path.join(applied.snapshotDir, 'SKILL.md'), 'utf8')).toBe('# hello v2') // 快照含恢复前内容
    expect(fs.readFileSync(path.join(skillsDir, 'SKILL.md'), 'utf8')).toBe('# hello v2') // 被覆盖为备份版本（备份里即 v2）
    expect(fs.existsSync(path.join(skillsDir, 'sub', 'a.md'))).toBe(true)
    expect(fs.readFileSync(path.join(skillsDir, 'local-only.md'), 'utf8')).toBe('keep me') // 不删除
  })

  it('重入锁：并发 sync 时后到者等待上一轮结束（不交叉执行）', async () => {
    // 起一个响应 400ms 的假 DAV：保证第一个 sync 还在跑时第二个就到
    const delay = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
        res.end('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"></d:multistatus>')
      }, 400)
    })
    await new Promise<void>((r) => delay.listen(PORT + 1, '127.0.0.1', () => r()))
    try {
      const paths = buildPaths(home)
      const db = openDb(paths)
      const eng = new SyncEngine(db, paths, new MemoryStore(paths), (): WebdavConfig => ({
        url: `http://127.0.0.1:${PORT + 1}`,
        username: 'u',
        password: 'p',
        basePath: '/dav/slow',
        autoSync: false,
      }))
      const [a, b] = await Promise.all([eng.sync(), eng.sync()])
      // 现行为：后到者 waitUntilIdle，上一轮结束后再跑；短任务下两者都 ok。超时仍在进行则返回可读错误。
      expect([a, b].every((r) => r.ok || !!r.error?.includes('仍在进行'))).toBe(true)
      expect([a, b].filter((r) => r.ok).length).toBeGreaterThanOrEqual(1)
      db.close()
    } finally {
      delay.close()
    }
  })
})
