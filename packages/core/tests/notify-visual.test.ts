import { describe, it, expect } from 'vitest'
import {
  balloonBounds,
  balloonHtml,
  escapeHtml,
  osNotificationInit,
  shouldShowDesktopNotify,
  visualNotifyChannel,
  BALLOON_HEIGHT,
  BALLOON_MARGIN,
  BALLOON_WIDTH,
} from '../src/notify/visual.js'

describe('visualNotifyChannel', () => {
  it('Windows 走自绘气泡，Linux 走系统通知', () => {
    expect(visualNotifyChannel('win32')).toBe('balloon')
    expect(visualNotifyChannel('linux')).toBe('os')
    expect(visualNotifyChannel('darwin')).toBe('os')
  })
})

describe('shouldShowDesktopNotify', () => {
  const base = { notifyDesktop: true, notifyOnlyBackground: true, focused: true, platform: 'linux' }

  it('关掉桌面通知则任何平台都不弹', () => {
    expect(shouldShowDesktopNotify({ ...base, notifyDesktop: false })).toBe(false)
    expect(shouldShowDesktopNotify({ ...base, notifyDesktop: false, platform: 'win32' })).toBe(false)
  })

  it('Linux 前台 + 仅后台 → 不弹（保持原 IM 惯例）', () => {
    expect(shouldShowDesktopNotify(base)).toBe(false)
  })

  it('Linux 前台但关掉仅后台 → 弹', () => {
    expect(shouldShowDesktopNotify({ ...base, notifyOnlyBackground: false })).toBe(true)
  })

  it('Linux 后台 → 弹', () => {
    expect(shouldShowDesktopNotify({ ...base, focused: false })).toBe(true)
  })

  it('Windows 前台看别的会话也要弹右下角（不跟仅后台走）', () => {
    expect(shouldShowDesktopNotify({ ...base, platform: 'win32' })).toBe(true)
    expect(shouldShowDesktopNotify({ ...base, platform: 'win32', focused: false })).toBe(true)
  })
})

describe('balloonBounds', () => {
  it('锚在主屏工作区右下角，避开任务栏', () => {
    const box = balloonBounds({ x: 0, y: 0, width: 1920, height: 1040 })
    expect(box).toEqual({
      x: 1920 - BALLOON_WIDTH - BALLOON_MARGIN,
      y: 1040 - BALLOON_HEIGHT - BALLOON_MARGIN,
      width: BALLOON_WIDTH,
      height: BALLOON_HEIGHT,
    })
  })

  it('副屏 workArea 带偏移时仍贴该屏右下角', () => {
    const box = balloonBounds({ x: 1920, y: -200, width: 2560, height: 1440 })
    expect(box.x).toBe(1920 + 2560 - BALLOON_WIDTH - BALLOON_MARGIN)
    expect(box.y).toBe(-200 + 1440 - BALLOON_HEIGHT - BALLOON_MARGIN)
  })
})

describe('escapeHtml / balloonHtml', () => {
  it('转义标签，避免标题把气泡 HTML 打穿', () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)"> & '"`)).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;&quot;',
    )
  })

  it('气泡 HTML 含转义后的标题/正文，并带 click/close 锚点', () => {
    const html = balloonHtml({ title: '小杰</title><script>', body: '完成 <b>任务</b>', dark: true })
    expect(html).toContain('小杰&lt;/title&gt;&lt;script&gt;')
    expect(html).toContain('完成 &lt;b&gt;任务&lt;/b&gt;')
    expect(html).not.toContain('</title><script>')
    expect(html).toContain("location.hash = 'click'")
    expect(html).toContain("location.hash = 'close'")
    expect(html).toContain('#2c2c2c')
  })
})

describe('osNotificationInit', () => {
  it('一律 silent，Windows 用 timeoutType=never 把 Toast 留在右下角', () => {
    const linux = osNotificationInit({ title: 'T', body: 'B', platform: 'linux' })
    expect(linux.silent).toBe(true)
    expect(linux.timeoutType).toBeUndefined()
    const win = osNotificationInit({ title: 'T', body: 'B'.repeat(250), icon: 'C:\\\\icon.png', platform: 'win32' })
    expect(win.silent).toBe(true)
    expect(win.timeoutType).toBe('never')
    expect(win.icon).toBe('C:\\\\icon.png')
    expect(win.body.length).toBe(200)
  })
})
