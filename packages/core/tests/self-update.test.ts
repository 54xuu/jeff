import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { agentRepo } from '../src/db/repos.js'
import { buildPaths, type JeffPaths } from '../src/paths.js'
import type { DB } from '../src/db/db.js'
import { ToolBridge } from '../src/tools/bridge.js'
import { registerSelfTools, snapshotInstructions, MAX_INSTRUCTIONS_CHARS } from '../src/tools/selfTools.js'
import { renderAgentMd } from '../src/agents/registry.js'
import { allToolDefs } from '../src/tools/definitions.js'
import type { SessionScopeCtx } from '../src/tools/memoryTools.js'

let tmp: string
let db: DB
let paths: JeffPaths
let changed = 0
/** sessionID → agentId（模拟 resolveSession 的会话映射） */
let sessions: Record<string, string> = {}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-selfupd-'))
  paths = buildPaths(tmp)
  db = openDb(paths)
  changed = 0
  sessions = {}
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function callFactory() {
  const bridge = new ToolBridge()
  registerSelfTools(bridge, {
    db,
    paths,
    resolveSession: (sessionId): SessionScopeCtx | null => {
      const agentId = sessionId ? sessions[sessionId] : undefined
      return agentId ? { kind: 'private', agentId } : null
    },
    onChanged: () => (changed += 1),
  })
  return async <T = unknown>(name: string, args: unknown): Promise<T> => {
    const h = (bridge as unknown as { handlers: Map<string, (a: unknown) => Promise<unknown>> }).handlers.get(name)
    if (!h) throw new Error(`未注册的工具：${name}`)
    return (await h(args)) as T
  }
}

const snapDir = (agentId: string) => path.join(paths.backupsDir, 'agent-instructions', agentId)
const snapFiles = (agentId: string) => (fs.existsSync(snapDir(agentId)) ? fs.readdirSync(snapDir(agentId)).filter((f) => f.endsWith('.md')) : [])

describe('jeff_self_update：定义与注册', () => {
  it('allToolDefs 里声明了 get/set/revert 三个动作与 expected_version（漏声明模型就永远传不进来）', () => {
    const d = allToolDefs().find((x) => x.name === 'jeff_self_update')
    expect(d, '缺少工具定义').toBeTruthy()
    expect(d!.args.action.enum).toEqual(['get', 'set', 'revert'])
    expect(Object.keys(d!.args)).toContain('expected_version')
    // 硬规矩：不能暴露 name/category（医护助手改分类会解除读盘封禁）
    expect(Object.keys(d!.args)).not.toContain('name')
    expect(Object.keys(d!.args)).not.toContain('category')
  })

  it('所有 Agent 的 md 都保留自我维护工具与版本提示', () => {
    const a = agentRepo(db).create({ name: '开发小李', instructions: '你是开发' })
    const md = renderAgentMd(agentRepo(db).get(a.id)!, undefined, paths)
    expect(md).not.toContain('jeff_self_update: false')
    expect(md).toContain('【自我维护（Jeff）】')
    expect(md).toContain('你的当前指令版本：v0')
    expect(md).toContain('jeff_self_update')
    const x = agentRepo(db).create({ name: '小杰', builtin: 1, id: 'agt_xiaojie', instructions: '个人 Prompt 与群角色无关' })
    const xmd = renderAgentMd(agentRepo(db).get(x.id)!, undefined, paths)
    expect(xmd).not.toContain('jeff_self_update: false')
    expect(xmd).toContain('个人 Prompt 与群角色无关')
  })

  it('Agent md 不按内置身份注入单独的 permission 限制', () => {
    const x = agentRepo(db).create({ name: '小杰', builtin: 1, id: 'agt_xiaojie' })
    const xmd = renderAgentMd(agentRepo(db).get(x.id)!, undefined, paths)
    expect(xmd).not.toContain('permission:')
    const a = agentRepo(db).create({ name: '普通' })
    expect(renderAgentMd(agentRepo(db).get(a.id)!, undefined, paths)).not.toContain('permission:')
  })
})

