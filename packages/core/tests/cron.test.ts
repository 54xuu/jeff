import { describe, it, expect } from 'vitest'
import { CRON_PRESETS, cronExprForOnce, describeCron, describeOnce, isValidCron, nextRunAt, parseCron, parseRunAt, syncedNextRun } from '../src/cron/expr.js'

/** 用本地时间构造时间戳（与实现同一时区语义，避免 CI 时区差异导致测试飘） */
function local(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

describe('cron 表达式解析', () => {
  it('标准 5 段', () => {
    const f = parseCron('0 8 * * *')
    expect(f.minute).toEqual([0])
    expect(f.hour).toEqual([8])
    expect(f.dom.length).toBe(31)
    expect(f.dow.length).toBe(7)
  })

  it('区间 / 步长 / 枚举', () => {
    expect(parseCron('*/15 * * * *').minute).toEqual([0, 15, 30, 45])
    expect(parseCron('30 8 * * 1-5').dow).toEqual([1, 2, 3, 4, 5])
    expect(parseCron('0 9,18 * * *').hour).toEqual([9, 18])
    expect(parseCron('0 6-12/3 * * *').hour).toEqual([6, 9, 12])
  })

  it('周字段 7 归一为 0（周日）', () => {
    expect(parseCron('0 8 * * 7').dow).toEqual([0])
    expect(parseCron('0 8 * * 0,7').dow).toEqual([0])
  })

  it('非法表达式报可读错误', () => {
    expect(() => parseCron('0 8 * *')).toThrow(/5 段/)
    expect(() => parseCron('99 8 * * *')).toThrow(/超出范围/)
    expect(() => parseCron('0 8 32 * *')).toThrow(/超出范围/)
    expect(() => parseCron('0 8 * * abc')).toThrow(/取值非法/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/步长非法/)
    expect(isValidCron('0 8 * * *')).toBe(true)
    expect(isValidCron('nope')).toBe(false)
  })
})

describe('nextRunAt', () => {
  it('每天 8:00：当天未到取当天，已过取次日', () => {
    const before = local(2026, 9, 14, 7, 30)
    expect(nextRunAt('0 8 * * *', before)).toBe(local(2026, 9, 14, 8, 0))
    const after = local(2026, 9, 14, 8, 0)
    // 严格晚于 from：正好等于触发点时要取下一次
    expect(nextRunAt('0 8 * * *', after)).toBe(local(2026, 9, 15, 8, 0))
  })

  it('工作日 8:30：周五之后跳到周一', () => {
    // 2026-09-18 是周五
    const fri = local(2026, 9, 18, 9, 0)
    expect(nextRunAt('30 8 * * 1-5', fri)).toBe(local(2026, 9, 21, 8, 30))
  })

  it('每小时整点', () => {
    expect(nextRunAt('0 * * * *', local(2026, 9, 14, 10, 5))).toBe(local(2026, 9, 14, 11, 0))
  })

  it('每月 1 号 09:00 跨月', () => {
    expect(nextRunAt('0 9 1 * *', local(2026, 9, 14, 12, 0))).toBe(local(2026, 10, 1, 9, 0))
  })

  it('日与周同时限定时取「或」（cron 惯例）', () => {
    // 每月 1 号或每周一 08:00：9/14 是周一 → 取 9/14；否则取 10/1
    const monday = local(2026, 9, 14, 7, 0)
    expect(nextRunAt('0 8 1 * 1', monday)).toBe(local(2026, 9, 14, 8, 0))
  })

  it('永不命中的组合抛错而非死循环', () => {
    expect(() => nextRunAt('0 8 30 2 *', local(2026, 9, 14, 0, 0))).toThrow(/5 年内/)
  })
})

describe('describeCron 人性化描述', () => {
  it('常见表达式', () => {
    expect(describeCron('0 8 * * *')).toBe('每天 08:00')
    expect(describeCron('30 8 * * 1-5')).toBe('工作日 08:30')
    expect(describeCron('0 9 * * 1')).toBe('每周一 09:00')
    expect(describeCron('0 9 * * 0,6')).toBe('周末 09:00')
    expect(describeCron('*/30 * * * *')).toBe('每 30 分钟')
    expect(describeCron('0 9 1 * *')).toBe('每月 1 日 09:00')
  })

  it('非法表达式返回提示而非抛错（UI 直接展示）', () => {
    expect(describeCron('bad')).toBe('表达式非法')
  })

  it('模板全部合法且可算出下次时间', () => {
    for (const p of CRON_PRESETS) {
      expect(isValidCron(p.expr)).toBe(true)
      expect(typeof nextRunAt(p.expr, Date.now())).toBe('number')
    }
  })
})

describe('一次性时刻', () => {
  const now = local(2026, 9, 22, 10, 0)

  it('今天 12:00 落在当天中午，不滚到明年', () => {
    const at = parseRunAt('今天 12:00', now)
    expect(at).toBe(local(2026, 9, 22, 12, 0))
    expect(describeOnce(at, now)).toBe('仅一次 · 今天 12:00')
    expect(cronExprForOnce(at)).toBe('0 12 22 9 *')
  })

  it('明天 / 绝对日期 / 刚过去 30 秒视为立刻', () => {
    expect(parseRunAt('明天 08:30', now)).toBe(local(2026, 9, 23, 8, 30))
    expect(parseRunAt('2026-09-22 18:00', now)).toBe(local(2026, 9, 22, 18, 0))
    expect(parseRunAt('今天12点', now)).toBe(local(2026, 9, 22, 12, 0))
    const just = now - 20_000
    expect(parseRunAt('今天 10:00', now)).toBe(now)
    expect(just).toBeLessThan(now)
  })

  it('过去超过 1 分钟直接拒绝，而不是排到下一年', () => {
    expect(() => parseRunAt('今天 08:00', now)).toThrow(/已过去|刚过去/)
    const yesterday = local(2026, 9, 1, 12, 0)
    const expr = cronExprForOnce(yesterday)
    expect(syncedNextRun({ cron_expr: expr, run_at: yesterday }, now)).toBeNull()
    expect(nextRunAt(expr, now)).toBeGreaterThan(now)
  })
})
