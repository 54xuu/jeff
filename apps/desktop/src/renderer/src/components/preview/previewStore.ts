/**
 * 全局 Markdown 预览器状态（App 顶层挂载 <MarkdownPreviewModal />，任意处一行代码调用）：
 * - openFile：预览工作空间里的 Markdown 文件（IPC 读取，只读）；
 * - openAbs：.md 进预览器，其它文件交系统默认程序；失败则改为在文件夹中显示；
 * - notify：轻提示（文件不存在 / 打开失败等），4s 自动消失。
 */
import { create } from 'zustand'
import { api } from '../../api'
import { IPC } from '@jeff/core'
import { isMarkdownPath } from './linkify'

export interface FileLinkMenuState {
  x: number
  y: number
  abs: string
}

export interface PreviewNotice {
  kind: 'error' | 'info'
  text: string
  id: number
}

interface PreviewFile {
  /** 绝对路径 */
  file: string
  title: string
  content: string
  truncated: boolean
  /** 预览内容里的相对链接以此为基准 */
  workspaceDir: string
  loading: boolean
}

interface PreviewState {
  file: PreviewFile | null
  notice: PreviewNotice | null
  fileMenu: FileLinkMenuState | null
  openFile: (file: string, opts?: { title?: string; workspaceDir?: string }) => Promise<void>
  openAbs: (abs: string) => Promise<void>
  revealAbs: (abs: string) => Promise<void>
  copyAbs: (abs: string) => Promise<void>
  openFileMenu: (menu: FileLinkMenuState) => void
  closeFileMenu: () => void
  reload: () => Promise<void>
  close: () => void
  notify: (text: string, kind?: 'error' | 'info') => void
}

let noticeSeq = 0

export const usePreviewStore = create<PreviewState>((set, get) => ({
  file: null,
  notice: null,
  fileMenu: null,
  openFileMenu: (menu) => set({ fileMenu: menu }),
  closeFileMenu: () => set({ fileMenu: null }),

  revealAbs: async (abs) => {
    try {
      await api.invoke(IPC.fsOpenPath, { target: abs, reveal: true })
    } catch (err) {
      get().notify(`无法在文件夹中显示：${String((err as Error).message).slice(0, 120)}`, 'error')
    }
  },

  copyAbs: async (abs) => {
    try {
      await navigator.clipboard.writeText(abs)
      get().notify('已复制路径', 'info')
    } catch {
      try {
        const area = document.createElement('textarea')
        area.value = abs
        area.setAttribute('readonly', 'true')
        area.style.position = 'fixed'
        area.style.left = '-9999px'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        if (!ok) throw new Error('copy failed')
        get().notify('已复制路径', 'info')
      } catch (err) {
        get().notify(`复制失败：${String((err as Error).message).slice(0, 120)}`, 'error')
      }
    }
  },

  openAbs: async (abs) => {
    if (isMarkdownPath(abs)) {
      const workspaceDir = abs.split(/[/\\]/).slice(0, -1).join('/')
      return get().openFile(abs, { workspaceDir })
    }
    try {
      const result = await api.invoke<{ ok: boolean; blocked?: boolean }>(IPC.fsOpenPath, { target: abs })
      if (result?.blocked) get().notify('可执行文件不会直接运行，已在文件夹中显示', 'info')
    } catch (err) {
      try {
        await api.invoke(IPC.fsOpenPath, { target: abs, reveal: true })
      } catch {
        /* 文件夹打不开时仍把打开失败的原因告诉用户 */
      }
      get().notify(`无法打开，已尝试在文件夹中显示：${String((err as Error).message).slice(0, 120)}`, 'error')
    }
  },

  notify: (text, kind = 'info') => {
    const id = ++noticeSeq
    set({ notice: { kind, text, id } })
    setTimeout(() => {
      const cur = get().notice
      if (cur && cur.id === id) set({ notice: null })
    }, 4000)
  },

  openFile: async (file, opts) => {
    const title = opts?.title || file.split(/[\\/]/).pop() || file
    set({ file: { file, title, content: '', truncated: false, workspaceDir: opts?.workspaceDir || '', loading: true } })
    try {
      const r = await api.invoke<{ content: string; truncated: boolean }>(IPC.fsReadFile, { file })
      // 读取期间用户可能已切到另一个文件：只更新仍是当前文件的记录
      set((s) => (s.file && s.file.file === file ? { file: { ...s.file, content: r.content, truncated: r.truncated, loading: false } } : s))
    } catch (err) {
      set({ file: null })
      get().notify(`打开失败：${String((err as Error).message).slice(0, 140)}`, 'error')
    }
  },

  reload: async () => {
    const f = get().file
    if (f) await get().openFile(f.file, { title: f.title, workspaceDir: f.workspaceDir })
  },

  close: () => set({ file: null }),
}))
