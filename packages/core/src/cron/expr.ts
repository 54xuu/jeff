/**
 * 5 段式 cron 解析（分 时 日 月 周），本机时区。
 *
 * 为什么自研而不引第三方：只需「算下一次触发 + 校验 + 人性化描述」三件事，
 * 实现不到 150 行且纯函数好测；引库会给 Electron 打包多一个运行时依赖。
 *
 * 支持语法：星号、数字、区间 a-b、步长（星号斜杠 n 与 a-b/n）、枚举 a,b,c；周字段 0/7 = 周日。
 */
export interface CronFields {
  minute: number[]
  hour: number[]
  dom: number[]
  month: number[]
  dow: number[]
}

const RANGES: Array<{ min: number; max: number; label: string }> = [
  { min: 0, max: 59, label: '分钟' },
  { min: 0, max: 23, label: '小时' },
  { min: 1, max: 31, label: '日' },
  { min: 1, max: 12, label: '月' },
  { min: 0, max: 6, label: '星期' },
]

/** 解析单个字段为升序去重的取值列表 */
function parseField(raw: string, min: number, max: number, label: string): number[] {
  const out = new Set<number>()
  const text = raw.trim()
  if (!text) throw new Error(`${label}字段为空`)
  for (const part of text.split(',')) {
    const seg = part.trim()
    if (!seg) throw new Error(`${label}字段含空项`)
    const [rangeRaw, stepRaw] = seg.split('/')
    let step = 1
    if (stepRaw !== undefined) {
      step = Number(stepRaw)
      if (!Number.isInteger(step) || step <= 0) throw new Error(`${label}步长非法：${seg}`)
    }
    let lo: number
    let hi: number
    if (rangeRaw === '*') {
      lo = min
      hi = max
    } else if (rangeRaw.includes('-')) {
      const [a, b] = rangeRaw.split('-')
      lo = Number(a)
      hi = Number(b)
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`${label}区间非法：${seg}`)
    } else {
      lo = Number(rangeRaw)
      hi = stepRaw === undefined ? lo : max
      if (!Number.isInteger(lo)) throw new Error(`${label}取值非法：${seg}`)
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`${label}超出范围 ${min}-${max}：${seg}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return Array.from(out).sort((a, b) => a - b)
}

/** 解析 5 段 cron；非法时抛错（错误信息可直接展示给用户） */
export function parseCron(expr: string): CronFields {
  const parts = String(expr || '').trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周（如 0 8 * * *）')
  const [minute, hour, dom, month, dowRaw] = parts
  // 周字段把 7 归一成 0（周日）
  const dow = parseField(dowRaw, 0, 7, RANGES[4].label).map((d) => (d === 7 ? 0 : d))
  return {
    minute: parseField(minute, RANGES[0].min, RANGES[0].max, RANGES[0].label),
    hour: parseField(hour, RANGES[1].min, RANGES[1].max, RANGES[1].label),
    dom: parseField(dom, RANGES[2].min, RANGES[2].max, RANGES[2].label),
    month: parseField(month, RANGES[3].min, RANGES[3].max, RANGES[3].label),
    dow: Array.from(new Set(dow)).sort((a, b) => a - b),
  }
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

/**
 * 下一次触发时间（严格晚于 from，本机时区）。
 * 日与周同时限定时按 cron 惯例取「或」（命中其一即可），这也是用户对「每月 1 号或每周一」的直觉。
 */
export function nextRunAt(expr: string, from: number = Date.now()): number {
  const f = parseCron(expr)
  const minSet = new Set(f.minute)
  const hourSet = new Set(f.hour)
  const monthSet = new Set(f.month)
  const domWildcard = f.dom.length === 31
  const dowWildcard = f.dow.length === 7
  const domSet = new Set(f.dom)
  const dowSet = new Set(f.dow)

  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  // 上限 5 年：防止 2 月 30 日之类永不命中的表达式把主进程卡死
  const limit = new Date(cursor.getTime())
  limit.setFullYear(limit.getFullYear() + 5)

  while (cursor.getTime() <= limit.getTime()) {
    if (!monthSet.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(cursor, domSet, dowSet, domWildcard, dowWildcard)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!hourSet.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!minSet.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
      continue
    }
    return cursor.getTime()
  }
  throw new Error('该表达式在 5 年内没有可命中的时间，请检查日/月组合')
}

function dayMatches(d: Date, domSet: Set<number>, dowSet: Set<number>, domWildcard: boolean, dowWildcard: boolean): boolean {
  if (domWildcard && dowWildcard) return true
  const domHit = domSet.has(d.getDate())
  const dowHit = dowSet.has(d.getDay())
  if (domWildcard) return dowHit
  if (dowWildcard) return domHit
  return domHit || dowHit
}

const DOW_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 人性化描述（左侧任务卡片副标题） */
export function describeCron(expr: string): string {
  let f: CronFields
  try {
    f = parseCron(expr)
  } catch {
    return '表达式非法'
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  const everyMinute = f.minute.length > 1 && f.hour.length === 24
  if (everyMinute) {
    const step = f.minute.length > 1 ? f.minute[1] - f.minute[0] : 1
    if (f.minute.every((m, i) => m === f.minute[0] + i * step) && f.minute[0] === 0) return `每 ${step} 分钟`
    return `每小时的第 ${f.minute.join('、')} 分钟`
  }
  // 时刻型：分钟与小时都是单个/少量取值
  const times = f.hour.length <= 4 && f.minute.length <= 4 ? f.hour.flatMap((h) => f.minute.map((m) => `${pad(h)}:${pad(m)}`)) : null
  const dayPart = describeDays(f)
  if (times && times.length <= 4) {
    return `${dayPart}${times.join('、')}`
  }
  return `自定义（${expr}）`
}

function describeDays(f: CronFields): string {
  if (f.month.length !== 12) return `${f.month.join('、')} 月的 ${f.dom.join('、')} 日 `
  const domWildcard = f.dom.length === 31
  const dowWildcard = f.dow.length === 7
  if (domWildcard && dowWildcard) return '每天 '
  if (dowWildcard) return `每月 ${f.dom.join('、')} 日 `
  if (domWildcard) {
    if (f.dow.length === 5 && f.dow.every((d) => d >= 1 && d <= 5)) return '工作日 '
    if (f.dow.length === 2 && f.dow.includes(0) && f.dow.includes(6)) return '周末 '
    return `每${f.dow.map((d) => DOW_NAMES[d]).join('、')} `
  }
  return `每月 ${f.dom.join('、')} 日或每${f.dow.map((d) => DOW_NAMES[d]).join('、')} `
}

/** 常用模板（新建任务一键填充） */
export const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: '每天 08:00', expr: '0 8 * * *' },
  { label: '每天 09:00', expr: '0 9 * * *' },
  { label: '工作日 08:30', expr: '30 8 * * 1-5' },
  { label: '每周一 09:00', expr: '0 9 * * 1' },
  { label: '每小时', expr: '0 * * * *' },
  { label: '每 30 分钟', expr: '*/30 * * * *' },
]
