import { b64ToBytes, bytesToB64 } from './bytes.js'
import { bootCipher, ed25519PublicKey, handshake, randomBytes, randomX25519, signAuth, x25519PublicKey, RemoteCipher } from './crypto.js'
import { openPlain, sealPlain, type E2ePlain } from './e2e.js'
import { REMOTE_PROTOCOL, decodeServerFrame, encodeFrame, type BindingView, type ClientFrame, type ClientRole, type ServerFrame } from './protocol.js'

export type LinkEvent =
  | { t: 'ready'; bindings: BindingView[] }
  | { t: 'pair-token'; token: string; expiresAt: number }
  | { t: 'pair-ask'; token: string; appId: string; appName: string; signPub: string; x25519Pub: string }
  | { t: 'presence'; desktopId: string; online: boolean }
  | { t: 'pair-result'; ok: boolean; desktopId?: string; appId?: string; error?: string }
  | { t: 'unbound'; desktopId: string }
  | { t: 'secure'; peerId: string }
  | { t: 'req'; from: string; id: string; ch: string; p?: unknown }
  | { t: 'push'; from: string; what: string; p?: unknown }
  | { t: 'error'; code: string; message: string }

interface Peer {
  staticPub: Uint8Array
  boot: RemoteCipher
  ephSecret: Uint8Array | null
  session: RemoteCipher | null
  hello: { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> } | null
  /** 进行中的握手。配对成功后的 presence 会再调一次 hello，不能另起一轮把临时密钥换掉。 */
  helloPromise: Promise<void> | null
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface RelayLinkOptions {
  role: ClientRole
  id: string
  signSecret: Uint8Array
  x25519Secret: Uint8Array
  sendRaw: (text: string) => void
  onEvent: (ev: LinkEvent) => void
  requestTimeoutMs?: number
}

/**
 * 一条到中转站的连接：认证、配对、以及和已绑定对端的端到端通道。
 * 不管套接字。桌面端、App、测试里的假手机共用这一份。
 */
export class RelayLink {
  private peers = new Map<string, Peer>()
  private pending = new Map<string, Pending>()
  private authed = false
  /** 这些对端的后续密文由原生层解密，JS 不再打开。 */
  private externalRecv = new Set<string>()
  private holdingRecv = false
  private heldRaw: string[] = []
  readonly id: string
  readonly x25519Pub: string

  constructor(private opts: RelayLinkOptions) {
    this.id = opts.id
    this.x25519Pub = bytesToB64(x25519PublicKey(opts.x25519Secret))
  }

  handleRaw(raw: string): void {
    let frame: ServerFrame
    try {
      frame = decodeServerFrame(raw)
    } catch (err) {
      this.opts.onEvent({ t: 'error', code: 'bad-frame', message: (err as Error).message })
      return
    }
    if (frame.t === 'challenge') {
      this.replyAuth(frame.nonce)
      return
    }
    if (frame.t === 'error') {
      this.opts.onEvent({ t: 'error', code: frame.code, message: frame.message })
      return
    }
    if (!this.authed && frame.t !== 'auth-ok') return
    if (frame.t === 'auth-ok') {
      this.authed = true
      for (const b of frame.bindings) {
        const pub = this.opts.role === 'desktop' ? b.appX25519 : b.desktopX25519
        const id = this.opts.role === 'desktop' ? b.appId : b.desktopId
        if (pub) this.setPeerKey(id, pub)
      }
      this.opts.onEvent({ t: 'ready', bindings: frame.bindings })
      return
    }
    if (frame.t === 'pair-token') {
      this.opts.onEvent({ t: 'pair-token', token: frame.token, expiresAt: frame.expiresAt })
      return
    }
    if (frame.t === 'pair-ask' || frame.t === 'pair-result' || frame.t === 'presence') {
      this.opts.onEvent(frame)
      return
    }
    if (frame.t === 'unbound') {
      this.peers.delete(frame.desktopId)
      this.externalRecv.delete(frame.desktopId)
      this.opts.onEvent(frame)
      return
    }
    if (frame.t === 'pong') return
    if (frame.t === 'e2e') {
      if (this.externalRecv.has(frame.from)) return
      if (this.holdingRecv) {
        const peer = this.peers.get(frame.from)
        if (peer?.session) {
          this.heldRaw.push(raw)
          return
        }
      }
      this.onE2e(frame.from, frame.body)
    }
  }

