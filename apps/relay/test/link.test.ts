import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { RelayLink, RemoteCipher, b64ToBytes, decodePairingQr, encodePairingQr, openPlain, randomEd25519, randomX25519, safetyCode } from '../../../packages/core/src/remote/index.js'
import { PhoneLink } from '../../mobile/src/session.js'
import { startRelay, type RunningRelay } from '../src/server.js'

function attach(url: string, role: 'desktop' | 'app', sign = randomEd25519(), box = randomX25519()) {
  const events: Array<{ t: string }> = []
  let link!: RelayLink
  const ws = new WebSocket(url)
  link = new RelayLink({
    role,
    id: Buffer.from(sign.publicKey).toString('base64url').slice(0, 22),
    signSecret: sign.secretKey,
    x25519Secret: box.secretKey,
    sendRaw: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text)
    },
    onEvent: (ev) => events.push(ev),
  })
  ws.on('message', (data) => link.handleRaw(data.toString()))
  return new Promise<{ link: RelayLink; events: Array<{ t: string }>; close: () => void; box: typeof box }>((resolve, reject) => {
    ws.once('open', () => resolve({ link, events, close: () => ws.close(), box }))
    ws.once('error', reject)
  })
}

function waitFor(events: Array<{ t: string }>, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (events.some((e) => e.t === type)) return resolve()
      if (Date.now() - start > 4000) return reject(new Error(`没等到 ${type}`))
      setTimeout(tick, 15)
    }
    tick()
  })
}

describe('端到端链路', () => {
  let relay: RunningRelay
  let dir: string
  const sockets: Array<{ close: () => void }> = []

  afterEach(async () => {
    for (const s of sockets) s.close()
    sockets.length = 0
    if (relay) await relay.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('配对后手机能调用电脑，安全码两边一致，未放行的通道会被拒绝', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'jeff-link-'))
    relay = await startRelay({ dataFile: path.join(dir, 'relay.db'), port: 0 })
    const desk = await attach(relay.url, 'desktop')
    const app = await attach(relay.url, 'app')
    sockets.push(desk, app)
    await waitFor(desk.events, 'ready')
    await waitFor(app.events, 'ready')

    const tokenP = new Promise<{ token: string; expiresAt: number }>((resolve) => {
      const orig = desk.events.push.bind(desk.events)
      desk.events.push = (ev) => {
        orig(ev)
        if (ev.t === 'pair-token') resolve(ev as unknown as { token: string; expiresAt: number })
        return 0
      }
    })
    desk.link.pairOpen('测试电脑')
    const token = await tokenP
    const qr = encodePairingQr({
      relay: relay.url,
      certSha256: 'TEST',
      desktopId: desk.link.id,
      desktopName: '测试电脑',
      desktopX25519Pub: desk.link.x25519Pub,
      token: token.token,
    })
    const parsed = decodePairingQr(qr)
    app.link.setPeerKey(parsed.desktopId, parsed.desktopX25519Pub)
    const asked = new Promise<{ safety: string }>((resolve) => {
      const orig = desk.events.push.bind(desk.events)
      desk.events.push = (ev) => {
        orig(ev)
        if (ev.t === 'pair-ask') {
          const ask = ev as unknown as { x25519Pub: string; appId: string }
          desk.link.setPeerKey(ask.appId, ask.x25519Pub)
          resolve({ safety: safetyCode(b64ToBytes(desk.link.x25519Pub), b64ToBytes(ask.x25519Pub)) })
        }
        return 0
      }
    })
    app.link.pairRequest(parsed.token, '测试手机')
    const ask = await asked
    expect(ask.safety).toBe(safetyCode(b64ToBytes(desk.link.x25519Pub), b64ToBytes(app.link.x25519Pub)))
    desk.link.pairConfirm(token.token, true)
    await waitFor(app.events, 'pair-result')
    await app.link.hello(parsed.desktopId)
    expect(desk.link.peerReady(app.link.id)).toBe(true)

    const prev = desk.events.push.bind(desk.events)
    desk.events.push = (ev) => {
      const n = prev(ev)
      if (ev.t === 'req') {
        const req = ev as unknown as { from: string; id: string; ch: string; p?: unknown }
        if (req.ch === 'dialog:pickDir') desk.link.respond(req.from, req.id, false, undefined, '改为 fs:listDirs')
        else desk.link.respond(req.from, req.id, true, { echoed: req.p })
      }
      return n
    }
    const echoed = await app.link.request(parsed.desktopId, 'agents:list')
    expect(echoed).toEqual({ echoed: undefined })
    await expect(app.link.request(parsed.desktopId, 'dialog:pickDir')).rejects.toThrow(/fs:listDirs/)

    app.link.beginRecvHandoff()
    desk.link.sendPlain(app.link.id, { t: 'push', what: 'note', p: { title: '小杰', body: '收到', kind: 'agent', id: 'xiaojie' } })
    await new Promise((r) => setTimeout(r, 400))
    const snap = app.link.exportRecv(parsed.desktopId)
    expect(snap).toBeTruthy()
    const held = app.link.commitRecvHandoff(parsed.desktopId)
    expect(held).toHaveLength(1)
    const frame = JSON.parse(held[0]) as { from: string; body: string }
    const wrap = JSON.parse(frame.body) as { n: number }
    expect(wrap.n).toBe(snap!.recvN)
    const box = new RemoteCipher(new Uint8Array(32), b64ToBytes(snap!.recvKey))
    for (let i = 0; i < snap!.recvN; i++) box.acceptRecv(i)
    const before = app.events.filter((e) => e.t === 'push').length
    desk.link.sendPlain(app.link.id, { t: 'push', what: 'note', p: { title: '后到', body: '不应由页面解开', kind: 'agent', id: 'xiaojie' } })
    await new Promise((r) => setTimeout(r, 300))
    expect(app.events.filter((e) => e.t === 'push')).toHaveLength(before)
    app.link.ingestPlain(frame.from, openPlain(box, frame.body), wrap.n)
    const note = app.events.filter((e) => e.t === 'push').at(-1) as { what?: string; p?: { title?: string } }
    expect(note.what).toBe('note')
    expect(note.p?.title).toBe('小杰')
  })

  it('手机连接断开后会自己重连', async () => {
    const store = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size
        },
      },
    })
    dir = mkdtempSync(path.join(os.tmpdir(), 'jeff-link-'))
    relay = await startRelay({ dataFile: path.join(dir, 'relay.db'), port: 0 })
    const phone = new PhoneLink()
    const stop = () => {
      const raw = phone as unknown as { wantLink: boolean; retryTimer: ReturnType<typeof setTimeout> | null; sockId: number; ws?: { close: () => void } }
      raw.wantLink = false
      raw.sockId += 1
      if (raw.retryTimer) clearTimeout(raw.retryTimer)
      raw.ws?.close()
    }
    try {
      await phone.connect(relay.url, '')
      const first = (phone as unknown as { ws?: WebSocket }).ws
      expect(first?.readyState).toBe(WebSocket.OPEN)
      first?.close()
      const again = await new Promise<WebSocket>((resolve, reject) => {
        const start = Date.now()
        const tick = () => {
          const ws = (phone as unknown as { ws?: WebSocket }).ws
          if (ws && ws !== first && ws.readyState === WebSocket.OPEN) return resolve(ws)
          if (Date.now() - start > 8000) return reject(new Error('断开后没有重连'))
          setTimeout(tick, 40)
        }
        tick()
      })
      expect(again.readyState).toBe(WebSocket.OPEN)
    } finally {
      stop()
    }
  })
})
