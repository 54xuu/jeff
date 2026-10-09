import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { chatMessageRepo } from '../src/db/repos.js'
import { DebugLogger } from '../src/logger.js'
import { buildPaths, ensureDirs } from '../src/paths.js'
import { prepareEnvironment } from '../src/engines/environment.js'
import { mergeSidecarEnv } from '../src/sidecar/manager.js'
import { clearSecretValues, redactText, setSecretValues } from '../src/secrets/redact.js'
import type { SecretCipher, SecretStore } from '../src/secrets/types.js'
import { SECRETS_APPLIED_KEY, SecretVault, hashEnv, mergeSecretMeta } from '../src/secrets/vault.js'

function memoryStore(): SecretStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>()
  return {
    raw,
    getJSON<T>(key: string, fallback: T): T {
      const value = raw.get(key)
      return value == null ? fallback : JSON.parse(value) as T
    },
    setJSON(key: string, value: unknown) {
      raw.set(key, JSON.stringify(value))
    },
  }
}

function xorBytes(input: Buffer): Buffer {
  const out = Buffer.alloc(input.length)
  for (let i = 0; i < input.length; i++) out[i] = input[i] ^ 0x5a
  return out
}

function xorCipher(available: boolean): SecretCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => xorBytes(Buffer.from(plain, 'utf8')).toString('base64'),
    decrypt: (blob) => xorBytes(Buffer.from(blob, 'base64')).toString('utf8'),
  }
}

afterEach(() => clearSecretValues())

