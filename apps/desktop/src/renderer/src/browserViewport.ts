/**
 * 内置浏览器的视口设置：人（工具栏「分辨率」菜单）与 agent（jeff_browser_set_viewport）
 * 改的是同一份，落在 store + localStorage（本机偏好，不参与 WebDAV 同步——与三栏宽度一致）。
 *
 * 为什么要分「请求值」与「生效尺寸」两层：
 * - 请求值是意图（自适应 / 4:3 比例 / 精确像素），要跨重启记住；
 * - 生效尺寸是按当前面板容器算出来的像素（4:3 要随面板变），它才是页面视口、
 *   截图尺寸、工具返回值的真实来源——不把两者混成一个数，才能「窗口变小只把视口挤小、
 *   偏好不被覆盖」（与 layout/panes.ts 同一套思路）。
 */
export type BrowserViewportRequest =
  | { mode: 'auto' }
  /** 等比例自适应：按面板可用高度算出最大的 4:3 视口，居中留白 */
  | { mode: 'ratio'; aspect: number; ratio: string }
  /** 精确像素：面板放不下时面板内出现滚动条，视口严格等于这两个值 */
  | { mode: 'fixed'; width: number; height: number }

export type BrowserViewportSize = { width: number; height: number }

export const VIEWPORT_LIMITS = { minWidth: 320, maxWidth: 5120, minHeight: 240, maxHeight: 5120 }

/** 视口偏好的 localStorage key（仅本机） */
export const VIEWPORT_STORE_KEY = 'jeff-browser-resolution'

export const AUTO_VIEWPORT: BrowserViewportRequest = { mode: 'auto' }

/**
 * 按容器可用尺寸算出实际视口像素。
 * auto：铺满容器；ratio：容器内最大的等比例矩形（放不下时按宽度反算）；fixed：原样。
 */
export function fitViewport(req: BrowserViewportRequest, avail: BrowserViewportSize): BrowserViewportSize {
  if (req.mode === 'fixed') return { width: req.width, height: req.height }
  const availW = Math.max(1, Math.floor(avail.width))
  const availH = Math.max(1, Math.floor(avail.height))
  if (req.mode === 'auto') return { width: availW, height: availH }
  const aspect = req.aspect > 0 ? req.aspect : 4 / 3
  let height = availH
  let width = Math.round(height * aspect)
  if (width > availW) {
    width = availW
    height = Math.round(width / aspect)
  }
  return { width: Math.max(1, width), height: Math.max(1, height) }
}

/** 面板标题/工具提示里显示的人类可读描述 */
export function describeViewport(req: BrowserViewportRequest, eff?: BrowserViewportSize): string {
  if (req.mode === 'auto') return eff ? `自适应 ${eff.width}x${eff.height}` : '自适应'
  if (req.mode === 'ratio') return eff ? `${req.ratio}（${eff.width}x${eff.height}）` : req.ratio
  return `${req.width}x${req.height}`
}

/** 从 localStorage 读回偏好（坏数据一律退回自适应，绝不因为脏 JSON 让面板打不开） */
export function parseViewport(json: string | null): BrowserViewportRequest {
  if (!json) return AUTO_VIEWPORT
  try {
    const raw = JSON.parse(json) as Partial<{ mode: string; aspect: number; ratio: string; width: number; height: number }>
    if (raw?.mode === 'fixed') {
      const w = Number(raw.width)
      const h = Number(raw.height)
      if (Number.isInteger(w) && Number.isInteger(h) && w >= VIEWPORT_LIMITS.minWidth && w <= VIEWPORT_LIMITS.maxWidth && h >= VIEWPORT_LIMITS.minHeight && h <= VIEWPORT_LIMITS.maxHeight) {
        return { mode: 'fixed', width: w, height: h }
      }
      return AUTO_VIEWPORT
    }
    if (raw?.mode === 'ratio') {
      const aspect = Number(raw.aspect)
      return { mode: 'ratio', aspect: aspect > 0 ? aspect : 4 / 3, ratio: typeof raw.ratio === 'string' && raw.ratio ? raw.ratio : '4:3' }
    }
  } catch {
    /* 脏数据：退回默认 */
  }
  return AUTO_VIEWPORT
}

export function serializeViewport(req: BrowserViewportRequest): string {
  return JSON.stringify(req)
}

/**
 * 解析用户输入的自定义分辨率（`1697x1063` / `1697 X 1063` / `1697×1063` / 带 px）；
 * 不在允许区间或解不出来返回 null（调用方据此提示，不静默忽略）。
 */
export function parseResolutionText(text: string): BrowserViewportSize | null {
  const m = /^\s*(\d{2,5})\s*(?:[x×*]|X)\s*(\d{2,5})\s*(?:px)?\s*$/i.exec(text || '')
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  const L = VIEWPORT_LIMITS
  if (width < L.minWidth || width > L.maxWidth || height < L.minHeight || height > L.maxHeight) return null
  return { width, height }
}
