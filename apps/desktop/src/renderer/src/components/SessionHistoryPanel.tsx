import { useEffect, useState } from 'react'
import { Markdown } from './Markdown'

export interface SessionHistoryItem {
  id: string
  title: string
  updatedAt: number
  active: boolean
  /** 消息条数（群话题有，私聊不传） */
  messageCount?: number
}

export interface SessionHistoryMsg {
  id: string
  role: string
  text: string
  time: number
  /** 群聊里的发言人名；私聊不传，按角色显示「对方」 */
  sender_name?: string
}

export interface SessionHistoryPanelProps {
  /** 生成中：临时禁用切换 / 新建 / 删除，防消息串会话 */
  busy?: boolean
  /** 列表为空时的文案 */
  emptyText: string
  /** 顶部说明文案 */
  tip: string
  /** 历史消息里相对路径链接的基准目录 */
  workspaceDir: string
  /** 列表容器 testid（群 / 私聊各一个，供 E2E 定位） */
  testId: string
  /** 「+ 新会话」按钮 testid */
  newBtnTestId: string
  /** 标题元素 testid 前缀（后面拼会话 id） */
  titleTestIdPrefix: string
  loadItems: () => Promise<SessionHistoryItem[]>
  loadPreview: (id: string) => Promise<SessionHistoryMsg[]>
  rename: (id: string, title: string) => Promise<void>
  /** 切换为当前会话；由调用方决定是否顺带关闭抽屉 */
  activate: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 新建会话；由调用方决定是否顺带关闭抽屉 */
  createNew: () => Promise<void>
}

/**
 * 会话记录面板：列表（改标题 / 继续 / 删除）+ 右侧完整历史预览。
 * 群「群资料 → 会话记录」与私聊「资料 → 聊天记录」共用同一套交互与样式，
 * 避免两侧行为再次漂移。
 */
export default function SessionHistoryPanel(props: SessionHistoryPanelProps): React.JSX.Element {
  const { busy, workspaceDir } = props
  const [items, setItems] = useState<SessionHistoryItem[] | null>(null)
  const [preview, setPreview] = useState<{ id: string; msgs: SessionHistoryMsg[] } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [error, setError] = useState('')

  const fail = (err: unknown) => setError(String((err as Error).message).slice(0, 160))

  const load = async () => {
    try {
      setItems(await props.loadItems())
      setError('')
    } catch (err) {
      fail(err)
      setItems([])
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openPreview = async (id: string) => {
    if (preview?.id === id) return
    setPreviewLoading(true)
    try {
      setPreview({ id, msgs: await props.loadPreview(id) })
    } catch (err) {
      fail(err)
    } finally {
      setPreviewLoading(false)
    }
  }

  const startRename = (t: SessionHistoryItem) => {
    setEditingId(t.id)
    setEditTitle(t.title)
  }

  const commitRename = async (id: string) => {
    const next = editTitle.trim()
    setEditingId(null)
    if (!next) return
    try {
      await props.rename(id, next)
      await load()
    } catch (err) {
      fail(err)
    }
  }

  const remove = async (t: SessionHistoryItem) => {
    if (!confirm(`删除会话「${t.title}」？该操作不可恢复。`)) return
    try {
      await props.remove(t.id)
      if (preview?.id === t.id) setPreview(null)
      await load()
    } catch (err) {
      fail(err)
    }
  }

  const busyTitle = (what: string) => (busy ? `生成中不可${what}，请先停止或等待完成` : undefined)
  const list = items || []
  const previewItem = list.find((x) => x.id === preview?.id)

  return (
    <>
      <div className="drawer-sec">
        聊天记录
        <button className="text-btn" data-testid={props.newBtnTestId} disabled={busy} title={busyTitle('新建会话')} onClick={() => void props.createNew()}>
          + 新会话
        </button>
      </div>
      {busy && <p className="settings-error">⏳ 生成中：会话切换 / 新建 / 删除已临时禁用，防止消息串会话。</p>}
      <p className="settings-tip" style={{ marginTop: 0 }}>
        {props.tip}
      </p>
      {error && <p className="settings-error">⚠️ {error}</p>}
      {!items && <p className="settings-tip">加载中…</p>}

      <div className="group-task-layout" data-testid={props.testId}>
        <div className="group-task-list">
          {items?.length === 0 && <div className="kanban-empty">{props.emptyText}</div>}
          {list.map((t) => (
            <div key={t.id} className={`history-item ${preview?.id === t.id ? 'previewing' : ''}`} onClick={() => void openPreview(t.id)}>
              <div className="history-item-top">
                {editingId === t.id ? (
                  <input
                    className="history-rename-input"
                    data-testid="session-rename-input"
                    autoFocus
                    value={editTitle}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={() => void commitRename(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commitRename(t.id)
                      }
                      if (e.key === 'Escape') {
                        // 约定：消费 Esc 的组件 preventDefault，外层抽屉守卫检测后跳过
                        e.preventDefault()
                        setEditingId(null)
                      }
                    }}
                  />
                ) : (
                  <span
                    className="history-item-title"
                    data-testid={`${props.titleTestIdPrefix}${t.id}`}
                    title="双击改标题"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      startRename(t)
                    }}
                  >
                    {t.title}
                  </span>
                )}
                {t.active && <span className="tag tag-green">当前</span>}
              </div>
              <div className="history-item-sub">
                {fmtTime(t.updatedAt)}
                {typeof t.messageCount === 'number' ? ` · ${t.messageCount} 条` : ''}
              </div>
              <div className="history-item-actions" onClick={(e) => e.stopPropagation()}>
                <button className="text-btn" data-testid={`session-rename-${t.id}`} disabled={busy} title={busyTitle('改标题')} onClick={() => startRename(t)}>
                  改名
                </button>
                {!t.active && (
                  <button className="text-btn" data-testid={`session-activate-${t.id}`} disabled={busy} title={busyTitle('切换会话')} onClick={() => void props.activate(t.id)}>
                    继续
                  </button>
                )}
                {!t.active && (
                  <button className="text-btn danger" data-testid={`session-delete-${t.id}`} disabled={busy} title={busyTitle('删除会话')} onClick={() => void remove(t)}>
                    删除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="history-preview">
          {previewLoading && <p className="settings-tip history-tip">加载中…</p>}
          {!previewLoading && !preview && <div className="empty-card">点击左侧会话查看完整历史</div>}
          {!previewLoading && preview && (
            <>
              <div className="history-preview-msgs">
                {preview.msgs.length === 0 && <div className="empty-card">该会话还没有消息。</div>}
                {preview.msgs.map((m) => (
                  <div key={m.id} className={`history-msg ${m.role}`}>
                    <div className="history-msg-meta">
                      {m.role === 'user' ? '我' : m.role === 'system' ? '系统' : m.sender_name || '对方'} · {fmtTime(m.time)}
                    </div>
                    {m.role === 'assistant' ? <Markdown text={m.text || '（无文本）'} workspaceDir={workspaceDir} /> : <pre className="history-msg-text">{m.text}</pre>}
                  </div>
                ))}
              </div>
              <div className="history-preview-actions">
                {previewItem && !previewItem.active ? (
                  <button className="btn primary" disabled={busy} title={busyTitle('切换会话')} onClick={() => void props.activate(previewItem.id)}>
                    继续此会话
                  </button>
                ) : (
                  <span className="settings-tip">这是当前会话</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

function fmtTime(t: number): string {
  if (!t) return '—'
  const d = new Date(t)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
