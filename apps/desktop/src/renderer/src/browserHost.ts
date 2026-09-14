import type { BrowserAction, BrowserConsoleEntry } from '@jeff/core'

/**
 * 浏览器动作路由：主进程下发的动作 → 当前挂载的 BrowserPanel 执行。
 *
 * 为什么用模块级单例而不是 React context：请求来自 IPC（React 树之外），
 * 且面板可能尚未挂载（agent 先调用、面板后打开）。这里负责「等面板就绪」这段时序。
 */
type Exec = (action: BrowserAction, args: Record<string, unknown>) => Promise<unknown>

let host: Exec | null = null
let opener: (() => void) | null = null
/** 主进程补采到的错误（资源 404 等）落进面板同一份缓冲；面板未挂载时丢弃（没有页面就没有现场） */
let consoleSink: ((entry: Omit<BrowserConsoleEntry, 'at'>) => void) | null = null
/** 面板打开后返回一个「就绪」信号，供等待方 await */
let waiters: Array<() => void> = []

export function registerBrowserHost(fn: Exec): void {
  host = fn
  const pending = waiters
  waiters = []
  for (const w of pending) w()
}

export function unregisterBrowserHost(fn: Exec): void {
  if (host === fn) host = null
}

/** 面板注册控制台采集缓冲（BrowserPanel 挂载时注册，卸载时注销） */
export function registerConsoleSink(fn: ((entry: Omit<BrowserConsoleEntry, 'at'>) => void) | null): void {
  consoleSink = fn
}

/** 主进程侧采集到的控制台记录（资源加载失败）投递给面板 */
export function emitConsoleEntry(entry: Omit<BrowserConsoleEntry, 'at'>): void {
  consoleSink?.(entry)
}

/**
 * 「因为 agent 要导航所以唤起面板」时的目标地址。
 *
 * 面板挂载时默认会恢复上次访问的地址（人性化），但 agent 调 navigate 唤起面板时这个恢复是**有害**的：
 * 上次那个地址很可能已经不可用（本地 dev 服务关了、测试站端口换了），它的加载失败会和 agent 真正要导航的
 * 页面抢时序（实测 live13 R13：agent 导航到可用地址，却拿到上一次恢复地址的 ERR_CONNECTION_REFUSED）。
 * 有它在就用它当起始地址，并且不去恢复上次地址。
 */
let pendingStartUrl: string | null = null

/** 面板挂载时取一次（取走即清空） */
export function takePendingStartUrl(): string | null {
  const u = pendingStartUrl
  pendingStartUrl = null
  return u
}

/** 面板打开入口（App 注册；agent 调用时自动唤起面板） */
export function registerBrowserOpener(fn: () => void): void {
  opener = fn
}

export function browserHostAvailable(): boolean {
  return !!host
}

/**
 * 执行动作：面板未挂载时先唤起并等待就绪（最长 8s），再交给面板执行。
 * 等待而非直接报错——用户看到的是「自动打开浏览器并执行」，而不是一句冷冰冰的工具失败。
 */
export async function runBrowserAction(action: BrowserAction, args: Record<string, unknown>, waitMs = 8000): Promise<unknown> {
  if (!host) {
    // 面板还没挂载：告诉它「是 agent 要打开这个地址」，别去恢复上次访问的旧地址（见 takePendingStartUrl）
    if (action === 'navigate' && typeof args?.url === 'string') pendingStartUrl = args.url
    opener?.()
  }
  if (!host) {
    await new Promise<void>((resolve) => {
      waiters.push(resolve)
      setTimeout(resolve, waitMs)
    })
  }
  if (!host) throw new Error('浏览器面板未就绪（无法自动打开），请在 Jeff 顶部菜单「工具 → 浏览器」手动打开后重试')
  return host(action, args)
}

/**
 * 用内置浏览器打开一个网址（插件首页等 UI 入口用）：
 * 自动打开面板并等待就绪，与 agent 调用走同一条路径，确保「人看到的页面 = agent 操作的页面」。
 */
export async function openInBrowser(url: string): Promise<void> {
  opener?.()
  await runBrowserAction('navigate', { url })
}
