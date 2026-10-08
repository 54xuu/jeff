import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { composePromptContext, PromptSnapshotStore, type PromptContextBlock } from '../src/prompt/context.js'

let root = ''
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

function block(input: Partial<PromptContextBlock> & Pick<PromptContextBlock, 'id' | 'kind' | 'content'>): PromptContextBlock {
  return {
    scope: 'project', source: input.id, readStatus: 'loaded', included: true,
    delivery: 'system', ...input,
  } as PromptContextBlock
}

describe('composePromptContext', () => {
  it('orders distinct context meanings and excludes personal Agent definition from the system string', () => {
    const context = composePromptContext({ agentId: 'agt_a', projectId: 'prj_a' }, [
      block({ id: 'task', kind: 'task', content: '验收标准：可复现' }),
      block({ id: 'rules', kind: 'group-rules', content: '本群规则：先检查' }),
      block({ id: 'identity', kind: 'agent-instructions', content: '个人身份', delivery: 'agent-definition' }),
      block({ id: 'duties', kind: 'member-duty', content: '成员职责：测试' }),
      block({ id: 'description', kind: 'group-description', content: '背景：项目 A' }),
      block({ id: 'absent-memory', kind: 'memory-user', content: '', included: false, readStatus: 'empty' }),
    ])

    expect(context.blocks.map((item) => item.id)).toEqual(['identity', 'description', 'rules', 'duties', 'absent-memory', 'task'])
    expect(context.system).toBe('背景：项目 A\n\n本群规则：先检查\n\n成员职责：测试\n\n验收标准：可复现')
    expect(context.system).not.toContain('个人身份')
    expect(context.blocks.find((item) => item.id === 'identity')?.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(context.blocks.find((item) => item.id === 'absent-memory')?.readStatus).toBe('empty')
  })

  it('hashes the ordered context deterministically and changes when a setting changes', () => {
    const metadata = { agentId: 'agt_a', projectId: 'prj_a', engine: 'opencode' }
    const blocks = [block({ id: 'rules', kind: 'group-rules', content: '先测试' })]
    const original = composePromptContext(metadata, blocks)
    expect(composePromptContext(metadata, blocks).contextHash).toBe(original.contextHash)
    expect(composePromptContext(metadata, [block({ id: 'rules', kind: 'group-rules', content: '先构建' })]).contextHash).not.toBe(original.contextHash)
  })
})

describe('PromptSnapshotStore', () => {
  it('stores only local snapshots, reads the latest valid record, and applies per-session retention', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-prompt-snapshot-'))
    const store = new PromptSnapshotStore(root, 1000, 2)
    const context = composePromptContext({ agentId: 'agt_a', projectId: 'prj_a', threadId: 'thr_a', taskRunId: 'run_a' }, [
      block({ id: 'task', kind: 'task', scope: 'task', content: '目标：写真实结果' }),
    ])
    const base = { sessionId: 'ses/a', agentId: 'agt_a', projectId: 'prj_a', threadId: 'thr_a', taskId: 'task_a', taskRunId: 'run_a', engine: 'opencode', context, system: context.system }
    store.write({ ...base, id: 'first', sentAt: 1000 })
    store.write({ ...base, id: 'second', sentAt: 1500, system: 'changed prompt' })
    store.write({ ...base, id: 'third', sentAt: 2000, system: 'latest prompt', adapterPrompt: 'agent definition' })

    const latest = store.latest('ses/a')
    expect(latest?.id).toBe('third')
    expect(latest?.system).toBe('latest prompt')
    expect(latest?.adapterPromptHash).toMatch(/^[a-f0-9]{64}$/)
    const snapshotDir = path.join(root, 'prompt-snapshots')
    const sessionDir = fs.readdirSync(snapshotDir)[0]
    expect(sessionDir).not.toContain('ses')
    expect(fs.readdirSync(path.join(snapshotDir, sessionDir))).toHaveLength(2)
    if (process.platform !== 'win32') expect(fs.statSync(path.join(snapshotDir, sessionDir)).mode & 0o777).toBe(0o700)
  })

  it('returns null for missing sessions', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-prompt-snapshot-'))
    expect(new PromptSnapshotStore(root).latest('missing')).toBeNull()
  })
})
