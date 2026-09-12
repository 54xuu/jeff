/**
 * 真实 WebDAV 联测：skills 整目录镜像备份 / 整目录替换恢复 的跨「平台」闭环。
 * 门控：SKILLS_LIVE_E2E=1 且提供 SKILLS_LIVE_URL / SKILLS_LIVE_USER / SKILLS_LIVE_PASS 环境变量才运行。
 * 用独立的远端 basePath（/jeff-skills-selftest-<ts>），绝不触碰真实 /jeff 数据；测完自动清理。
 *
 * 场景（模拟用户「只维护一份 ~/.agents/skills、多平台通用」）：
 *   平台 A（win）：建 skills（含子目录）→ 备份（全量上传）
 *   平台 B（linux）：恢复 → 整目录替换，与 A 一致
 *   平台 A：删除某文件 + 修改另一文件 + 新增文件 → 备份（远端镜像：删/改/增）
 *   平台 B：本地新增多余文件 → 恢复 → 被删文件同步消失、多余文件被移除、修改生效；快照兜底可回退
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from 'webdav'
import { openDb } from '../src/db/db.js'
import { buildPaths } from '../src/paths.js'
import { MemoryStore } from '../src/memory/store.js'
import { SyncEngine, type WebdavConfig } from '../src/sync/engine.js'

const GATED = process.env.SKILLS_LIVE_E2E === '1' && process.env.SKILLS_LIVE_URL && process.env.SKILLS_LIVE_USER
const d = it.skipIf(!GATED)

const BASE = `/jeff-skills-selftest-${Date.now()}`
let homeA: string
let homeB: string
let dirA: string
let dirB: string
let engineA: SyncEngine
let engineB: SyncEngine

function makeEngine(home: string): SyncEngine {
  const paths = buildPaths(home)
  const db = openDb(paths)
  return new SyncEngine(db, paths, new MemoryStore(paths), (): WebdavConfig => ({
    url: process.env.SKILLS_LIVE_URL!,
    username: process.env.SKILLS_LIVE_USER!,
    password: process.env.SKILLS_LIVE_PASS ?? '',
    basePath: BASE,
    autoSync: false,
  }))
}

function write(rel: string, content: string): void {
  const target = path.join(process.env.JEFF_SKILLS_DIR!, ...rel.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}
const read = (rel: string) => fs.readFileSync(path.join(process.env.JEFF_SKILLS_DIR!, ...rel.split('/')), 'utf8')

beforeAll(() => {
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-live-a-'))
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-live-b-'))
  dirA = path.join(homeA, 'skills')
  dirB = path.join(homeB, 'skills')
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })
  process.env.JEFF_SKILLS_DIR = dirA
  engineA = makeEngine(homeA)
  process.env.JEFF_SKILLS_DIR = dirB
  engineB = makeEngine(homeB)
})

afterAll(async () => {
  delete process.env.JEFF_SKILLS_DIR
  // 清理远端测试目录
  if (GATED) {
    try {
      const client = createClient(process.env.SKILLS_LIVE_URL!, {
        username: process.env.SKILLS_LIVE_USER!,
        password: process.env.SKILLS_LIVE_PASS ?? '',
      })
      await client.deleteFile(`${BASE}/`)
    } catch {
      /* 清理失败不影响结论 */
    }
  }
})

describe.skipIf(!GATED)('skills 镜像备份/恢复（真实 WebDAV）', () => {
  d('跨平台闭环：备份 → 恢复 → 删除传播 → 再恢复', async () => {
    // 平台 A：初始化 skills 并全量备份
    process.env.JEFF_SKILLS_DIR = dirA
    write('alpha/SKILL.md', '# alpha v1\n')
    write('beta/SKILL.md', '# beta v1\n')
    write('beta/ref/detail.md', 'detail-1\n')
    const r1 = await engineA.backupSkills()
    expect(r1.ok, `备份 A 失败：${r1.error}`).toBe(true)
    expect(r1.uploaded).toBe(3)

    // 平台 B：本地有旧内容（应被整目录替换掉）
    process.env.JEFF_SKILLS_DIR = dirB
    write('old-skill/SKILL.md', '# 老的，应被移除\n')
    const st1 = await engineB.restoreSkillsStage()
    expect(st1.ok, `stage 失败：${st1.error}`).toBe(true)
    expect(st1.files.sort()).toEqual(['alpha/SKILL.md', 'beta/SKILL.md', 'beta/ref/detail.md'])
    const ap1 = await engineB.restoreSkillsApply()
    expect(ap1.ok, `恢复 B 失败：${ap1.error}`).toBe(true)
    expect(ap1.restored).toBe(3)
    expect(ap1.removed).toBe(1) // old-skill/SKILL.md 被移除
    expect(fs.existsSync(path.join(dirB, 'alpha', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(dirB, 'old-skill'))).toBe(false)
    expect(read('beta/ref/detail.md')).toBe('detail-1\n')
    expect(fs.existsSync(ap1.snapshotDir), '恢复前快照应存在').toBe(true)

    // 平台 A：删除 beta/ref/detail.md + 修改 alpha + 新增 gamma → 备份镜像到远端
    process.env.JEFF_SKILLS_DIR = dirA
    fs.rmSync(path.join(dirA, 'beta', 'ref'), { recursive: true })
    write('alpha/SKILL.md', '# alpha v2\n')
    write('gamma/SKILL.md', '# gamma\n')
    const r2 = await engineA.backupSkills()
    expect(r2.ok, `备份 A2 失败：${r2.error}`).toBe(true)
    expect(r2.deleted).toBe(1)
    expect(r2.uploaded).toBe(2)

    // 平台 B：又加了一个本地多出的文件 → 恢复后：删除传播、多余被移除、修改生效
    process.env.JEFF_SKILLS_DIR = dirB
    write('local-extra.md', '本地多出的\n')
    write('beta/ref/detail.md', '旧内容，远端已删\n')
    const st2 = await engineB.restoreSkillsStage()
    expect(st2.ok).toBe(true)
    expect(st2.files.sort()).toEqual(['alpha/SKILL.md', 'beta/SKILL.md', 'gamma/SKILL.md'])
    const ap2 = await engineB.restoreSkillsApply()
    expect(ap2.ok, `恢复 B2 失败：${ap2.error}`).toBe(true)
    expect(ap2.removed).toBe(2) // local-extra.md + 旧 beta/ref/detail.md
    expect(fs.existsSync(path.join(dirB, 'beta', 'ref')), '远端已删除的文件本地也应消失').toBe(false)
    expect(fs.existsSync(path.join(dirB, 'local-extra.md')), '本地多出文件应被移除').toBe(false)
    expect(read('alpha/SKILL.md')).toBe('# alpha v2\n')
    expect(read('gamma/SKILL.md')).toBe('# gamma\n')

    // 恢复后立即备份：与远端一致，零上传零删除
    const r3 = await engineB.backupSkills()
    expect(r3.ok).toBe(true)
    expect(r3.uploaded).toBe(0)
    expect(r3.deleted).toBe(0)
    expect(r3.skipped).toBe(3)
  }, 300_000)
})
