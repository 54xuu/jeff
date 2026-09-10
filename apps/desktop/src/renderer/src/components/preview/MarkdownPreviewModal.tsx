/**
 * 全局公共 Markdown 预览器（只读）：大模态层，标题栏带文件名/完整路径，
 * 支持刷新、在系统中打开、复制路径；Esc 关闭。由 previewStore 全局控制。
 * 注意：点遮罩空白处**不**关闭（内容预览时容易误触），只有右上角 ✕ / Esc 关闭。
 */
import { useEffect } from 'react'
import { usePreviewStore } from './previewStore'
import { Markdown } from '../Markdown'
import { CopyButton } from '../ui/CopyButton'
import { api } from '../../api'
import { IPC } from '@jeff/core'

export default function MarkdownPreviewModal(): React.JSX.Element | null {
  const file = usePreviewStore((s) => s.file)
  const close = usePreviewStore((s) => s.close)
  const reload = usePreviewStore((s) => s.reload)
  const notify = usePreviewStore((s) => s.notify)

  useEffect(() => {
    if (!file) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [file?.file, close])

  if (!file) return null

  const openInSystem = async () => {
    try {
      await api.invoke(IPC.fsOpenPath, { target: file.file, reveal: true })
    } catch (err) {
      notify(`在系统中打开失败：${String((err as Error).message).slice(0, 120)}`, 'error')
    }
  }

  return (
    <div className="preview-mask" data-testid="md-preview-modal">
      <div className="preview-panel">
        <div className="preview-head">
          <span className="preview-name" data-testid="md-preview-title">
            📄 {file.title}
          </span>
          {file.truncated && <span className="preview-warn">内容过大已截断</span>}
          <div className="preview-actions">
            <button className="text-btn" onClick={() => void reload()}>
              刷新
            </button>
            <button className="text-btn" onClick={() => void openInSystem()}>
              在系统中打开
            </button>
            <CopyButton text={file.file} label="复制路径" testId="md-preview-copy-path" />
            <button className="icon-btn" onClick={close}>
              ✕
            </button>
          </div>
        </div>
        <div className="preview-path" title={file.file}>
          {file.file}
        </div>
        <div className="preview-body">
          {file.loading ? (
            <p className="settings-tip">加载中…</p>
          ) : (
            <Markdown text={file.content || '（空文件）'} workspaceDir={file.workspaceDir} />
          )}
        </div>
      </div>
    </div>
  )
}

/** 全局轻提示：消息里点不存在的路径 / 系统打开失败等场景 */
export function PreviewNotice(): React.JSX.Element | null {
  const notice = usePreviewStore((s) => s.notice)
  if (!notice) return null
  return (
    <div className={`preview-toast ${notice.kind}`} data-testid="preview-toast">
      {notice.kind === 'error' ? '⚠️ ' : ''}
      {notice.text}
    </div>
  )
}
