import type { ProjectRow, TaskActivityRow, TaskRow } from '../db/repos.js'
import { parseProjectWorkspaceState } from './workspace.js'

export type ProjectDocumentKind = 'charter' | 'weekly_report' | 'closeout'
export interface ProjectDocumentOutput { kind: ProjectDocumentKind; filename: string; content: string; missing: string[] }
export interface ProjectWeekRange { startDate: string; endDate: string }

/** Deterministic, source-bound project drafts. This function does not infer facts from chat. */
export function buildProjectDocument(project: ProjectRow, tasks: TaskRow[], kind: ProjectDocumentKind, at = Date.now(), activities: TaskActivityRow[] = [], range?: ProjectWeekRange): ProjectDocumentOutput {
  const workspace = parseProjectWorkspaceState(project.workspace_state)
  const stamp = new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replaceAll('-', '')
  const base = [`# ${project.title} · ${kindLabel(kind)}（草稿）`, '', `生成时间：${new Date(at).toLocaleString('zh-CN')}`, `项目编号：${project.id}`, `项目状态：${project.status}`, '']
  const missing: string[] = []
  if (kind === 'charter') {
    if (!workspace.goal) missing.push('项目目标未填写')
    if (!project.description.trim()) missing.push('项目背景/简介未填写')
    base.push('## 项目背景与目标', '', project.description || '待补充：项目背景', '', '### 阶段目标', '', workspace.goal || '待补充：阶段目标', '', `### 销售对象\n\n${workspace.salesAudience || '待补充：销售对象'}`, '', `### 内容呈现对象\n\n${workspace.storyAudience || '待补充：典型使用者'}`, '', '## 范围与交付', '', ...(workspace.systemOutline.length ? workspace.systemOutline.map((line) => `- ${line}`) : ['- 待补充：项目范围与交付物']), '', '### 协作渠道', '', ...(workspace.channels.length ? workspace.channels.map((line) => `- ${line}`) : ['- 待补充：协作渠道']), '', '## 项目任务基线', '', ...taskLines(tasks), '', '## 未确认信息', '', ...(missing.length ? missing.map((line) => `- ${line}`) : ['- 当前已填写字段未发现空缺；请项目负责人复核后批准基线。']))
  } else if (kind === 'weekly_report') {
    const period = range || currentWeekRange(at)
    if (!isISODate(period.startDate) || !isISODate(period.endDate) || period.startDate > period.endDate) throw new Error('请选择有效的周报日期范围')
    const weekActivities = activities.filter((activity) => activity.at >= dateStart(period.startDate) && activity.at < dateStart(addDays(period.endDate, 1)))
    if (!tasks.length) missing.push('暂无项目任务记录')
    if (!weekActivities.length) missing.push('该日期范围内没有任务创建或状态变更记录')
    const done = tasks.filter((task) => task.status === 'done')
    const active = tasks.filter((task) => ['in_progress', 'in_review'].includes(task.status))
    const blocked = tasks.filter((task) => {
      try { return (JSON.parse(task.depends_on || '[]') as string[]).some((id) => tasks.find((item) => item.id === id)?.status !== 'done') } catch { return false }
    })
    const overdue = tasks.filter((task) => task.due_at != null && task.due_at < at && !['done', 'cancelled'].includes(task.status))
    base.push(`## 周期进展（${period.startDate} 至 ${period.endDate}）`, '', '### 周期内实际记录', '', ...activityLines(weekActivities), '', '### 当前任务快照', '', `- 任务总数：${tasks.length}`, `- 当前已完成：${done.length}`, `- 当前进行中/待验收：${active.length}`, `- 当前阻塞：${blocked.length}`, `- 当前逾期：${overdue.length}`, '', '### 当前阻塞与逾期风险', '', ...taskLines([...new Map([...blocked, ...overdue].map((task) => [task.id, task])).values()]), '', '### 下一步', '', ...taskLines(tasks.filter((task) => !['done', 'cancelled'].includes(task.status))), '', '## 来源与待核实', '', '- 周期进展来源：不可变任务活动记录；任务快照与风险来源：报告生成时的任务看板。', '- “当前已完成/进行中/风险”为生成时状态，不代表周期末状态。', ...(missing.length ? missing.map((line) => `- ${line}`) : []))
    return { kind, filename: `${kind}-${period.startDate.replaceAll('-', '')}-${period.endDate.replaceAll('-', '')}-${stamp}.md`, content: `${base.join('\n')}\n`, missing }
  } else {
    const incomplete = tasks.filter((task) => !['done', 'cancelled'].includes(task.status))
    const noCriteria = tasks.filter((task) => task.status === 'done' && !task.acceptance_criteria.trim())
    const noEvidence = tasks.filter((task) => {
      if (task.status !== 'done') return false
      try { return !(JSON.parse(task.evidence_paths || '[]') as unknown[]).length } catch { return true }
    })
    if (incomplete.length) missing.push(`${incomplete.length} 项任务未完成`)
    if (noCriteria.length) missing.push(`${noCriteria.length} 项已完成任务缺少验收标准`)
    if (noEvidence.length) missing.push(`${noEvidence.length} 项已完成任务缺少验收证据`)
    base.push('## 结项核查', '', ...tasks.map((task) => {
      const criteria = task.acceptance_criteria.trim() ? '有验收标准' : '缺验收标准'
      let hasEvidence = false
      try { hasEvidence = (JSON.parse(task.evidence_paths || '[]') as unknown[]).length > 0 } catch { /* malformed legacy data is missing evidence */ }
      const evidence = hasEvidence ? '有证据路径' : '缺验收证据'
      return `- [${task.status === 'done' ? 'x' : ' '}] ${task.title}（${task.status}；${criteria}；${evidence}）`
    }), ...(tasks.length ? [] : ['- [ ] 尚未建立项目任务']), '', '## 未满足条件', '', ...(missing.length ? missing.map((line) => `- ${line}`) : ['- 任务状态、验收标准与证据路径检查通过；仍需负责人确认公司要求的其他结项材料。']), '', '## 建议归档材料', '', '- 立项审批与范围变更记录', '- 最终交付文件及用户验收记录', '- 风险处理与遗留事项说明', '- 项目复盘与后续行动')
  }
  return { kind, filename: `${kind}-${stamp}.md`, content: `${base.join('\n')}\n`, missing }
}

