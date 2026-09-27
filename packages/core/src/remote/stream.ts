/**
 * 桌面端 chat-stream 每次推的是累计全文。走公网只发增量。
 * 若新文本不是旧文本的延伸（压缩、替换），reset=true，delta 为全文。
 */
export function streamDelta(prev: string, next: string): { reset: boolean; delta: string } {
  if (next.startsWith(prev)) return { reset: false, delta: next.slice(prev.length) }
  return { reset: true, delta: next }
}

export interface StreamFlush {
  reset: boolean
  delta: string
}

/**
 * 把细碎增量合并成约 intervalMs 一帧。force=true（回合结束）立即吐出。
 * now 可注入，单测不必真等。
 */
export function createStreamCoalescer(intervalMs: number, now: () => number = Date.now) {
  let lastFlush = Number.NEGATIVE_INFINITY
  let pending = ''
  let pendingReset = false
  return {
    push(delta: string, reset: boolean, force = false): StreamFlush | null {
      if (reset) {
        pending = delta
        pendingReset = true
      } else {
        pending += delta
      }
      const t = now()
      if (!force && t - lastFlush < intervalMs) return null
      if (pending.length === 0 && !pendingReset) return null
      const out: StreamFlush = { reset: pendingReset, delta: pending }
      pending = ''
      pendingReset = false
      lastFlush = t
      return out
    },
  }
}
