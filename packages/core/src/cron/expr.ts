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

/** 一次性目标刚过去仍允许立刻补上的窗口（模型算时刻时常差几秒到跨分钟） */
const ONCE_GRACE_MS = 60 * 1000
/** 超过这个窗口的过去时间不再当成「刚跨分钟」，必须让用户改到未来 */
const ONCE_STALE_MS = 30 * 60 * 1000

/**
 * 把「今天 12:00 / 明天 08:30 / 2026-09-22 12:00」收成绝对时间戳（本机时区）。
 * 已经过去不足 1 分钟：立刻执行；过去 1 分钟到 30 分钟：拒绝（不要滚到明天或明年）。
 */
export function parseRunAt(text: string, now = Date.now()): number {
  const raw = String(text || '').trim().replace(/^仅一次\s*/, '')
  if (!raw) throw new Error('一次性时间不能为空。示例：今天 12:00、明天 08:30、2026-09-22 12:00')
  const compact = raw.replace(/\s+/g, '')
  let at: number | null = null
  const rel = /^(今天|明天|后天)(\d{1,2})(?:[:：]|点)(\d{1,2})?分?$/.exec(compact)
  if (rel) {
    const day = rel[1] === '今天' ? 0 : rel[1] === '明天' ? 1 : 2
    const hour = Number(rel[2])
    const minute = rel[3] === undefined ? 0 : Number(rel[3])
    if (hour > 23 || minute > 59) throw new Error('时间超出范围：小时 0-23，分钟 0-59')
    const base = new Date(now)
    base.setDate(base.getDate() + day)
    base.setHours(hour, minute, 0, 0)
    at = base.getTime()
  } else {
    const abs = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(raw)
    if (abs) {
      const hour = Number(abs[4])
      const minute = Number(abs[5])
      if (hour > 23 || minute > 59) throw new Error('时间超出范围：小时 0-23，分钟 0-59')
      at = new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3]), hour, minute, 0, 0).getTime()
    } else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
      const d = new Date(raw)
      if (!Number.isNaN(d.getTime())) at = d.getTime()
    } else {
      const hm = /^(\d{1,2}):(\d{2})$/.exec(compact)
      if (hm) {
        const hour = Number(hm[1])
        const minute = Number(hm[2])
        if (hour > 23 || minute > 59) throw new Error('时间超出范围：小时 0-23，分钟 0-59')
        const base = new Date(now)
        base.setHours(hour, minute, 0, 0)
        at = base.getTime()
      }
    }
  }
  if (at == null || Number.isNaN(at)) {
    throw new Error('无法识别的一次性时间。示例：今天 12:00、明天 08:30、2026-09-22 12:00')
  }
  return resolveOnceTarget(at, now)
}

/** 过去不足 1 分钟视为立刻执行；更早的目标拒绝，避免一次性任务被排到下一年 */
export function resolveOnceTarget(at: number, now = Date.now()): number {
  if (!Number.isFinite(at)) throw new Error('一次性时间无效')
  if (at > now) return at
  const age = now - at
  if (age < ONCE_GRACE_MS) return now
  if (age <= ONCE_STALE_MS) {
    throw new Error(`一次性任务的目标时间（${new Date(at).toLocaleString()}）刚过去；请改成还没到的时刻，或点「立即执行」`)
  }
  throw new Error(`一次性任务的目标时间（${new Date(at).toLocaleString()}）已过去；请改成未来的时刻`)
}

/** 一次性任务的兼容 cron（只用于展示/同步；调度以 run_at 为准，不会滚到下一年） */
export function cronExprForOnce(at: number): string {
  const d = new Date(at)
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`
}

/** 卡片副标题：仅一次 · 今天 12:00 */
export function describeOnce(at: number, now = Date.now()): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const startOf = (ts: number) => {
    const x = new Date(ts)
    x.setHours(0, 0, 0, 0)
    return x.getTime()
  }
  const dayDiff = Math.round((startOf(at) - startOf(now)) / 86_400_000)
  if (dayDiff === 0) return `仅一次 · 今天 ${hm}`
  if (dayDiff === 1) return `仅一次 · 明天 ${hm}`
  if (dayDiff === 2) return `仅一次 · 后天 ${hm}`
  return `仅一次 · ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

/** 任务卡片上的时间描述：有 run_at 的是一次性，否则按 cron */
export function describeSchedule(task: { cron_expr: string; run_at?: number | null }, now = Date.now()): string {
  if (task.run_at != null) return describeOnce(task.run_at, now)
  return describeCron(task.cron_expr)
}

/**
 * 同步落地后的下次触发。
 * 重复任务按 cron 从本机此刻重算；一次性任务只用绝对 run_at，已经过去就留空（绝不排到明年同一天）。
 */
export function syncedNextRun(task: { cron_expr: string; run_at?: number | null }, now = Date.now()): number | null {
  if (task.run_at != null) return task.run_at > now ? task.run_at : null
  try {
    return nextRunAt(task.cron_expr, now)
  } catch {
    return null
  }
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
