/**
 * 浏览器工具的参数规范化。
 *
 * 为什么单独抽一个文件而不是内联在 handler 里：这几条规则都是被真模型咬出来的，
 * 需要单测钉住（见 packages/core/tests/browser-args.test.ts）：
 * - AGENTS.md 硬规矩②：**没传到 / 传空串一律当未提供**，否则模型一次「全字段补空」的调用
 *   就能把已经设好的分辨率打回默认；
 * - 给模型的参数只用标量，所以 width/height/preset 到达这里时可能是 1697、"1697"、"1697px"、'' 各种形状。
 */

export type ViewportSpec =
  | { mode: 'auto' }
  | { mode: 'ratio'; aspect: number; ratio: string }
  | { mode: 'fixed'; width: number; height: number }

export const VIEWPORT_LIMITS = { minWidth: 320, maxWidth: 5120, minHeight: 240, maxHeight: 5120 }

/** 把「未传 / null / 空串 / 全空白」统一成空串，交给调用方当「未提供」 */
function text(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim()
}

function dimOf(raw: string, min: number, max: number, label: string): number {
  // 容忍模型式的写法（"1697px"、"1697.0"），但结果必须是落在区间里的整数
  const n = Number(raw.replace(/px$/i, ''))
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} 要是 ${min}-${max} 之间的整数，收到「${raw}」`)
  return n
}

/**
 * decideViewport：preset 与 width/height 二选一。
 * - 同时给 width+height → 精确像素；
 * - preset="4:3" → 按比例自适应；
 * - preset="auto" → 恢复铺满；
 * - 只给一边、preset 不认识、**一个字段都没给（含全空串）** → 明确报错（不猜用户意图）。
 *
 * 为什么「全空串」必须报错而不是当「恢复默认」：模型经常一次把所有字段补空再调 update 类工具
 * （AGENTS.md 硬规矩②）。若把空串当 auto，它一次补空调用就会把 agent/用户刚设好的分辨率抹掉，
 * 而回复里还会说「已按你的要求设置」。宁可报错，也不要静默改掉用户看得见的状态。
 */
export function normalizeViewportArgs(args: { preset?: unknown; width?: unknown; height?: unknown }): ViewportSpec {
  // 全角冒号与空格容错：模型偶尔写 "4：3" / "4 : 3"（冒号要映射而不是删掉，否则变成 "43"）
  const preset = text(args?.preset).toLowerCase().replace(/：/g, ':').replace(/\s+/g, '')
  const widthRaw = text(args?.width)
  const heightRaw = text(args?.height)
  const hasWidth = widthRaw !== ''
  const hasHeight = heightRaw !== ''
  if (hasWidth !== hasHeight) {
    throw new Error('width 与 height 要一起传（精确分辨率）；只想按比例就用 preset="4:3"，恢复默认用 preset="auto"')
  }
  if (hasWidth) {
    return {
      mode: 'fixed',
      width: dimOf(widthRaw, VIEWPORT_LIMITS.minWidth, VIEWPORT_LIMITS.maxWidth, 'width'),
      height: dimOf(heightRaw, VIEWPORT_LIMITS.minHeight, VIEWPORT_LIMITS.maxHeight, 'height'),
    }
  }
  if (preset === 'auto' || preset === 'default' || preset === '自适应') return { mode: 'auto' }
  if (preset === '4:3' || preset === 'ratio' || preset === '4/3') return { mode: 'ratio', aspect: 4 / 3, ratio: '4:3' }
  if (preset === '') {
    throw new Error('没有要设置的分辨率：preset 传 "4:3"（按比例自适应）或 "auto"（恢复铺满），或用 width+height 指定精确像素')
  }
  throw new Error(`preset 只支持 "4:3"（按比例自适应）或 "auto"（恢复铺满），收到「${preset}」`)
}

/** full_page 是标量（字符串/布尔）传进来的，两种都认；'' / undefined 视为「只截可视区」 */
export function parseFullPageFlag(v: unknown): boolean {
  if (v === true) return true
  return /^(true|1|yes|full)$/i.test(text(v))
}

/**
 * 截图文件名里带页面标题（便于人和 agent 事后按标题找图）。
 * 标题来自网页、可能带路径分隔符等非法字符，也可能很长：清洗 + 截断，清洗后为空则退回 shot。
 */
export function shotName(title: string): string {
  const cleaned = String(title || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[.\s]+$/, '')
  return cleaned || 'shot'
}
