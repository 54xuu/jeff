import os from 'node:os'
import tls from 'node:tls'
import { app, powerSaveBlocker } from 'electron'
import WebSocket from 'ws'
import type { JeffCore } from '@jeff/core'
import { IPC, type RemotePairAsk, type RemoteStatus } from '@jeff/core'
import {
  RELAY_CERT_SHA256,
  RELAY_URL,
  RelayLink,
  b64ToBytes,
  createChatStreamGate,
  encodePairingQr,
  remoteRule,
  safetyCode,
  type BindingView,
  type RemoteStreamIn,
} from '../../../../../packages/core/src/remote/index.js'
import { loadIdentity, loadPrefs, savePrefs, type RemotePrefs } from './identity.js'

type Handler = (payload: unknown) => Promise<unknown>

const NAV = new Set<string>([IPC.sessionActivate, IPC.chatNew, IPC.chatSend, IPC.groupThreadNew, IPC.groupThreadActivate, IPC.groupSend])

export interface RemoteHost {
  core: JeffCore
  handlers: Record<string, Handler>
  broadcast: (what: string, payload?: unknown) => void
}

/** 出站连中转站，把手机的调用交给和本机同一张 handlers 表。 */
export class RemoteGateway {
  private link: RelayLink | null = null
  private ws: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private connected = false
  private bindings: BindingView[] = []
  private appId = ''
  private pairing: { token: string; expiresAt: number; payload: string } | null = null
  private ask: { token: string; appId: string; appName: string; x25519Pub: string } | null = null
  private lastError = ''
  private sleepId: number | null = null
  private prefs: RemotePrefs
  private identity: ReturnType<typeof loadIdentity>
  private gate = createChatStreamGate(180)
  private queue: Array<{ what: string; p?: unknown }> = []
  private noted = new Set<string>()
  private url: string
  private pin: string

  constructor(private host: RemoteHost) {
    this.identity = loadIdentity(host.core.paths.root)
    this.prefs = loadPrefs(host.core.paths.root, os.hostname())
    this.url = process.env.JEFF_RELAY_URL || RELAY_URL
    this.pin = process.env.JEFF_RELAY_CERT ?? RELAY_CERT_SHA256
    this.bindHandlers()
    this.applyLogin()
    this.applySleep()
    this.listen()
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.dropSleep()
    this.ws?.close()
  }

  status(): RemoteStatus {
    const bound = this.bindings[0]
    return {
      connected: this.connected,
      desktopId: this.identity.id,
      desktopName: this.prefs.desktopName,
      bound: bound ? { appId: bound.appId, appName: bound.appName, appX25519: bound.appX25519 } : null,
      openAtLogin: this.prefs.openAtLogin,
      preventSleep: this.prefs.preventSleep,
      pairing: this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing : null,
      lastError: this.lastError || undefined,
    }
  }

  private bindHandlers(): void {
    const h = this.host.handlers
    h[IPC.remoteStatus] = async () => this.status()
    h[IPC.remotePairStart] = async () => this.pairStart()
    h[IPC.remotePairConfirm] = async (p) => {
      const d = p as { token: string; accept: boolean; replace?: boolean }
      this.confirm(d.token, d.accept, d.replace === true)
      return { ok: true }
    }
    h[IPC.remoteUnbind] = async () => {
      this.link?.unbind()
      return { ok: true }
    }
    h[IPC.remoteSettings] = async (p) => {
      const d = (p || {}) as { openAtLogin?: boolean; preventSleep?: boolean; desktopName?: string }
      if (typeof d.openAtLogin === 'boolean') this.prefs.openAtLogin = d.openAtLogin
      if (typeof d.preventSleep === 'boolean') this.prefs.preventSleep = d.preventSleep
      if (typeof d.desktopName === 'string' && d.desktopName.trim()) this.prefs.desktopName = d.desktopName.trim().slice(0, 40)
      savePrefs(this.host.core.paths.root, this.prefs)
      this.applyLogin()
      this.applySleep()
      this.publish()
      return this.status()
    }
    h[IPC.remoteFocus] = async (p) => {
      const d = p as { kind?: string; id?: string }
      if ((d.kind === 'agent' || d.kind === 'group') && d.id) this.push('remote-nav', { kind: d.kind, id: d.id })
      return { ok: true }
    }
  }

