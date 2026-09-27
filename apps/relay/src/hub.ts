import { randomBytes } from 'node:crypto'
import { b64ToBytes } from '../../../packages/core/src/remote/bytes.js'
import { verifyAuth } from '../../../packages/core/src/remote/crypto.js'
import {
  REMOTE_PROTOCOL,
  decodeClientFrame,
  encodeFrame,
  type BindingView,
  type ClientFrame,
  type ClientRole,
  type ServerFrame,
} from '../../../packages/core/src/remote/protocol.js'
import { Store, type BindingRow } from './store.js'

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const PAIR_TTL_MS = 5 * 60 * 1000

export interface RelaySocket {
  send(text: string): void
  close(): void
}

export interface HubOptions {
  now?: () => number
  pairTtlMs?: number
  ratePerSec?: number
}

interface Session {
  sock: RelaySocket
  nonce: string
  authed: boolean
  role?: ClientRole
  id?: string
  signPub?: string
  times: number[]
}

export class Hub {
  private sessions = new Map<RelaySocket, Session>()
  private online = new Map<string, Session>()
  private closed = false
  private now: () => number
  private pairTtlMs: number
  private ratePerSec: number

  constructor(
    private store: Store,
    opts: HubOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.pairTtlMs = opts.pairTtlMs ?? PAIR_TTL_MS
    this.ratePerSec = opts.ratePerSec ?? 30
  }

  /** 停机后迟到的 close 事件不再查库。 */
  stop(): void {
    this.closed = true
    this.sessions.clear()
    this.online.clear()
  }

  connect(sock: RelaySocket): void {
    if (this.closed) return
    const nonce = randomBytes(24).toString('base64url')
    this.sessions.set(sock, { sock, nonce, authed: false, times: [] })
    this.send(sock, { t: 'challenge', nonce })
  }

  disconnect(sock: RelaySocket): void {
    if (this.closed) return
    const s = this.sessions.get(sock)
    this.sessions.delete(sock)
    if (!s?.authed || !s.id || !s.role) return
    const key = this.key(s.role, s.id)
    if (this.online.get(key) !== s) return
    this.online.delete(key)
    if (s.role === 'desktop') this.tellApp(s.id, { t: 'presence', desktopId: s.id, online: false })
  }

  message(sock: RelaySocket, raw: string): void {
    if (this.closed) return
    const s = this.sessions.get(sock)
    if (!s) return
    if (!this.allow(s)) {
      this.fail(sock, 'rate', '消息过于频繁')
      return
    }
    let frame: ClientFrame
    try {
      frame = decodeClientFrame(raw)
    } catch (err) {
      this.fail(sock, 'bad-frame', (err as Error).message.slice(0, 200))
      return
    }
    if (!s.authed) {
      if (frame.t !== 'auth') {
        this.fail(sock, 'auth', '请先完成身份认证')
        return
      }
      this.onAuth(s, frame)
      return
    }
    try {
      this.onAuthed(s, frame)
    } catch (err) {
      this.fail(sock, 'bad-frame', (err as Error).message.slice(0, 200))
    }
  }

  private onAuth(s: Session, frame: Extract<ClientFrame, { t: 'auth' }>): void {
    if (frame.protocol !== REMOTE_PROTOCOL) {
      this.fail(s.sock, 'protocol', `协议版本 ${frame.protocol} 不受支持，当前是 ${REMOTE_PROTOCOL}`)
      return
    }
    if (!ID_RE.test(frame.id)) {
      this.fail(s.sock, 'auth', 'id 只能是 8 到 64 位字母、数字、下划线或短横线')
      return
    }
    let pub: Uint8Array
    let sig: Uint8Array
    try {
      pub = b64ToBytes(frame.signPub)
      sig = b64ToBytes(frame.sig)
    } catch {
      this.fail(s.sock, 'auth', '公钥或签名不是合法的 base64')
      return
    }
    if (pub.length !== 32 || sig.length !== 64) {
      this.fail(s.sock, 'auth', '公钥或签名长度不对')
      return
    }
    if (!verifyAuth(pub, sig, s.nonce, frame.role, frame.id, frame.signPub)) {
      this.fail(s.sock, 'auth', '签名校验失败')
      return
    }
    const known = this.store.getPeer(frame.id)
    if (known && (known.sign_pub !== frame.signPub || known.role !== frame.role)) {
      this.fail(s.sock, 'auth', '这个 id 已经登记过另一把公钥')
      return
    }
    const now = this.now()
    if (!known) {
      this.store.upsertPeer({ id: frame.id, role: frame.role, sign_pub: frame.signPub, x25519_pub: '', name: '' }, now)
    } else {
      this.store.touch(frame.id, now)
    }
    s.authed = true
    s.role = frame.role
    s.id = frame.id
    s.signPub = frame.signPub
    const prev = this.online.get(this.key(frame.role, frame.id))
    if (prev && prev !== s) {
      this.fail(prev.sock, 'replaced', '这个身份在别处连上了，当前连接被替换')
      prev.sock.close()
      this.sessions.delete(prev.sock)
    }
    this.online.set(this.key(frame.role, frame.id), s)
    this.send(s.sock, { t: 'auth-ok', id: frame.id, bindings: this.viewsFor(frame.role, frame.id) })
    if (frame.role === 'desktop') this.tellApp(frame.id, { t: 'presence', desktopId: frame.id, online: true })
    if (frame.role === 'app') {
      for (const b of this.store.bindingsByApp(frame.id)) {
        const desk = this.online.get(this.key('desktop', b.desktop_id))
        this.send(s.sock, { t: 'presence', desktopId: b.desktop_id, online: !!desk })
      }
    }
  }