describe('密码库', () => {
  it('拒绝保留名、非法字符、空值、空字符和超长值', () => {
    const vault = new SecretVault(memoryStore(), xorCipher(true))
    for (const name of ['PATH', 'ld_preload', 'ELECTRON_RUN_AS_NODE', 'JEFF_HOME', 'OPENCODE_CONFIG', '1KEY', 'HAS-DASH']) {
      expect(() => vault.save({ name, value: 'abcdefghij' })).toThrow()
    }
    expect(() => vault.save({ name: 'WEB_SEARCH_API_KEY', value: '' })).toThrow(/请填写值/)
    expect(() => vault.save({ name: 'WEB_SEARCH_API_KEY', value: 'a\0b' })).toThrow(/空字符/)
    expect(() => vault.save({ name: 'WEB_SEARCH_API_KEY', value: 'x'.repeat(8193) })).toThrow(/不能超过/)
  })

  it('加密往返不落明文；钥匙串可用后把明文迁移成密文', () => {
    const store = memoryStore()
    const plain = new SecretVault(store, xorCipher(false))
    plain.save({ name: 'WEB_SEARCH_API_KEY', value: 'super-secret-value', note: '搜索' })
    expect(store.raw.get('secrets:vault')).toContain('plain:super-secret-value')
    const encrypted = new SecretVault(store, xorCipher(true))
    encrypted.load()
    const raw = store.raw.get('secrets:vault') || ''
    expect(raw).not.toContain('super-secret-value')
    expect(raw).not.toContain('plain:')
    expect(encrypted.reveal('WEB_SEARCH_API_KEY')).toBe('super-secret-value')
    expect(encrypted.list().encrypted).toBe(true)
    expect(encrypted.list().items[0]).toMatchObject({ last4: 'alue', hasValue: true, pending: false })
    expect(JSON.stringify(encrypted.list())).not.toContain('super-secret-value')
  })

  it('解密失败只标记这一条，其他条目继续注入', () => {
    const store = memoryStore()
    const ok = new SecretVault(store, xorCipher(true))
    ok.save({ name: 'GOOD_TOKEN', value: 'good-token-value' })
    ok.save({ name: 'BAD_TOKEN', value: 'bad-token-value' })
    const broken = new SecretVault(store, {
      isAvailable: () => true,
      encrypt: (plain) => xorBytes(Buffer.from(plain, 'utf8')).toString('base64'),
      decrypt: (blob) => {
        const plain = xorBytes(Buffer.from(blob, 'base64')).toString('utf8')
        if (plain.includes('bad-token')) throw new Error('钥匙串已重置')
        return plain
      },
    })
    const view = broken.list()
    expect(view.items.find((item) => item.name === 'BAD_TOKEN')?.undecryptable).toBe(true)
    expect(broken.env()).toEqual({ GOOD_TOKEN: 'good-token-value' })
    expect(() => broken.reveal('BAD_TOKEN')).toThrow(/无法解密/)
  })

  it('只注入启用且已填写的条目，并覆盖系统同名变量', () => {
    const vault = new SecretVault(memoryStore(), xorCipher(true))
    vault.save({ name: 'WEB_SEARCH_API_KEY', value: 'from-jeff-value' })
    vault.save({ name: 'DISABLED_TOKEN', value: 'disabled-token-value', enabled: false })
    expect(() => vault.save({ name: 'web_search_api_key', value: 'other-value-ok' })).toThrow(/已存在/)
    const merged = mergeSidecarEnv({ WEB_SEARCH_API_KEY: 'from-system', PATH: '/usr/bin' }, { PATH: '/fixed' }, { ...vault.env(), PATH: '/hijack' })
    expect(merged.env.WEB_SEARCH_API_KEY).toBe('from-jeff-value')
    expect(merged.env.PATH).toBe('/fixed')
    expect(merged.injected.PATH).toBeUndefined()
    expect(merged.injected.DISABLED_TOKEN).toBeUndefined()
  })

  it('改名留下墓碑；停用和新增会让重启标记变真，标记已应用后消失', () => {
    const store = memoryStore()
    const vault = new SecretVault(store, xorCipher(true))
    vault.save({ name: 'OLD_TOKEN', value: 'old-token-value' })
    expect(vault.list().restartNeeded).toBe(true)
    vault.markApplied()
    expect(vault.list().restartNeeded).toBe(false)
    vault.save({ name: 'NEW_TOKEN', value: 'new-token-value', originalName: 'OLD_TOKEN' })
    expect(vault.read().some((entry) => entry.name === 'OLD_TOKEN' && entry.deletedAt)).toBe(true)
    expect(vault.env()).toEqual({ NEW_TOKEN: 'new-token-value' })
    expect(vault.list().restartNeeded).toBe(true)
    vault.save({ name: 'NEW_TOKEN', originalName: 'NEW_TOKEN', enabled: false })
    expect(vault.env()).toEqual({})
    expect(hashEnv(vault.env())).not.toBe(store.getJSON(SECRETS_APPLIED_KEY, ''))
  })

  it('同步合并只更新元数据，不覆盖本机的值', () => {
    const local = new SecretVault(memoryStore(), xorCipher(true))
    local.save({ name: 'WEB_SEARCH_API_KEY', value: 'local-secret-value', note: '旧备注' })
    const stored = local.read()
    stored[0].updatedAt = 10
    const merged = mergeSecretMeta(stored, [
      { name: 'WEB_SEARCH_API_KEY', note: '新备注', enabled: false, updatedAt: 20, deletedAt: null },
      { name: 'OTHER_TOKEN', note: '待填', enabled: true, updatedAt: 20, deletedAt: null },
    ])
    expect(merged.find((entry) => entry.name === 'WEB_SEARCH_API_KEY')).toMatchObject({ note: '新备注', enabled: false, pending: false })
    expect(merged.find((entry) => entry.name === 'WEB_SEARCH_API_KEY')?.valueEnc).toBe(stored[0].valueEnc)
    expect(merged.find((entry) => entry.name === 'OTHER_TOKEN')).toMatchObject({ pending: true, valueEnc: '' })
  })

  it('外部引擎环境覆盖同名变量，且不改写 process.env', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-secret-env-'))
    const prev = process.env.PROBE_SECRET
    process.env.PROBE_SECRET = 'from-system'
    try {
      const result = prepareEnvironment(root, 's', 'cursor', '身份', root, 'http://127.0.0.1:9', {}, { PROBE_SECRET: 'from-jeff', PATH: '/nope' })
      expect(result.env.PROBE_SECRET).toBe('from-jeff')
      expect(result.env.PATH).toBe(process.env.PATH)
      expect(process.env.PROBE_SECRET).toBe('from-system')
    } finally {
      if (prev === undefined) delete process.env.PROBE_SECRET
      else process.env.PROBE_SECRET = prev
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('落盘文本会替换足够长的精确值', () => {
    setSecretValues([{ name: 'PROBE_SECRET', value: 'short' }, { name: 'WEB_SEARCH_API_KEY', value: 'super-secret-value' }])
    expect(redactText('token=super-secret-value')).toBe('token=••••(WEB_SEARCH_API_KEY)')
    expect(redactText('short')).toBe('short')
    clearSecretValues()
    expect(redactText('super-secret-value')).toBe('super-secret-value')
  })

  it('聊天记录和调试日志入库前脱敏', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-secret-log-'))
    const paths = buildPaths(home)
    ensureDirs(paths)
    const db = openDb(paths)
    setSecretValues([{ name: 'WEB_SEARCH_API_KEY', value: 'super-secret-value' }])
    const row = chatMessageRepo(db).add({ scope: 'group:p:t', sender_type: 'agent', content: '看到 super-secret-value', meta: { out: 'super-secret-value' } })
    expect(row.content).toBe('看到 ••••(WEB_SEARCH_API_KEY)')
    expect(row.meta).not.toContain('super-secret-value')
    const logger = new DebugLogger(paths)
    logger.setEnabled(true)
    logger.log('tool', { output: 'super-secret-value' })
    const log = fs.readFileSync(path.join(paths.logDir, `debug-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}.log`), 'utf8')
    expect(log).toContain('••••(WEB_SEARCH_API_KEY)')
    expect(log).not.toContain('super-secret-value')
    db.close()
  })
})