  private pairWait: { resolve: (v: { token: string; expiresAt: number; payload: string }) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null

  private pairStart(): Promise<{ token: string; expiresAt: number; payload: string }> {
    if (!this.link || !this.connected) return Promise.reject(new Error('还没连上中转站'))
    if (this.pairWait) return Promise.reject(new Error('已经在等一张配对码'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pairWait = null
        reject(new Error('中转站没有返回配对码'))
      }, 8000)
      this.pairWait = { resolve, reject, timer }
      this.link?.pairOpen(this.prefs.desktopName)
    })
  }

  private confirm(token: string, accept: boolean, replace: boolean): void {
    if (accept && this.ask?.token === token) this.link?.setPeerKey(this.ask.appId, this.ask.x25519Pub)
    this.link?.pairConfirm(token, accept, replace)
    if (!accept) this.ask = null
    this.host.broadcast('remote-pair-ask', null)
  }

  private listen(): void {
    const bus = this.host.core.bus
    bus.on('data-changed', (what: string) => this.push('data-changed', { what }))
    bus.on('chat-updated', (p: unknown) => this.push('chat-updated', p))
    bus.on('group-updated', (p: unknown) => this.push('group-updated', p))
    bus.on('cron-updated', () => this.push('cron-updated', {}))
    bus.on('cron-turn-done', (p: unknown) => {
      this.push('cron-turn-done', p)
      const d = (p || {}) as { kind?: string; id?: string; taskName?: string }
      this.push('note', { title: d.taskName || '定时任务', body: '已运行完成', kind: d.kind === 'group' ? 'group' : 'agent', id: d.id || '' })
    })
    bus.on('chat-stream', (p: unknown) => this.onStream(p as RemoteStreamIn))
    this.host.core.on('sidecar-status', (p: unknown) => this.push('sidecar-status', p))
  }

  private onStream(p: RemoteStreamIn): void {
    const frame = this.gate.push(p)
    if (!frame) return
    this.push('chat-stream', frame)
    if (frame.done) {
      const id = frame.kind === 'group' ? frame.projectId || '' : frame.agentId
      this.push('note', {
        title: frame.kind === 'group' ? '项目群' : '私聊',
        body: '回复完成',
        kind: frame.kind === 'group' ? 'group' : 'agent',
        id,
      })
      this.noted.delete(frame.messageId)
      return
    }
    const pending = frame.tools?.some((t) => t.status === 'pending')
    if (pending && frame.messageId && !this.noted.has(frame.messageId)) {
      this.noted.add(frame.messageId)
      this.push('note', {
        title: '需要确认',
        body: '有一项操作正在等你确认',
        kind: frame.kind === 'group' ? 'group' : 'agent',
        id: frame.kind === 'group' ? frame.projectId || '' : frame.agentId,
      })
    }
  }

  private push(what: string, p?: unknown): void {
    if (!this.appId) return
    if (!this.link?.peerReady(this.appId)) {
      if (this.queue.length < 40) this.queue.push({ what, p })
      return
    }
    this.link.sendPlain(this.appId, { t: 'push', what, p })
  }

  private flush(): void {
    if (!this.appId || !this.link?.peerReady(this.appId)) return
    const queued = this.queue.splice(0)
    for (const item of queued) this.link.sendPlain(this.appId, { t: 'push', what: item.what, p: item.p })
  }

  private publish(): void {
    this.host.broadcast('remote-status', this.status())
  }

  private onLink = (ev: { t: string; [k: string]: unknown }): void => {
    if (ev.t === 'pair-token') {
      const token = String(ev.token || '')
      const expiresAt = Number(ev.expiresAt || 0)
      const payload = encodePairingQr({
        relay: this.url,
        certSha256: this.qrCert(),
        desktopId: this.identity.id,
        desktopName: this.prefs.desktopName,
        desktopX25519Pub: this.identity.x25519Pub,
        token,
      })
      this.pairing = { token, expiresAt, payload }
      this.publish()
      const wait = this.pairWait
      this.pairWait = null
      if (wait) {
        clearTimeout(wait.timer)
        wait.resolve(this.pairing)
      }
      return
    }
    if (ev.t === 'ready') {
      this.bindings = (ev.bindings as BindingView[]) || []
      this.appId = this.bindings[0]?.appId || ''
      this.connected = true
      this.lastError = ''
      this.applySleep()
      this.publish()
      return
    }
    if (ev.t === 'pair-ask') {
      const ask = ev as unknown as { token: string; appId: string; appName: string; x25519Pub: string }
      this.ask = ask
      const safety = safetyCode(b64ToBytes(this.identity.x25519Pub), b64ToBytes(ask.x25519Pub))
      const view: RemotePairAsk = {
        token: ask.token,
        appId: ask.appId,
        appName: ask.appName,
        safety,
        replace: !!this.bindings[0] && this.bindings[0].appId !== ask.appId,
      }
      this.host.broadcast('remote-pair-ask', view)
      return
    }
    if (ev.t === 'pair-result') {
      const r = ev as { ok?: boolean; appId?: string; error?: string }
      if (r.ok && r.appId) {
        this.appId = r.appId
        this.pairing = null
        const name = this.ask?.appName || ''
        const pub = this.ask?.x25519Pub || ''
        this.bindings = [{ desktopId: this.identity.id, appId: r.appId, desktopName: this.prefs.desktopName, appName: name, desktopX25519: this.identity.x25519Pub, appX25519: pub }]
        this.ask = null
      } else if (r.error) this.lastError = r.error
      this.applySleep()
      this.publish()
      return
    }
    if (ev.t === 'unbound') {
      this.bindings = []
      this.appId = ''
      this.queue = []
      this.applySleep()
      this.publish()
      return
    }
    if (ev.t === 'secure') {
      this.flush()
      return
    }
    if (ev.t === 'req') {
      const req = ev as { from?: string; id?: string; ch?: string; p?: unknown }
      if (req.from && req.id && req.ch) void this.dispatch(req.from, req.id, req.ch, req.p)
      return
    }
    if (ev.t === 'error') {
      this.lastError = String(ev.message || ev.code || '')
      this.publish()
    }
  }

  private async dispatch(from: string, id: string, channel: string, payload: unknown): Promise<void> {
    const link = this.link
    if (!link) return
    try {
      const rule = remoteRule(channel)
      if (rule.policy === 'deny' || rule.policy === 'push') throw new Error(rule.note || '这个操作不能从手机发起')
      if (rule.policy === 'replace') {
        if (channel === IPC.pluginImport) {
          const dir = (payload as { dir?: string } | undefined)?.dir
          if (!dir) throw new Error(rule.note || '请先在手机上选好插件目录')
        } else {
          throw new Error(rule.note || '请改用手机上的对应操作')
        }
      }
      const handler = this.host.handlers[channel]
      if (!handler) throw new Error(`没有这个通道 ${channel}`)
      const result = await handler(payload)
      link.respond(from, id, true, result)
      this.afterNav(channel, payload, result)
    } catch (err) {
      try {
        link.respond(from, id, false, undefined, (err as Error).message || '调用失败')
      } catch {
        /* 对端已经断开 */
      }
    }
  }

  private afterNav(channel: string, payload: unknown, result: unknown): void {
    if (!NAV.has(channel)) return
    const p = (payload || {}) as { agentId?: string; projectId?: string; scope?: string }
    if (channel === IPC.chatNew || channel === IPC.sessionActivate) {
      if (p.scope === 'group' && p.projectId) this.host.broadcast('remote-nav', { kind: 'group', id: p.projectId })
      else if (p.agentId) this.host.broadcast('remote-nav', { kind: 'agent', id: p.agentId })
      return
    }
    if (p.projectId) this.host.broadcast('remote-nav', { kind: 'group', id: p.projectId })
    else if (p.agentId) this.host.broadcast('remote-nav', { kind: 'agent', id: p.agentId })
    void result
  }

  /** 明文 ws（本地验收）没有证书，二维码里放一个非空占位，正式 wss 仍用指纹。 */
  private qrCert(): string {
    if (this.pin) return this.pin
    if (this.url.startsWith('ws://')) return 'local'
    return RELAY_CERT_SHA256
  }

  private connect(): void {
    if (this.stopped) return
    const ws = openSocket(this.url, this.pin, (message) => {
      this.lastError = message
      this.stopped = true
      this.publish()
    })
    this.ws = ws
    const link = new RelayLink({
      role: 'desktop',
      id: this.identity.id,
      signSecret: this.identity.signSecret,
      x25519Secret: this.identity.x25519Secret,
      sendRaw: (text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text)
      },
      onEvent: (ev) => this.onLink(ev),
    })
    this.link = link
    ws.on('open', () => {
      this.attempt = 0
    })
    ws.on('message', (data) => link.handleRaw(data.toString()))
    ws.on('close', () => {
      this.connected = false
      link.failAll('连接已断开')
      this.publish()
      this.schedule()
    })
    ws.on('error', (err) => {
      this.lastError = err.message
      this.publish()
    })
  }

  private schedule(): void {
    if (this.stopped) return
    const wait = Math.min(30_000, 1000 * 2 ** this.attempt)
    this.attempt += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.connect(), wait)
  }

  private applyLogin(): void {
    try {
      app.setLoginItemSettings({ openAtLogin: this.prefs.openAtLogin })
    } catch (err) {
      this.lastError = (err as Error).message
    }
  }

  private applySleep(): void {
    const on = this.prefs.preventSleep && !!this.appId
    if (on) {
      if (this.sleepId == null || !powerSaveBlocker.isStarted(this.sleepId)) this.sleepId = powerSaveBlocker.start('prevent-app-suspension')
      return
    }
    this.dropSleep()
  }

  private dropSleep(): void {
    if (this.sleepId == null) return
    if (powerSaveBlocker.isStarted(this.sleepId)) powerSaveBlocker.stop(this.sleepId)
    this.sleepId = null
  }
}

function openSocket(url: string, pin: string, onPinFail: (message: string) => void): WebSocket {
  if (url.startsWith('ws://')) return new WebSocket(url)
  const ws = new WebSocket(url, { rejectUnauthorized: false })
  ws.on('upgrade', () => {
    const sock = (ws as unknown as { _socket?: tls.TLSSocket })._socket
    const fp = sock?.getPeerCertificate?.().fingerprint256 || ''
    if (!pin || fp.toUpperCase() !== pin.toUpperCase()) {
      onPinFail(`证书指纹不符：${fp || '没有证书'}`)
      ws.close()
    }
  })
  return ws
}

export function startRemoteGateway(host: RemoteHost): RemoteGateway | null {
  if ((process.env.JEFF_E2E === '1' || process.env.JEFF_SMOKE === '1') && !process.env.JEFF_RELAY_URL) return null
  return new RemoteGateway(host)
}
