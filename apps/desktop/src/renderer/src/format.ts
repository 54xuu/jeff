/**
 * 消息发送时间统一格式：YYYY-MM-DD HH:mm:ss（本地时区）。
 * 用本地时间而非 ISO/UTC：用户要对照的是「我几点发的、几点回的」，
 * 便于直接相减估算每轮耗时。
 */
export function fmtFullTime(t?: number): string {
  if (!t) return ''
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
