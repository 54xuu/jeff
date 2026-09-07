import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, projectRoleLabel, type ChatMsg, type ProjectInfo, type SessionBrief } from '@jeff/core'
import Avatar from './Avatar'
import { Markdown } from './Markdown'

/** 群资料抽屉：上段群设置 + 下段按成员分组的会话（任务） */
export default function GroupInfoDrawer(props: { project: ProjectInfo; onClose: () => void }): React.JSX.Element {
  const { project, onClose } = props
  const agents = useStore((s) => s.agents)
  const { refreshProjects, setActive, loadGroupHistory } = useStore()
  const [members, setMembers] = useState<Array<{ agent_id: string; role: string; name: string; avatar: string }>>([])
  const [addingMember, setAddingMember] = useState(false)

  const [title, setTitle] = useState(project.title)
  const [icon, setIcon] = useState(project.icon || '👥')
  const [description, setDescription] = useState(project.description || '')
  const [workspaceDir, setWorkspaceDir] = useState(project.workspace_dir || '')
  const [leaderId, setLeaderId] = useState(project.leader_agent_id || '')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const [sessions, setSessions] = useState<SessionBrief[] | null>(null)
  const [preview, setPreview] = useState<{ id: string; msgs: ChatMsg[] } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [sessionError, setSessionError] = useState('')

  useEffect(() => {
    setTitle(project.title)
    setIcon(project.icon || '👥')
    setDescription(project.description || '')
    setWorkspaceDir(project.workspace_dir || '')
    setLeaderId(project.leader_agent_id || '')
  }, [project.id, project.title, project.icon, project.description, project.workspace_dir, project.leader_agent_id])

  const refreshMembers = async () => {
    const list = await api.invoke<Array<{ agent_id: string; role: string; name: string; avatar: string }>>(IPC.projectMembers, { projectId: project.id })
    setMembers(list)
  }

  const refreshSessions = async () => {
    try {
      const r = await api.invoke<{ sessions: SessionBrief[] }>(IPC.sessionsList, { projectId: project.id })
      setSessions(r.sessions)
      setSessionError('')
    } catch (err) {
      setSessionError(String((err as Error).message).slice(0, 160))
      setSessions([])
    }
  }

  useEffect(() => {
    void refreshMembers()
    void refreshSessions()
  }, [project.id])

  const candidateAgents = useMemo(() => {
    const inGroup = new Set(members.map((m) => m.agent_id))
    return agents.filter((a) => !inGroup.has(a.id))
  }, [agents, members])

  const sessionsByMember = useMemo(() => {
    const map = new Map<string, { agentId: string; agentName: string; list: SessionBrief[] }>()
    for (const m of members) {
      map.set(m.agent_id, { agentId: m.agent_id, agentName: m.name, list: [] })
    }
    for (const s of sessions || []) {
      const g = map.get(s.agentId)
      if (g) g.list.push(s)
      else map.set(s.agentId, { agentId: s.agentId, agentName: s.agentName, list: [s] })
    }
    return Array.from(map.values())
  }, [members, sessions])

  const saveSettings = async () => {
    if (!title.trim() || !leaderId) return
    setSaving(true)
    setSaveMsg(null)
    try {
      await api.invoke(IPC.projectSave, {
        id: project.id,
        title: title.trim(),
        icon: icon.trim() || '👥',
        description: description.trim(),
        leader_agent_id: leaderId,
        workspace_dir: workspaceDir.trim(),
        memberAgentIds: members.map((m) => m.agent_id),
      })
      await refreshProjects()
      await refreshMembers()
      setSaveMsg('已保存')
    } catch (err) {
      setSaveMsg(`保存失败：${String((err as Error).message).slice(0, 120)}`)
    } finally {
      setSaving(false)
    }
  }

  const pickDir = async () => {
    const dir = await api.invoke<string | null>(IPC.dialogPickDir, { title: '选择工作空间目录', defaultPath: workspaceDir || undefined })
    if (dir) setWorkspaceDir(dir)
  }

  const dissolve = async () => {
    if (!confirm(`确定解散项目群「${project.title}」？任务与群聊记录将随软删除保留，可从同步历史恢复。`)) return
    await api.invoke(IPC.projectDelete, { id: project.id })
    await refreshProjects()
    setActive(null)
    onClose()
  }

  const openPreview = async (s: SessionBrief) => {
    if (preview?.id === s.id) return
    setPreviewLoading(true)
    try {
      const r = await api.invoke<{ messages: ChatMsg[] }>(IPC.sessionPreview, { sessionId: s.id })
      setPreview({ id: s.id, msgs: r.messages })
    } catch (err) {
      setSessionError(String((err as Error).message).slice(0, 160))
    } finally {
      setPreviewLoading(false)
    }
  }

  const activate = async (s: SessionBrief) => {
    await api.invoke(IPC.sessionActivate, { scope: 'group', agentId: s.agentId, projectId: project.id, sessionId: s.id })
    await loadGroupHistory(project.id)
    await refreshSessions()
    onClose()
  }

  const remove = async (s: SessionBrief) => {
    if (!confirm(`删除任务「${s.title}」？该操作不可恢复。`)) return
    await api.invoke(IPC.sessionDelete, { sessionId: s.id })
    if (preview?.id === s.id) setPreview(null)
    await refreshSessions()
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
      await refreshSessions()
    } catch (err) {
      setSessionError(String((err as Error).message).slice(0, 160))
    }
  }

  const newTask = async (agentId: string) => {
    await api.invoke(IPC.groupNewSession, { projectId: project.id, agentId })
    await loadGroupHistory(project.id)
    await refreshSessions()
  }

  return (
    <div className="drawer-mask" data-testid="group-info-drawer" onClick={onClose}>
      <div className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span>群资料：{project.title}</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="drawer-sec">群设置</div>
        <div className="group-settings" data-testid="group-settings">
          <label className="field">
            <span>群名 *</span>
            <input value={title} data-testid="group-settings-title" onChange={(e) => setTitle(e.target.value)} placeholder="如：Jeff 官网开发" />
          </label>
          <label className="field" style={{ width: 90 }}>
            <span>图标</span>
            <input value={icon} data-testid="group-settings-icon" onChange={(e) => setIcon(e.target.value)} maxLength={4} />
          </label>
          <label className="field">
            <span>群简介 / 项目背景（注入群聊 system）</span>
            <textarea
              rows={5}
              value={description}
              data-testid="group-settings-desc"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="项目背景、约束、验收口径…会作为固定上下文注入每位成员的任务会话"
            />
          </label>
          <label className="field">
            <span>工作空间目录（不选 = Jeff 默认工作区）</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={workspaceDir}
                data-testid="group-settings-workspace"
                onChange={(e) => setWorkspaceDir(e.target.value)}
                placeholder="留空 = Jeff 默认工作区"
                style={{ flex: 1 }}
              />
              <button className="btn" type="button" onClick={() => void pickDir()}>
                浏览…
              </button>
            </div>
          </label>
          <label className="field">
            <span>群主（leader）*</span>
            <select value={leaderId} data-testid="group-settings-leader" onChange={(e) => setLeaderId(e.target.value)}>
              <option value="">选择智能体…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar} {a.name}
                  {a.builtin ? '（内置）' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-actions" style={{ justifyContent: 'flex-start', marginTop: 4 }}>
            <button className="btn primary" data-testid="group-settings-save" disabled={saving || !title.trim() || !leaderId} onClick={() => void saveSettings()}>
              {saving ? '保存中…' : '保存群设置'}
            </button>
            {saveMsg && <span className="settings-tip">{saveMsg}</span>}
          </div>
        </div>

        <div className="drawer-sec">
          成员（{members.length}）
          <button className="text-btn" data-testid="group-add-member" disabled={candidateAgents.length === 0} onClick={() => setAddingMember(true)}>
            + 添加成员
          </button>
        </div>
        <div className="member-list">
          {members.map((m) => {
            const isLeader = m.agent_id === (leaderId || project.leader_agent_id)
            return (
              <div key={m.agent_id} className="member-row">
                <Avatar emoji={m.avatar} size={30} />
                <span className="member-name">{m.name}</span>
                <span className={`tag ${isLeader ? 'tag-green' : ''}`}>{projectRoleLabel(isLeader ? 'leader' : m.role)}</span>
                {!isLeader && (
                  <button
                    className="text-btn danger"
                    onClick={async () => {
                      await api.invoke(IPC.projectRemoveMember, { projectId: project.id, agentId: m.agent_id })
                      setMembers((prev) => prev.filter((x) => x.agent_id !== m.agent_id))
                      await refreshProjects()
                    }}
                  >
                    移出
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <div className="drawer-sec">任务会话（按成员）</div>
        <p className="settings-tip" style={{ marginTop: 0 }}>
          每个成员下的会话就是一个任务；可改标题、继续或新开任务。
        </p>
        {sessionError && <p className="settings-error">⚠️ {sessionError}</p>}
        {!sessions && <p className="settings-tip">加载任务中…</p>}

        <div className="group-task-layout" data-testid="group-task-sessions">
          <div className="group-task-list">
            {sessionsByMember.map((g) => (
              <div key={g.agentId} className="group-task-member">
                <div className="group-task-member-head">
                  <span>{g.agentName}</span>
                  <button className="text-btn" data-testid={`group-new-task-${g.agentId}`} onClick={() => void newTask(g.agentId)} title="给该成员开新任务">
                    + 新任务
                  </button>
                </div>
                {g.list.length === 0 && <div className="kanban-empty">还没有任务会话</div>}
                {g.list.map((s) => (
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
                            if (e.key === 'Escape') setEditingId(null)
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
                      <button className="text-btn" onClick={() => startRename(s)}>
                        改名
                      </button>
                      {!s.active && (
                        <button className="text-btn" onClick={() => void activate(s)}>
                          继续
                        </button>
                      )}
                      {!s.active && (
                        <button className="text-btn danger" onClick={() => void remove(s)}>
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="history-preview">
            {previewLoading && <p className="settings-tip history-tip">加载中…</p>}
            {!previewLoading && !preview && <div className="empty-card">点击左侧任务查看完整历史</div>}
            {!previewLoading && preview && (
              <>
                <div className="history-preview-msgs">
                  {preview.msgs.length === 0 && <div className="empty-card">该任务还没有消息。</div>}
                  {preview.msgs.map((m) => (
                    <div key={m.id} className={`history-msg ${m.role}`}>
                      <div className="history-msg-meta">
                        {m.role === 'user' ? '我' : m.role === 'system' ? '系统' : '对方'} · {fmtTime(m.time)}
                      </div>
                      {m.role === 'assistant' ? <Markdown text={m.text || '（无文本）'} /> : <pre className="history-msg-text">{m.text}</pre>}
                    </div>
                  ))}
                </div>
                <div className="history-preview-actions">
                  {(() => {
                    const s = (sessions || []).find((x) => x.id === preview.id)
                    return s && !s.active ? (
                      <button className="btn primary" onClick={() => void activate(s)}>
                        继续此任务
                      </button>
                    ) : (
                      <span className="settings-tip">这是当前任务</span>
                    )
                  })()}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="drawer-danger">
          <button className="btn danger" data-testid="group-dissolve" onClick={() => void dissolve()}>
            解散群
          </button>
        </div>

        {addingMember && (
          <AddMemberModal
            candidates={candidateAgents}
            onClose={() => setAddingMember(false)}
            onPick={async (agentId) => {
              await api.invoke(IPC.projectAddMember, { projectId: project.id, agentId })
              setAddingMember(false)
              await refreshMembers()
              await refreshProjects()
            }}
          />
        )}
      </div>
    </div>
  )
}

function AddMemberModal(props: {
  candidates: Array<{ id: string; name: string; avatar: string }>
  onClose: () => void
  onPick: (agentId: string) => Promise<void>
}): React.JSX.Element {
  return (
    <div className="modal-mask" data-testid="group-add-member-modal" onClick={props.onClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">添加工作者</div>
        {props.candidates.length === 0 ? (
          <p className="settings-tip">没有可添加的智能体了。先到「通讯录」或找小杰创建。</p>
        ) : (
          <div className="member-picker">
            {props.candidates.map((a) => (
              <button key={a.id} className="member-chip" type="button" onClick={() => void props.onPick(a.id)}>
                {a.avatar} {a.name}
              </button>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
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
