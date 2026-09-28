import fs from 'node:fs'
import path from 'node:path'
import { b64ToBytes, bytesToB64, randomEd25519, randomX25519, x25519PublicKey } from '../../../../../packages/core/src/remote/index.js'

export interface RemoteIdentity {
  id: string
  signSecret: Uint8Array
  x25519Secret: Uint8Array
  x25519Pub: string
}

function idOf(bytes: Uint8Array): string {
  return bytesToB64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '').slice(0, 22)
}

/** 长期身份只放在本机数据目录，权限 0600。 */
export function loadIdentity(root: string): RemoteIdentity {
  const file = path.join(root, 'remote-identity.json')
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string; signSecret: string; x25519Secret: string }
    const x25519Secret = b64ToBytes(j.x25519Secret)
    return { id: j.id, signSecret: b64ToBytes(j.signSecret), x25519Secret, x25519Pub: bytesToB64(x25519PublicKey(x25519Secret)) }
  }
  const sign = randomEd25519()
  const box = randomX25519()
  const body = {
    id: idOf(sign.publicKey),
    signSecret: bytesToB64(sign.secretKey),
    x25519Secret: bytesToB64(box.secretKey),
  }
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* Windows 上 chmod 可能无效 */
  }
  return { id: body.id, signSecret: sign.secretKey, x25519Secret: box.secretKey, x25519Pub: bytesToB64(box.publicKey) }
}

export interface RemotePrefs {
  desktopName: string
  openAtLogin: boolean
  preventSleep: boolean
}

export function loadPrefs(root: string, fallbackName: string): RemotePrefs {
  const file = path.join(root, 'remote-settings.json')
  const base: RemotePrefs = { desktopName: fallbackName.slice(0, 40) || 'Jeff', openAtLogin: false, preventSleep: true }
  if (!fs.existsSync(file)) return base
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RemotePrefs>
    return {
      desktopName: (j.desktopName || base.desktopName).slice(0, 40),
      openAtLogin: j.openAtLogin === true,
      preventSleep: j.preventSleep !== false,
    }
  } catch {
    return base
  }
}

export function savePrefs(root: string, prefs: RemotePrefs): void {
  const file = path.join(root, 'remote-settings.json')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(prefs), { mode: 0o600 })
}
