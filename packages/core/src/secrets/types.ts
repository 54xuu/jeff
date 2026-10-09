/** 主进程注入的加密器。core 不依赖 Electron。 */
export interface SecretCipher {
  /** 系统钥匙串是否真的可用（Linux 的 basic_text 伪加密视为不可用） */
  isAvailable(): boolean
  encrypt(plain: string): string
  decrypt(blob: string): string
}

export interface StoredSecret {
  name: string
  /** 密文；明文降级时以 `plain:` 开头 */
  valueEnc: string
  note: string
  enabled: boolean
  updatedAt: number
  deletedAt: number | null
  /** 元数据从其他设备同步而来，本机还没有值 */
  pending: boolean
  /** 钥匙串变化后无法解密 */
  undecryptable?: boolean
}

export interface SecretMeta {
  name: string
  note: string
  enabled: boolean
  updatedAt: number
  deletedAt: number | null
}

export interface SecretListItem {
  name: string
  note: string
  enabled: boolean
  hasValue: boolean
  last4: string
  pending: boolean
  undecryptable: boolean
}

export interface SecretListResult {
  items: SecretListItem[]
  encrypted: boolean
  restartNeeded: boolean
}

export interface SecretStore {
  getJSON<T>(key: string, fallback: T): T
  setJSON(key: string, value: unknown): void
}
