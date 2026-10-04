import { describe, expect, it } from 'vitest'
import { EMPTY_PROJECT_WORKSPACE, parseProjectWorkspaceState, serializeProjectWorkspaceState, validateProjectWorkspaceJson } from '../src/project/workspace.js'

describe('project workspace profile', () => {
  it('older/invalid project state opens as an empty editable workspace', () => {
    expect(parseProjectWorkspaceState(undefined)).toEqual(EMPTY_PROJECT_WORKSPACE)
    expect(parseProjectWorkspaceState('{')).toEqual(EMPTY_PROJECT_WORKSPACE)
    expect(parseProjectWorkspaceState('[]')).toEqual(EMPTY_PROJECT_WORKSPACE)
  })

  it('trims editable lists and round-trips the campaign fields', () => {
    const raw = serializeProjectWorkspaceState({
      schemaVersion: 1,
      goal: ' 宣传腕表方案 ',
      salesAudience: ' 渠道商 ',
      storyAudience: ' 一线医护 ',
      channels: ['微信', ' ', '现场'],
      systemOutline: ['整体方案', '功能介绍'],
      weeklyCadence: '每周一批',
    })
    expect(parseProjectWorkspaceState(raw)).toEqual({
      schemaVersion: 1,
      goal: '宣传腕表方案',
      salesAudience: '渠道商',
      storyAudience: '一线医护',
      channels: ['微信', '现场'],
      systemOutline: ['整体方案', '功能介绍'],
      weeklyCadence: '每周一批',
    })
  })

  it('rejects malformed, non-object, empty, and oversized JSON', () => {
    expect(() => validateProjectWorkspaceJson('')).toThrow(/不能为空/)
    expect(() => validateProjectWorkspaceJson('{')).toThrow(/合法 JSON/)
    expect(() => validateProjectWorkspaceJson('[]')).toThrow(/顶层/)
    expect(() => validateProjectWorkspaceJson(`{"x":"${'x'.repeat(200_000)}"}`)).toThrow(/200KB/)
  })
})