  private onAuthed(s: Session, frame: ClientFrame): void {
    if (frame.t === 'auth') {
      this.fail(s.sock, 'auth', '已经认证过了')
      return
    }
    if (frame.t === 'ping') {
      this.send(s.sock, { t: 'pong' })
      return
    }
    if (frame.t === 'pair-open') return this.onPairOpen(s, frame)
    if (frame.t === 'pair-request') return this.onPairRequest(s, frame)
    if (frame.t === 'pair-confirm') return this.onPairConfirm(s, frame)
    if (frame.t === 'unbind') return this.onUnbind(s, frame.desktopId)
    if (frame.t === 'e2e') return this.onE2e(s, frame)
  }

  private onPairOpen(s: Session, frame: Extract<ClientFrame, { t: 'pair-open' }>): void {
    if (s.role !== 'desktop' || !s.id) {
      this.fail(s.sock, 'role', '只有电脑能发起配对')
      return
    }
    const now = this.now()
    this.store.setX25519(s.id, frame.x25519Pub, frame.desktopName, now)
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + this.pairTtlMs
    this.store.putPairing(token, s.id, expiresAt)
    this.send(s.sock, { t: 'pair-token', token, expiresAt })
  }

  private onPairRequest(s: Session, frame: Extract<ClientFrame, { t: 'pair-request' }>): void {
    if (s.role !== 'app' || !s.id || !s.signPub) {
      this.fail(s.sock, 'role', '只有手机能接受配对')
      return
    }
    const row = this.store.getPairing(frame.token)
    const now = this.now()
    if (!row || row.expires_at < now) {
      this.fail(s.sock, 'expired', '配对码无效或已过期')
      return
    }
    if (row.app_id && row.app_id !== s.id) {
      this.fail(s.sock, 'expired', '配对码已经被别的手机使用')
      return
    }
    this.store.claimPairing(frame.token, s.id, frame.appName, s.signPub, frame.x25519Pub)
    this.store.setX25519(s.id, frame.x25519Pub, frame.appName, now)
    const desk = this.online.get(this.key('desktop', row.desktop_id))
    if (!desk) {
      this.fail(s.sock, 'offline', '电脑不在线，无法确认配对')
      return
    }
    this.send(desk.sock, {
      t: 'pair-ask',
      token: frame.token,
      appId: s.id,
      appName: frame.appName,
      signPub: s.signPub,
      x25519Pub: frame.x25519Pub,
    })
  }

