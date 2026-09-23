import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { buildPaths } from '../src/paths.js'
import { agentRepo, kvRepo } from '../src/db/repos.js'
import { SubtaskRunner, SUBTASK_TOOL } from '../src/orchestrator/subtask.js'
import { agentSlug } from '../src/agents/registry.js'
import { sesMetaKey } from '../src/tools/memoryTools.js'
import { JeffCore } from '../src/index.js'
import type { DB } from '../src/db/db.js'
import type { OcClient } from '../src/oc/client.js'

let tmp: string
let db: DB
let runner: SubtaskRunner
let agentId: string
let sent: Array<{ sessionId: string; agent?: string; text?: string; system?: string }>
let createdSessions: Array<{ title?: string; agent?: string; directory?: string }>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-subtask-'))
  db = openDb(buildPaths(tmp))
  agentId = agentRepo(db).create({ name: '标书分析师', instructions: '提取 POCT 相关功能' }).id
  sent = []
  createdSessions = []
  runner = new SubtaskRunner(db, () => okOc)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const okOc = {
  createSession: async (input: { title?: string; agent?: string; directory?: string }) => {
    createdSessions.push(input)
    return { id: `ses_${Math.random().toString(36).slice(2, 8)}`, title: input?.title }
  },
  sendMessage: async (input: { sessionId: string; agent?: string; text?: string; system?: string }) => {
    sent.push(input)
    return {
      id: `msg_${Math.random().toString(36).slice(2, 8)}`,
      parts: [
        { type: 'reasoning', text: '先读文件再提取' },
        { type: 'tool', tool: 'read', state: { status: 'completed', output: '文件A.md' } },
        { type: 'text', text: `已完成：从 [${input.text?.slice(0, 10)}...] 提取到 3 条 POCT 相关要点，保存到 输出.md` },
      ],
    }
  },
} as unknown as OcClient

describe('SubtaskRunner', () => {
  it('成功路径：新建独立会话、继承调用者身份、只回传简短摘要（不含完整正文以外的思考/工具）', async () => {
    const r = await runner.run({ agentId, kind: 'private' }, { label: '标书A-功能提取', instruction: '分析标书A，提取 POCT 功能', target_path: '/x/标书A.md' }, 'msg_1')
    expect(r.ok).toBe(true)
    expect(r.label).toBe('标书A-功能提取')
    expect(r.target_path).toBe('/x/标书A.md')
    expect(r.summary).toContain('已完成')
    expect(r.subtask_session).toBeTruthy()
    // 新会话使用调用者的 agent slug（同模型/同指令/同工具集）
    expect(createdSessions).toHaveLength(1)
    expect(createdSessions[0].agent).toBe(agentSlug(agentId))
    expect(sent).toHaveLength(1)
    expect(sent[0].agent).toBe(agentSlug(agentId))
    expect(sent[0].text).toContain('独立子任务')
  })

  it('回传契约是「短摘要」，超长结果会被截断（不把完整产出灌回调用方）', async () => {
    const longOc = {
      createSession: async () => ({ id: 'ses_long' }),
      sendMessage: async () => ({ id: 'm1', parts: [{ type: 'text', text: 'X'.repeat(1000) }] }),
    } as unknown as OcClient
    const r = new SubtaskRunner(db, () => longOc)
    const res = await r.run({ agentId, kind: 'private' }, { instruction: '长任务' }, 'msg_2')
    expect(res.ok).toBe(true)
    expect(res.summary!.length).toBeLessThan(1000)
    expect(res.summary!.endsWith('…')).toBe(true)
  })

  it('创建的 session 会通过 onSessionCreated 回调标记 isSubtask（供 resolveSession 拦嵌套/不进搜索）', async () => {
    const created: Array<{ sessionId: string; meta: unknown }> = []
    runner.onSessionCreated = (sessionId, meta) => created.push({ sessionId, meta })
    const r = await runner.run({ agentId, kind: 'group', projectId: 'proj_1', directory: '/ws' }, { instruction: '任务' }, 'msg_3')
    expect(r.ok).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0].sessionId).toBe(r.subtask_session)
    expect(created[0].meta).toMatchObject({ kind: 'group', agentId, projectId: 'proj_1' })
    expect(createdSessions[0].directory).toBe('/ws')
  })

  it('子任务执行失败时返回明确错误（不抛异常），仍带上 label/target_path 便于调用方汇总', async () => {
    const failOc = {
      createSession: async () => ({ id: 'ses_fail' }),
      sendMessage: async () => {
        throw new Error('文件损坏，无法解析')
      },
    } as unknown as OcClient
    const r = new SubtaskRunner(db, () => failOc)
    const res = await r.run({ agentId, kind: 'private' }, { label: '标书B', instruction: '分析标书B', target_path: '/x/标书B.md' }, 'msg_4')
    expect(res.ok).toBe(false)
    expect(res.label).toBe('标书B')
    expect(res.target_path).toBe('/x/标书B.md')
    expect(res.error).toContain('文件损坏')
    expect(res.subtask_session).toBe('ses_fail')
  })

  it('instruction 为空直接报错，不创建会话', async () => {
    const res = await runner.run({ agentId, kind: 'private' }, { instruction: '   ' }, 'msg_5')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('instruction')
    expect(createdSessions).toHaveLength(0)
  })

  it('智能体不存在直接报错，不创建会话', async () => {
    const res = await runner.run({ agentId: 'agt_missing', kind: 'private' }, { instruction: '任务' }, 'msg_6')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不存在')
    expect(createdSessions).toHaveLength(0)
  })

  it('同一条触发消息内子任务数超过 80 次会被拦下（防失控，但上限比 delegate 高很多）', async () => {
    for (let i = 0; i < 80; i++) {
      const r = await runner.run({ agentId, kind: 'private' }, { instruction: `第 ${i} 个文件` }, 'msg_loop')
      expect(r.ok).toBe(true)
    }
    const r81 = await runner.run({ agentId, kind: 'private' }, { instruction: '第 81 个文件' }, 'msg_loop')
    expect(r81.ok).toBe(false)
    expect(r81.error).toContain('上限')
  })

  it('不同触发消息的计数互不影响', async () => {
    const r1 = await runner.run({ agentId, kind: 'private' }, { instruction: 'a' }, 'msg_a')
    const r2 = await runner.run({ agentId, kind: 'private' }, { instruction: 'b' }, 'msg_b')
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })

  it('注入 buildSystem 时按调用者与 projectId 生成 system（与私聊/群聊回合一致）', async () => {
    runner.buildSystem = (aid, pid) => {
      expect(aid).toBe(agentId)
      expect(pid).toBe('proj_x')
      return 'MEM-BLOCK'
    }
    const r = await runner.run({ agentId, kind: 'group', projectId: 'proj_x' }, { instruction: '任务' }, 'msg_7')
    expect(r.ok).toBe(true)
    expect(sent[sent.length - 1].system).toBe('MEM-BLOCK')
  })
})

