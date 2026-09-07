import { describe, expect, it } from 'vitest'
import { formatWebdavError, normalizeWebdavBasePath } from '../src/sync/engine.js'

describe('WebDAV path / error helpers', () => {
  it('normalizeWebdavBasePath 补前导斜杠并去尾斜杠', () => {
    expect(normalizeWebdavBasePath('jeff')).toBe('/jeff')
    expect(normalizeWebdavBasePath('/jeff/')).toBe('/jeff')
    expect(normalizeWebdavBasePath('')).toBe('/jeff')
    expect(normalizeWebdavBasePath('  /dav/jeff/  ')).toBe('/dav/jeff')
  })

  it('formatWebdavError 翻译 403/401', () => {
    const e403 = formatWebdavError(new Error('Invalid response: 403 Forbidden'))
    expect(e403).toContain('拒绝访问')
    expect(e403).toContain('403')
    const e401 = formatWebdavError(new Error('Invalid response: 401 Unauthorized'))
    expect(e401).toContain('认证失败')
  })
})