  private onPairConfirm(s: Session, frame: Extract<ClientFrame, { t: 'pair-confirm' }>): void {
    if (s.role !== 'desktop' || !s.id) {
      this.fail(s.sock, 'role', '只有电脑能确认配对')
      return
    }
    const row = this.store.getPairing(frame.token)
    if (!row || row.desktop_id !== s.id || row.expires_at < this.now()) {
      this.fail(s.sock, 'expired', '配对码无效或已过期')
      return
    }
    if (!frame.accept) {
      this.store.deletePairing(frame.token)
      this.tell(row.app_id, 'app', { t: 'pair-result', ok: false, error: '电脑拒绝了配对' })
      this.send(s.sock, { t: 'pair-result', ok: false, error: '已拒绝' })
      return
    }
    if (!row.app_id) {
      this.fail(s.sock, 'expired', '还没有手机扫这个码')
      return
    }
    const existing = this.store.bindingByDesktop(s.id)
    if (existing && existing.app_id !== row.app_id && !frame.replace) {
      this.fail(s.sock, 'bound', '这台电脑已经绑定了另一部手机，确认时要带上替换')
      return
    }
    if (existing && existing.app_id !== row.app_id) {
      this.tell(existing.app_id, 'app', { t: 'unbound', desktopId: s.id })
    }
    this.store.upsertBinding(s.id, row.app_id, this.now())
    this.store.deletePairing(frame.token)
    const result: ServerFrame = { t: 'pair-result', ok: true, desktopId: s.id, appId: row.app_id }
    this.send(s.sock, result)
    this.tell(row.app_id, 'app', result)
    this.tell(row.app_id, 'app', { t: 'presence', desktopId: s.id, online: true })
  }

  private onUnbind(s: Session, desktopId: string | undefined): void {
    if (!s.id || !s.role) return
    const target = s.role === 'desktop' ? s.id : desktopId
    if (!target) {
      this.fail(s.sock, 'bad-frame', '手机解除绑定需要指定 desktopId')
      return
    }
    const row = this.store.bindingByDesktop(target)
    if (!row) {
      this.fail(s.sock, 'forbidden', '没有这条绑定')
      return
    }
    if (s.role === 'app' && row.app_id !== s.id) {
      this.fail(s.sock, 'forbidden', '不能解除别人的绑定')
      return
    }
    if (s.role === 'desktop' && row.desktop_id !== s.id) return
    this.store.deleteBinding(target)
    const note: ServerFrame = { t: 'unbound', desktopId: target }
    this.send(s.sock, note)
    if (s.role === 'desktop') this.tell(row.app_id, 'app', note)
    else this.tell(target, 'desktop', note)
  }

  private onE2e(s: Session, frame: Extract<ClientFrame, { t: 'e2e' }>): void {
    if (!s.id || !s.role) return
    if (s.role === 'app') {
      const row = this.store.bindingByDesktop(frame.to)
      if (!row || row.app_id !== s.id) {
        this.fail(s.sock, 'forbidden', '没有绑定这台电脑')
        return
      }
      if (!this.tell(frame.to, 'desktop', { t: 'e2e', from: s.id, body: frame.body })) {
        this.fail(s.sock, 'offline', '电脑不在线')
      }
      return
    }
    const row = this.store.bindingByDesktop(s.id)
    if (!row || row.app_id !== frame.to) {
      this.fail(s.sock, 'forbidden', '没有绑定这部手机')
      return
    }
    if (!this.tell(frame.to, 'app', { t: 'e2e', from: s.id, body: frame.body })) {
      this.fail(s.sock, 'offline', '手机不在线')
    }
  }

  private viewsFor(role: ClientRole, id: string): BindingView[] {
    const rows: BindingRow[] = role === 'app' ? this.store.bindingsByApp(id) : this.store.bindingByDesktop(id) ? [this.store.bindingByDesktop(id)!] : []
    return rows.map((b) => this.toView(b))
  }

  private toView(b: BindingRow): BindingView {
    const desk = this.store.getPeer(b.desktop_id)
    const app = this.store.getPeer(b.app_id)
    return {
      desktopId: b.desktop_id,
      appId: b.app_id,
      desktopName: desk?.name || '',
      appName: app?.name || '',
      desktopX25519: desk?.x25519_pub || '',
      appX25519: app?.x25519_pub || '',
    }
  }

  private tellApp(desktopId: string, frame: ServerFrame): void {
    const row = this.store.bindingByDesktop(desktopId)
    if (row) this.tell(row.app_id, 'app', frame)
  }

  private tell(id: string, role: ClientRole, frame: ServerFrame): boolean {
    const s = this.online.get(this.key(role, id))
    if (!s) return false
    this.send(s.sock, frame)
    return true
  }

  private allow(s: Session): boolean {
    const now = this.now()
    s.times = s.times.filter((t) => now - t < 1000)
    if (s.times.length >= this.ratePerSec) return false
    s.times.push(now)
    return true
  }

  private key(role: ClientRole, id: string): string {
    return `${role}:${id}`
  }

  private send(sock: RelaySocket, frame: ServerFrame): void {
    sock.send(encodeFrame(frame))
  }

  private fail(sock: RelaySocket, code: string, message: string): void {
    this.send(sock, { t: 'error', code, message })
  }
}
