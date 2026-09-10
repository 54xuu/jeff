import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { IPC, type ChatMsg, type SessionBrief } from '@jeff/core'
import { Markdown } from './Markdown'

/**
 * 聊天记录抽屉（微信式历史会话，私聊用）：
 * - 私聊：该 agent 的全部会话；可改标题 / 继续 / 删除
 */
export default function ChatHistoryDrawer(props: { agentId?: string; projectId?: string; onClose: () => void }): React.JSX.Element {
  const appInfo = useStore((s) => s.appInfo)
  const projects = useStore((s) => s.projects)
  const [sessions, setSessions] = useState<SessionBrief[] | null>(null)
  const [preview, setPreview] = useState<{ id: string; msgs: ChatMsg[] } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  // 历史消息里的相对路径链接：群会话以群工作空间为基准，私聊用 Jeff 默认工作区
  const defaultWs = appInfo ? `${appInfo.dataDir}/workspace` : ''
  const workspaceDir = props.projectId
    ? (projects.find((p) => p.id === props.projectId)?.workspace_dir || '').trim() || defaultWs
    : props.agentId
      ? defaultWs
      : ''

  const load = async () => {
    try {
      const r = await api.invoke<{ sessions: SessionBrief[] }>(IPC.sessionsList, { agentId: props.agentId, projectId: props.projectId })
      setSessions(r.sessions)
      setError('')
    } catch (err) {
      setError(String((err as Error).message).slice(0, 160))
      setSessions([])
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc 关抽屉；行内改名输入框的 Esc 已 preventDefault，不会触发这里
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props.onClose])

  const openPreview = async (s: SessionBrief) => {
    if (preview?.id === s.id) return
    setPreviewLoading(true)
    try {
      const r = await api.invoke<{ messages: ChatMsg[] }>(IPC.sessionPreview, { sessionId: s.id })
      setPreview({ id: s.id, msgs: r.messages })
    } catch (err) {
      setError(String((err as Error).message).slice(0, 160))
    } finally {
      setPreviewLoading(false)
    }
  }

  const activate = async (s: SessionBrief) => {
    if (!props.agentId && !props.projectId) return
    await api.invoke(IPC.sessionActivate, { scope: props.projectId ? 'group' : 'private', agentId: s.agentId, projectId: props.projectId, sessionId: s.id })
    if (props.agentId) await useStore.getState().loadHistory(`agent:${props.agentId}`)
    if (props.projectId) await useStore.getState().loadGroupHistory(props.projectId)
    await load()
    props.onClose()
  }

  const remove = async (s: SessionBrief) => {
    if (!confirm(`删除会话「${s.title}」？该操作不可恢复。`)) return
    await api.invoke(IPC.sessionDelete, { sessionId: s.id })
    if (preview?.id === s.id) setPreview(null)
    await load()
  }

  const startRename = (s: SessionBrief) => {
    setEditingId(s.id)
    setEditTitle(s.title)
  }

  const commitRename = async (sessionId: string) => {
    const t = editTitle.trim()
    setEditingId(null)
    if (!t) return
    try {
      await api.invoke(IPC.sessionRename, { sessionId, title: t })
      await load()
    } catch (err) {
      setError(String((err as Error).message).slice(0, 160))
    }
  }

  // 按 agent 分组（私聊只有一组）
  const groups = new Map<string, SessionBrief[]>()
  for (const s of sessions || []) {
    const arr = groups.get(s.agentName) || []
    arr.push(s)
    groups.set(s.agentName, arr)
  }

  return (
    <div className="drawer-mask" data-testid="chat-history-drawer" onClick={props.onClose}>
      <div className="history-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="history-head">
          <span>聊天记录</span>
          <button className="text-btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
        {error && <p className="settings-error">⚠️ {error}</p>}
        {!sessions && <p className="settings-tip history-tip">加载中…</p>}
        {sessions?.length === 0 && <div className="empty-card">还没有历史会话。</div>}
        <div className="history-body">
          <div className="history-list">
            {Array.from(groups.entries()).map(([agentName, list]) => (
              <div key={agentName}>
                {(groups.size > 1 || props.projectId) && <div className="history-group-title">{agentName}</div>}
                {list.map((s) => (
                  <div key={s.id} className={`history-item ${preview?.id === s.id ? 'previewing' : ''}`} onClick={() => void openPreview(s)}>
                    <div className="history-item-top">
                      {editingId === s.id ? (
                        <input
                          className="history-rename-input"
                          data-testid="session-rename-input"
                          autoFocus
                          value={editTitle}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onBlur={() => void commitRename(s.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              void commitRename(s.id)
                            }
                            if (e.key === 'Escape') {
                              // 约定：消费 Esc 的组件 preventDefault，抽屉级 Esc 关闭检测后跳过
                              e.preventDefault()
                              setEditingId(null)
                            }
                          }}
                        />
                      ) : (
                        <span
                          className="history-item-title"
                          data-testid={`session-title-${s.id}`}
                          title="双击改标题"
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            startRename(s)
                          }}
                        >
                          {s.title}
                        </span>
                      )}
                      {s.active && <span className="tag tag-green">当前</span>}
                    </div>
                    <div className="history-item-sub">{fmtTime(s.updatedAt)}</div>
                    <div className="history-item-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="text-btn" data-testid={`session-rename-${s.id}`} onClick={() => startRename(s)}>
                        改名
                      </button>
                    </div>
                  </div>
                ))}
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
                        {m.role === 'user' ? '我' : m.role === 'system' ? '系统' : '对方'} · {fmtTime(m.time)}
                      </div>
                      {m.role === 'assistant' ? <Markdown text={m.text || '（无文本）'} workspaceDir={workspaceDir} /> : <pre className="history-msg-text">{m.text}</pre>}
                    </div>
                  ))}
                </div>
                <div className="history-preview-actions">
                  {(() => {
                    const s = (sessions || []).find((x) => x.id === preview.id)
                    return s && !s.active ? (
                      <button className="btn primary" onClick={() => void activate(s)}>
                        继续此会话
                      </button>
                    ) : (
                      <span className="settings-tip">这是当前会话</span>
                    )
                  })()}
                  {(() => {
                    const s = (sessions || []).find((x) => x.id === preview.id)
                    return s && !s.active ? (
                      <button className="btn danger" onClick={() => void remove(s)}>
                        删除
                      </button>
                    ) : null
                  })()}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function fmtTime(t: number): string {
  if (!t) return '—'
  const d = new Date(t)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
