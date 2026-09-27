import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  REMOTE_PROTOCOL,
  bytesToB64,
  decodeServerFrame,
  encodeFrame,
  randomEd25519,
  signAuth,
  type ClientFrame,
  type ClientRole,
  type ServerFrame,
} from '../../../packages/core/src/remote/index.js'
import { startRelay, type RunningRelay } from '../src/server.js'

class Peer {
  private q: ServerFrame[] = []
  private waiters: Array<(f: ServerFrame) => void> = []
  private constructor(private ws: WebSocket) {
    ws.on('message', (data) => {
      const frame = decodeServerFrame(data.toString())
      const waiter = this.waiters.shift()
      if (waiter) waiter(frame)
      else this.q.push(frame)
    })
  }

  static connect(url: string): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const peer = new Peer(ws)
      ws.once('open', () => resolve(peer))
      ws.once('error', reject)
    })
  }

  next(): Promise<ServerFrame> {
    const queued = this.q.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待帧超时')), 3000)
      this.waiters.push((f) => {
        clearTimeout(timer)
        resolve(f)
      })
    })
  }

  send(frame: ClientFrame): void {
    this.ws.send(encodeFrame(frame))
  }

  close(): void {
    this.ws.close()
  }
}

interface Ident {
  id: string
  role: ClientRole
  signPub: string
  secretKey: Uint8Array
}

function ident(role: ClientRole, id: string): Ident {
  const keys = randomEd25519()
  return { id, role, signPub: bytesToB64(keys.publicKey), secretKey: keys.secretKey }
}

async function login(url: string, who: Ident): Promise<{ peer: Peer; ok: Extract<ServerFrame, { t: 'auth-ok' }> }> {
  const peer = await Peer.connect(url)
  const challenge = await peer.next()
  if (challenge.t !== 'challenge') throw new Error(`期望 challenge，得到 ${challenge.t}`)
  peer.send({
    t: 'auth',
    role: who.role,
    id: who.id,
    protocol: REMOTE_PROTOCOL,
    signPub: who.signPub,
    sig: bytesToB64(signAuth(who.secretKey, challenge.nonce, who.role, who.id, who.signPub)),
  })
  const ok = await peer.next()
  if (ok.t !== 'auth-ok') throw new Error(`认证失败 ${JSON.stringify(ok)}`)
  return { peer, ok }
}

