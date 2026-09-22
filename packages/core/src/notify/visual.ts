/**
 * 桌面提醒的纯策略 / 布局 / HTML：不碰 Electron。
 *
 * Windows 系统 Toast 依赖开始菜单快捷方式 AUMID、操作中心权限、免打扰，
 * 经常出现「应用自己的提示音响了、右下角气泡没出来」。
 * 所以 Windows 走自绘屏幕右下角气泡，不把视觉通道交给系统。
 */

export const BALLOON_WIDTH = 360
export const BALLOON_HEIGHT = 96
export const BALLOON_MARGIN = 16
/** 气泡停留时间：够读完一行摘要 */
export const BALLOON_SHOW_MS = 8000

export type VisualNotifyChannel = 'os' | 'balloon'

/** Windows 用自绘右下角气泡；其余平台用系统通知（Linux 已用 D-Bus 验证可用） */
export function visualNotifyChannel(platform: string): VisualNotifyChannel {
  return platform === 'win32' ? 'balloon' : 'os'
}

/**
 * 要不要弹视觉提醒（声音由调用方单独播）。
 *
 * Windows 气泡不依赖系统 Toast，也不跟「仅后台」走：只要开了桌面通知、
 * 且调用方已经排除「正看着这个会话」，前台看别的会话也要弹出——对齐微信/QQ。
 * Linux 仍尊重 notifyOnlyBackground，避免 GNOME 顶栏横幅在前台抢视线。
 */
export function shouldShowDesktopNotify(p: {
  notifyDesktop: boolean
  notifyOnlyBackground: boolean
  focused: boolean
  platform: string
}): boolean {
  if (!p.notifyDesktop) return false
  if (visualNotifyChannel(p.platform) === 'balloon') return true
  return !p.focused || !p.notifyOnlyBackground
}

export type Rect = { x: number; y: number; width: number; height: number }

/** 把气泡锚在工作区右下角（避开任务栏）。多显示器时传入目标屏的 workArea。 */
export function balloonBounds(
  workArea: Rect,
  size: { width: number; height: number } = { width: BALLOON_WIDTH, height: BALLOON_HEIGHT },
  margin = BALLOON_MARGIN,
): Rect {
  return {
    x: Math.round(workArea.x + workArea.width - size.width - margin),
    y: Math.round(workArea.y + workArea.height - size.height - margin),
    width: size.width,
    height: size.height,
  }
}

export function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 系统 Notification 构造参数（Linux 主路径；Windows 气泡失败时的兜底） */
export function osNotificationInit(p: {
  title: string
  body?: string
  icon?: string | null
  platform: string
}): { title: string; body: string; silent: true; icon?: string; timeoutType?: 'never' } {
  const init: { title: string; body: string; silent: true; icon?: string; timeoutType?: 'never' } = {
    title: p.title,
    body: (p.body || '').slice(0, 200),
    silent: true,
  }
  if (p.icon) init.icon = p.icon
  // reminder 场景：Windows 会把 Toast 留在右下角直到用户关掉，而不是一闪进操作中心
  if (p.platform === 'win32') init.timeoutType = 'never'
  return init
}

/** 气泡页面向主进程发动作：改 document.title（立刻触发 page-title-updated）。data: URL 上改 hash 经常不导航。 */
export const BALLOON_ACTION_CLOSE = 'jeff-balloon:close'
export const BALLOON_ACTION_CLICK = 'jeff-balloon:click'

export function parseBalloonAction(signal: string): 'close' | 'click' | null {
  if (signal === BALLOON_ACTION_CLOSE) return 'close'
  if (signal === BALLOON_ACTION_CLICK) return 'click'
  return null
}

/** 自绘气泡的 HTML。点关闭立即关；点卡片唤起主窗口。 */
export function balloonHtml(p: { title: string; body?: string; dark?: boolean }): string {
  const title = escapeHtml(p.title || 'Jeff')
  const body = escapeHtml((p.body || '').slice(0, 200))
  const dark = !!p.dark
  const bg = dark ? '#2c2c2c' : '#ffffff'
  const fg = dark ? '#f5f5f5' : '#111111'
  const muted = dark ? '#b3b3b3' : '#666666'
  const border = dark ? '#3d3d3d' : '#e7e7e7'
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:"Segoe UI","Microsoft YaHei",sans-serif;}
  .card{display:flex;gap:10px;height:100%;box-sizing:border-box;padding:12px 12px 12px 0;background:${bg};color:${fg};
    border:1px solid ${border};border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);cursor:pointer;user-select:none;}
  .bar{width:4px;flex:0 0 4px;background:#07c160;border-radius:4px 0 0 4px;margin:-12px 0 -12px 0;}
  .body{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:4px;}
  .kicker{font-size:11px;color:${muted};letter-spacing:.02em;}
  .title{font-size:14px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .msg{font-size:12px;color:${muted};line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
  .x{flex:0 0 22px;height:22px;border:none;background:transparent;color:${muted};font-size:16px;cursor:pointer;border-radius:4px;}
  .x:hover{background:rgba(127,127,127,.15);}
</style></head>
<body>
  <div class="card" id="card">
    <div class="bar"></div>
    <div class="body">
      <div class="kicker">Jeff</div>
      <div class="title">${title}</div>
      ${body ? `<div class="msg">${body}</div>` : ''}
    </div>
    <button class="x" id="close" aria-label="关闭" type="button">×</button>
  </div>
  <script>
    function signal(action) {
      document.title = action;
      console.log(action);
      if (action === '${BALLOON_ACTION_CLOSE}') {
        try { window.close(); } catch (e) {}
      }
    }
    document.getElementById('close').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      signal('${BALLOON_ACTION_CLOSE}');
    });
    document.getElementById('card').addEventListener('click', function () {
      signal('${BALLOON_ACTION_CLICK}');
    });
  </script>
</body></html>`
}
