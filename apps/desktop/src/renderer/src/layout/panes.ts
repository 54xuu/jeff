/**
 * 三栏布局的尺寸规则（纯计算 + localStorage 读写）。
 *
 * 界面 = 导航栏 + 会话列表（可拖宽/可收起）+ 对话区（自适应）+ 内置浏览器（可拖宽/可收起）。
 * 规则集中在这里，免得 App / BrowserPanel / store 各算一套互相打架。
 *
 * 宽度分两层：store 里存的是「用户偏好的宽度」（落盘），渲染时再用 clamp 算「当前生效宽度」。
 * 这样窗口临时变小只是把面板挤窄，窗口变回来宽度会自动恢复，不会被一次 clamp 永久改掉。
 */

export const RAIL_WIDTH = 64
/** 对话区的最小可读宽度：拖动两侧栏时优先保住它 */
export const CHAT_MIN_WIDTH = 360

export const LIST_DEFAULT_WIDTH = 280
export const LIST_MIN_WIDTH = 200
export const LIST_MAX_WIDTH = 480

export const BROWSER_MIN_WIDTH = 320
/** 默认宽度按窗口比例给：旧的固定 460px 在宽窗口下只有手机大小 */
export const BROWSER_DEFAULT_RATIO = 0.42
export const BROWSER_DEFAULT_MIN = 520

/** 旧版本的固定默认宽度：localStorage 里是这个值说明用户从没手动调过，按新默认重算 */
const LEGACY_BROWSER_WIDTH = 460

export const LAYOUT_KEYS = {
  listWidth: 'jeff-list-width',
  listVisible: 'jeff-list-visible',
  browserWidth: 'jeff-browser-width',
} as const

export interface PaneLayout {
  listVisible: boolean
  /** 会话列表宽度（偏好值） */
  listWidth: number
  /** 内置浏览器宽度（偏好值） */
  browserWidth: number
}

/** 当前窗口宽度（渲染层总是有 window；脱离 DOM 的调用给个兜底值，便于纯函数测试） */
export function viewportWidth(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth
}

export function defaultBrowserWidth(winWidth: number = viewportWidth()): number {
  return Math.max(BROWSER_DEFAULT_MIN, Math.round(winWidth * BROWSER_DEFAULT_RATIO))
}

/** 会话列表上限：窗口不够宽时不能把对话区挤没 */
export function maxListWidth(winWidth: number = viewportWidth()): number {
  return Math.max(LIST_MIN_WIDTH, Math.min(LIST_MAX_WIDTH, winWidth - RAIL_WIDTH - CHAT_MIN_WIDTH))
}

export function clampListWidth(width: number, winWidth: number = viewportWidth()): number {
  if (!Number.isFinite(width)) return LIST_DEFAULT_WIDTH
  return Math.round(Math.min(Math.max(width, LIST_MIN_WIDTH), maxListWidth(winWidth)))
}

/** 浏览器上限：窗口宽度刨掉导航栏、会话列表，再留出对话区最小值 */
export function maxBrowserWidth(
  winWidth: number = viewportWidth(),
  listVisible = true,
  listWidth: number = LIST_DEFAULT_WIDTH,
): number {
  const occupied = RAIL_WIDTH + (listVisible ? listWidth : 0)
  return Math.max(BROWSER_MIN_WIDTH, winWidth - occupied - CHAT_MIN_WIDTH)
}

export function clampBrowserWidth(
  width: number,
  winWidth: number = viewportWidth(),
  listVisible = true,
  listWidth: number = LIST_DEFAULT_WIDTH,
): number {
  if (!Number.isFinite(width)) return defaultBrowserWidth(winWidth)
  return Math.round(Math.min(Math.max(width, BROWSER_MIN_WIDTH), maxBrowserWidth(winWidth, listVisible, listWidth)))
}

function readNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export function readLayout(): PaneLayout {
  let listVisible = true
  try {
    listVisible = localStorage.getItem(LAYOUT_KEYS.listVisible) !== '0'
  } catch {
    listVisible = true
  }
  const listWidth = clampListWidth(readNumber(LAYOUT_KEYS.listWidth) ?? LIST_DEFAULT_WIDTH)
  const stored = readNumber(LAYOUT_KEYS.browserWidth)
  const preferred = stored == null || stored === LEGACY_BROWSER_WIDTH ? defaultBrowserWidth() : stored
  return { listVisible, listWidth, browserWidth: clampBrowserWidth(preferred, viewportWidth(), listVisible, listWidth) }
}

/** 落盘（只在拖拽结束 / 点按钮时调用，不逐帧写） */
export function writeLayout(layout: PaneLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEYS.listVisible, layout.listVisible ? '1' : '0')
    localStorage.setItem(LAYOUT_KEYS.listWidth, String(Math.round(layout.listWidth)))
    localStorage.setItem(LAYOUT_KEYS.browserWidth, String(Math.round(layout.browserWidth)))
  } catch {
    /* 隐私模式等场景写不进去：布局照常工作，只是下次启动回到默认 */
  }
}
