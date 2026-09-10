/**
 * 端到端：流式输出 + 图片（多模态）链路 —— 真实 opencode sidecar + mock LLM。
 * 仅在 JEFF_E2E=1 时运行。运行：JEFF_E2E=1 npx vitest run --no-file-parallelism tests/e2e.stream.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlm } from './helpers/mock-llm.mjs'
import { JeffCore, kvRepo, buildPaths, openDb, XIAOJIE_ID } from '../src/index.js'

const RUN = process.env.JEFF_E2E === '1'
const d = RUN ? describe : describe.skip

const helperDir = path.dirname(fileURLToPath(import.meta.url))
const MOCK_PORT = 18082
const BIN = process.env.JEFF_OPENCODE_BIN || path.join(process.env.HOME || '', '.opencode/bin/opencode')

// 1x1 合法 PNG
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let mockServer: Awaited<ReturnType<typeof startMockLlm>> | null = null
let core: JeffCore
let home: string

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 100))
  }
}

d('E2E: 流式输出与图片消息', () => {
  beforeAll(async () => {
    if (!fs.existsSync(BIN)) throw new Error(`找不到 opencode: ${BIN}`)
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-e2e-stream-'))

    mockServer = await startMockLlm(MOCK_PORT, {
      imageReply: '【mock 已收到图片】图中是 1x1 像素测试图。',
      reasoningReply: '我需要先想想：用户说的是推理题，那么我应该给出结论。',
    })

    const paths = buildPaths(home)
    fs.mkdirSync(path.dirname(paths.dbFile), { recursive: true })
    const db = openDb(paths)
    kvRepo(db).setJSON('settings:providers', [
      { id: 'mockai', kind: 'custom', name: 'MockAI', baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, models: [{ id: 'mock-mini', name: 'Mock Mini', attachment: true }] },
    ])
    kvRepo(db).setJSON('settings:defaultModel', { providerID: 'mockai', modelID: 'mock-mini' })
    db.close()

    core = new JeffCore(home)
    await core.init({ binaryPath: BIN })
  }, 60000)

  afterAll(async () => {
    await core?.dispose()
    mockServer?.close()
    if (home && process.env.JEFF_E2E_KEEP !== '1') fs.rmSync(home, { recursive: true, force: true })
  })

  it('流式：私聊回复产生增量 chat-stream 事件并以 done 收尾', async () => {
    const chunks: Array<{ text: string; done: boolean }> = []
    const handler = (p: unknown) => {
      const e = p as { kind: string; agentId: string; text: string; done: boolean }
      if (e.kind === 'private' && e.agentId === XIAOJIE_ID) chunks.push({ text: e.text, done: e.done })
    }
    core.bus.on('chat-stream', handler)
    try {
      await core.privateChat.send(XIAOJIE_ID, '小杰', '请回复一句话：流式测试')
      await waitFor(() => chunks.some((c) => c.done), 8000)
    } finally {
      core.bus.off('chat-stream', handler)
    }
    const incremental = chunks.filter((c) => !c.done)
    expect(incremental.length).toBeGreaterThanOrEqual(1)
    // 增量文本单调不减
    for (let i = 1; i < incremental.length; i++) {
      expect(incremental[i].text.length).toBeGreaterThanOrEqual(incremental[i - 1].text.length)
    }
    expect(incremental[incremental.length - 1].text.length).toBeGreaterThan(0)
  }, 120000)

  it('流式：思考增量归入 reasoning，不混进正文（回归：长推导完成后「消失」）', async () => {
    const events: Array<{ text: string; reasoning?: string; done: boolean }> = []
    const handler = (p: unknown) => {
      const e = p as { kind: string; agentId: string; text: string; reasoning?: string; done: boolean }
      if (e.kind === 'private' && e.agentId === XIAOJIE_ID) events.push({ text: e.text, reasoning: e.reasoning, done: e.done })
    }
    core.bus.on('chat-stream', handler)
    try {
      await core.privateChat.send(XIAOJIE_ID, '小杰', '请推理：1+1 等于几？')
      await waitFor(() => events.some((e) => e.done), 120000)
    } finally {
      core.bus.off('chat-stream', handler)
    }
    const incremental = events.filter((e) => !e.done)
    // 思考内容必须出现在 reasoning 通道
    expect(incremental.some((e) => (e.reasoning || '').includes('我需要先想想'))).toBe(true)
    // 且不得混进正文通道（正文只在最后出结论）
    expect(incremental.map((e) => e.text).join('')).not.toContain('我需要先想想')
    expect(events[events.length - 1].text || incremental[incremental.length - 1]?.text || '').toBeTruthy()
  }, 180000)

  it('图片：file part 透传到 LLM，历史回放还原 images', async () => {
    const reply = await core.privateChat.send(XIAOJIE_ID, '小杰', '这张图里是什么？', undefined, [
      { mime: 'image/png', dataUrl: `data:image/png;base64,${PNG_1PX}` },
    ])
    expect(reply.id).toMatch(/^msg_/)
    const texts = (reply.parts || []).filter((p) => p.type === 'text') as Array<{ type: 'text'; text: string }>
    expect(texts.map((t) => t.text).join('')).toContain('收到图片')

    // 历史回放：opencode 里的 file part 映射回 images
    const history = await core.privateChat.history(XIAOJIE_ID)
    const lastUser = [...history].reverse().find((m) => m.role === 'user')
    expect(lastUser?.images?.length).toBe(1)
    expect(lastUser?.images?.[0].mime).toBe('image/png')
  }, 120000)

  it('流式缓冲：回复完成后清空（不残留增量）', async () => {
    // 触发一次新回复；done 后内部 streamParts 不应再推增量
    const after = await core.privateChat.send(XIAOJIE_ID, '小杰', '再回复一句：清理测试')
    expect(after.id).toMatch(/^msg_/)
    const lateEvents: Array<{ text: string; done: boolean }> = []
    const handler = (p: unknown) => {
      const e = p as { kind: string; agentId: string; text: string; done: boolean }
      if (e.kind === 'private' && e.agentId === XIAOJIE_ID) lateEvents.push({ text: e.text, done: e.done })
    }
    core.bus.on('chat-stream', handler)
    await new Promise((r) => setTimeout(r, 1500))
    core.bus.off('chat-stream', handler)
    // 已完成的会话不应再冒出任何流式事件
    expect(lateEvents.length).toBe(0)
  }, 60000)
})
