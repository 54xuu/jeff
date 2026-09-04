import { contextBridge, ipcRenderer } from 'electron'

const api = {
  env: { smokeSelect: process.env.JEFF_SMOKE_SELECT || '' },
  invoke: (channel: string, payload?: unknown): Promise<unknown> => ipcRenderer.invoke(`jeff:${channel}`, payload),
  /** 主进程推送：{what, payload} */
  onPush: (cb: (evt: { what: string; payload?: unknown }) => void): (() => void) => {
    const listener = (_e: unknown, data: { what: string; payload?: unknown }) => cb(data)
    ipcRenderer.on('jeff:push', listener as never)
    return () => ipcRenderer.removeListener('jeff:push', listener as never)
  },
}

contextBridge.exposeInMainWorld('jeff', api)

export type JeffPreload = typeof api
