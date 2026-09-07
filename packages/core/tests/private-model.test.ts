import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { agentRepo } from '../src/db/repos.js'
import { buildPaths } from '../src/paths.js'
import { PrivateChat } from '../src/chat/private.js'
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
})