describe('JeffCore.resolveSession：子任务会话标记 isSubtask', () => {
  let core: JeffCore
  let coreDb: DB
  let coreTmp: string

  beforeEach(() => {
    coreTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-subtask-resolve-'))
    coreDb = openDb(buildPaths(coreTmp))
    core = new JeffCore(coreTmp)
    core.db = coreDb
  })

  afterEach(() => {
    coreDb.close()
    fs.rmSync(coreTmp, { recursive: true, force: true })
  })

  it('私聊子任务会话解析出 isSubtask:true；普通私聊会话没有该标记', () => {
    const aid = agentRepo(coreDb).create({ name: 'X' }).id
    kvRepo(coreDb).setJSON(sesMetaKey('ses_sub'), { kind: 'private', agentId: aid, isSubtask: true })
    kvRepo(coreDb).setJSON(sesMetaKey('ses_normal'), { kind: 'private', agentId: aid })
    expect(core.resolveSession('ses_sub')).toMatchObject({ kind: 'private', agentId: aid, isSubtask: true })
    expect(core.resolveSession('ses_normal')).toEqual({ kind: 'private', agentId: aid })
  })

  it('群子任务会话同样解析出 isSubtask:true，且保留 projectId', () => {
    const aid = agentRepo(coreDb).create({ name: 'Y' }).id
    kvRepo(coreDb).setJSON(sesMetaKey('ses_gsub'), { kind: 'group', agentId: aid, projectId: 'proj_1', isSubtask: true })
    expect(core.resolveSession('ses_gsub')).toMatchObject({ kind: 'group', agentId: aid, projectId: 'proj_1', isSubtask: true })
  })
})

it('SUBTASK_TOOL 常量与工具定义名一致', async () => {
  const { allToolDefs } = await import('../src/tools/definitions.js')
  const def = allToolDefs().find((d) => d.name === SUBTASK_TOOL)
  expect(def).toBeTruthy()
  // 参数一律标量：不允许嵌套 object（硬规矩，模型侧会把嵌套对象塞成空串）
  for (const [k, v] of Object.entries(def!.args)) {
    expect(v.type, `${k} 应为标量类型`).not.toBe('object')
  }
})
