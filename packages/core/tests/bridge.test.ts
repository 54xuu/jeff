import { describe, it, expect, afterEach } from 'vitest'
import { ToolBridge, renderBridgePlugin } from '../src/tools/bridge.js'
import type { ToolDef } from '../src/tools/definitions.js'
import { allToolDefs } from '../src/tools/definitions.js'

describe('ToolBridge', () => {
  let bridge: ToolBridge
  afterEach(async () => {
    if (bridge) await bridge.stop()
  })

  it('未带 token 返回 401', async () => {
    bridge = new ToolBridge()
    bridge.register('echo', async (args: unknown) => args)
    await bridge.start()
    const res = await fetch(`${bridge.url()}/tools/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    })
    expect(res.status).toBe(401)
  })

  it('带 token 正常调用并返回数据', async () => {
    bridge = new ToolBridge()
    bridge.register('echo', async (args: unknown) => args)
    await bridge.start()
    const res = await fetch(`${bridge.url()}/tools/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ a: 1 }),
    })
    const data = (await res.json()) as { ok: boolean; data: { a: number } }
    expect(data.ok).toBe(true)
    expect(data.data.a).toBe(1)
  })

  it('handler 抛错返回 ok:false', async () => {
    bridge = new ToolBridge()
    bridge.register('boom', async () => {
      throw new Error('炸了')
    })
    await bridge.start()
    const res = await fetch(`${bridge.url()}/tools/boom`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}` },
      body: '{}',
    })
    const data = (await res.json()) as { ok: boolean; error: string }
    expect(data.ok).toBe(false)
    expect(data.error).toContain('炸了')
  })

  it('未知工具返回 404', async () => {
    bridge = new ToolBridge()
    await bridge.start()
    const res = await fetch(`${bridge.url()}/tools/nope`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}` },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })
})

describe('renderBridgePlugin', () => {
  it('生成包含全部工具定义的插件代码', () => {
    const defs: ToolDef[] = allToolDefs()
    const code = renderBridgePlugin('http://127.0.0.1:1234', 'tok', defs)
    for (const d of defs) {
      expect(code).toContain(`'${d.name}'`)
    }
    expect(code).toContain('Bearer')
    expect(code).toContain('http://127.0.0.1:1234')
  })
})
