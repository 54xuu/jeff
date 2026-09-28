import { Capacitor, registerPlugin } from '@capacitor/core'
import {
  RelayLink,
  applyRemoteStream,
  b64ToBytes,
  bytesToB64,
  decodePairingQr,
  randomEd25519,
  randomX25519,
  type BindingView,
  type E2ePlain,
  type LinkEvent,
  type PairingQr,
  type RemoteStreamFrame,
} from '@jeff/core/remote'

export interface NativeBridge {
  openSocket(opts: { url: string; pin: string }): Promise<void>
  sendText(opts: { text: string }): Promise<void>
  closeSocket(): Promise<void>
  notify(opts: { title: string; body: string; kind?: string; id?: string }): Promise<void>
  scan(): Promise<{ text: string }>
  pickImage(): Promise<{ dataUrl: string }>
  unlock(): Promise<{ ok: boolean; skipped?: boolean }>
  cacheGet(opts: { desktopId: string; key: string }): Promise<{ json: string }>
  cachePut(opts: { desktopId: string; key: string; json: string }): Promise<void>
  readDebugPair(): Promise<{ text: string }>
  openBattery(): Promise<void>
  minimize(): Promise<void>
  addListener(event: 'frame' | 'plain' | 'resume' | 'back', cb: (ev: { text?: string; from?: string; n?: number; json?: string; closed?: string }) => void): Promise<{ remove: () => Promise<void> }>
  armRecv(opts: { peerId: string; recvKey: string; recvN: number }): Promise<void>
  feedFrame(opts: { text: string }): Promise<void>
  goLive(): Promise<void>
  disarmRecv(opts: { peerId: string }): Promise<void>
  pullPlain(): Promise<{ items: Array<{ from: string; n: number; json: string }> }>
  takeNote(): Promise<{ kind: string; id: string; title: string }>
}

export const Native = registerPlugin<NativeBridge>('JeffSpike')

export interface DesktopPeer {
  id: string
  name: string
  online: boolean
  x25519: string
}

export interface PhonePush {
  what: string
  p?: unknown
}

interface Identity {
  id: string
  signSecret: Uint8Array
  x25519Secret: Uint8Array
}

const ID_KEY = 'jeff-phone-identity'

function freshId(pub: Uint8Array): string {
  return bytesToB64(pub).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '').slice(0, 22)
}

function loadIdentity(): Identity {
  const raw = localStorage.getItem(ID_KEY)
  if (raw) {
    const j = JSON.parse(raw) as { id: string; signSecret: string; x25519Secret: string }
    return { id: j.id, signSecret: b64ToBytes(j.signSecret), x25519Secret: b64ToBytes(j.x25519Secret) }
  }
  const sign = randomEd25519()
  const box = randomX25519()
  const id = freshId(sign.publicKey)
  localStorage.setItem(ID_KEY, JSON.stringify({ id, signSecret: bytesToB64(sign.secretKey), x25519Secret: bytesToB64(box.secretKey) }))
  return { id, signSecret: sign.secretKey, x25519Secret: box.secretKey }
}

/** 手机侧协议客户端。网页里用浏览器 WebSocket，真机把套接字放在前台服务里。 */
export class PhoneLink {
  readonly me = loadIdentity()
  desktops = new Map<string, DesktopPeer>()
  activeId = ''
  private link: RelayLink | null = null
  private recvNative = false
  private url = ''
  private pin = ''
  private wantLink = false
  private attempt = 0
  private sockId = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private nativeBound = false
  private opening: Promise<void> | null = null
  private listeners = new Set<(ev: PhonePush) => void>()
  private ready: { resolve: () => void; reject: (err: Error) => void } | null = null
  private secureWait = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()

