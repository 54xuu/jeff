import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { agentRepo, kvRepo } from '../src/db/repos.js'
import { buildPaths } from '../src/paths.js'
import { PrivateChat, PrivateChatStoppedError, autoTitleKey } from '../src/chat/private.js'
import { XIAOJIE_ID } from '../src/ipc/contract.js'
import type { DB } from '../src/db/db.js'
import type { OcClient } from '../src/oc/client.js'

let tmp: string
let db: DB

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-priv-'))
  db = openDb(buildPaths(tmp))
  agentRepo(db).create({ id: XIAOJIE_ID, name: '小杰', builtin: 1 })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('PrivateChat.send 模型归属', () => {
  it('使用智能体绑定的 model/thinking，忽略入参覆盖', async () => {
    const agents = agentRepo(db)
    const a = agents.create({ name: '探路者', model_provider: 'prov-a', model_id: 'model-a', thinking: 'high' })
    const sent: Array<{ model?: { providerID: string; modelID: string }; variant?: string }> = []
    const oc = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_p' }),
      sendMessage: async (input: { model?: { providerID: string; modelID: string }; variant?: string }) => {
        sent.push(input)
        return { id: 'msg', parts: [{ type: 'text', text: 'ok' }] }
      },
    } as unknown as OcClient
    const chat = new PrivateChat(db, () => oc, {
      defaultModel: () => ({ providerID: 'fallback', modelID: 'fb' }),
    })

    await chat.send(a.id, a.name, 'hi', { providerID: 'hack', modelID: 'ignored' }, undefined, 'none')
    expect(sent[0].model).toEqual({ providerID: 'prov-a', modelID: 'model-a' })
    expect(sent[0].variant).toBe('high')
  })

  it('未绑定模型时用 defaultModel；空 thinking 不传 variant', async () => {
    const agents = agentRepo(db)
    const a = agents.create({ name: '无模', thinking: '' })
    const sent: Array<{ model?: { providerID: string; modelID: string }; variant?: string }> = []
    const oc = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_p2' }),
      sendMessage: async (input: { model?: { providerID: string; modelID: string }; variant?: string }) => {
        sent.push(input)
        return { id: 'msg', parts: [{ type: 'text', text: 'ok' }] }
      },
    } as unknown as OcClient
    const chat = new PrivateChat(db, () => oc, {
      defaultModel: () => ({ providerID: 'fallback', modelID: 'fb' }),
    })

    await chat.send(a.id, a.name, 'hi')
    expect(sent[0].model).toEqual({ providerID: 'fallback', modelID: 'fb' })
    expect(sent[0].variant).toBeUndefined()
  })

  it('并发 ensureSession 同一 agent 只建一个会话', async () => {
    let createCalls = 0
    const oc = {
      getSession: async () => {
        throw new Error('not found')
      },
      createSession: async () => {
        createCalls += 1
        await new Promise((r) => setTimeout(r, 50))
        return { id: `ses_${createCalls}` }
      },
    } as unknown as OcClient
    const chat = new PrivateChat(db, () => oc)
    const [s1, s2] = await Promise.all([chat.ensureSession('agt_a', '甲'), chat.ensureSession('agt_a', '甲')])
    expect(s1).toBe(s2)
    expect(createCalls).toBe(1)
  })

  it('用户主动停止抛 PrivateChatStoppedError，与 provider 失败可区分', async () => {    const oc = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_stop' }),
      sendMessage: async () => {
        throw new Error('request aborted')
      },
      isAbortRequested: () => true,
    } as unknown as OcClient
    const chat = new PrivateChat(db, () => oc)
    await expect(chat.send('agt_stop', '甲', 'hi')).rejects.toThrow(PrivateChatStoppedError)
    // provider 失败（未请求停止）仍原样抛出
    const oc2 = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_fail' }),
      sendMessage: async () => {
        throw new Error('request aborted')
      },
      isAbortRequested: () => false,
    } as unknown as OcClient
    const chat2 = new PrivateChat(db, () => oc2)
    await expect(chat2.send('agt_fail', '乙', 'hi')).rejects.toThrow(/aborted/)
    expect(chat2).toBeDefined()
  })

  // 回归：界面「发送中」是同步置位的，停止按钮在建会话期间就可点；此时 KV 还没有 sessionId。
  // 旧实现 `if (sessionId)` 会静默丢弃停止 → 用户点了停止却继续生成（实测卡到超时）。
  it('会话建成前点停止：停止意图被保留，建好后立即中止本轮且不发出请求', async () => {
    let sendCalls = 0
    const oc = {
      getSession: async () => {
        throw new Error('not found')
      },
      createSession: async () => {
        await new Promise((r) => setTimeout(r, 80))
        return { id: 'ses_race' }
      },
      sendMessage: async () => {
        sendCalls += 1
        return { id: 'msg', parts: [{ type: 'text', text: '不该被调用' }] }
      },
      abortSession: async () => {},
    } as unknown as OcClient
    const logs: Array<{ tag: string; detail: unknown }> = []
    const chat = new PrivateChat(db, () => oc, { onDebugLog: (tag, detail) => logs.push({ tag, detail }) })

    const sending = chat.send('agt_race', '甲', 'hi')
    await new Promise((r) => setTimeout(r, 20)) // 让 send 进入「建会话中」
    const r = await chat.stop('agt_race')
    expect(r).toEqual({ sessionId: null, deferred: true })
    await expect(sending).rejects.toThrow(PrivateChatStoppedError)
    expect(sendCalls, '停止后不应真正发出请求').toBe(0)
    expect(logs[0]?.tag).toBe('private-send-stop')
  })

  it('停止意图只作用于在途发送：空闲时点停止不会污染下一轮', async () => {
    let sendCalls = 0
    const oc = {
      getSession: async () => ({ id: 'x' }),
      createSession: async () => ({ id: 'ses_idle' }),
      sendMessage: async () => {
        sendCalls += 1
        return { id: 'msg', parts: [{ type: 'text', text: 'ok' }] }
      },
      abortSession: async () => {},
    } as unknown as OcClient
    const chat = new PrivateChat(db, () => oc)
    const r = await chat.stop('agt_idle')
    expect(r).toEqual({ sessionId: null, deferred: false })
    await expect(chat.send('agt_idle', '甲', 'hi')).resolves.toBeTruthy()
    expect(sendCalls).toBe(1)
  })
})

