import { useCallback, useEffect, useMemo, useState } from 'react'
import { IPC, type ProjectMember, type TaskInfo, type TaskRunInfo } from '@jeff/core'
import { api } from '../api'

type TaskFilter = 'all' | 'todo' | 'in_progress' | 'in_review' | 'done'
const STATUS: Record<string, string> = { todo: '待办', in_progress: '进行中', in_review: '待验收', done: '已完成', cancelled: '已取消' }
const RUN_STATUS: Record<TaskRunInfo['status'], string> = {
  queued: '排队中', running: '执行中', succeeded: '已提交', failed: '执行失败',
  cancelled: '已停止', interrupted: '意外中断', needs_input: '需要补充', waiting_browser: '等待你完成浏览器验证',
}

interface TaskDraft {
  title: string
  goal: string
  description: string
  acceptance_criteria: string
  assignee_id: string
  priority: string
  due_at: number | null
  depends_on: string[]
}
const emptyDraft = (): TaskDraft => ({ title: '', goal: '', description: '', acceptance_criteria: '', assignee_id: '', priority: 'medium', due_at: null, depends_on: [] })
function fromTask(task: TaskInfo): TaskDraft {
  return { title: task.title, goal: task.goal, description: task.description, acceptance_criteria: task.acceptance_criteria,
    assignee_id: task.assignee_type === 'agent' ? task.assignee_id : '', priority: task.priority, due_at: task.due_at, depends_on: task.depends_on }
}
function shortDate(value: number): string {
  return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

/** 通用任务队列：左侧可筛选任务，右侧显示要求、执行记录和用户验收。 */
export default function ProjectTaskBoard(props: { projectId: string; members: ProjectMember[]; onOpenThread: (threadId: string) => Promise<void> }): React.JSX.Element {
  const { projectId, members, onOpenThread } = props
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft)
  const [runs, setRuns] = useState<TaskRunInfo[]>([])
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  const selected = tasks.find((task) => task.id === selectedId) || null
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await api.invoke<TaskInfo[]>(IPC.tasksList, { projectId })
      setTasks(list)
      setSelectedId((current) => current && list.some((task) => task.id === current) ? current : list[0]?.id || '')
    } finally { setLoading(false) }
  }, [projectId])
  useEffect(() => { void refresh().catch((error) => setMessage(String(error))) }, [refresh])
  useEffect(() => {
    if (!selected) { setRuns([]); return }
    let active = true
    const load = async () => {
      try {
        const next = await api.invoke<TaskRunInfo[]>(IPC.taskRuns, { id: selected.id })
        if (active) setRuns(next)
      } catch (error) { if (active) setMessage(String(error)) }
    }
    void load()
    const timer = selected.active_run ? window.setInterval(() => void Promise.all([load(), refresh()]), 1600) : undefined
    return () => { active = false; if (timer) clearInterval(timer) }
  }, [selected?.id, selected?.active_run?.id, selected?.active_run?.status, refresh])
  useEffect(() => {
    if (!selected || editing) return
    setDraft(fromTask(selected))
    setFeedback('')
  }, [selected?.id, selected?.updated_at, editing])

  const filtered = useMemo(() => tasks.filter((task) => {
    if (filter !== 'all' && task.status !== filter) return false
    const query = search.trim().toLowerCase()
    return !query || (task.key + ' ' + task.title + ' ' + task.goal + ' ' + task.description).toLowerCase().includes(query)
  }), [tasks, filter, search])
  const counts = useMemo(() => ({
    all: tasks.length,
    todo: tasks.filter((task) => task.status === 'todo').length,
    in_progress: tasks.filter((task) => task.status === 'in_progress').length,
    in_review: tasks.filter((task) => task.status === 'in_review').length,
    done: tasks.filter((task) => task.status === 'done').length,
  }), [tasks])
  const latestRun = runs[0] || null
  const blocked = (task: TaskInfo) => task.depends_on.some((id) => tasks.find((item) => item.id === id)?.status !== 'done')
  const ownerName = (task: TaskInfo) => task.assignee_type === 'agent'
    ? members.find((member) => member.agent_id === task.assignee_id)?.name || '成员已移出'
    : '由群主协调'

  const beginCreate = () => {
    setSelectedId('')
    setDraft(emptyDraft())
    setEditing(true)
    setMessage('')
  }
  const beginEdit = () => {
    if (!selected || selected.active_run || selected.status === 'done') return
    setDraft(fromTask(selected))
    setEditing(true)
    setMessage('')
  }
  const updateDraft = (patch: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const saveDraft = async () => {
    if (!draft.title.trim()) { setMessage('请填写任务标题'); return }
    setBusy(true); setMessage('')
    try {
      const task = await api.invoke<TaskInfo>(IPC.taskSave, {
        ...(selectedId ? { id: selectedId } : {}), project_id: projectId, title: draft.title.trim(),
        goal: draft.goal, description: draft.description, acceptance_criteria: draft.acceptance_criteria,
        assignee_id: draft.assignee_id, priority: draft.priority, due_at: draft.due_at, depends_on: draft.depends_on,
      })
      await refresh()
      setSelectedId(task.id)
      setEditing(false)
      setMessage('任务已保存；保存不会自动开始执行。')
    } catch (error) { setMessage(String((error as Error).message || error)) }
    finally { setBusy(false) }
  }
  const runAction = async (action: 'start' | 'stop' | 'approve' | 'return' | 'reopen') => {
    if (!selected) return
    setBusy(true); setMessage('')
    try {
      if (action === 'start') await api.invoke(IPC.taskStart, { id: selected.id })
      if (action === 'stop' && selected.active_run) await api.invoke(IPC.taskStop, { id: selected.id, runId: selected.active_run.id })
      if (action === 'approve') await api.invoke(IPC.taskReview, { id: selected.id, action, submissionId: selected.submission_id, specHash: selected.submitted_spec_hash })
      if (action === 'return') await api.invoke(IPC.taskReview, { id: selected.id, action, submissionId: selected.submission_id, specHash: selected.submitted_spec_hash, feedback })
      if (action === 'reopen') await api.invoke(IPC.taskReview, { id: selected.id, action })
      await refresh()
      if (action === 'start') setMessage('已启动任务，Agent 正在专属话题中执行。')
      if (action === 'approve') setMessage('验收通过，任务已完成。')
      if (action === 'return') setMessage('已退回任务，意见会随下一轮执行一起发送。')
      if (action === 'reopen') setMessage('任务已重新打开。')
    } catch (error) { setMessage(String((error as Error).message || error)) }
    finally { setBusy(false) }
  }
  const removeTask = async () => {
    if (!selected || selected.active_run || !confirm('删除任务 ' + selected.key + '「' + selected.title + '」？')) return
    setBusy(true)
    try { await api.invoke(IPC.taskDelete, { id: selected.id }); await refresh(); setMessage('任务已删除') }
    catch (error) { setMessage(String((error as Error).message || error)) }
    finally { setBusy(false) }
  }
  const switchTask = (task: TaskInfo) => {
    if (editing) {
      const choice = confirm('放弃当前任务草稿并切换？')
      if (!choice) return
      setEditing(false)
    }
    setSelectedId(task.id)
    setMessage('')
  }
  const selectedThread = selected?.active_run?.thread_id || latestRun?.thread_id || ''

  return <section className="project-task-board" data-testid="project-task-board">
    <div className="task-board-heading">
      <div><div className="task-eyebrow">任务与验收</div><h2>项目管理</h2><p>任务保存后保持待办；由你启动，并由你验收执行结果。</p></div>
      <button className="btn primary" data-testid="project-task-new" onClick={beginCreate}>新建任务</button>
    </div>
    <div className="task-board-counts" aria-label="任务状态统计">
      <div><strong>{counts.all}</strong><span>全部任务</span></div>
      <div><strong>{counts.in_progress + counts.todo}</strong><span>待执行</span></div>
      <div><strong>{counts.in_review}</strong><span>待验收</span></div>
      <div><strong>{counts.done}</strong><span>已完成</span></div>
    </div>
    <div className="task-board-layout">
      <aside className="task-queue">
        <label className="task-search"><span aria-hidden="true">⌕</span><input aria-label="搜索任务" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、目标或描述" /></label>
        <div className="task-filters" role="tablist" aria-label="按状态筛选任务">
          {([{ id: 'all', label: '全部' }, { id: 'todo', label: '待办' }, { id: 'in_progress', label: '进行中' }, { id: 'in_review', label: '待验收' }, { id: 'done', label: '已完成' }] as Array<{ id: TaskFilter; label: string }>).map((item) =>
            <button key={item.id} role="tab" aria-selected={filter === item.id} className={filter === item.id ? 'active' : ''} onClick={() => setFilter(item.id)}>{item.label}<small>{counts[item.id]}</small></button>)}
        </div>
        <div className="task-queue-list" data-testid="project-task-list">
          {filtered.map((task) => <button type="button" key={task.id} data-testid={'project-task-' + task.id} aria-current={selectedId === task.id ? 'true' : undefined}
            className={'task-queue-card' + (selectedId === task.id ? ' selected' : '')} onClick={() => switchTask(task)}>
            <span className="task-card-top"><span>{task.key}</span><span className={'task-status status-' + task.status}>{STATUS[task.status] || task.status}</span></span>
            <strong>{task.title}</strong>
            {task.goal && <span className="task-card-goal">{task.goal}</span>}
            <span className="task-card-bottom"><span>{ownerName(task)}</span>{task.active_run && <span className="task-live-dot">● {RUN_STATUS[task.active_run.status]}</span>}{task.due_at && <span>{shortDate(task.due_at)}</span>}</span>
          </button>)}
          {filtered.length === 0 && <div className="task-queue-empty">{loading ? '正在读取任务…' : message && tasks.length === 0 ? `读取任务失败：${message}` : tasks.length ? '没有符合筛选条件的任务。' : '这里还没有任务。新建任务后，它会先留在待办状态。'}</div>}
        </div>
      </aside>

      <div className="task-detail" data-testid="project-task-detail">
        {editing ? <div className="task-editor">
          <div className="task-detail-head"><div><div className="task-eyebrow">{selectedId ? 'EDIT TASK' : 'NEW TASK'}</div><h3>{selectedId ? '编辑任务要求' : '新建任务'}</h3></div><button className="text-btn" onClick={() => { setEditing(false); if (!selectedId) setSelectedId(tasks[0]?.id || '') }}>取消</button></div>
          <label className="field"><span>任务标题 <b>*</b></span><input data-testid="project-task-title" value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} placeholder="用一句话说明要做的事" /></label>
          <label className="field"><span>目标</span><textarea rows={3} data-testid="project-task-goal" value={draft.goal} onChange={(event) => updateDraft({ goal: event.target.value })} placeholder="期望达成什么结果？如有销售对象，可写在这里。" /></label>
          <label className="field"><span>任务描述</span><textarea rows={5} data-testid="project-task-description" value={draft.description} onChange={(event) => updateDraft({ description: event.target.value })} placeholder="说明具体工作、背景、材料或限制。" /></label>
          <label className="field"><span>验收标准</span><textarea rows={3} data-testid="project-task-criteria" value={draft.acceptance_criteria} onChange={(event) => updateDraft({ acceptance_criteria: event.target.value })} placeholder="怎样判断这项工作已经完成？" /></label>
          <div className="task-editor-routing"><label className="field"><span>负责人</span><select value={draft.assignee_id} onChange={(event) => updateDraft({ assignee_id: event.target.value })}><option value="">未指定 · 由群主协调</option>{members.map((member) => <option key={member.agent_id} value={member.agent_id}>{member.name}{member.role === 'leader' ? ' · 群主' : ''}</option>)}</select></label>
            <label className="field"><span>优先级</span><select value={draft.priority} onChange={(event) => updateDraft({ priority: event.target.value })}><option value="low">低</option><option value="medium">普通</option><option value="high">高</option><option value="urgent">紧急</option></select></label></div>
          <details className="task-more-settings"><summary>更多设置 · 截止日期与前置任务</summary><label className="field"><span>截止日期</span><input type="date" value={draft.due_at ? new Date(draft.due_at).toISOString().slice(0, 10) : ''} onChange={(event) => updateDraft({ due_at: event.target.value ? new Date(event.target.value + 'T23:59:59').getTime() : null })} /></label>
            <label className="field"><span>前置任务</span><select multiple value={draft.depends_on} onChange={(event) => updateDraft({ depends_on: Array.from(event.currentTarget.selectedOptions, (option) => option.value) })}>{tasks.filter((task) => task.id !== selectedId && task.status !== 'done').map((task) => <option key={task.id} value={task.id}>{task.key} · {task.title}</option>)}</select></label></details>
          <div className="task-editor-foot"><span className="settings-tip" role="status">{message || '三个文本域分别保存，均可留空。'}</span><button className="btn primary" data-testid="project-task-create" disabled={busy || !draft.title.trim()} onClick={() => void saveDraft()}>{busy ? '保存中…' : '保存任务'}</button></div>
        </div> : selected ? <div className="task-detail-content">
          <div className="task-detail-head"><div><div className="task-eyebrow">{selected.key} · {ownerName(selected)}</div><h3>{selected.title}</h3></div><span className={'task-status status-' + selected.status}>{STATUS[selected.status] || selected.status}</span></div>
          <div className="task-requirements">
            <TaskRequirement label="目标" value={selected.goal} />
            <TaskRequirement label="任务描述" value={selected.description} />
            <TaskRequirement label="验收标准" value={selected.acceptance_criteria} />
          </div>
          <div className="task-detail-meta"><span>优先级：{selected.priority}</span><span>截止：{selected.due_at ? new Date(selected.due_at).toLocaleDateString('zh-CN') : '未设置'}</span><span>创建：{new Date(selected.created_at).toLocaleDateString('zh-CN')}</span></div>
          {blocked(selected) && selected.status !== 'done' && <div className="task-inline-alert">前置任务尚未完成。完成所有前置任务后才能开始执行。</div>}
          {selected.review_feedback && <div className="task-inline-alert returned"><strong>上次退回意见</strong><p>{selected.review_feedback}</p></div>}
          <section className="task-run-section"><div className="task-section-title"><h4>执行记录</h4>{selectedThread && <button className="text-btn" onClick={() => void onOpenThread(selectedThread)}>查看执行话题 ↗</button>}</div>
            {selected.active_run && <div className="task-live-run"><span className="task-live-dot">●</span><strong>{RUN_STATUS[selected.active_run.status]}</strong><span>负责人：{members.find((member) => member.agent_id === selected.active_run?.agent_id)?.name || ownerName(selected)}</span><button className="btn" disabled={busy} onClick={() => void runAction('stop')}>停止本次执行</button></div>}
            {latestRun ? <article className="task-run-card"><div><strong>{RUN_STATUS[latestRun.status]}</strong><time>{new Date(latestRun.started_at).toLocaleString('zh-CN')}</time></div>{latestRun.error && <p>{latestRun.error}</p>}{latestRun.thread_id && <small>此任务始终复用自己的专属话题，不影响普通群聊。</small>}</article> : <p className="task-empty-hint">尚无执行记录。保存任务后，点击“开始执行”才会调用负责人。</p>}
          </section>
          {selected.status === 'in_review' && <section className="task-submission" data-testid="project-task-submission"><div className="task-section-title"><h4>执行结果 · 等待你的验收</h4></div><p>{selected.result_summary || 'Agent 已提交结果。'}</p>{selected.evidence_paths.length > 0 && <div className="task-evidence"><strong>提交的工作区证据</strong>{selected.evidence_paths.map((path) => <code key={path}>{path}</code>)}</div>}
            <label className="field"><span>退回意见 <small>· 退回时必填</small></span><textarea rows={3} value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="说明还需要修改或补充的内容。" /></label>
            <div className="task-review-actions"><button className="btn" disabled={busy || !feedback.trim()} onClick={() => void runAction('return')}>退回继续执行</button><button className="btn primary" data-testid="project-task-approve" disabled={busy} onClick={() => void runAction('approve')}>验收通过</button></div>
          </section>}
          {message && <p className="task-action-message" role="status">{message}</p>}
          <footer className="task-detail-actions">
            {(selected.status === 'todo' || selected.status === 'in_progress') && !selected.active_run && <button className="btn primary" data-testid="project-task-start" disabled={busy || blocked(selected)} onClick={() => void runAction('start')}>{latestRun ? '继续执行' : '开始执行'}</button>}
            {selected.status === 'done' && <button className="btn" disabled={busy} onClick={() => void runAction('reopen')}>重新打开</button>}
            {selected.status !== 'done' && !selected.active_run && <button className="btn" data-testid="project-task-edit" onClick={beginEdit}>编辑要求</button>}
            {!selected.active_run && <button className="text-btn danger" onClick={() => void removeTask()}>删除任务</button>}
          </footer>
        </div> : <div className="task-detail-empty"><div className="task-empty-mark">＋</div><h3>开始管理项目任务</h3><p>每项任务都从待办开始。保存后由你决定何时执行，并在结果提交后验收。</p><button className="btn primary" onClick={beginCreate}>新建任务</button></div>}
      </div>
    </div>
  </section>
}

function TaskRequirement(props: { label: string; value: string }): React.JSX.Element {
  return <div className="task-requirement"><strong>{props.label}</strong><p>{props.value.trim() || <span className="task-unset">未填写</span>}</p></div>
}
