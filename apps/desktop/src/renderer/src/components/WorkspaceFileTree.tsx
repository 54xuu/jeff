/**
 * 工作空间文件树（资料抽屉「工作区文件」Tab）：
 * 显示当前工作空间全部文件与文件夹（.git/node_modules 等噪音目录已由主进程过滤），
 * 点击 .md 直接用内置预览器打开；其它文件交给系统默认程序。
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { IPC, type FileNode } from '@jeff/core'
import { usePreviewStore } from './preview/previewStore'
import { isMarkdownPath } from './preview/linkify'

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

export default function WorkspaceFileTree(props: { dir: string }): React.JSX.Element {
  const { dir } = props
  const [res, setRes] = useState<{ exists: boolean; nodes: FileNode[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const openFile = usePreviewStore((s) => s.openFile)
  const notify = usePreviewStore((s) => s.notify)

  const load = useCallback(async () => {
    if (!dir) return
    setLoading(true)
    setError('')
    try {
      const r = await api.invoke<{ dir: string; exists: boolean; nodes: FileNode[] }>(IPC.fsListFiles, { dir })
      setRes({ exists: r.exists, nodes: r.nodes })
      // 默认展开第一层目录，深目录按需展开
      setExpanded(new Set(r.nodes.filter((n) => n.dir).map((n) => n.rel)))
    } catch (err) {
      setError(String((err as Error).message).slice(0, 160))
      setRes({ exists: false, nodes: [] })
    } finally {
      setLoading(false)
    }
  }, [dir])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = (rel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }

  const openTarget = async (n: FileNode) => {
    if (isMarkdownPath(n.abs)) return void openFile(n.abs, { title: n.name, workspaceDir: dir })
    try {
      await api.invoke(IPC.fsOpenPath, { target: n.abs })
    } catch (err) {
      notify(`无法打开 ${n.name}：${String((err as Error).message).slice(0, 120)}`, 'error')
    }
  }

  const Row = (p: { node: FileNode; depth: number }): React.JSX.Element => {
    const { node, depth } = p
    const isMd = isMarkdownPath(node.abs)
    const isOpen = expanded.has(node.rel)
    return (
      <>
        <div
          className={`file-row ${node.dir ? 'dir' : isMd ? 'md' : 'other'}`}
          style={{ paddingLeft: 4 + depth * 16 }}
          title={node.dir ? '点击展开/折叠' : isMd ? '点击预览 Markdown' : '点击用系统程序打开'}
          data-testid={`file-row-${node.rel}`}
          onClick={() => (node.dir ? toggle(node.rel) : void openTarget(node))}
        >
          <span className="file-row-icon">{node.dir ? (isOpen ? '📂' : '📁') : isMd ? '📄' : '📎'}</span>
          <span className="file-row-name">{node.name}</span>
          {node.truncated && <span className="file-row-size">…</span>}
          {!node.dir && node.size > 0 && <span className="file-row-size">{fmtSize(node.size)}</span>}
        </div>
        {node.dir && isOpen && (node.children || []).map((c) => <Row key={c.rel} node={c} depth={depth + 1} />)}
      </>
    )
  }

  return (
    <div className="file-tree" data-testid="workspace-file-tree">
      <div className="file-tree-head">
        <span className="file-tree-path" title={dir}>
          {dir || '（未配置工作空间）'}
        </span>
        <div className="file-tree-actions">
          <button className="text-btn" data-testid="file-tree-refresh" disabled={loading} onClick={() => void load()}>
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button
            className="text-btn"
            disabled={!dir}
            onClick={() =>
              void api
                .invoke(IPC.fsOpenPath, { target: dir, reveal: true })
                .catch((err: Error) => notify(`在系统中打开失败：${String(err.message).slice(0, 120)}`, 'error'))
            }
          >
            在系统中打开
          </button>
        </div>
      </div>
      {error && <p className="settings-error">⚠️ {error}</p>}
      {res && !res.exists && <div className="empty-card">目录不存在：{dir}</div>}
      {res?.exists && res.nodes.length === 0 && <div className="empty-card">工作空间还没有文件</div>}
      <div className="file-tree-body">{(res?.nodes || []).map((n) => <Row key={n.rel} node={n} depth={0} />)}</div>
    </div>
  )
}
