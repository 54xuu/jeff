import { describe, expect, it } from 'vitest'
import { normalizeProjectRole, projectRoleLabel } from '../src/util/projectRole.js'

describe('normalizeProjectRole', () => {
  it('仅保留 leader，其余一律 worker', () => {
    expect(normalizeProjectRole('leader')).toBe('leader')
    expect(normalizeProjectRole('Leader')).toBe('leader')
    expect(normalizeProjectRole('worker')).toBe('worker')
    expect(normalizeProjectRole('member')).toBe('worker')
    expect(normalizeProjectRole('开发')).toBe('worker')
    expect(normalizeProjectRole('产品')).toBe('worker')
    expect(normalizeProjectRole('ui')).toBe('worker')
    expect(normalizeProjectRole('')).toBe('worker')
    expect(normalizeProjectRole(null)).toBe('worker')
  })

  it('中文标签', () => {
    expect(projectRoleLabel('leader')).toBe('群主')
    expect(projectRoleLabel('开发')).toBe('工作者')
  })
})