  /** 握手刚完成、还没把接收密钥交给原生层时，先把新来的密文扣住。 */
  beginRecvHandoff(): void {
    this.holdingRecv = true
  }

  exportRecv(peerId: string): { recvKey: string; recvN: number } | null {
    const peer = this.peers.get(peerId)
    if (!peer?.session) return null
    return peer.session.snapshotRecv()
  }

  commitRecvHandoff(peerId: string): string[] {
    this.externalRecv.add(peerId)
    this.holdingRecv = false
    return this.heldRaw.splice(0)
  }

  cancelRecvHandoff(): void {
    this.holdingRecv = false
    const held = this.heldRaw.splice(0)
    for (const raw of held) this.handleRaw(raw)
  }

  /** 原生层已经解开的明文。n 用来对齐接收序号。 */
  ingestPlain(from: string, msg: E2ePlain, n: number): void {
    const peer = this.peers.get(from)
    if (!peer?.session) return
    peer.session.acceptRecv(n)
    this.dispatchPlain(from, msg)
  }

  setPeerKey(peerId: string, x25519PubB64: string): void {
    const prev = this.peers.get(peerId)
    if (prev && bytesToB64(prev.staticPub) === x25519PubB64) return
    const staticPub = b64ToBytes(x25519PubB64)
    this.peers.set(peerId, { staticPub, boot: bootCipher(this.opts.x25519Secret, staticPub), ephSecret: null, session: null, hello: null, helloPromise: null })
  }

  peerReady(peerId: string): boolean {
    return !!this.peers.get(peerId)?.session
  }

