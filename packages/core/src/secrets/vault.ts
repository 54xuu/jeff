import crypto from 'node:crypto'
import type { SecretCipher, SecretListItem, SecretListResult, SecretMeta, SecretStore, StoredSecret } from './types.js'
import { setSecretValues } from './redact.js'
import { SECRET_ENTRY_MAX, isReservedName, validateSecretName, validateSecretNote, validateSecretValue } from './validate.js'

export const SECRETS_VAULT_KEY = 'secrets:vault'
export const SECRETS_APPLIED_KEY = 'secrets:appliedHash'
const PLAIN_PREFIX = 'plain:'

export function hashEnv(env: Record<string, string>): string {
  const lines = Object.keys(env).sort().map((key) => `${key}=${env[key]}`)
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

export function hash8(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/** 丢掉会破坏进程或隔离环境的名字。大小写不敏感。 */
export function injectableEnv(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!key || isReservedName(key)) continue
    out[key] = value
  }
  return out
}

export function exportSecretMeta(entries: StoredSecret[]): SecretMeta[] {
  return entries.map((entry) => ({
    name: entry.name,
    note: entry.note,
    enabled: entry.enabled,
    updatedAt: entry.updatedAt,
    deletedAt: entry.deletedAt,
  }))
}

/** 按变量名（大小写不敏感）做 LWW。远端只带元数据，不覆盖本机已有的值。 */
export function mergeSecretMeta(local: StoredSecret[], remote: SecretMeta[]): StoredSecret[] {
  const next = local.map((entry) => ({ ...entry }))
  const find = (name: string) => next.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
  for (const item of remote) {
    if (!item || typeof item.name !== 'string') continue
    let name = item.name
    try {
      name = validateSecretName(name)
    } catch {
      continue
    }
    const updatedAt = Number(item.updatedAt) || 0
    const deletedAt = item.deletedAt == null ? null : Number(item.deletedAt) || updatedAt
    const current = find(name)
    if (!current) {
      next.push({
        name,
        valueEnc: '',
        note: typeof item.note === 'string' ? item.note : '',
        enabled: item.enabled !== false,
        updatedAt,
        deletedAt,
        pending: deletedAt == null,
      })
      continue
    }
    if (updatedAt < current.updatedAt) continue
    current.note = typeof item.note === 'string' ? item.note : current.note
    current.enabled = item.enabled !== false
    current.updatedAt = updatedAt
    current.deletedAt = deletedAt
    if (deletedAt == null && !current.valueEnc) current.pending = true
  }
  return next
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export class SecretVault {
  constructor(private store: SecretStore, private cipher: SecretCipher) {}

  load(): void {
    const entries = this.read()
    if (this.cipher.isAvailable()) {
      let changed = false
      for (const entry of entries) {
        if (!entry.valueEnc.startsWith(PLAIN_PREFIX) || entry.pending || entry.deletedAt) continue
        entry.valueEnc = this.cipher.encrypt(entry.valueEnc.slice(PLAIN_PREFIX.length))
        entry.undecryptable = false
        changed = true
      }
      if (changed) this.write(entries)
    }
    this.refreshRedactor(entries)
  }

  list(): SecretListResult {
    const entries = this.read().filter((entry) => !entry.deletedAt)
    const env = this.envFrom(entries)
    const applied = this.store.getJSON<string | null>(SECRETS_APPLIED_KEY, null)
    return {
      items: entries
        .map((entry) => this.toItem(entry))
        .sort((a, b) => a.name.localeCompare(b.name)),
      encrypted: this.cipher.isAvailable(),
      restartNeeded: hashEnv(env) !== (applied ?? hashEnv({})),
    }
  }

  env(): Record<string, string> {
    return this.envFrom(this.read())
  }

  markApplied(): void {
    this.store.setJSON(SECRETS_APPLIED_KEY, hashEnv(this.env()))
  }

  save(input: { name: string; value?: string; note?: string; enabled?: boolean; originalName?: string }): SecretListItem {
    const name = validateSecretName(input.name)
    const note = validateSecretNote(input.note || '')
    const enabled = input.enabled !== false
    const entries = this.read()
    const active = entries.filter((entry) => !entry.deletedAt)
    const original = input.originalName?.trim()
    const renaming = !!original && !sameName(original, name)
    if (renaming) {
      const old = active.find((entry) => sameName(entry.name, original!))
      if (!old) throw new Error('原条目不存在')
      if (active.some((entry) => sameName(entry.name, name))) throw new Error('变量名已存在')
      const value = input.value !== undefined ? validateSecretValue(input.value) : this.requirePlain(old)
      const now = Date.now()
      old.deletedAt = now
      old.updatedAt = now
      entries.push(this.make(name, value, note, enabled, now))
    } else {
      const current = active.find((entry) => sameName(entry.name, name))
      if (!original && current) throw new Error('变量名已存在')
      if (!current) {
        if (active.length >= SECRET_ENTRY_MAX) throw new Error(`最多保存 ${SECRET_ENTRY_MAX} 条密码`)
        if (input.value === undefined) throw new Error('请填写值')
        const value = validateSecretValue(input.value)
        const tomb = entries.find((entry) => entry.deletedAt && sameName(entry.name, name))
        const now = Date.now()
        if (tomb) {
          tomb.name = name
          tomb.valueEnc = this.encode(value)
          tomb.note = note
          tomb.enabled = enabled
          tomb.updatedAt = now
          tomb.deletedAt = null
          tomb.pending = false
          tomb.undecryptable = false
        } else {
          entries.push(this.make(name, value, note, enabled, now))
        }
      } else {
        if (active.some((entry) => entry !== current && sameName(entry.name, name))) throw new Error('变量名已存在')
        if (input.value !== undefined) {
          current.valueEnc = this.encode(validateSecretValue(input.value))
          current.pending = false
          current.undecryptable = false
        }
        current.name = name
        current.note = note
        current.enabled = enabled
        current.updatedAt = Date.now()
      }
    }
    this.write(entries)
    this.refreshRedactor(entries)
    const saved = entries.find((entry) => !entry.deletedAt && sameName(entry.name, name))!
    return this.toItem(saved)
  }

  delete(name: string): void {
    const entries = this.read()
    const current = entries.find((entry) => !entry.deletedAt && sameName(entry.name, name))
    if (!current) throw new Error('条目不存在')
    const now = Date.now()
    current.deletedAt = now
    current.updatedAt = now
    this.write(entries)
    this.refreshRedactor(entries)
  }

  reveal(name: string): string {
    const current = this.read().find((entry) => !entry.deletedAt && sameName(entry.name, name))
    if (!current) throw new Error('条目不存在')
    if (current.pending || !current.valueEnc) throw new Error('这条还没有填写值')
    return this.requirePlain(current)
  }

  meta(): SecretMeta[] {
    return exportSecretMeta(this.read())
  }

  replaceStored(entries: StoredSecret[]): void {
    this.write(entries)
    this.refreshRedactor(entries)
  }

  read(): StoredSecret[] {
    const raw = this.store.getJSON<unknown>(SECRETS_VAULT_KEY, [])
    if (!Array.isArray(raw)) return []
    return raw.filter((item) => item && typeof item === 'object' && typeof (item as StoredSecret).name === 'string') as StoredSecret[]
  }

  private envFrom(entries: StoredSecret[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const entry of entries) {
      if (entry.deletedAt || entry.pending || !entry.enabled || entry.undecryptable || !entry.valueEnc) continue
      if (isReservedName(entry.name)) continue
      try {
        out[entry.name] = this.decode(entry)
      } catch {
        entry.undecryptable = true
      }
    }
    return out
  }

  private toItem(entry: StoredSecret): SecretListItem {
    let last4 = ''
    let undecryptable = !!entry.undecryptable
    if (!entry.pending && entry.valueEnc && !undecryptable) {
      try {
        const plain = this.decode(entry)
        last4 = plain.slice(-4)
      } catch {
        undecryptable = true
      }
    }
    return {
      name: entry.name,
      note: entry.note,
      enabled: entry.enabled,
      hasValue: !entry.pending && !!entry.valueEnc && !undecryptable,
      last4,
      pending: entry.pending,
      undecryptable,
    }
  }

  private make(name: string, value: string, note: string, enabled: boolean, now: number): StoredSecret {
    return { name, valueEnc: this.encode(value), note, enabled, updatedAt: now, deletedAt: null, pending: false }
  }

  private encode(value: string): string {
    if (!this.cipher.isAvailable()) return `${PLAIN_PREFIX}${value}`
    return this.cipher.encrypt(value)
  }

  private decode(entry: StoredSecret): string {
    if (entry.valueEnc.startsWith(PLAIN_PREFIX)) return entry.valueEnc.slice(PLAIN_PREFIX.length)
    if (!this.cipher.isAvailable()) throw new Error('无法解密')
    return this.cipher.decrypt(entry.valueEnc)
  }

  private requirePlain(entry: StoredSecret): string {
    try {
      return this.decode(entry)
    } catch {
      throw new Error('无法解密，请重新填写')
    }
  }

  private write(entries: StoredSecret[]): void {
    this.store.setJSON(SECRETS_VAULT_KEY, entries)
  }

  private refreshRedactor(entries: StoredSecret[]): void {
    const values: Array<{ name: string; value: string }> = []
    for (const entry of entries) {
      if (entry.deletedAt || !entry.enabled || entry.pending || !entry.valueEnc) continue
      try {
        values.push({ name: entry.name, value: this.decode(entry) })
      } catch {
        /* 无法解密的条目不参与脱敏 */
      }
    }
    setSecretValues(values)
  }
}

/** 没有系统钥匙串时的降级：明文带前缀，调用方负责提示用户。 */
export function unavailableCipher(): SecretCipher {
  return {
    isAvailable: () => false,
    encrypt: (plain) => `${PLAIN_PREFIX}${plain}`,
    decrypt: (blob) => {
      if (!blob.startsWith(PLAIN_PREFIX)) throw new Error('无法解密')
      return blob.slice(PLAIN_PREFIX.length)
    },
  }
}
