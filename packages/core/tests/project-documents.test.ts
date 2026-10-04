import { describe, expect, it } from 'vitest'
import { buildProjectDocument, currentWeekRange } from '../src/project/documents.js'
import type { ProjectRow, TaskActivityRow, TaskRow } from '../src/db/repos.js'

const project = { id: 'prj_e2e', title: '病房呼叫改造', description: '', status: 'in_progress', workspace_state: JSON.stringify({ goal: '完成联调', systemOutline: ['接口联调'] }) } as ProjectRow
const task = (patch: Partial<TaskRow>): TaskRow => ({ id: 'task_1', project_id: project.id, number: 1, title: '接口联调', description: '', status: 'todo', priority: 'medium', assignee_type: 'none', assignee_id: '', parent_task_id: null, due_at: null, depends_on: '[]', acceptance_criteria: '', evidence_paths: '[]', position: 0, created_at: 1, updated_at: 1, deleted_at: null, ...patch })

describe('project documents', () => {
  it('默认周区间按中国日期从周一到周日', () => {
    expect(currentWeekRange(Date.parse('2026-10-07T12:00:00+08:00'))).toEqual({ startDate: '2026-10-05', endDate: '2026-10-11' })
  })

  it('立项文档引用已保存的目标与项目任务，缺少背景时明确标记', () => {
    const output = buildProjectDocument(project, [task({})], 'charter', Date.UTC(2026, 9, 5))
    expect(output.filename).toBe('charter-20261005.md')
    expect(output.content).toContain('完成联调')
    expect(output.content).toContain('JEF-1')
    expect(output.missing).toContain('项目背景/简介未填写')
  })

  it('周报按选定日期列真实活动并单独标明当前风险快照，结项清单不会把缺证据任务算通过', () => {
    const activities: TaskActivityRow[] = [
      { id: 'activity_1', project_id: project.id, task_id: 'task_1', task_number: 1, title: '接口联调', kind: 'status_changed', from_status: 'in_progress', to_status: 'done', at: Date.parse('2026-10-05T12:00:00+08:00') },
      { id: 'activity_2', project_id: project.id, task_id: 'task_1', task_number: 1, title: '接口联调', kind: 'status_changed', from_status: 'done', to_status: 'in_progress', at: Date.parse('2026-10-08T12:00:00+08:00') },
    ]
    const range = { startDate: '2026-10-01', endDate: '2026-10-07' }
    const output = buildProjectDocument(project, [task({ acceptance_criteria: '设备呼叫成功' })], 'weekly_report', Date.UTC(2026, 9, 5), activities, range)
    expect(output.filename).toBe('weekly_report-20261001-20261007-20261005.md')
    expect(output.content).toContain('2026-10-01 至 2026-10-07')
    expect(output.content).toContain('in_progress → done')
    expect(output.content).not.toContain('done → in_progress')
    expect(output.content).toContain('当前任务快照')
    expect(output.content).toContain('不代表周期末状态')
    expect(() => buildProjectDocument(project, [], 'weekly_report', Date.UTC(2026, 9, 5), [], { startDate: '2026-02-30', endDate: '2026-10-07' })).toThrow('有效的周报日期范围')
    const closeout = buildProjectDocument(project, [task({ status: 'done', acceptance_criteria: '设备呼叫成功' })], 'closeout', Date.UTC(2026, 9, 5))
    expect(closeout.missing).toContain('1 项已完成任务缺少验收证据')
    expect(closeout.content).toContain('[x] 接口联调')
  })
})
