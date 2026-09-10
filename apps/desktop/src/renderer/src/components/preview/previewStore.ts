/**
 * 全局 Markdown 预览器状态（App 顶层挂载 <MarkdownPreviewModal />，任意处一行代码调用）：
 * - openFile：预览工作空间里的 Markdown 文件（IPC 读取，只读）；
 * - openRel：识别的相对路径入口 —— .md 走预览器，其它文件交系统默认程序打开；
 * - notify：轻提示（文件不存在 / 打开失败等），4s 自动消失。
 */
import { create } from 'zustand'
import { api } from '../../api'
import { IPC } from '@jeff/core'
import { isMarkdownPath, joinWorkspacePath } from './linkify'

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
  openFile: (file: string, opts?: { title?: string; workspaceDir?: string }) => Promise<void>
  openRel: (rel: string, workspaceDir: string) => Promise<void>
  reload: () => Promise<void>
  close: () => void
  notify: (text: string, kind?: 'error' | 'info') => void
}

let noticeSeq = 0

export const usePreviewStore = create<PreviewState>((set, get) => ({
  file: null,
  notice: null,

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

  openRel: async (rel, workspaceDir) => {
    if (!workspaceDir) {
      get().notify('当前会话没有关联的工作空间，无法定位文件', 'error')
      return
    }
    const abs = joinWorkspacePath(workspaceDir, rel)
    if (isMarkdownPath(abs)) return get().openFile(abs, { workspaceDir })
    // 非 markdown：交给系统默认程序打开（不存在时 shell.openPath 会返回错误串）
    try {
      await api.invoke(IPC.fsOpenPath, { target: abs })
    } catch (err) {
      get().notify(`无法打开 ${rel}：${String((err as Error).message).slice(0, 120)}`, 'error')
    }
  },

  reload: async () => {
    const f = get().file
    if (f) await get().openFile(f.file, { title: f.title, workspaceDir: f.workspaceDir })
  },

  close: () => set({ file: null }),
}))
