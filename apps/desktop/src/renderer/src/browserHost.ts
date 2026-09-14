import type { BrowserAction } from '@jeff/core'

/**
 * 浏览器动作路由：主进程下发的动作 → 当前挂载的 BrowserPanel 执行。
 *
 * 为什么用模块级单例而不是 React context：请求来自 IPC（React 树之外），
 * 且面板可能尚未挂载（agent 先调用、面板后打开）。这里负责「等面板就绪」这段时序。
 */
type Exec = (action: BrowserAction, args: Record<string, unknown>) => Promise<unknown>

let host: Exec | null = null
let opener: (() => void) | null = null
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
  if (!host) opener?.()
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