  /** App 发起握手。电脑收到后回自己的临时公钥。重复调用复用同一次握手。 */
  hello(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) return Promise.reject(new Error('还没有对端公钥'))
    if (peer.session) return Promise.resolve()
    if (peer.helloPromise) return peer.helloPromise
    const eph = randomX25519()
    peer.ephSecret = eph.secretKey
    this.sendRaw({ t: 'e2e', to: peerId, body: sealPlain(peer.boot, { t: 'hs', eph: bytesToB64(eph.publicKey) }) })
    peer.helloPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.hello = null
        peer.helloPromise = null
        reject(new Error('加密握手超时'))
      }, 10_000)
      peer.hello = { resolve, reject, timer }
    })
    return peer.helloPromise
  }

  request(peerId: string, channel: string, payload?: unknown): Promise<unknown> {
    const peer = this.peers.get(peerId)
    if (!peer?.session) return Promise.reject(new Error('加密通道还没建立'))
    const id = bytesToB64(randomBytes(9)).replace(/=+$/, '')
    const slow = channel === 'chat:send' || channel === 'group:send'
    const timeout = this.opts.requestTimeoutMs ?? (slow ? 95 * 60 * 1000 : 30_000)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('电脑没有在时间内回应'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.sendPlain(peerId, { t: 'req', id, ch: channel, p: payload })
    })
  }

  respond(peerId: string, id: string, ok: boolean, r?: unknown, e?: string): void {
    this.sendPlain(peerId, ok ? { t: 'res', id, ok: true, r } : { t: 'res', id, ok: false, e: e || '调用失败' })
  }

  sendPlain(peerId: string, msg: E2ePlain): void {
    const peer = this.peers.get(peerId)
    if (!peer?.session) throw new Error('加密通道还没建立')
    this.sendRaw({ t: 'e2e', to: peerId, body: sealPlain(peer.session, msg) })
  }

  pairOpen(desktopName: string): void {
    this.sendRaw({ t: 'pair-open', desktopName, x25519Pub: this.x25519Pub })
  }

  pairRequest(token: string, appName: string): void {
    this.sendRaw({ t: 'pair-request', token, appName, x25519Pub: this.x25519Pub })
  }

  pairConfirm(token: string, accept: boolean, replace?: boolean): void {
    this.sendRaw({ t: 'pair-confirm', token, accept, replace: replace === true })
  }

  unbind(desktopId?: string): void {
    this.sendRaw({ t: 'unbind', desktopId })
  }

  failAll(message: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
    }
    this.pending.clear()
    for (const peer of this.peers.values()) {
      if (!peer.hello) continue
      clearTimeout(peer.hello.timer)
      peer.hello.reject(new Error(message))
      peer.hello = null
      peer.helloPromise = null
    }
  }

  private replyAuth(nonce: string): void {
    const signPub = bytesToB64(ed25519PublicKey(this.opts.signSecret))
    const sig = bytesToB64(signAuth(this.opts.signSecret, nonce, this.opts.role, this.opts.id, signPub))
    this.sendRaw({ t: 'auth', role: this.opts.role, id: this.opts.id, protocol: REMOTE_PROTOCOL, signPub, sig })
  }

  private sendRaw(frame: ClientFrame): void {
    this.opts.sendRaw(encodeFrame(frame))
  }

  private dispatchPlain(from: string, msg: E2ePlain): void {
    if (msg.t === 'res') {
      const wait = this.pending.get(msg.id)
      if (!wait) return
      clearTimeout(wait.timer)
      this.pending.delete(msg.id)
      if (msg.ok) wait.resolve(msg.r)
      else wait.reject(new Error(msg.e || '调用失败'))
      return
    }
    if (msg.t === 'push') {
      this.opts.onEvent({ t: 'push', from, what: msg.what, p: msg.p })
      return
    }
    if (msg.t === 'req') this.opts.onEvent({ t: 'req', from, id: msg.id, ch: msg.ch, p: msg.p })
  }

  private onE2e(from: string, body: string): void {
    const peer = this.peers.get(from)
    if (!peer) {
      this.opts.onEvent({ t: 'error', code: 'e2e', message: '收到了还没交换公钥的对端消息' })
      return
    }
    try {
      if (!peer.session) {
        this.acceptHello(from, peer, body)
        return
      }
      const msg = openPlain(peer.session, body)
      this.dispatchPlain(from, msg)
    } catch (err) {
      this.opts.onEvent({ t: 'error', code: 'e2e', message: (err as Error).message })
    }
  }

  private acceptHello(from: string, peer: Peer, body: string): void {
    const msg = openPlain(peer.boot, body)
    if (msg.t !== 'hs') throw new Error('握手帧不是 hs')
    const peerEph = b64ToBytes(msg.eph)
    if (this.opts.role === 'desktop') {
      const eph = randomX25519()
      peer.ephSecret = eph.secretKey
      const hs = handshake({
        myStaticPriv: this.opts.x25519Secret,
        myEphPriv: eph.secretKey,
        peerStaticPub: peer.staticPub,
        peerEphPub: peerEph,
      })
      const reply = sealPlain(peer.boot, { t: 'hs', eph: bytesToB64(eph.publicKey) })
      peer.session = new RemoteCipher(hs.sendKey, hs.recvKey)
      this.sendRaw({ t: 'e2e', to: from, body: reply })
      this.opts.onEvent({ t: 'secure', peerId: from })
      return
    }
    if (!peer.ephSecret) throw new Error('还没发起握手就收到了临时公钥')
    const hs = handshake({
      myStaticPriv: this.opts.x25519Secret,
      myEphPriv: peer.ephSecret,
      peerStaticPub: peer.staticPub,
      peerEphPub: peerEph,
    })
    peer.session = new RemoteCipher(hs.sendKey, hs.recvKey)
    const hello = peer.hello
    peer.hello = null
    peer.helloPromise = null
    if (hello) {
      clearTimeout(hello.timer)
      hello.resolve()
    }
    this.opts.onEvent({ t: 'secure', peerId: from })
  }
}