describe('中转站', () => {
  let relay: RunningRelay | undefined
  const xpub = bytesToB64(new Uint8Array(32).fill(9))

  afterEach(async () => {
    await relay?.close()
    relay = undefined
  })

  async function boot(opts: { ratePerSec?: number; pairTtlMs?: number } = {}): Promise<string> {
    relay = await startRelay({ dataFile: ':memory:', host: '127.0.0.1', port: 0, ...opts })
    return relay.url
  }

  it('错误签名进不来，协议版本不对会被拒绝', async () => {
    const url = await boot()
    const who = ident('desktop', 'desk_bad_01')
    const peer = await Peer.connect(url)
    const challenge = await peer.next()
    if (challenge.t !== 'challenge') throw new Error('no challenge')
    peer.send({
      t: 'auth',
      role: 'desktop',
      id: who.id,
      protocol: REMOTE_PROTOCOL,
      signPub: who.signPub,
      sig: bytesToB64(new Uint8Array(64).fill(1)),
    })
    const denied = await peer.next()
    expect(denied).toMatchObject({ t: 'error', code: 'auth' })
    peer.send({
      t: 'auth',
      role: 'desktop',
      id: who.id,
      protocol: 99,
      signPub: who.signPub,
      sig: bytesToB64(signAuth(who.secretKey, challenge.nonce, 'desktop', who.id, who.signPub)),
    })
    const old = await peer.next()
    expect(old).toMatchObject({ t: 'error', code: 'protocol' })
    peer.close()
  })

  it('一台电脑只能绑一部手机，换绑必须显式替换；一部手机可以绑多台电脑', async () => {
    const url = await boot()
    const desk = ident('desktop', 'desk_home_1')
    const desk2 = ident('desktop', 'desk_office1')
    const app = ident('app', 'app_phone_01')
    const other = ident('app', 'app_phone_02')
    const d = await login(url, desk)
    d.peer.send({ t: 'pair-open', desktopName: '家里的电脑', x25519Pub: xpub })
    const tokenFrame = await d.peer.next()
    if (tokenFrame.t !== 'pair-token') throw new Error(JSON.stringify(tokenFrame))

    const a = await login(url, app)
    a.peer.send({ t: 'pair-request', token: tokenFrame.token, appName: '我的手机', x25519Pub: xpub })
    const ask = await d.peer.next()
    expect(ask).toMatchObject({ t: 'pair-ask', appId: app.id, appName: '我的手机' })
    if (ask.t !== 'pair-ask') return
    d.peer.send({ t: 'pair-confirm', token: ask.token, accept: true })
    expect(await d.peer.next()).toMatchObject({ t: 'pair-result', ok: true })
    expect(await a.peer.next()).toMatchObject({ t: 'pair-result', ok: true, desktopId: desk.id })
    expect(await a.peer.next()).toMatchObject({ t: 'presence', desktopId: desk.id, online: true })

    d.peer.send({ t: 'pair-open', desktopName: '家里的电脑', x25519Pub: xpub })
    const token2 = await d.peer.next()
    if (token2.t !== 'pair-token') throw new Error('no token2')
    const o = await login(url, other)
    o.peer.send({ t: 'pair-request', token: token2.token, appName: '另一部', x25519Pub: xpub })
    const ask2 = await d.peer.next()
    if (ask2.t !== 'pair-ask') throw new Error(JSON.stringify(ask2))
    d.peer.send({ t: 'pair-confirm', token: ask2.token, accept: true })
    expect(await d.peer.next()).toMatchObject({ t: 'error', code: 'bound' })
    d.peer.send({ t: 'pair-confirm', token: ask2.token, accept: true, replace: true })
    expect(await d.peer.next()).toMatchObject({ t: 'pair-result', ok: true, appId: other.id })
    expect(await a.peer.next()).toMatchObject({ t: 'unbound', desktopId: desk.id })

    const d2 = await login(url, desk2)
    d2.peer.send({ t: 'pair-open', desktopName: '办公室', x25519Pub: xpub })
    const token3 = await d2.peer.next()
    if (token3.t !== 'pair-token') throw new Error('no token3')
    o.peer.send({ t: 'pair-request', token: token3.token, appName: '另一部', x25519Pub: xpub })
    const ask3 = await d2.peer.next()
    if (ask3.t !== 'pair-ask') throw new Error(JSON.stringify(ask3))
    d2.peer.send({ t: 'pair-confirm', token: ask3.token, accept: true })
    expect(await d2.peer.next()).toMatchObject({ t: 'pair-result', ok: true })

    o.peer.close()
    const again = await login(url, other)
    expect(again.ok.bindings.map((b) => b.desktopId).sort()).toEqual([desk.id, desk2.id].sort())
    again.peer.close()
    d.peer.close()
    d2.peer.close()
    a.peer.close()
  })

  it('只在已绑定的两端之间原样转发密文，对端离线则报错', async () => {
    const url = await boot()
    const desk = ident('desktop', 'desk_fwd_001')
    const app = ident('app', 'app_fwd_0001')
    const stranger = ident('app', 'app_stranger')
    const d = await login(url, desk)
    const a = await login(url, app)
    d.peer.send({ t: 'pair-open', desktopName: '电脑', x25519Pub: xpub })
    const token = await d.peer.next()
    if (token.t !== 'pair-token') throw new Error('no token')
    a.peer.send({ t: 'pair-request', token: token.token, appName: '手机', x25519Pub: xpub })
    const ask = await d.peer.next()
    if (ask.t !== 'pair-ask') throw new Error('no ask')
    d.peer.send({ t: 'pair-confirm', token: ask.token, accept: true })
    await d.peer.next()
    await a.peer.next()
    await a.peer.next()

    a.peer.send({ t: 'e2e', to: desk.id, body: 'ciphertext-from-app' })
    expect(await d.peer.next()).toEqual({ t: 'e2e', from: app.id, body: 'ciphertext-from-app' })
    d.peer.send({ t: 'e2e', to: app.id, body: 'ciphertext-from-desk' })
    expect(await a.peer.next()).toEqual({ t: 'e2e', from: desk.id, body: 'ciphertext-from-desk' })

    const s = await login(url, stranger)
    s.peer.send({ t: 'e2e', to: desk.id, body: 'nope' })
    expect(await s.peer.next()).toMatchObject({ t: 'error', code: 'forbidden' })

    d.peer.close()
    expect(await a.peer.next()).toMatchObject({ t: 'presence', desktopId: desk.id, online: false })
    a.peer.send({ t: 'e2e', to: desk.id, body: 'later' })
    expect(await a.peer.next()).toMatchObject({ t: 'error', code: 'offline' })
    a.peer.close()
    s.peer.close()
  })

  it('超过每秒上限的消息被丢掉', async () => {
    const url = await boot({ ratePerSec: 2 })
    const who = ident('app', 'app_rate_001')
    const { peer } = await login(url, who)
    peer.send({ t: 'ping' })
    expect(await peer.next()).toEqual({ t: 'pong' })
    peer.send({ t: 'ping' })
    expect(await peer.next()).toMatchObject({ t: 'error', code: 'rate' })
    peer.close()
  })

  it('过期配对码不能用', async () => {
    const url = await boot({ pairTtlMs: -1 })
    const desk = ident('desktop', 'desk_exp_001')
    const app = ident('app', 'app_exp_0001')
    const d = await login(url, desk)
    const a = await login(url, app)
    d.peer.send({ t: 'pair-open', desktopName: '电脑', x25519Pub: xpub })
    const token = await d.peer.next()
    if (token.t !== 'pair-token') throw new Error('no token')
    a.peer.send({ t: 'pair-request', token: token.token, appName: '手机', x25519Pub: xpub })
    expect(await a.peer.next()).toMatchObject({ t: 'error', code: 'expired' })
    d.peer.close()
    a.peer.close()
  })
})
