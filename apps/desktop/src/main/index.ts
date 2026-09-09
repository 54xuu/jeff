import { app, BrowserWindow, shell, Tray, Menu, dialog, nativeImage } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { JeffCore } from '@jeff/core'
import { registerIpc } from './ipc.js'

let win: BrowserWindow | null = null
let core: JeffCore | null = null
let tray: Tray | null = null

// 主进程兜底：漏网的 Promise 拒绝/异常只记日志，不再弹「Uncaught Exception」崩溃框
// （webdav 库在休眠唤醒/断网等场景会泄漏 AbortError 拒绝，杀不掉主进程才是正确行为）
process.on('unhandledRejection', (reason) => fatalLog('unhandled-rejection', reason))
process.on('uncaughtException', (err) => fatalLog('uncaught-exception', err))

function fatalLog(tag: string, err: unknown): void {
  const msg = err instanceof Error ? err.stack || err.message : String(err)
  console.error(`[jeff] ${tag}:`, msg)
  try {
    core?.debugLog?.log(tag, msg)
  } catch {
    /* 日志失败忽略 */
  }
}

function iconPath(): string | null {
  const cand = app.isPackaged
    ? path.join(process.resourcesPath ?? '', 'icon.png')
    : path.join(import.meta.dirname, '../../../build/icon.png')
  try {
    if (fs.existsSync(cand)) return cand
  } catch {
    /* 忽略 */
  }
  return null
}

const gotLock = process.env.JEFF_E2E === '1' || process.env.JEFF_SMOKE === '1' ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  if (process.env.JEFF_E2E !== '1' && process.env.JEFF_SMOKE !== '1') {
    app.on('second-instance', () => {
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
  }

  app.whenReady().then(async () => {
    core = new JeffCore()
    const resourceBinDir = app.isPackaged ? path.join(process.resourcesPath, 'oc-bin') : undefined
    try {
      await core.init({ resourceBinDir })
    } catch (err) {
      // sidecar 启动失败也先开窗展示错误（SidecarManager 会持续重试）
      console.error('[jeff] core init 失败:', err)
    }
    core.bus.on('data-changed', (what: string) => broadcast(what))
    core.bus.on('chat-updated', (p: unknown) => broadcast('chat-updated', p))
    core.bus.on('chat-stream', (p: unknown) => broadcast('chat-stream', p))
    core.bus.on('group-updated', (p: unknown) => broadcast('group-updated', p))
    core.on('sidecar-status', (p: unknown) => broadcast('sidecar-status', p))
    core.on('sidecar-log', (line: string) => pushSidecarLog(line))
    registerIpc(core)

    createWindow()
    setupAppMenu()
    setupTray()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', async () => {
    if (core) await core.dispose().catch(() => {})
    if (process.platform !== 'darwin') app.quit()
  })
}

/** 菜单动作 → 渲染层（新会话/发起群聊/设置/主题/使用说明） */
function menuAction(action: string, value?: string): void {
  broadcast('menu-action', { action, value })
}

/** agent 应用型菜单（参考 Codex / opencode desktop 的精简风格，去掉编辑器式的窗口组） */
function setupAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Jeff',
      submenu: [
        {
          label: '关于 Jeff',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于 Jeff',
              message: `Jeff ${app.getVersion()}`,
              detail: '个人「Code + Work」agent 工作台\nVibe Coding · 项目管理 · 文档产出\n引擎：opencode sidecar',
            })
          },
        },
        {
          label: '设置…',
          accelerator: 'CmdOrCtrl+,',
          click: () => menuAction('settings'),
        },
        { type: 'separator' },
        {
          label: '重启 Jeff',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            app.relaunch()
            app.quit()
          },
        },
        {
          label: '退出 Jeff',
          accelerator: 'CmdOrCtrl+Q',
          click: () => app.quit(),
        },
      ],
    },
    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: () => menuAction('new-session'),
        },
        {
          label: '发起群聊…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => menuAction('new-group'),
        },
        { type: 'separator' },
        {
          label: '打开小杰',
          accelerator: 'CmdOrCtrl+1',
          click: () => menuAction('usage'),
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '显示',
      submenu: [
        {
          label: '亮色主题',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => menuAction('theme', 'light'),
        },
        {
          label: '深夜主题',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => menuAction('theme', 'dark'),
        },
        {
          label: '跟随系统',
          click: () => menuAction('theme', 'system'),
        },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { label: '重置缩放', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '使用说明',
          accelerator: 'CmdOrCtrl+/',
          click: () => menuAction('usage'),
        },
        {
          label: 'GitHub 仓库',
          click: () => void shell.openExternal('https://github.com/54xuu/jeff'),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function setupTray(): void {
  const icon = iconPath()
  if (!icon) return
  try {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 24, height: 24 }))
    tray.setToolTip('Jeff — 个人 agent 工作台')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '显示主窗口',
          click: () => {
            if (win) {
              win.show()
              win.focus()
            } else {
              createWindow()
            }
          },
        },
        {
          label: '重启 Jeff',
          click: () => {
            app.relaunch()
            app.quit()
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => app.quit(),
        },
      ]),
    )
    tray.on('double-click', () => {
      if (win) {
        win.show()
        win.focus()
      }
    })
  } catch (err) {
    console.error('[jeff] 托盘创建失败:', err)
  }
}

function broadcast(what: string, payload?: unknown): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(`jeff:push`, { what, payload })
}

function createWindow(): void {
  const icon = iconPath()
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    title: 'Jeff',
    ...(icon ? { icon } : {}),
    backgroundColor: '#ededed',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 渲染层订阅 push 之前 sidecar 可能已 running：补发一次当前状态（触发渲染层补拉模型目录）
  win.webContents.once('did-finish-load', () => {
    if (core?.sidecar) broadcast('sidecar-status', { status: core.sidecar.status, error: core.sidecar.lastError || undefined })
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
  win.on('closed', () => {
    win = null
  })

  // 冒烟钩子：JEFF_SMOKE=1 时加载完成后截图并退出（用于 CI/验收）
  // 多视图模式（JEFF_SMOKE_VIEWS）由渲染层驱动逐视图截图，这里只兜底单视图模式
  if (process.env.JEFF_SMOKE === '1' && !process.env.JEFF_SMOKE_VIEWS) {
    win.webContents.once('did-finish-load', async () => {
      setTimeout(async () => {
        try {
          const image = await win!.webContents.capturePage()
          const out = process.env.JEFF_SMOKE_OUT || path.join(app.getPath('temp'), 'jeff-smoke.png')
          fs.writeFileSync(out, image.toPNG())
          console.log(`[jeff-smoke] screenshot saved: ${out}`)
        } catch (err) {
          console.error('[jeff-smoke] capture failed:', err)
        }
        app.exit(0)
      }, Number(process.env.JEFF_SMOKE_DELAY_MS || 4000))
    })
  }
}

/** sidecar 最近日志环形缓冲（设置页「引擎服务」展示） */
const sidecarLogBuffer: string[] = []
function pushSidecarLog(line: string): void {
  sidecarLogBuffer.push(line)
  if (sidecarLogBuffer.length > 300) sidecarLogBuffer.splice(0, sidecarLogBuffer.length - 300)
}

export function getSidecarLogs(): string[] {
  return sidecarLogBuffer.slice(-200)
}

export function getMainWindow(): BrowserWindow | null {
  return win
}