  onPush(cb: (ev: PhonePush) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async connect(url: string, pin: string): Promise<void> {
    if (this.url === url && this.link && this.wantLink) return
    this.wantLink = true
    this.url = url
    this.pin = pin
    this.attempt = 0
    if (this.retryTimer) clearTimeout(this.retryTimer)
    await this.openNow()
  }

  private async openNow(): Promise<void> {
    if (this.opening) return this.opening
    this.opening = this.openSocket().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async openSocket(): Promise<void> {
    if (!this.wantLink) return
    const id = ++this.sockId
    const prev = this.link
    this.link = null
    this.recvNative = false
    prev?.failAll('已重连')
    await this.closeSocket()
    if (!this.wantLink || id !== this.sockId) return
    const link = new RelayLink({
      role: 'app',
      id: this.me.id,
      signSecret: this.me.signSecret,
      x25519Secret: this.me.x25519Secret,
      sendRaw: (text) => this.sendRaw(text),
      onEvent: (ev) => this.onEvent(ev),
    })
    this.link = link
    if (this.readyTimer) clearTimeout(this.readyTimer)
    const opened = new Promise<void>((resolve, reject) => {
      this.readyTimer = setTimeout(() => reject(new Error('连接中转站超时')), 8000)
      this.ready = {
        resolve: () => {
          if (this.readyTimer) clearTimeout(this.readyTimer)
          resolve()
        },
        reject: (err) => {
          if (this.readyTimer) clearTimeout(this.readyTimer)
          reject(err)
        },
      }
    })
    if (Capacitor.isNativePlatform()) {
      if (!this.nativeBound) {
        await Native.addListener('frame', (ev) => {
          if (ev.closed) {
            if (this.link) this.onDown(this.link, this.sockId, ev.closed)
            return
          }
          if (ev.text) this.link?.handleRaw(ev.text)
        })
        await Native.addListener('plain', (ev) => {
          if (!ev.from || typeof ev.n !== 'number' || !ev.json || !this.link) return
          this.link.ingestPlain(ev.from, JSON.parse(ev.json) as E2ePlain, ev.n)
        })
        this.nativeBound = true
      }
      await Native.openSocket({ url: this.url, pin: this.pin })
    } else {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(this.url)
        ;(this as { ws?: WebSocket }).ws = ws
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('WebSocket 连接失败'))
        ws.onmessage = (e) => link.handleRaw(String(e.data))
        ws.onclose = () => this.onDown(link, id, '连接已断开')
      })
    }
    if (!this.wantLink || id !== this.sockId) return
    await opened
    this.attempt = 0
  }

  private onDown(link: RelayLink, id: number, reason: string): void {
    if (id !== this.sockId) return
    if (this.link === link) this.link = null
    this.recvNative = false
    link.failAll(reason)
    if (Capacitor.isNativePlatform()) {
      for (const peerId of this.desktops.keys()) void Native.disarmRecv({ peerId }).catch(() => undefined)
    }
    if (this.activeId) {
      const peer = this.desktops.get(this.activeId)
      if (peer) peer.online = false
      this.emit({ what: 'presence', p: { desktopId: this.activeId, online: false } })
    }
    this.schedule()
  }

  private schedule(): void {
    if (!this.wantLink || !this.url) return
    const wait = Math.min(30_000, 1000 * 2 ** this.attempt)
    this.attempt += 1
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      void this.openNow().catch(() => this.schedule())
    }, wait)
  }

  async pair(raw: string, appName: string): Promise<void> {
    const qr: PairingQr = decodePairingQr(raw.trim())
    await this.connect(qr.relay, qr.certSha256)
    const link = this.link
    if (!link) throw new Error('没有连接')
    link.setPeerKey(qr.desktopId, qr.desktopX25519Pub)
    this.desktops.set(qr.desktopId, { id: qr.desktopId, name: qr.desktopName, online: false, x25519: qr.desktopX25519Pub })
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('电脑没有确认配对')), 5 * 60 * 1000)
      const off = this.onPush((ev) => {
        if (ev.what === 'error') {
          const message = (ev.p as { message?: string } | undefined)?.message
          if (!message) return
          clearTimeout(timer)
          off()
          reject(new Error(message))
          return
        }
        if (ev.what !== '__pair__') return
        const r = ev.p as { ok?: boolean; error?: string; desktopId?: string }
        if (r.desktopId && r.desktopId !== qr.desktopId) return
        clearTimeout(timer)
        off()
        if (r.ok) resolve()
        else reject(new Error(r.error || '配对失败'))
      })
    })
    link.pairRequest(qr.token, appName)
    await result
    this.activeId = qr.desktopId
    await this.hello(qr.desktopId)
  }

  async hello(desktopId: string): Promise<void> {
    const link = this.link
    const peer = this.desktops.get(desktopId)
    if (!link || !peer?.x25519) throw new Error('还没有这台电脑的公钥')
    link.setPeerKey(desktopId, peer.x25519)
    if (link.peerReady(desktopId)) return
    await link.hello(desktopId)
  }

  async invoke<T>(channel: string, payload?: unknown): Promise<T> {
    const id = this.activeId
    const link = this.link
    if (!id || !link) throw new Error('还没有选择电脑')
    if (!this.desktops.get(id)?.online && !link.peerReady(id)) throw new Error('电脑离线')
    if (!link.peerReady(id)) await this.hello(id)
    return link.request(id, channel, payload) as Promise<T>
  }

  unbind(): void {
    if (!this.activeId) return
    this.link?.unbind(this.activeId)
    this.desktops.delete(this.activeId)
    this.activeId = [...this.desktops.keys()][0] || ''
  }

  select(id: string): void {
    this.activeId = id
    const peer = this.desktops.get(id)
    if (peer?.online) void this.hello(id).catch(() => {})
  }

  private sendRaw(text: string): void {
    if (Capacitor.isNativePlatform()) {
      void Native.sendText({ text })
      return
    }
    const ws = (this as { ws?: WebSocket }).ws
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(text)
  }

  private async close(): Promise<void> {
    this.wantLink = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.sockId += 1
    const link = this.link
    this.link = null
    link?.failAll('已关闭')
    await this.closeSocket()
  }

  private async closeSocket(): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await Native.closeSocket().catch(() => undefined)
      return
    }
    const ws = (this as { ws?: WebSocket }).ws
    ;(this as { ws?: WebSocket }).ws = undefined
    ws?.close()
  }

  private onEvent(ev: LinkEvent): void {
    if (ev.t === 'ready') {
      this.absorb(ev.bindings)
      this.ready?.resolve()
      this.ready = null
      return
    }
    if (ev.t === 'presence') {
      const peer = this.desktops.get(ev.desktopId)
      if (peer) peer.online = ev.online
      this.emit({ what: 'presence', p: ev })
      if (ev.online && ev.desktopId === this.activeId) void this.hello(ev.desktopId).catch(() => {})
      return
    }
    if (ev.t === 'pair-result') {
      this.emit({ what: '__pair__', p: ev })
      return
    }
    if (ev.t === 'unbound') {
      this.desktops.delete(ev.desktopId)
      if (this.activeId === ev.desktopId) this.activeId = ''
      this.emit({ what: 'unbound', p: ev })
      return
    }
    if (ev.t === 'secure') {
      this.secureWait.get(ev.peerId)?.resolve()
      this.secureWait.delete(ev.peerId)
      if (Capacitor.isNativePlatform()) {
        this.link?.beginRecvHandoff()
        void this.handoffRecv(ev.peerId)
      }
      return
    }
    if (ev.t === 'push') {
      if (ev.what === 'note' && Capacitor.isNativePlatform() && !this.recvNative) {
        const n = (ev.p || {}) as { title?: string; body?: string; kind?: string; id?: string }
        void Native.notify({ title: n.title || 'Jeff', body: n.body || '', kind: n.kind || '', id: n.id || '' })
      }
      if (ev.what === 'chat-stream') this.emit({ what: 'chat-stream', p: ev.p })
      else this.emit({ what: ev.what, p: ev.p })
      return
    }
    if (ev.t === 'error') this.emit({ what: 'error', p: { message: ev.message } })
  }

  private absorb(bindings: BindingView[]): void {
    for (const b of bindings) {
      const prev = this.desktops.get(b.desktopId)
      this.desktops.set(b.desktopId, {
        id: b.desktopId,
        name: b.desktopName || prev?.name || b.desktopId,
        online: prev?.online || false,
        x25519: b.desktopX25519 || prev?.x25519 || '',
      })
    }
    if (!this.activeId && bindings[0]) this.activeId = bindings[0].desktopId
  }

  async pullNative(): Promise<void> {
    if (!Capacitor.isNativePlatform() || !this.link) return
    const batch = await Native.pullPlain()
    for (const item of batch.items || []) {
      this.link.ingestPlain(item.from, JSON.parse(item.json) as E2ePlain, item.n)
    }
  }

  async takeNote(): Promise<{ kind: string; id: string; title: string }> {
    if (!Capacitor.isNativePlatform()) return { kind: '', id: '', title: '' }
    return Native.takeNote()
  }

  private async handoffRecv(peerId: string): Promise<void> {
    const link = this.link
    if (!link) return
    const snap = link.exportRecv(peerId)
    if (!snap) {
      link.cancelRecvHandoff()
      return
    }
    try {
      await Native.armRecv({ peerId, recvKey: snap.recvKey, recvN: snap.recvN })
      const held = link.commitRecvHandoff(peerId)
      for (const text of held) await Native.feedFrame({ text })
      await Native.goLive()
      this.recvNative = true
    } catch {
      await Native.disarmRecv({ peerId }).catch(() => undefined)
      link.cancelRecvHandoff()
    }
  }

  private emit(ev: PhonePush): void {
    for (const cb of this.listeners) cb(ev)
  }
}

export function mergeStream(prev: { text: string; reasoning: string }, frame: RemoteStreamFrame): { text: string; reasoning: string; ok: boolean } {
  return applyRemoteStream(prev, frame)
}

export async function shrinkImage(dataUrl: string): Promise<{ mime: string; dataUrl: string }> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const max = 1600
  const scale = Math.min(1, max / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return { mime: 'image/jpeg', dataUrl }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return { mime: 'image/jpeg', dataUrl: canvas.toDataURL('image/jpeg', 0.8) }
}
