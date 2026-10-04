import { describe, expect, it } from 'vitest'
import { buildProjectDocument } from '../src/project/documents.js'
import type { ProjectRow, TaskRow } from '../src/db/repos.js'

const project = { id: 'prj_e2e', title: '病房呼叫改造', description: '', status: 'in_progress', workspace_state: JSON.stringify({ goal: '完成联调', systemOutline: ['接口联调'] }) } as ProjectRow
const task = (patch: Partial<TaskRow>): TaskRow => ({ id: 'task_1', project_id: project.id, number: 1, title: '接口联调', description: '', status: 'todo', priority: 'medium', assignee_type: 'none', assignee_id: '', parent_task_id: null, due_at: null, depends_on: '[]', acceptance_criteria: '', evidence_paths: '[]', position: 0, created_at: 1, updated_at: 1, deleted_at: null, ...patch })

describe('project documents', () => {
  it('立项文档引用已保存的目标与项目任务，缺少背景时明确标记', () => {
    const output = buildProjectDocument(project, [task({})], 'charter', Date.UTC(2026, 9, 5))
    expect(output.filename).toBe('charter-20261005.md')
    expect(output.content).toContain('完成联调')
    expect(output.content).toContain('JEF-1')
    expect(output.missing).toContain('项目背景/简介未填写')
  })

  it('周报区分当前快照，结项清单不会把未完成或缺证据任务算通过', () => {
    const output = buildProjectDocument(project, [task({ acceptance_criteria: '设备呼叫成功' })], 'weekly_report', Date.UTC(2026, 9, 5))
    expect(output.content).toContain('当前任务快照')
    expect(output.content).toContain('不声称任务在本周内完成')
    const closeout = buildProjectDocument(project, [task({ status: 'done', acceptance_criteria: '设备呼叫成功' })], 'closeout', Date.UTC(2026, 9, 5))
    expect(closeout.missing).toContain('1 项已完成任务缺少验收证据')
    expect(closeout.content).toContain('[x] 接口联调')
  })
})
