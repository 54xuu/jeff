import { useEffect, useState } from 'react'
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

/** 群资料抽屉：成员列表 + 任务看板（拖拽改状态） */
export default function GroupInfoDrawer(props: { project: ProjectInfo; tasks: TaskInfo[]; onClose: () => void }): React.JSX.Element {
  const { project, tasks, onClose } = props
  const [members, setMembers] = useState<Array<{ agent_id: string; role: string; name: string; avatar: string }>>([])
  const [addingTask, setAddingTask] = useState(false)
  const [editing, setEditing] = useState<TaskInfo | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const { loadTasks } = useStore()

  useEffect(() => {
    void api.invoke<Array<{ agent_id: string; role: string; name: string; avatar: string }>>(IPC.projectMembers, { projectId: project.id }).then(setMembers)
  }, [project.id])

  const moveTask = async (taskId: string, status: string) => {
    await api.invoke(IPC.taskSave, { id: taskId, project_id: project.id, title: tasks.find((t) => t.id === taskId)?.title || '', status })
    await loadTasks(project.id)
  }

  const activeTasks = tasks.filter((t) => t.status !== 'cancelled')

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span>群资料：{project.title}</span>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="drawer-sec">成员（{members.length}）</div>
        <div className="member-list">
          {members.map((m) => {
            const isLeader = m.agent_id === project.leader_agent_id
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
          <button className="text-btn" onClick={() => setAddingTask(true)}>+ 新建任务</button>
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

        {addingTask && (
          <TaskModal
            projectId={project.id}
            agents={useStore.getState().agents}
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
            agents={useStore.getState().agents}
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
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
              <option value="cancelled">已取消</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>优先级</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {Object.entries(PRIORITY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>指派给</span>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">（未指派）</option>
            {props.agents.map((a) => (
              <option key={a.id} value={a.id}>{a.avatar} {a.name}</option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          {t && props.onDelete && (
            <button className="btn danger" onClick={() => void props.onDelete!()}>删除</button>
          )}
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn primary" disabled={!title.trim()} onClick={() => void save()}>保存</button>
        </div>
      </div>
    </div>
  )
}
