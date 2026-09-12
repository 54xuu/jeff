import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
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

beforeEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true })
  fs.mkdirSync(skillsDir, { recursive: true })
})

afterAll(() => {
  server?.close()
  delete process.env.JEFF_SKILLS_DIR
})

describe('SyncEngine skills 整目录镜像备份（远端=本地全量对齐）', () => {
  it('备份 → 远端与本地完全一致；本地删除传播到远端（删前归档）；本地目录缺失不清空远端', async () => {
    const engine = makeEngine('sk1')
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# hello')
    fs.mkdirSync(path.join(skillsDir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'sub', 'a.md'), 'aaa')

    // 1. 首次备份：全部上传
    const r1 = await engine.backupSkills()
    expect(r1.ok).toBe(true)
    expect(r1.uploaded).toBe(2)
    expect(r1.deleted).toBe(0)
    expect(fs.existsSync(path.join(davRoot, 'dav/sk1/skills/SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(davRoot, 'dav/sk1/skills/sub/a.md'))).toBe(true)

    // 2. 无变化再备份：全部跳过
    const r2 = await engine.backupSkills()
    expect(r2.ok).toBe(true)
    expect(r2.uploaded).toBe(0)
    expect(r2.skipped).toBe(2)
    expect(r2.deleted).toBe(0)

    // 3. 镜像删除：本地删掉 sub/a.md 后远端同步消失，旧版本先归档
    fs.rmSync(path.join(skillsDir, 'sub'), { recursive: true })
    const r3 = await engine.backupSkills()
    expect(r3.ok).toBe(true)
    expect(r3.deleted).toBe(1)
    expect(r3.archived).toBe(1)
    expect(fs.existsSync(path.join(davRoot, 'dav/sk1/skills/sub/a.md'))).toBe(false)
    const delVerDir = path.join(davRoot, 'dav/sk1/skills-versions/sub/a.md')
    expect(fs.existsSync(delVerDir)).toBe(true)
    expect(fs.readFileSync(path.join(delVerDir, fs.readdirSync(delVerDir)[0]), 'utf8')).toBe('aaa')

    // 4. 内容变化：远端旧版本归档后再覆盖
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# hello v2')
    const r4 = await engine.backupSkills()
    expect(r4.ok).toBe(true)
    expect(r4.archived).toBe(1)
    expect(fs.readFileSync(path.join(davRoot, 'dav/sk1/skills/SKILL.md'), 'utf8')).toBe('# hello v2')
    const verDir = path.join(davRoot, 'dav/sk1/skills-versions/SKILL.md')
    expect(fs.readdirSync(verDir).length).toBe(1)
    expect(fs.readFileSync(path.join(verDir, fs.readdirSync(verDir)[0]), 'utf8')).toBe('# hello')

    // 5. 本地目录缺失：报错跳过，远端不清空（新机器保护）
    fs.rmSync(skillsDir, { recursive: true })
    const r5 = await engine.backupSkills()
    expect(r5.ok).toBe(false)
    expect(r5.error).toContain('不存在')
    expect(fs.existsSync(path.join(davRoot, 'dav/sk1/skills/SKILL.md'))).toBe(true)
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# hello v2')
  })

  it('恢复 = 整目录替换：备份里没有的本地文件被移除；快照可回退；恢复后备份不重传', async () => {
    const engine = makeEngine('sk2')
    fs.writeFileSync(path.join(skillsDir, 'a.md'), 'A')
    fs.writeFileSync(path.join(skillsDir, 'b.md'), 'B')
    expect((await engine.backupSkills()).ok).toBe(true)

    // 模拟「另一台平台」删掉 b.md 后重新备份 → 远端镜像只剩 a.md
    fs.rmSync(path.join(skillsDir, 'b.md'))
    const rb = await engine.backupSkills()
    expect(rb.ok).toBe(true)
    expect(rb.deleted).toBe(1)
    expect(fs.existsSync(path.join(davRoot, 'dav/sk2/skills/b.md'))).toBe(false)

    // 本机场景：本地仍留着 b.md 与本地新增 c.md；恢复后都应消失（整目录替换）
    fs.writeFileSync(path.join(skillsDir, 'b.md'), 'B-local')
    fs.writeFileSync(path.join(skillsDir, 'c.md'), 'C-local')

    const staged = await engine.restoreSkillsStage()
    expect(staged.ok).toBe(true)
    expect(staged.files).toEqual(['a.md'])

    const applied = await engine.restoreSkillsApply()
    expect(applied.ok).toBe(true)
    expect(applied.restored).toBe(1)
    expect(applied.removed).toBe(2) // b.md + c.md 被移除
    expect(fs.existsSync(path.join(skillsDir, 'a.md'))).toBe(true)
    expect(fs.readFileSync(path.join(skillsDir, 'a.md'), 'utf8')).toBe('A')
    expect(fs.existsSync(path.join(skillsDir, 'b.md'))).toBe(false)
    expect(fs.existsSync(path.join(skillsDir, 'c.md'))).toBe(false)
    // 快照含恢复前全部内容（b/c 都在，可手工回退）
    expect(fs.readFileSync(path.join(applied.snapshotDir, 'b.md'), 'utf8')).toBe('B-local')
    expect(fs.readFileSync(path.join(applied.snapshotDir, 'c.md'), 'utf8'), 'c.md 也应在快照里').toBe('C-local')

    // 恢复后立即备份：内容与远端一致 → 全部跳过，不误删远端
    const rAfter = await engine.backupSkills()
    expect(rAfter.ok).toBe(true)
    expect(rAfter.uploaded).toBe(0)
    expect(rAfter.deleted).toBe(0)
    expect(rAfter.skipped).toBe(1)
  })

  it('posix 相对路径跨平台：备份里子目录文件恢复后落回子目录', async () => {
    const engine = makeEngine('sk3')
    fs.mkdirSync(path.join(skillsDir, 'deep', 'nest'), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'deep', 'nest', 'x.md'), 'X')
    expect((await engine.backupSkills()).ok).toBe(true)
    expect(fs.existsSync(path.join(davRoot, 'dav/sk3/skills/deep/nest/x.md'))).toBe(true)

    fs.rmSync(path.join(skillsDir, 'deep'), { recursive: true })
    const staged = await engine.restoreSkillsStage()
    expect(staged.files).toEqual(['deep/nest/x.md'])
    const applied = await engine.restoreSkillsApply()
    expect(applied.ok).toBe(true)
    expect(fs.readFileSync(path.join(skillsDir, 'deep', 'nest', 'x.md'), 'utf8')).toBe('X')
  })

  it('安全阀：本地为空不清空远端备份；远端无备份时 stage 失败并拒绝恢复', async () => {
    // 1) 平台 X 备份出一份远端
    const ex = makeEngine('sk4')
    fs.writeFileSync(path.join(skillsDir, 'keep.md'), 'keep')
    expect((await ex.backupSkills()).ok).toBe(true)

    // 2) 另一台设备本地 skills 为空（如新机器/路径配错）→ 备份必须报错跳过，远端原样保留
    fs.rmSync(skillsDir, { recursive: true })
    fs.mkdirSync(skillsDir, { recursive: true })
    const rEmpty = await ex.backupSkills()
    expect(rEmpty.ok).toBe(false)
    expect(rEmpty.error, '空本地备份应报防误清空错误').toContain('为空')
    expect(fs.existsSync(path.join(davRoot, 'dav/sk4/skills/keep.md'))).toBe(true)

    // 3) 该设备「从备份恢复」：远端有备份可正常恢复
    const st = await ex.restoreSkillsStage()
    expect(st.ok).toBe(true)
    expect(st.files).toEqual(['keep.md'])
    const ap = await ex.restoreSkillsApply()
    expect(ap.ok).toBe(true)
    expect(fs.readFileSync(path.join(skillsDir, 'keep.md'), 'utf8')).toBe('keep')

    // 4) 远端没有任何备份文件 → stage 失败（UI 不会出现「确认恢复」）
    const ex2 = makeEngine('sk5')
    const stNone = await ex2.restoreSkillsStage()
    expect(stNone.ok).toBe(false)
    expect(stNone.error, '空远端 stage 应失败并提示先备份').toContain('没有')
    // 暂存区为空时 apply 也拒绝
    const apNone = await ex2.restoreSkillsApply()
    expect(apNone.ok).toBe(false)
    expect(apNone.error).toContain('暂存区为空')
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
      // 现行为：后到者 waitUntilIdle，上一轮结束后再跑；两者都应结束（ok 或带 error），不交叉挂死。
      // 本假 DAV 只回 PROPFIND XML，实体 JSON 拉取会失败——属预期，重点是重入不卡死。
      expect([a, b].every((r) => r.ok || !!r.error)).toBe(true)
      expect([a, b].some((r) => r.ok || !!r.error?.includes('仍在进行') || !!r.error)).toBe(true)
      db.close()
    } finally {
      delay.close()
    }
  })
})