describe('jeff_self_update：身份边界', () => {
  it('没有会话上下文（sessionID 缺失 / 解析不到）就拒绝——身份只认 sessionID，不做按名字兜底', async () => {
    const call = callFactory()
    const a = agentRepo(db).create({ name: '开发小李' })
    sessions["ses-1"] = a.id
    await expect(call('jeff_self_update', { action: 'get', __ctx: {} })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/无法识别调用者身份/) })
    await expect(call('jeff_self_update', { action: 'get', __ctx: { sessionID: 'ses-unknown' } })).resolves.toMatchObject({ ok: false })
  })

  it('物理上只能改自己：群主调用只改群主，成员不受影响', async () => {
    const call = callFactory()
    const leader = agentRepo(db).create({ name: '群主', instructions: '群主指令 v1' })
    const worker = agentRepo(db).create({ name: '工作者', instructions: '工作者指令 v1' })
    sessions["ses-1"] = leader.id
    const r = await call<{ ok: boolean; new_version: number }>('jeff_self_update', {
      action: 'set',
      instructions: '群主指令 v2',
      expected_version: '0',
      __ctx: { sessionID: 'ses-1' },
    })
    expect(r.ok).toBe(true)
    expect(agentRepo(db).get(leader.id)!.instructions).toBe('群主指令 v2')
    expect(agentRepo(db).get(worker.id)!.instructions).toBe('工作者指令 v1')
  })

  it('小杰也能读取和维护自己的个人 Prompt', async () => {
    const call = callFactory()
    const x = agentRepo(db).create({ name: '小杰', builtin: 1, id: 'agt_xiaojie', instructions: '旧个人 Prompt' })
    sessions["ses-1"] = 'agt_xiaojie'
    await expect(call('jeff_self_update', { action: 'get', __ctx: { sessionID: 'ses-1' } })).resolves.toMatchObject({ ok: true, instructions: '旧个人 Prompt' })
    await expect(call('jeff_self_update', { action: 'set', instructions: '新个人 Prompt', expected_version: '0', __ctx: { sessionID: 'ses-1' } })).resolves.toMatchObject({ ok: true })
    expect(agentRepo(db).get(x.id)?.instructions).toBe('新个人 Prompt')
  })
})

