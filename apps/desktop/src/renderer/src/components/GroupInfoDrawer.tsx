import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, projectRoleLabel, type GroupMessage, type GroupThreadBrief, type ProjectInfo } from '@jeff/core'
import Avatar from './Avatar'
import { Markdown } from './Markdown'
import { EmojiPickerButton } from './ui/EmojiPicker'
import { useDirtyClose } from './ui/useDirtyClose'

/** 群资料抽屉：上段群设置 + 下段项目级扁平聊天记录。busy（生成中）时禁用切换/新建/删除会话，防消息串线 */
export default function GroupInfoDrawer(props: { project: ProjectInfo; busy?: boolean; onClose: () => void }): React.JSX.Element {
  const { project, busy, onClose } = props
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

  const [threads, setThreads] = useState<GroupThreadBrief[] | null>(null)
  const [preview, setPreview] = useState<{ id: string; msgs: GroupMessage[] } | null>(null)
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

  const refreshThreads = async () => {
    try {
      const r = await api.invoke<{ threads: GroupThreadBrief[] }>(IPC.groupThreadsList, { projectId: project.id })
      setThreads(r.threads)
      setSessionError('')
    } catch (err) {
      setSessionError(String((err as Error).message).slice(0, 160))
      setThreads([])
    }
  }

  useEffect(() => {
    void refreshMembers()
    void refreshThreads()
  }, [project.id])

  const candidateAgents = agents.filter((a) => !members.some((m) => m.agent_id === a.id))

  // 群设置表单脏检查：任一字段相对当前 project 有变化即视为脏（成员增删是即时保存的，不参与）
  const formDirty =
    title !== project.title ||
    icon !== (project.icon || '👥') ||
    description !== (project.description || '') ||
    workspaceDir !== (project.workspace_dir || '') ||
    leaderId !== (project.leader_agent_id || '')
  const { requestClose, guard } = useDirtyClose({ dirty: formDirty, onClose, disabled: addingMember })

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

  const openPreview = async (t: GroupThreadBrief) => {
    if (preview?.id === t.id) return
    setPreviewLoading(true)
    try {
      const r = await api.invoke<{ messages: GroupMessage[] }>(IPC.groupThreadPreview, { projectId: project.id, threadId: t.id })
      setPreview({ id: t.id, msgs: r.messages })
    } catch (err) {
      setSessionError(String((err as Error).message).slice(0, 160))
    } finally {
      setPreviewLoading(false)
    }
  }

  const activate = async (t: GroupThreadBrief) => {
    try {
      await api.invoke(IPC.groupThreadActivate, { projectId: project.id, threadId: t.id })
      await loadGroupHistory(project.id)
      await refreshThreads()
      onClose()
    } catch (err) {
      setSessionError(String((err as Error).message).slice(0, 160))
    }
  }

  const remove = async (t: GroupThreadBrief) => {
    if (!confirm(`删除会话「${t.title}」？该段聊天记录不可恢复。`)) return
    try {
      await api.invoke(IPC.groupThreadDelete, { projectId: project.id, threadId: t.id })
      if (preview?.id === t.id) setPreview(null)
      await loadGroupHistory(project.id)
      await refreshThreads()
    } catch (err) {
      setSessionError(String((err as Error).message).slice(0, 160))
    }
  }

  const startRename = (t: GroupThreadBrief) => {
    setEditingId(t.id)
    setEditTitle(t.title)
  }

  const commitRename = async (threadId: string) => {
    const next = editTitle.trim()
    setEditingId(null)
    if (!next) return
    try {
      await api.invoke(IPC.groupThreadRename, { projectId: project.id, threadId, title: next })
      await refreshThreads()
    } catch (err) {
      setSessionError(String((err as Error).message).slice(0, 160))
    }
  }

  const newThread = async () => {
    try {
      await api.invoke(IPC.groupThreadNew, { projectId: project.id })
      await loadGroupHistory(project.id)
      await refreshThreads()
      onClose()
    } catch (err) {
      setSessionError(String((err as Error).message).slice(0, 160))
    }
  }

  return (
    <div className="drawer-mask" data-testid="group-info-drawer" onClick={requestClose}>
      <div className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span>群资料：{project.title}</span>
          <button className="icon-btn" onClick={requestClose}>
            ✕
          </button>
        </div>

        <div className="drawer-sec">群设置</div>
        <div className="group-settings" data-testid="group-settings">
          <label className="field">
            <span>群名 *</span>
            <input value={title} data-testid="group-settings-title" onChange={(e) => setTitle(e.target.value)} placeholder="如：Jeff 官网开发" />
          </label>
          <label className="field" style={{ width: 110 }}>
            <span>图标</span>
            <div className="emoji-input-row">
              <input value={icon} data-testid="group-settings-icon" onChange={(e) => setIcon(e.target.value)} />
              <EmojiPickerButton value={icon} onPick={setIcon} testId="group-icon-picker" />
            </div>
          </label>
          <label className="field">
            <span>群简介 / 项目背景（注入群聊 system）</span>
            <textarea
              rows={5}
              value={description}
              data-testid="group-settings-desc"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="项目背景、约束、验收口径…会作为固定上下文注入群聊"
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

        <div className="drawer-sec">
          聊天记录
          <button className="text-btn" data-testid="group-new-thread" disabled={busy} title={busy ? '生成中不可新建会话，请先停止或等待完成' : undefined} onClick={() => void newThread()}>
            + 新会话
          </button>
        </div>
        {busy && <p className="settings-error">⏳ 生成中：会话切换 / 新建 / 删除已临时禁用，防止消息串会话。</p>}
        <p className="settings-tip" style={{ marginTop: 0 }}>
          每一段都是整个项目群的对话历史（可由不同成员执行）；可改标题、继续或新开。
        </p>
        {sessionError && <p className="settings-error">⚠️ {sessionError}</p>}
        {!threads && <p className="settings-tip">加载中…</p>}

        <div className="group-task-layout" data-testid="group-chat-history">
          <div className="group-task-list">
            {threads?.length === 0 && <div className="kanban-empty">还没有会话</div>}
            {(threads || []).map((t) => (
              <div key={t.id} className={`history-item ${preview?.id === t.id ? 'previewing' : ''}`} onClick={() => void openPreview(t)}>
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
                          // 约定：消费 Esc 的组件 preventDefault，外层抽屉守卫（useDirtyClose）检测后跳过
                          e.preventDefault()
                          setEditingId(null)
                        }
                      }}
                    />
                  ) : (
                    <span
                      className="history-item-title"
                      data-testid={`thread-title-${t.id}`}
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
                  <button className="text-btn" disabled={busy} title={busy ? '生成中不可操作会话' : undefined} onClick={() => startRename(t)}>
                    改名
                  </button>
                  {!t.active && (
                    <button className="text-btn" disabled={busy} title={busy ? '生成中不可切换会话' : undefined} onClick={() => void activate(t)}>
                      继续
                    </button>
                  )}
                  {!t.active && (
                    <button className="text-btn danger" disabled={busy} title={busy ? '生成中不可删除会话' : undefined} onClick={() => void remove(t)}>
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
                      {m.role === 'assistant' ? <Markdown text={m.text || '（无文本）'} /> : <pre className="history-msg-text">{m.text}</pre>}
                    </div>
                  ))}
                </div>
                <div className="history-preview-actions">
                  {(() => {
                    const t = (threads || []).find((x) => x.id === preview.id)
                    return t && !t.active ? (
                      <button className="btn primary" onClick={() => void activate(t)}>
                        继续此会话
                      </button>
                    ) : (
                      <span className="settings-tip">这是当前会话</span>
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
      {guard}
    </div>
  )
}

function AddMemberModal(props: {
  candidates: Array<{ id: string; name: string; avatar: string }>
  onClose: () => void
  onPick: (agentId: string) => Promise<void>
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props.onClose])

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
