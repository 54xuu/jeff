/** 桌面端与 App 握手时比对；不兼容就提示升级，不硬解。 */
export const REMOTE_PROTOCOL = 1

export const RELAY_HOST = '47.106.209.32'
export const RELAY_PORT = 9443
export const RELAY_URL = `wss://${RELAY_HOST}:${RELAY_PORT}`

/**
 * 中转站 TLS 证书的 SHA-256 指纹（大写、冒号分隔）。
 * 证书在服务器上生成后填进来；空字符串表示尚未固定，客户端必须拒绝连接。
 */
export const RELAY_CERT_SHA256 = '7E:59:C6:E3:6F:76:68:A6:58:F5:A6:25:B2:E9:F4:FD:FB:59:54:8C:10:7E:AF:05:B3:2E:05:0E:59:E7:64:45'

export type ClientRole = 'desktop' | 'app'

/** 客户端 → 中转站。e2e.body 是密文，中转站不解析。 */
export type ClientFrame =
  | { t: 'auth'; role: ClientRole; id: string; protocol: number; signPub: string; sig: string }
  | { t: 'pair-open'; desktopName: string; x25519Pub: string }
  | { t: 'pair-request'; token: string; appName: string; x25519Pub: string }
  | { t: 'pair-confirm'; token: string; accept: boolean; replace?: boolean }
  | { t: 'unbind'; desktopId?: string }
  | { t: 'e2e'; to: string; body: string }
  | { t: 'ping' }

export interface BindingView {
  desktopId: string
  appId: string
  desktopName: string
  appName: string
  desktopX25519: string
  appX25519: string
}

/** 中转站 → 客户端。 */
export type ServerFrame =
  | { t: 'challenge'; nonce: string }
  | { t: 'auth-ok'; id: string; bindings: BindingView[] }
  | { t: 'pair-token'; token: string; expiresAt: number }
  | { t: 'pair-ask'; token: string; appId: string; appName: string; signPub: string; x25519Pub: string }
  | { t: 'pair-result'; ok: boolean; desktopId?: string; appId?: string; error?: string }
  | { t: 'presence'; desktopId: string; online: boolean }
  | { t: 'unbound'; desktopId: string }
  | { t: 'e2e'; from: string; body: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong' }

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function needStr(o: Record<string, unknown>, key: string, max: number): string {
  const v = o[key]
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Error(`帧字段 ${key} 非法`)
  return v
}

function parseJson(raw: string): Record<string, unknown> {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new Error('帧不是 JSON')
  }
  if (!isRecord(v) || typeof v.t !== 'string') throw new Error('帧缺少 t')
  return v
}

/** 解析客户端发来的帧。中转站只用这个。 */
export function decodeClientFrame(raw: string): ClientFrame {
  const v = parseJson(raw)
  switch (v.t) {
    case 'auth': {
      if (v.role !== 'desktop' && v.role !== 'app') throw new Error('role 非法')
      if (typeof v.protocol !== 'number') throw new Error('protocol 非法')
      return { t: 'auth', role: v.role, id: needStr(v, 'id', 80), protocol: v.protocol, signPub: needStr(v, 'signPub', 128), sig: needStr(v, 'sig', 256) }
    }
    case 'pair-open':
      return { t: 'pair-open', desktopName: needStr(v, 'desktopName', 40), x25519Pub: needStr(v, 'x25519Pub', 128) }
    case 'pair-request':
      return { t: 'pair-request', token: needStr(v, 'token', 128), appName: needStr(v, 'appName', 40), x25519Pub: needStr(v, 'x25519Pub', 128) }
    case 'pair-confirm':
      if (typeof v.accept !== 'boolean') throw new Error('accept 非法')
      return { t: 'pair-confirm', token: needStr(v, 'token', 128), accept: v.accept, replace: v.replace === true }
    case 'unbind':
      return { t: 'unbind', desktopId: typeof v.desktopId === 'string' && v.desktopId ? v.desktopId : undefined }
    case 'e2e':
      return { t: 'e2e', to: needStr(v, 'to', 80), body: needStr(v, 'body', 3_500_000) }
    case 'ping':
      return { t: 'ping' }
    default:
      throw new Error(`不是客户端帧：${v.t}`)
  }
}

export function decodeServerFrame(raw: string): ServerFrame {
  const v = parseJson(raw)
  switch (v.t) {
    case 'challenge':
      return { t: 'challenge', nonce: needStr(v, 'nonce', 128) }
    case 'auth-ok':
      if (!Array.isArray(v.bindings)) throw new Error('bindings 非法')
      return { t: 'auth-ok', id: needStr(v, 'id', 80), bindings: v.bindings as BindingView[] }
    case 'pair-token':
      if (typeof v.expiresAt !== 'number') throw new Error('expiresAt 非法')
      return { t: 'pair-token', token: needStr(v, 'token', 128), expiresAt: v.expiresAt }
    case 'pair-ask':
      return {
        t: 'pair-ask',
        token: needStr(v, 'token', 128),
        appId: needStr(v, 'appId', 80),
        appName: needStr(v, 'appName', 40),
        signPub: needStr(v, 'signPub', 128),
        x25519Pub: needStr(v, 'x25519Pub', 128),
      }
    case 'pair-result':
      if (typeof v.ok !== 'boolean') throw new Error('ok 非法')
      return { t: 'pair-result', ok: v.ok, desktopId: typeof v.desktopId === 'string' ? v.desktopId : undefined, appId: typeof v.appId === 'string' ? v.appId : undefined, error: typeof v.error === 'string' ? v.error : undefined }
    case 'presence':
      if (typeof v.online !== 'boolean') throw new Error('online 非法')
      return { t: 'presence', desktopId: needStr(v, 'desktopId', 80), online: v.online }
    case 'unbound':
      return { t: 'unbound', desktopId: needStr(v, 'desktopId', 80) }
    case 'e2e':
      return { t: 'e2e', from: needStr(v, 'from', 80), body: needStr(v, 'body', 3_500_000) }
    case 'error':
      return { t: 'error', code: needStr(v, 'code', 40), message: needStr(v, 'message', 400) }
    case 'pong':
      return { t: 'pong' }
    default:
      throw new Error(`不是服务端帧：${v.t}`)
  }
}

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame)
}

/** 电脑上二维码的内容。App 扫到后按这里的地址连，并校验证书指纹。 */
export interface PairingQr {
  relay: string
  certSha256: string
  desktopId: string
  desktopName: string
  desktopX25519Pub: string
  token: string
}

export function encodePairingQr(q: PairingQr): string {
  return JSON.stringify(q)
}

export function decodePairingQr(raw: string): PairingQr {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new Error('二维码不是 JSON')
  }
  if (!v || typeof v !== 'object') throw new Error('二维码内容不对')
  const o = v as Record<string, unknown>
  const need = (k: string) => {
    const s = o[k]
    if (typeof s !== 'string' || !s) throw new Error(`二维码缺少 ${k}`)
    return s
  }
  return {
    relay: need('relay'),
    certSha256: need('certSha256'),
    desktopId: need('desktopId'),
    desktopName: need('desktopName'),
    desktopX25519Pub: need('desktopX25519Pub'),
    token: need('token'),
  }
}
