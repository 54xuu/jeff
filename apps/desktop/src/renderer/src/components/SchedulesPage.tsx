import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, CRON_PRESETS, describeCron, describeOnce, isValidCron, nextRunAt, type CronRunInfo, type CronTaskInfo } from '@jeff/core'
import { Button } from './ui/Button'
import { Field } from './ui/Field'
import { Toast } from './ui/Toast'
import { Dialog } from './ui/Dialog'

const STATUS_LABEL: Record<string, string> = { running: '执行中', ok: '成功', failed: '失败', missed: '已错过', skipped: '已跳过' }

/** 距离下次触发的可读倒计时 */
function untilText(ts: number | null): string {
  if (!ts) return '未排期'
  const diff = ts - Date.now()
  if (diff <= 0) return '即将触发'
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m} 分钟后`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分后`
  return `${Math.floor(h / 24)} 天后`
}

const fmtTime = (ts: number | null | undefined): string => (ts ? new Date(ts).toLocaleString() : '—')

const pad2 = (n: number) => String(n).padStart(2, '0')

/** datetime-local 的值（本机时区，不含秒） */
function toLocalInput(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function todayAt(hm: string): string {
  const [h, m] = hm.split(':')
  const d = new Date()
  d.setHours(Number(h), Number(m), 0, 0)
  return toLocalInput(d.getTime())
}

/** 新建一次性任务的默认时刻：今天这个钟点还没到就用今天，否则用明天 */
function upcomingClock(hm: string): string {
  const value = todayAt(hm)
  const ts = fromLocalInput(value)
  if (ts != null && ts <= Date.now()) {
    const d = new Date(ts)
    d.setDate(d.getDate() + 1)
    return toLocalInput(d.getTime())
  }
  return value
}

function fromLocalInput(value: string): number | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

/**
 * 定时任务视图：所有「到点自动向某会话发消息」的任务集中管理。
 * 触发后消息落在目标私聊/群聊里（与手动发消息同一套上下文），这里只管「排期与健康度」。
 */
export default function SchedulesPage(): React.JSX.Element {
  const { cronTasks, agents, projects, refreshCron, loadCronRuns } = useStore()
  const [editing, setEditing] = useState<CronTaskInfo | 'new' | null>(null)
  const [runs, setRuns] = useState<Record<string, CronRunInfo[]>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    void refreshCron()
  }, [refreshCron])

  const toggle = async (t: CronTaskInfo) => {
    setBusy(t.id)
    try {
      await api.invoke(IPC.cronSave, {
        id: t.id,
        name: t.name,
        target_type: t.target_type,
        target_id: t.target_id,
        cron_expr: t.cron_expr,
        prompt: t.prompt,
        miss_policy: t.miss_policy,
        enabled: !t.enabled,
      })
      await refreshCron()
    } catch (e) {
      setToast({ kind: 'error', message: String((e as Error)?.message || e) })
    } finally {
      setBusy(null)
    }
  }

  const runNow = async (t: CronTaskInfo) => {
    setBusy(t.id)
    try {
      await api.invoke(IPC.cronRun, { id: t.id })
      setToast({ kind: 'success', message: `已在「${t.target_label}」里触发一次，稍后可在会话中查看回复` })
      setExpanded(t.id)
      setRuns((r) => ({ ...r, [t.id]: [] }))
      setTimeout(() => void refreshRuns(t.id), 1200)
    } catch (e) {
      setToast({ kind: 'error', message: String((e as Error)?.message || e) })
    } finally {
      setBusy(null)
    }
  }

  const refreshRuns = async (id: string) => {
    const list = await loadCronRuns(id)
    setRuns((r) => ({ ...r, [id]: list }))
  }

  const remove = async (t: CronTaskInfo) => {
    if (!confirm(`删除定时任务「${t.name}」？`)) return
    await api.invoke(IPC.cronDelete, { id: t.id })
    await refreshCron()
  }

  const openRuns = (t: CronTaskInfo) => {
    if (expanded === t.id) {
      setExpanded(null)
      return
    }
    setExpanded(t.id)
    void refreshRuns(t.id)
  }

  return (
    <div className="page-pane" data-testid="schedules-page">
      <div className="page-head">
        <div>
          <h2>定时任务</h2>
          <p className="settings-tip">
            到点自动向某个智能体（私聊）或项目群发消息，并让它回复。可以每天重复，也可以只跑一次（例如今天 12:00）。
          </p>
        </div>
        <Button variant="primary" data-testid="cron-create" onClick={() => setEditing('new')}>
          + 新建任务
        </Button>
      </div>

      {cronTasks.length === 0 && (
        <div className="empty-hint" style={{ padding: '40px 0' }}>
          <p>还没有定时任务</p>
          <p className="sub">也可以直接对小杰说「每天早上 8 点让资讯助手报最新 AI 资讯」</p>
        </div>
      )}

      <div className="cron-grid">
        {cronTasks.map((t) => (
          <div key={t.id} className={`cron-card ${t.enabled ? '' : 'disabled'}`} data-testid={`cron-card-${t.id}`}>
            <div className="cron-card-top">
              <div className="cron-title">
                <span className="cron-name">{t.name}</span>
                {!t.enabled && <span className="tag">已停用</span>}
                {t.target_exists === false && <span className="tag tag-red">目标失效</span>}
                {t.last_status === 'failed' && t.enabled && <span className="tag tag-red">上次失败</span>}
              </div>
              <div className="cron-card-actions">
                <button className="icon-btn" title="立即执行一次" data-testid={`cron-run-${t.id}`} disabled={busy === t.id} onClick={() => void runNow(t)}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                    <path d="M6 4l12 8-12 8z" />
                  </svg>
                </button>
                <button className="icon-btn" title={t.enabled ? '停用' : '启用'} disabled={busy === t.id} onClick={() => void toggle(t)}>
                  {t.enabled ? (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M10 4v8M14 4v8M6 12a6 6 0 0 0 12 0" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2v10M5 12a7 7 0 1 0 14 0" />
                    </svg>
                  )}
                </button>
                <button className="icon-btn" title="编辑" onClick={() => setEditing(t)}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                  </svg>
                </button>
                <button className="icon-btn" title="删除" onClick={() => void remove(t)}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="cron-meta">
              <span className="cron-badge">{t.cron_human}</span>
              {t.run_at == null && <span className="cron-badge">expr {t.cron_expr}</span>}
              <span className="cron-badge">{t.miss_policy === 'catchup' ? '错过补跑' : '错过跳过'}</span>
            </div>
            <div className="cron-target">
              目标：{t.target_label} <span className="cron-dim">（{t.target_type === 'agent' ? '私聊' : '项目群'}）</span>
            </div>
            <div className="cron-prompt" title={t.prompt}>
              “{t.prompt}”
            </div>
            <div className="cron-foot">
              <span>下次：{t.enabled ? `${fmtTime(t.next_run_at)}（${untilText(t.next_run_at)}）` : '—'}</span>
              <button className="link-btn" data-testid={`cron-history-${t.id}`} onClick={() => openRuns(t)}>
                {expanded === t.id ? '收起历史' : '运行历史'}
              </button>
            </div>
            {expanded === t.id && (
              <div className="cron-runs" data-testid={`cron-runs-${t.id}`}>
                {(runs[t.id] ?? []).length === 0 ? (
                  <div className="cron-dim">暂无运行记录</div>
                ) : (
                  (runs[t.id] ?? []).map((r) => (
                    <div key={r.id} className="cron-run-row">
                      <span className={`cron-run-status ${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span>
                      {r.is_catchup && <span className="tag">补跑</span>}
                      <span className="cron-dim">{fmtTime(r.started_at)}</span>
                      {r.finished_at && <span className="cron-dim">{Math.max(1, Math.round((r.finished_at - r.started_at) / 1000))}s</span>}
                      {r.error && <span className="cron-run-error" title={r.error}>{r.error.slice(0, 60)}</span>}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <CronEditor
          task={editing === 'new' ? null : editing}
          agents={agents.map((a) => ({ id: a.id, label: `${a.avatar} ${a.name}` }))}
          projects={projects.map((p) => ({ id: p.id, label: `${p.icon} ${p.title}` }))}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await refreshCron()
            setToast({ kind: 'success', message: '已保存' })
          }}
        />
      )}

      {toast && <Toast kind={toast.kind} message={toast.message} onClose={() => setToast(null)} />}
    </div>
  )
}

/** 新建/编辑任务弹窗 */
function CronEditor(props: {
  task: CronTaskInfo | null
  agents: Array<{ id: string; label: string }>
  projects: Array<{ id: string; label: string }>
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const t = props.task
  const [name, setName] = useState(t?.name || '')
  const [targetKey, setTargetKey] = useState(t ? `${t.target_type}:${t.target_id}` : '')
  const [mode, setMode] = useState<'cron' | 'once'>(t?.run_at ? 'once' : 'cron')
  const [expr, setExpr] = useState(t?.cron_expr || '0 8 * * *')
  const [runAt, setRunAt] = useState(t?.run_at ? toLocalInput(t.run_at) : upcomingClock('12:00'))
  const [prompt, setPrompt] = useState(t?.prompt || '')
  const [missPolicy, setMissPolicy] = useState<'catchup' | 'skip'>(t?.miss_policy || 'catchup')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allTargets = useMemo(
    () => [
      ...props.agents.map((a) => ({ key: `agent:${a.id}`, id: a.id, type: 'agent' as const, label: a.label })),
      ...props.projects.map((p) => ({ key: `project:${p.id}`, id: p.id, type: 'project' as const, label: p.label })),
    ],
    [props.agents, props.projects],
  )
  useEffect(() => {
    // 目标被删或列表刷新后，当前选择不在清单里就清空，避免提交到错误的 id
    if (targetKey && !allTargets.some((o) => o.key === targetKey)) setTargetKey(allTargets[0]?.key || '')
    if (!targetKey && allTargets[0]) setTargetKey(allTargets[0].key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.agents.length, props.projects.length])

  const exprError = useMemo(() => (mode === 'once' || isValidCron(expr) ? null : '表达式非法（需 5 段：分 时 日 月 周）'), [expr, mode])
  const onceAt = useMemo(() => (mode === 'once' ? fromLocalInput(runAt) : null), [mode, runAt])
  const nextPreview = useMemo(() => {
    if (mode === 'once') {
      if (onceAt == null) return '请选择时间'
      if (onceAt <= Date.now()) return '这个时间已经过了'
      return `${describeOnce(onceAt)}（${new Date(onceAt).toLocaleString()}）`
    }
    if (exprError) return '—'
    try {
      return new Date(nextRunAt(expr, Date.now())).toLocaleString()
    } catch (e) {
      return String((e as Error)?.message || e)
    }
  }, [expr, exprError, mode, onceAt])

  const submit = async () => {
    setError(null)
    if (!name.trim()) return setError('请填写任务名')
    const picked = allTargets.find((o) => o.key === targetKey)
    if (!picked) return setError('请选择目标会话')
    if (mode === 'once') {
      if (onceAt == null) return setError('请选择一次性执行时间')
      if (onceAt <= Date.now()) return setError('一次性任务要选一个还没到的时刻')
    } else if (exprError) return setError(exprError)
    if (!prompt.trim()) return setError('请填写触发时要说的话')
    setSaving(true)
    try {
      await api.invoke(IPC.cronSave, {
        ...(t ? { id: t.id } : {}),
        name: name.trim(),
        target_type: picked.type,
        target_id: picked.id,
        cron_expr: mode === 'once' ? '0 0 1 1 *' : expr.trim(),
        run_at: mode === 'once' ? onceAt : null,
        prompt: prompt.trim(),
        miss_policy: missPolicy,
        enabled: t ? t.enabled : true,
      })
      await props.onSaved()
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={t ? `编辑定时任务 · ${t.name}` : '新建定时任务'} onClose={props.onClose}>
      <div className="pv-grid">
        <Field label="任务名 *">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：晨间病区动态" data-testid="cron-name" />
        </Field>
        <Field label="目标会话 *" span>
          <select value={targetKey} onChange={(e) => setTargetKey(e.target.value)} data-testid="cron-target-id">
            <option value="">（请选择）</option>
            <optgroup label="智能体" data-testid="cron-optgroup-agents">
              {props.agents.map((o) => (
                <option key={o.id} value={`agent:${o.id}`}>
                  {o.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="项目群" data-testid="cron-optgroup-projects">
              {props.projects.map((o) => (
                <option key={o.id} value={`project:${o.id}`}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        <Field label="重复还是只跑一次" span>
          <div className="cron-presets">
            <button type="button" className={`chip ${mode === 'cron' ? 'active' : ''}`} onClick={() => setMode('cron')} data-testid="cron-mode-repeat">
              重复
            </button>
            <button type="button" className={`chip ${mode === 'once' ? 'active' : ''}`} onClick={() => setMode('once')} data-testid="cron-mode-once">
              仅一次
            </button>
          </div>
        </Field>
        {mode === 'once' ? (
          <Field label="执行时刻（本机时区，到点后自动停用）" span>
            <div className="cron-expr-row">
              <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} data-testid="cron-run-at" />
              <div className="cron-presets">
                <button type="button" className="chip" onClick={() => setRunAt(todayAt('12:00'))} data-testid="cron-once-today-noon">
                  今天 12:00
                </button>
                <button type="button" className="chip" onClick={() => setRunAt(todayAt('18:00'))}>
                  今天 18:00
                </button>
              </div>
            </div>
          </Field>
        ) : (
          <Field label="触发时间（5 段 cron：分 时 日 月 周，本机时区）" span>
            <div className="cron-expr-row">
              <input value={expr} onChange={(e) => setExpr(e.target.value)} spellCheck={false} data-testid="cron-expr" />
              <div className="cron-presets">
                {CRON_PRESETS.map((p) => (
                  <button key={p.expr} type="button" className={`chip ${expr === p.expr ? 'active' : ''}`} onClick={() => setExpr(p.expr)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </Field>
        )}
        <p className="settings-tip" style={{ gridColumn: '1 / -1' }}>
          {mode === 'once' ? (
            nextPreview
          ) : exprError ? (
            <span style={{ color: 'var(--red, #d33)' }}>{exprError}</span>
          ) : (
            <>将描述为「{describeCron(expr)}」，下次触发：{nextPreview}</>
          )}
        </p>
        <Field label="触发时发出的内容 *" span>
          <textarea
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="如：请汇报今天的病区动态；或 请汇总最新的 AI 资讯并给出三条重点。"
            data-testid="cron-prompt"
          />
        </Field>
        <Field label="错过的触发如何处理（Jeff 未开机期间）" span>
          <div className="cron-presets">
            <button className={`chip ${missPolicy === 'catchup' ? 'active' : ''}`} onClick={() => setMissPolicy('catchup')} data-testid="cron-miss-catchup">
              开机后补跑一次（重要任务）
            </button>
            <button className={`chip ${missPolicy === 'skip' ? 'active' : ''}`} onClick={() => setMissPolicy('skip')} data-testid="cron-miss-skip">
              直接跳过（不重要的资讯类）
            </button>
          </div>
        </Field>
      </div>

      {error && <Toast kind="error" message={error} onClose={() => setError(null)} />}

      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <Button variant="primary" disabled={saving} onClick={() => void submit()} data-testid="cron-save">
          {saving ? '保存中…' : '保存'}
        </Button>
        <Button onClick={props.onClose}>取消</Button>
      </div>
    </Dialog>
  )
}