function taskLines(tasks: TaskRow[]): string[] {
  return tasks.length ? tasks.map((task) => `- ${task.title}（${task.status}${task.due_at ? `；截止 ${new Date(task.due_at).toLocaleDateString('zh-CN')}` : ''}；编号 JEF-${task.number}）`) : ['- 无任务记录']
}
function activityLines(activities: TaskActivityRow[]): string[] {
  if (!activities.length) return ['- 本周期没有任务活动记录']
  return activities.map((item) => {
    const status = item.kind === 'created' ? `新建（${item.to_status}）` : item.kind === 'deleted' ? `删除（删除前状态：${item.from_status}）` : `${item.from_status} → ${item.to_status}`
    return `- ${new Date(item.at).toLocaleString('zh-CN')} · JEF-${item.task_number} ${item.title}：${status}`
  })
}
function kindLabel(kind: ProjectDocumentKind): string { return kind === 'charter' ? '立项文档' : kind === 'weekly_report' ? '项目周报' : '结项核查' }

export function currentWeekRange(at = Date.now()): ProjectWeekRange {
  const today = dateString(at)
  const day = new Date(`${today}T00:00:00.000Z`).getUTCDay()
  const mondayOffset = (day + 6) % 7
  const monday = addDays(today, -mondayOffset)
  return { startDate: monday, endDate: addDays(monday, 6) }
}

function dateStart(date: string): number { return Date.parse(`${date}T00:00:00+08:00`) }
function dateString(at: number): string { return new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) }
function addDays(date: string, count: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + count)
  return value.toISOString().slice(0, 10)
}
function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