describe('jeff_self_update：get / set / revert', () => {
  it('get 返回当前全文与版本', async () => {
    const call = callFactory()
    const a = agentRepo(db).create({ name: '开发小李', instructions: '你是开发' })
    sessions["ses-1"] = a.id
    const r = await call<{ ok: boolean; version: number; instructions: string }>('jeff_self_update', { action: 'get', __ctx: { sessionID: 'ses-1' } })
    expect(r).toMatchObject({ ok: true, version: 0, instructions: '你是开发' })
  })

  it('set 快照旧文本 → 版本 +1 → DB 生效；改名/分类不顶版本号', async () => {
    const call = callFactory()
    const a = agentRepo(db).create({ name: '开发小李', instructions: '你是开发，负责写代码' })
    sessions["ses-1"] = a.id
    const r = await call<{ ok: boolean; old_version: number; new_version: number; effective: string }>('jeff_self_update', {
      action: 'set',
      instructions: '你是资深开发，代码要过 lint；用户不喜欢你跳过测试',
      expected_version: 'v0',
      __ctx: { sessionID: 'ses-1' },
    })
    expect(r.ok).toBe(true)
    expect(r).toMatchObject({ old_version: 0, new_version: 1 })
    expect(r.effective).toMatch(/下一轮/)
    expect(agentRepo(db).get(a.id)).toMatchObject({ instructions: '你是资深开发，代码要过 lint；用户不喜欢你跳过测试', instructions_version: 1 })
    expect(snapFiles(a.id)).toHaveLength(1)
    expect(fs.readFileSync(path.join(snapDir(a.id), snapFiles(a.id)[0]), 'utf8')).toBe('你是开发，负责写代码')
    expect(changed).toBe(1)

    // 只改模型（不是 instructions）不应顶版本号
    agentRepo(db).update(a.id, { model_id: 'm1' })
    expect(agentRepo(db).get(a.id)!.instructions_version).toBe(1)
  })

  it('版本校验 fail-closed：缺失 / 非法 / 不匹配都拒绝且 DB 不动', async () => {
    const call = callFactory()
    const a = agentRepo(db).create({ name: '开发小李', instructions: 'v0 文本' })
    sessions["ses-1"] = a.id
    await expect(call('jeff_self_update', { action: 'set', instructions: 'x', __ctx: { sessionID: 'ses-1' } })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/expected_version 必填/) })
    await expect(call('jeff_self_update', { action: 'set', instructions: 'x', expected_version: 'abc', __ctx: { sessionID: 'ses-1' } })).resolves.toMatchObject({ ok: false })
    const miss = await call<{ ok: boolean; current_version: number; error: string }>('jeff_self_update', { action: 'set', instructions: 'x', expected_version: '5', __ctx: { sessionID: 'ses-1' } })
    expect(miss.ok).toBe(false)
    expect(miss.current_version).toBe(0)
    expect(agentRepo(db).get(a.id)!.instructions).toBe('v0 文本')
    expect(snapFiles(a.id)).toHaveLength(0)
    // 报错文本要引导模型先 get
    expect(miss.error).toMatch(/action=get/)
  })

  it('set 空串 = 未提供（拒绝而不是清空）；超长拒绝', async () => {
    const call = callFactory()
    const a = agentRepo(db).create({ name: '开发小李', instructions: '原文' })
    sessions["ses-1"] = a.id
    await expect(call('jeff_self_update', { action: 'set', instructions: '   ', expected_version: '0', __ctx: { sessionID: 'ses-1' } })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/非空 instructions/) })
    await expect(
      call('jeff_self_update', { action: 'set', instructions: 'x'.repeat(MAX_INSTRUCTIONS_CHARS + 1), expected_version: '0', __ctx: { sessionID: 'ses-1' } }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/过长/) })
    expect(agentRepo(db).get(a.id)!.instructions).toBe('原文')
  })

  it('revert 回滚到最近快照；revert 前也快照（可再撤销）；无快照时明确报错', async () => {
    const call = callFactory()
    const a = agentRepo(db).create({ name: '开发小李', instructions: '第一版' })
    sessions["ses-1"] = a.id
    await call('jeff_self_update', { action: 'set', instructions: '第二版', expected_version: '0', __ctx: { sessionID: 'ses-1' } })
    const r = await call<{ ok: boolean; reverted_to: string; new_version: number }>('jeff_self_update', { action: 'revert', expected_version: '1', __ctx: { sessionID: 'ses-1' } })
    expect(r.ok).toBe(true)
    expect(agentRepo(db).get(a.id)!.instructions).toBe('第一版')
    expect(agentRepo(db).get(a.id)!.instructions_version).toBe(2)
    // 快照数 = set 时 1 份 + revert 前对「第二版」的 1 份
    expect(snapFiles(a.id)).toHaveLength(2)

    const a2 = agentRepo(db).create({ name: '新兵', instructions: '从未改过' })
    sessions["ses-1"] = a2.id
    const miss = await call<{ ok: boolean; error: string }>('jeff_self_update', { action: 'revert', expected_version: '0', __ctx: { sessionID: 'ses-1' } })
    expect(miss.ok).toBe(false)
    expect(miss.error).toMatch(/没有可用的历史快照/)
  })
})

describe('snapshotInstructions：保留 20 份', () => {
  it('超过 20 份时最旧的被清理', () => {
    const a = agentRepo(db).create({ name: '开发小李' })
    for (let i = 0; i < 25; i++) snapshotInstructions(paths, a.id, `第 ${i} 版`)
    const files = snapFiles(a.id)
    expect(files).toHaveLength(20)
    // 留下的是最新的 20 份（第 5 ~ 24 版）
    expect(fs.readFileSync(path.join(snapDir(a.id), files[0]), 'utf8')).toBe('第 5 版')
    expect(fs.readFileSync(path.join(snapDir(a.id), files[files.length - 1]), 'utf8')).toBe('第 24 版')
  })
})
