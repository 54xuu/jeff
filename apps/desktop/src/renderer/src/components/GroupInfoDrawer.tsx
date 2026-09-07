import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, projectRoleLabel, type ProjectInfo, type TaskInfo } from '@jeff/core'
import Avatar from './Avatar'

const STATUSES: Array<{ id: string; label: string }> = [
  { id: 'todo', label: '待办' },
  { id: 'in_progress', label: '进行中' },
  { id: 'in_review', label: '待审' },
  { id: 'done', label: '完成' },
]
const PRIORITY_LABEL: Record<string, string> = { urgent: '紧急', high: '高', medium: '中', low: '低' }

/** 群资料抽屉：群设置 + 成员管理 + 任务看板（拖拽改状态） */
export default function GroupInfoDrawer(props: { project: ProjectInfo; tasks: TaskInfo[]; onClose: () => void }): React.JSX.Element {
  const { project, tasks, onClose } = props
  const agents = useStore((s) => s.agents)
  const { loadTasks, refreshProjects, setActive } = useStore()
  const [members, setMembers] = useState<Array<{ agent_id: string; role: string; name: string; avatar: string }>>([])
  const [addingTask, setAddingTask] = useState(false)
  const [editing, setEditing] = useState<TaskInfo | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [addingMember, setAddingMember] = useState(false)

  const [title, setTitle] = useState(project.title)
  const [icon, setIcon] = useState(project.icon || '👥')
  const [description, setDescription] = useState(project.description || '')
  const [workspaceDir, setWorkspaceDir] = useState(project.workspace_dir || '')
  const [leaderId, setLeaderId] = useState(project.leader_agent_id || '')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

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

  useEffect(() => {
    void refreshMembers()
  }, [project.id])

  const candidateAgents = useMemo(() => {
    const inGroup = new Set(members.map((m) => m.agent_id))
    return agents.filter((a) => !inGroup.has(a.id))
  }, [agents, members])

  const moveTask = async (taskId: string, status: string) => {
    await api.invoke(IPC.taskSave, { id: taskId, project_id: project.id, title: tasks.find((t) => t.id === taskId)?.title || '', status })
    await loadTasks(project.id)
  }

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

  const activeTasks = tasks.filter((t) => t.status !== 'cancelled')

  return (
    <div className="drawer-mask" data-testid="group-info-drawer" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
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
          <div style={{ display: 'flex', gap: 12 }}>
            <label className="field" style={{ width: 90 }}>
              <span>图标</span>
              <input value={icon} data-testid="group-settings-icon" onChange={(e) => setIcon(e.target.value)} maxLength={4} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>群简介</span>
              <input value={description} data-testid="group-settings-desc" onChange={(e) => setDescription(e.target.value)} placeholder="这个项目是干嘛的" />
            </label>
          </div>
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
          任务看板（{activeTasks.length}）
          <button className="text-btn" onClick={() => setAddingTask(true)}>
            + 新建任务
          </button>
        </div>
        <div className="kanban">
          {STATUSES.map((col) => (
            <div
              key={col.id}
              className={`kanban-col ${dragOver === col.id ? 'drag-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(col.id)
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(null)
                const taskId = e.dataTransfer.getData('text/jeff-task')
                if (taskId) void moveTask(taskId, col.id)
              }}
            >
              <div className="kanban-col-title">
                {col.label}
                <span className="kanban-count">{activeTasks.filter((t) => t.status === col.id).length}</span>
              </div>
              {activeTasks
                .filter((t) => t.status === col.id)
                .map((t) => (
                  <div
                    key={t.id}
                    className="task-card"
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/jeff-task', t.id)}
                    onClick={() => setEditing(t)}
                  >
                    <div className="task-card-title">{t.title}</div>
                    <div className="task-card-meta">
                      <span className="tag">JEF-{t.number}</span>
                      <span className={`tag ${t.priority === 'urgent' ? 'tag-red' : ''}`}>{PRIORITY_LABEL[t.priority] || t.priority}</span>
                      {t.assignee_id && <AssigneeTag agentId={t.assignee_id} />}
                    </div>
                  </div>
                ))}
              {activeTasks.filter((t) => t.status === col.id).length === 0 && <div className="kanban-empty">拖任务到这里</div>}
            </div>
          ))}
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

        {addingTask && (
          <TaskModal
            projectId={project.id}
            agents={agents}
            onClose={() => setAddingTask(false)}
            onSaved={async () => {
              setAddingTask(false)
              await loadTasks(project.id)
            }}
          />
        )}
        {editing && (
          <TaskModal
            projectId={project.id}
            agents={agents}
            initial={editing}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null)
              await loadTasks(project.id)
            }}
            onDelete={async () => {
              await api.invoke(IPC.taskDelete, { id: editing.id })
              setEditing(null)
              await loadTasks(project.id)
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

function AssigneeTag(props: { agentId: string }): React.JSX.Element {
  const agent = useStore((s) => s.agents.find((a) => a.id === props.agentId))
  return <span className="tag tag-green">{agent ? `${agent.avatar} ${agent.name}` : '已指派'}</span>
}

/** 任务新建/编辑弹窗 */
export function TaskModal(props: {
  projectId: string
  agents: Array<{ id: string; name: string; avatar: string }>
  initial?: TaskInfo
  onClose: () => void
  onSaved: () => Promise<void>
  onDelete?: () => Promise<void>
}): React.JSX.Element {
  const t = props.initial
  const [title, setTitle] = useState(t?.title || '')
  const [description, setDescription] = useState(t?.description || '')
  const [status, setStatus] = useState(t?.status || 'todo')
  const [priority, setPriority] = useState(t?.priority || 'medium')
  const [assignee, setAssignee] = useState(t?.assignee_id || '')

  const save = async () => {
    if (!title.trim()) return
    await api.invoke(IPC.taskSave, {
      ...(t ? { id: t.id } : {}),
      project_id: props.projectId,
      title: title.trim(),
      description,
      status,
      priority,
      assignee_id: assignee,
    })
    await props.onSaved()
  }

  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t ? `编辑任务 JEF-${t.number}` : '新建任务'}</div>
        <label className="field">
          <span>标题 *</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：修复登录超时" />
        </label>
        <label className="field">
          <span>描述 / 验收标准</span>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div style={{ display: 'flex', gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            <span>状态</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              <option value="cancelled">已取消</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>优先级</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {Object.entries(PRIORITY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>指派给</span>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">（未指派）</option>
            {props.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.avatar} {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          {t && props.onDelete && (
            <button className="btn danger" onClick={() => void props.onDelete!()}>
              删除
            </button>
          )}
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!title.trim()} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
