import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { agentRepo, projectAgentRepo, projectRepo, taskActivityRepo, taskRepo, taskRunRepo } from '../src/db/repos.js'
import { buildPaths } from '../src/paths.js'
import { GroupThreadStore } from '../src/orchestrator/groupThreads.js'
import { TaskService, type TaskSessionIdentity } from '../src/tasks/service.js'
import type { GroupChat } from '../src/orchestrator/group.js'
import type { DB } from '../src/db/db.js'

let tmp: string
let db: DB
let workspace: string
let projectId: string
let leaderId: string
let workerId: string
let threads: GroupThreadStore
let sent: Array<Record<string, any>>
let finishSend: (result: { routedTo: string }) => void
let identity: TaskSessionIdentity | null
let service: TaskService

async function waitForRun(runId: string, status: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (taskRunRepo(db).get(runId)?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`任务运行未进入 ${status}：${taskRunRepo(db).get(runId)?.status}`)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-task-service-'))
  workspace = path.join(tmp, 'workspace')
  fs.mkdirSync(workspace)
  db = openDb(buildPaths(tmp))
  const agents = agentRepo(db)
  leaderId = agents.create({ name: '本群群主' }).id
  workerId = agents.create({ name: '指定负责人' }).id
  const project = projectRepo(db).create({ title: '通用任务项目', leader_agent_id: leaderId, workspace_dir: workspace })
  projectId = project.id
  projectAgentRepo(db).add(projectId, leaderId, 'leader')
  projectAgentRepo(db).add(projectId, workerId, 'worker')
  threads = new GroupThreadStore(db)
  sent = []
  identity = null
  let resolve!: (result: { routedTo: string }) => void
  const group = {
    threads,
    send: (input: Record<string, any>) => {
      sent.push(input)
      return new Promise<{ routedTo: string }>((done) => { resolve = done })
    },
    abortTask: vi.fn(async () => true),
  } as unknown as GroupChat
  finishSend = (result) => resolve(result)
  service = new TaskService(db, group, threads, workspace, {
    resolveSession: () => identity,
    onChanged: () => {},
  })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('TaskService', () => {
  it('显式负责人优先，未指定时路由到群主；任务话题不抢当前讨论', async () => {
    const discussion = threads.createThread(projectId, '用户当前讨论')
    const assigned = taskRepo(db).create({ project_id: projectId, title: '负责人任务', goal: '交付可复核结果', assignee_type: 'agent', assignee_id: workerId })
    const assignedRun = service.start(assigned.id)
    expect(sent[0]).toMatchObject({ projectId, threadId: assignedRun.thread_id, taskRunId: assignedRun.id, targetAgentId: workerId, taskSnapshot: { key: 'JEF-1', goal: '交付可复核结果' } })
    expect(threads.getActiveThreadId(projectId)).toBe(discussion.id)
    expect(threads.getMeta(projectId, assignedRun.thread_id)).toMatchObject({ kind: 'task', taskId: assigned.id })
    finishSend({ routedTo: workerId })
    await waitForRun(assignedRun.id, 'needs_input')

    const coordinated = taskRepo(db).create({ project_id: projectId, title: '群主协调任务' })
    const coordinatedRun = service.start(coordinated.id)
    expect(sent[1]).toMatchObject({ targetAgentId: leaderId, taskSnapshot: { key: 'JEF-2' } })
    finishSend({ routedTo: leaderId })
    await waitForRun(coordinatedRun.id, 'needs_input')
  })

  it('提交绑定到真实负责人和本轮任务快照，只有完成本轮后才能人工验收', async () => {
    const task = taskRepo(db).create({
      project_id: projectId,
      title: '核对接口结果',
      goal: '提供可复核的接口结论',
      description: '请求测试环境并记录响应。',
      acceptance_criteria: '结果包含请求和响应摘要。',
      assignee_type: 'agent',
      assignee_id: workerId,
    })
    const run = service.start(task.id)
    taskRunRepo(db).update(run.id, { status: 'running' })
    identity = { kind: 'group', projectId, threadId: run.thread_id, agentId: leaderId }
    expect(() => service.submitFromSession('leader-session', '已完成', [])).toThrow('只有本轮指定负责人')

    identity = { kind: 'group', projectId, threadId: run.thread_id, agentId: workerId }
    const submission = service.submitFromSession('worker-session', '已读取响应并确认接口返回 200。', [])
    expect(taskRepo(db).get(task.id)).toMatchObject({ status: 'in_review', submission_id: submission.submissionId, goal: '提供可复核的接口结论' })
    expect(() => service.review(task.id, { action: 'approve', submissionId: submission.submissionId, specHash: taskRepo(db).get(task.id)!.submitted_spec_hash })).toThrow('仍在运行')

    finishSend({ routedTo: workerId })
    await waitForRun(run.id, 'succeeded')
    const reviewed = service.review(task.id, { action: 'approve', submissionId: submission.submissionId, specHash: taskRepo(db).get(task.id)!.submitted_spec_hash })
    expect(reviewed).toMatchObject({ status: 'done', reviewed_submission_id: submission.submissionId })
    expect(taskActivityRepo(db).listByProject(projectId).map((item) => [item.kind, item.from_status, item.to_status])).toEqual([
      ['created', '', 'todo'],
      ['status_changed', 'todo', 'in_progress'],
      ['status_changed', 'in_progress', 'in_review'],
      ['submitted', 'in_progress', 'in_review'],
      ['status_changed', 'in_review', 'done'],
      ['review_approved', 'in_review', 'done'],
    ])
  })

  it('启动时重新检查前置任务，证据路径必须是工作区内存在的文件', async () => {
    const prerequisite = taskRepo(db).create({ project_id: projectId, title: '前置任务' })
    const task = taskRepo(db).create({ project_id: projectId, title: '后续任务', depends_on: [prerequisite.id] })
    expect(() => service.start(task.id)).toThrow('前置任务尚未完成')
    taskRepo(db).update(prerequisite.id, { status: 'done' })
    const run = service.start(task.id)
    taskRunRepo(db).update(run.id, { status: 'running' })
    identity = { kind: 'group', projectId, threadId: run.thread_id, agentId: leaderId }
    expect(() => service.submitFromSession('group-session', '结果已完成', ['missing.md'])).toThrow()
    fs.writeFileSync(path.join(workspace, 'result.md'), '# 结果')
    const outside = path.join(tmp, 'outside.md')
    fs.writeFileSync(outside, 'outside')
    fs.symlinkSync(outside, path.join(workspace, 'outside.md'))
    expect(() => service.submitFromSession('group-session', '结果已完成', ['outside.md'])).toThrow('超出项目工作区')
    const submitted = service.submitFromSession('group-session', '结果已完成', ['result.md'])
    expect(taskRepo(db).get(task.id)).toMatchObject({ status: 'in_review', evidence_paths: '["result.md"]' })
    finishSend({ routedTo: leaderId })
    await waitForRun(run.id, 'succeeded')
    expect(taskRunRepo(db).get(run.id)?.submission_id).toBe(submitted.submissionId)
  })
})