describe('私聊会话默认命名 {YYYYMMDD-HHmm}-{任务中文名称}', () => {
  it('建会话先用「时间戳-新会话」占位，首条消息补任务名且只补一次', async () => {
    const patches: Array<{ title?: string }> = []
    let createdTitle = ''
    const oc = {
      getSession: async () => ({ id: 'ses_n1' }),
      createSession: async (input: { title?: string }) => {
        createdTitle = input.title || ''
        return { id: 'ses_n1' }
      },
      updateSession: async (_id: string, patch: { title?: string }) => {
        patches.push(patch)
        return { id: 'ses_n1', title: patch.title }
      },
      sendMessage: async () => ({ id: 'msg', parts: [{ type: 'text', text: 'ok' }] }),
    } as unknown as OcClient
    const chat = new PrivateChat(db, () => oc)

    await chat.send('agt_n1', '甲', '修复登录按钮')

    expect(createdTitle).toMatch(/^\d{8}-\d{4}-新会话$/)
    const stamp = createdTitle.slice(0, 13)
    expect(patches).toEqual([{ title: `${stamp}-修复登录按钮` }])
    // 补完即删标记，第二条消息不会再改名
    expect(kvRepo(db).get(autoTitleKey('ses_n1'))).toBeNull()
    await chat.send('agt_n1', '甲', '第二句话')
    expect(patches).toHaveLength(1)
  })

  it('补名失败不影响发送：只记日志，保留标记等下次重试', async () => {
    const logs: Array<{ tag: string; detail: unknown }> = []
    const oc = {
      getSession: async () => ({ id: 'ses_f' }),
      createSession: async () => ({ id: 'ses_f' }),
      updateSession: async () => {
        throw new Error('engine down')
      },
      sendMessage: async () => ({ id: 'msg', parts: [{ type: 'text', text: 'ok' }] }),
    } as unknown as OcClient
    const chat = new PrivateChat(db, () => oc, { onDebugLog: (tag, detail) => logs.push({ tag, detail }) })

    await expect(chat.send('agt_f', '甲', '修复登录按钮')).resolves.toBeTruthy()
    expect(logs.some((l) => l.tag === 'private-autotitle-fail')).toBe(true)
    expect(kvRepo(db).get(autoTitleKey('ses_f'))).not.toBeNull()
  })

  it('已存在的旧会话不补名（只对新会话生效）', async () => {
    kvRepo(db).set('session:private:agt_old', 'ses_old')
    const patches: unknown[] = []
    const oc = {
      getSession: async () => ({ id: 'ses_old' }),
      createSession: async () => ({ id: 'ses_never' }),
      updateSession: async (_id: string, patch: unknown) => {
        patches.push(patch)
        return { id: 'ses_old' }
      },
      sendMessage: async () => ({ id: 'msg', parts: [{ type: 'text', text: 'ok' }] }),
    } as unknown as OcClient
    const chat = new PrivateChat(db, () => oc)

    await chat.send('agt_old', '甲', '随便说点什么')
    expect(patches).toHaveLength(0)
  })
})
