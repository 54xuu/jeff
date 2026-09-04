import type { JeffPreload } from '../../preload/index'

declare global {
  interface Window {
    jeff: JeffPreload
  }
}

/** 渲染进程侧 API 封装 */
export const api = {
  invoke: <T = unknown>(channel: string, payload?: unknown): Promise<T> => window.jeff.invoke(channel, payload) as Promise<T>,
  onPush: (cb: (evt: { what: string; payload?: unknown }) => void): (() => void) => window.jeff.onPush(cb),
}
