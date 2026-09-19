/**
 * Windows 屏幕右下角气泡：不走系统 Toast。
 *
 * 系统 Notification 在 NSIS 包上经常「调用成功但不出横幅」（AUMID / 操作中心权限 /
 * 免打扰会把 Toast 静默丢进中心或直接丢掉），而提示音是渲染层自己播的，
 * 于是用户只听到声音、看不到右下角。自绘 alwaysOnTop 窗口不依赖那些前置条件。
 */
import { BrowserWindow, nativeTheme, screen } from 'electron'
import {
  BALLOON_HEIGHT,
  BALLOON_SHOW_MS,
  BALLOON_WIDTH,
  balloonBounds,
  balloonHtml,
} from '@jeff/core'

let balloon: BrowserWindow | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let onActivate: (() => void) | null = null

function clearTimer(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

export function closeWindowsBalloon(): void {
  clearTimer()
  onActivate = null
  if (balloon && !balloon.isDestroyed()) {
    balloon.hide()
  }
}

function targetWorkArea(main: BrowserWindow | null): { x: number; y: number; width: number; height: number } {
  try {
    if (main && !main.isDestroyed()) {
      return screen.getDisplayMatching(main.getBounds()).workArea
    }
  } catch {
    /* 窗口已毁则退回主屏 */
  }
  return screen.getPrimaryDisplay().workArea
}

function ensureBalloon(): BrowserWindow {
  if (balloon && !balloon.isDestroyed()) return balloon
  balloon = new BrowserWindow({
    width: BALLOON_WIDTH,
    height: BALLOON_HEIGHT,
    show: false,
    frame: false,
    transparent: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2c2c2c' : '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  balloon.setAlwaysOnTop(true, 'screen-saver')
  try {
    balloon.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } catch {
    /* Windows 上该 API 可能不可用，忽略 */
  }
  balloon.webContents.on('did-navigate-in-page', (_e, url) => {
    if (url.endsWith('#close')) {
      closeWindowsBalloon()
      return
    }
    if (url.endsWith('#click')) {
      const go = onActivate
      closeWindowsBalloon()
      go?.()
    }
  })
  balloon.on('closed', () => {
    if (balloon) balloon = null
    clearTimer()
  })
  return balloon
}

export function showWindowsBalloon(
  p: { title: string; body?: string; onClick?: () => void },
  main: BrowserWindow | null,
): void {
  const win = ensureBalloon()
  onActivate = p.onClick || null
  const box = balloonBounds(targetWorkArea(main))
  win.setBounds(box)
  const html = balloonHtml({
    title: p.title,
    body: p.body,
    dark: nativeTheme.shouldUseDarkColors,
  })
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  if (!win.isVisible()) win.showInactive()
  else win.moveTop()
  clearTimer()
  hideTimer = setTimeout(() => closeWindowsBalloon(), BALLOON_SHOW_MS)
}
