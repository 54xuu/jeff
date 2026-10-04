import { useEffect, useState } from 'react'
import { IPC, type TaskInfo } from '@jeff/core'
import { api } from '../api'

/** Project task board: exposes deadlines, dependency gates and acceptance evidence. */
export default function ProjectTaskBoard({ projectId }: { projectId: string }): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [title, setTitle] = useState('')
  const [criteria, setCriteria] = useState('')
  const [due, setDue] = useState('')
  const [depends, setDepends] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const refresh = async () => setTasks(await api.invoke<TaskInfo[]>(IPC.tasksList, { projectId }))
  useEffect(() => { void refresh() }, [projectId])
  const save = async (task?: TaskInfo, patch?: Partial<TaskInfo>) => {
    setSaving(true); setMessage('')
    try {
      const payload = task ? { id: task.id, project_id: projectId, title: patch?.title ?? task.title, description: task.description,
        status: patch?.status ?? task.status, priority: task.priority, assignee_id: task.assignee_id,
        due_at: patch?.due_at ?? task.due_at, depends_on: patch?.depends_on ?? task.depends_on,
        acceptance_criteria: patch?.acceptance_criteria ?? task.acceptance_criteria, evidence_paths: patch?.evidence_paths ?? task.evidence_paths }
        : { project_id: projectId, title: title.trim(), due_at: due ? new Date(`${due}T23:59:59`).getTime() : null, depends_on: depends, acceptance_criteria: criteria.trim() }
      await api.invoke<TaskInfo>(IPC.taskSave, payload)
      setTitle(''); setCriteria(''); setDue(''); setDepends([]); await refresh(); setMessage('任务已保存')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const remove = async (task: TaskInfo) => {
    if (!confirm(`删除任务 ${task.key}「${task.title}」？`)) return
    try { await api.invoke(IPC.taskDelete, { id: task.id }); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  const setStatus = async (task: TaskInfo, status: string) => { await save(task, { status }) }
  const input = { width: '100%', boxSizing: 'border-box' as const }
  return <section className="project-task-board" data-testid="project-task-board">
    <h3>项目任务看板</h3>
    <p className="settings-tip">截止日期用于逾期提醒；依赖任务未完成前，系统会阻止后续任务结项。验收证据先登记为工作区相对路径。</p>
    <div className="group-settings">
      <label className="field"><span>任务标题</span><input data-testid="project-task-title" style={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：完成腕表呼叫联调" /></label>
      <label className="field"><span>截止日期</span><input data-testid="project-task-due" type="date" style={input} value={due} onChange={(e) => setDue(e.target.value)} /></label>
      <label className="field"><span>前置任务</span><select multiple data-testid="project-task-dependencies" style={{ ...input, minHeight: 72 }} value={depends} onChange={(e) => setDepends(Array.from(e.currentTarget.selectedOptions, (o) => o.value))}>{tasks.map((t) => <option key={t.id} value={t.id}>{t.key} · {t.title}</option>)}</select></label>
      <label className="field"><span>验收标准</span><textarea data-testid="project-task-criteria" style={input} rows={2} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="完成条件与可核对结果" /></label>
      <button className="btn primary" data-testid="project-task-create" disabled={saving || !title.trim()} onClick={() => void save()}>{saving ? '保存中…' : '创建任务'}</button>
      {message && <span className="settings-tip" role="status">{message}</span>}
    </div>
    {tasks.length ? <div className="campaign-assets">{tasks.map((task) => {
      const blocked = task.depends_on.some((id) => tasks.find((item) => item.id === id)?.status !== 'done')
      const daysLeft = task.due_at == null ? null : Math.ceil((new Date(task.due_at).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000)
      const risk = task.status === 'done' || task.status === 'cancelled' ? '' : blocked ? '风险：等待前置任务' : daysLeft !== null && daysLeft < 0 ? `风险：已逾期 ${-daysLeft} 天` : daysLeft !== null && daysLeft <= 3 ? `风险：${daysLeft === 0 ? '今天到期' : `${daysLeft} 天内到期`}` : ''
      return <div className="campaign-asset-row" key={task.id} data-testid={`project-task-${task.id}`}>
        <span><strong>{task.key} · {task.title}</strong><br />{task.due_at ? `截止 ${new Date(task.due_at).toLocaleDateString('zh-CN')}` : '未设期限'} · {blocked ? '等待前置任务' : task.status} {risk ? <strong data-testid={`project-task-risk-${task.id}`}> · {risk}</strong> : null} {task.acceptance_criteria ? `· 验收：${task.acceptance_criteria}` : ''}{task.evidence_paths.length ? ` · 证据：${task.evidence_paths.join('、')}` : ''}</span>
        <span><select aria-label={`${task.key} 状态`} value={task.status} onChange={(e) => void setStatus(task, e.target.value)} disabled={saving || (blocked && task.status !== 'done')}><option value="todo">待办</option><option value="in_progress">进行中</option><option value="in_review">待验收</option><option value="done">已完成</option><option value="cancelled">已取消</option></select><button className="btn" onClick={() => void remove(task)}>删除</button></span>
      </div>
    })}</div> : <p className="settings-tip">还没有项目任务。</p>}
  </section>
}
