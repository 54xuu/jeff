import { app, BrowserWindow, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { JeffCore } from '@jeff/core'
import { registerIpc } from './ipc.js'

let win: BrowserWindow | null = null
let core: JeffCore | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

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
    core.on('sidecar-status', (p: unknown) => broadcast('sidecar-status', p))
    registerIpc(core)

    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', async () => {
    if (core) await core.dispose().catch(() => {})
    if (process.platform !== 'darwin') app.quit()
  })
}

function broadcast(what: string, payload?: unknown): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(`jeff:push`, { what, payload })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    title: 'Jeff',
    backgroundColor: '#ededed',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  win.on('closed', () => {
    win = null
  })

  // 冒烟钩子：JEFF_SMOKE=1 时加载完成后截图并退出（用于 CI/验收）
  if (process.env.JEFF_SMOKE === '1') {
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

export function getMainWindow(): BrowserWindow | null {
  return win
}
