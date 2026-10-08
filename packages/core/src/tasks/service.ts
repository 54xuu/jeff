import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db/db.js'
import {
  agentRepo, projectAgentRepo, projectRepo, taskActivityRepo, taskRepo, taskRunRepo,
  taskSpecHash, type TaskRow, type TaskRunRow,
} from '../db/repos.js'
import type { GroupChat, GroupTaskSnapshot } from '../orchestrator/group.js'
import type { GroupThreadStore } from '../orchestrator/groupThreads.js'
import { genId } from '../util/id.js'
import { BrowserHandoffPausedError } from '../browser/handoff.js'

export interface TaskSessionIdentity {
  kind: 'private' | 'group' | 'review' | 'subtask'
  projectId?: string
  threadId?: string
  agentId?: string
}

export interface TaskServiceHooks {
  resolveSession: (sessionId: string) => TaskSessionIdentity | null
  onChanged: (projectId: string, taskId: string) => void
}

export type TaskRunInfo = import('../ipc/contract.js').TaskRunInfo

function toRunInfo(run: TaskRunRow): TaskRunInfo {
  return {
    id: run.id, task_id: run.task_id, project_id: run.project_id, thread_id: run.thread_id,
    agent_id: run.agent_id, status: run.status, started_at: run.started_at,
    finished_at: run.finished_at, error: run.error, submission_id: run.submission_id,
  }
}

export class TaskService {
  constructor(
    private db: DB,
    private group: GroupChat,
    private threads: GroupThreadStore,
    private workspaceDir: string,
    private hooks: TaskServiceHooks,
  ) {
    taskRunRepo(db).markOrphanedInterrupted()
  }

  active(runId: string): boolean {
    return taskRunRepo(this.db).get(runId)?.status === 'queued'
  }

  hasActiveTask(taskId: string): boolean {
    return !!taskRunRepo(this.db).getActive(taskId)
  }

  activeForTask(taskId: string): TaskRunInfo | null {
    const run = taskRunRepo(this.db).getActive(taskId)
    return run ? toRunInfo(run) : null
  }

  markRunning(runId: string): void {
    const runs = taskRunRepo(this.db)
    const run = runs.get(runId)
    if (!run || run.status !== 'queued') return
    runs.update(runId, { status: 'running' })
    this.hooks.onChanged(run.project_id, run.task_id)
  }

  start(taskId: string): TaskRunInfo {
    const tasks = taskRepo(this.db)
    const runs = taskRunRepo(this.db)
    const current = tasks.get(taskId)
    if (!current || current.deleted_at) throw new Error('任务不存在或已删除')
    const active = runs.getActive(taskId)
    if (active) return toRunInfo(active)
    if (current.status === 'done' || current.status === 'cancelled') throw new Error('此任务当前不能开始执行')
    if (current.status === 'in_review') throw new Error('任务正在等待验收，请先通过或退回')
    if (this.dependencies(current).length) throw new Error('前置任务尚未完成，暂时不能开始')

    const project = projectRepo(this.db).get(current.project_id)
    if (!project || project.deleted_at) throw new Error('项目不存在或已解散')
    const agentId = current.assignee_type === 'agent' && current.assignee_id
      ? current.assignee_id
      : project.leader_agent_id || ''
    if (!agentId) throw new Error('请先为任务选择负责人或为项目群设置群主')
    const agent = agentRepo(this.db).get(agentId)
    if (!agent || agent.deleted_at || !projectAgentRepo(this.db).getRole(current.project_id, agentId)) {
      throw new Error('任务负责人已不存在或不属于当前群，请更新负责人后重试')
    }

    const hash = taskSpecHash(current)
    const snapshot = this.snapshot(current)
    const runId = genId('taskrun')
    const threadMeta = this.threads.listThreads(current.project_id).find((item) => item.kind === 'task' && item.taskId === taskId)
      || this.threads.createThread(current.project_id, `${`JEF-${current.number}`} · ${current.title}`, { activate: false, kind: 'task', taskId })

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const latest = tasks.get(taskId)
      if (!latest || latest.deleted_at || taskSpecHash(latest) !== hash || latest.status !== current.status) {
        throw new Error('任务在启动前已发生变化，请刷新后重试')
      }
      const racing = runs.getActive(taskId)
      if (racing) {
        this.db.exec('ROLLBACK')
        return toRunInfo(racing)
      }
      if (latest.status === 'todo') tasks.update(taskId, { status: 'in_progress' })
      runs.create({
        id: runId, task_id: taskId, project_id: current.project_id, thread_id: threadMeta.id,
        agent_id: agentId, status: 'queued', spec_hash: hash, task_snapshot: JSON.stringify(snapshot), started_at: Date.now(),
      })
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* transaction already closed */ }
      const racing = runs.getActive(taskId)
      if (racing) return toRunInfo(racing)
      throw error
    }

    this.hooks.onChanged(current.project_id, taskId)
    void this.execute(runId)
    return toRunInfo(runs.get(runId)!)
  }

  private async execute(runId: string, continuation?: string): Promise<void> {
    const runs = taskRunRepo(this.db)
    const run = runs.get(runId)
    if (!run || (run.status !== 'queued' && !(continuation && run.status === 'running'))) return
    const task = taskRepo(this.db).get(run.task_id)
    try {
      if (!task || task.deleted_at || taskSpecHash(task) !== run.spec_hash) throw new Error('任务要求已变化，请重新开始以创建新的执行快照')
      const project = projectRepo(this.db).get(run.project_id)
      if (!project || project.deleted_at) throw new Error('项目不存在或已解散')
      const target = agentRepo(this.db).get(run.agent_id)
      if (!target || target.deleted_at || !projectAgentRepo(this.db).getRole(run.project_id, run.agent_id)) throw new Error('任务负责人已不存在或不属于当前群')
      const snapshot = JSON.parse(run.task_snapshot) as GroupTaskSnapshot
      const result = await this.group.send({
        projectId: run.project_id,
        threadId: run.thread_id,
        taskRunId: runId,
        targetAgentId: run.agent_id,
        taskSnapshot: snapshot,
        text: continuation || `请开始执行项目任务 ${snapshot.key}「${snapshot.title}」。完成后提交实际结果和可核验的产物位置。`,
      })
      const latest = runs.get(runId)
      if (!latest || latest.status === 'cancelled') return
      if (result.stopped) {
        runs.update(runId, { status: 'cancelled', finished_at: Date.now(), error: '用户停止了任务执行' })
        this.hooks.onChanged(run.project_id, run.task_id)
        return
      }
      const latestTask = taskRepo(this.db).get(run.task_id)
      if (latestTask?.submission_id && latestTask.submitted_spec_hash === run.spec_hash) {
        runs.update(runId, { status: 'succeeded', finished_at: Date.now(), submission_id: latestTask.submission_id })
      } else {
        const error = result.summaryFailed
          ? `协作总结失败：${result.summaryError || '未知错误'}`
          : '本轮回复结束，但智能体尚未正式提交验收结果。可查看话题后继续执行。'
        runs.update(runId, { status: 'needs_input', finished_at: Date.now(), error })
      }
      this.hooks.onChanged(run.project_id, run.task_id)
    } catch (error) {
      const latest = runs.get(runId)
      if (!latest || latest.status === 'cancelled') return
      if (error instanceof BrowserHandoffPausedError) {
        runs.update(runId, { status: 'waiting_browser', finished_at: null, error: '等待用户完成浏览器验证' })
        this.hooks.onChanged(run.project_id, run.task_id)
        return
      }
      const message = String((error as Error)?.message || error).slice(0, 500)
      runs.update(runId, { status: 'failed', finished_at: Date.now(), error: message })
      this.hooks.onChanged(run.project_id, run.task_id)
    }
  }

  /** Resume the same project-task run after the user returns browser control. */
  async resumeBrowserHandoff(runId: string, continuation: string): Promise<void> {
    const runs = taskRunRepo(this.db)
    const run = runs.get(runId)
    if (!run || run.status !== 'waiting_browser') throw new Error('项目任务当前没有等待浏览器验证的运行。')
    runs.update(runId, { status: 'running', finished_at: null, error: '' })
    this.hooks.onChanged(run.project_id, run.task_id)
    await this.execute(runId, continuation)
    const latest = runs.get(runId)
    if (latest?.status === 'waiting_browser') throw new BrowserHandoffPausedError('')
    if (latest?.status === 'failed') throw new Error(latest.error || '项目任务续接失败')
  }

  cancelBrowserHandoff(runId: string): void {
    const run = taskRunRepo(this.db).get(runId)
    if (!run || (run.status !== 'waiting_browser' && run.status !== 'running')) return
    taskRunRepo(this.db).update(runId, { status: 'cancelled', finished_at: Date.now(), error: '用户取消了浏览器接管任务' })
    this.hooks.onChanged(run.project_id, run.task_id)
  }

  stop(taskId: string, runId: string): TaskRunInfo {
    const run = taskRunRepo(this.db).get(runId)
    if (!run || run.task_id !== taskId) throw new Error('任务运行记录不存在')
    if (run.status === 'waiting_browser') {
      const cancelled = taskRunRepo(this.db).update(runId, { status: 'cancelled', finished_at: Date.now(), error: '用户停止了等待浏览器的任务' })
      this.hooks.onChanged(run.project_id, run.task_id)
      return toRunInfo(cancelled)
    }
    if (run.status !== 'queued' && run.status !== 'running') throw new Error('任务当前没有可停止的运行')
    if (run.status === 'queued') {
      const cancelled = taskRunRepo(this.db).update(runId, { status: 'cancelled', finished_at: Date.now(), error: '用户停止了排队任务' })
      this.hooks.onChanged(run.project_id, run.task_id)
      return toRunInfo(cancelled)
    }
    void this.group.abortTask(run.project_id, runId)
    return toRunInfo(run)
  }

  list(taskId: string): TaskRunInfo[] {
    return taskRunRepo(this.db).list(taskId).map(toRunInfo)
  }

  snapshotForThread(projectId: string, threadId: string): GroupTaskSnapshot | undefined {
    const meta = this.threads.getMeta(projectId, threadId)
    if (meta?.kind === 'task' && meta.taskId) {
      const task = taskRepo(this.db).get(meta.taskId)
      if (task && !task.deleted_at) return this.snapshot(task)
    }
    const run = this.db.prepare("SELECT * FROM task_run WHERE project_id=? AND thread_id=? AND status IN ('queued', 'running', 'waiting_browser') ORDER BY started_at DESC LIMIT 1")
      .get(projectId, threadId) as unknown as TaskRunRow | undefined
    return run ? JSON.parse(run.task_snapshot) as GroupTaskSnapshot : undefined
  }

  activeRunForThread(projectId: string, threadId: string): TaskRunRow | null {
    return (this.db.prepare("SELECT * FROM task_run WHERE project_id=? AND thread_id=? AND status IN ('queued', 'running', 'waiting_browser') ORDER BY started_at DESC LIMIT 1")
      .get(projectId, threadId) as unknown as TaskRunRow | undefined) || null
  }

  submitFromSession(sessionId: string, resultSummary: string, evidencePaths: string[]): { taskId: string; submissionId: string } {
    const identity = this.hooks.resolveSession(sessionId)
    if (!identity || identity.kind !== 'group' || !identity.projectId || !identity.threadId || !identity.agentId) {
      throw new Error('只能从项目群成员的实际会话提交任务结果')
    }
    const run = this.db.prepare("SELECT * FROM task_run WHERE project_id=? AND thread_id=? AND status='running' ORDER BY started_at DESC LIMIT 1")
      .get(identity.projectId, identity.threadId) as unknown as TaskRunRow | undefined
    if (!run) throw new Error('当前会话没有正在执行的项目任务')
    if (!projectAgentRepo(this.db).getRole(run.project_id, identity.agentId)) throw new Error('提交者不属于当前项目群')
    if (identity.agentId !== run.agent_id) throw new Error('只有本轮指定负责人可以提交验收结果')
    const task = taskRepo(this.db).get(run.task_id)
    if (!task || task.deleted_at) throw new Error('任务不存在或已删除')
    if (taskSpecHash(task) !== run.spec_hash) throw new Error('任务要求已变化，请重新执行后提交')
    const paths = this.validateEvidence(run.project_id, evidencePaths)
    const submissionId = genId('submission')
    const next = taskRepo(this.db).submit(run.task_id, { submissionId, resultSummary, specHash: run.spec_hash, evidencePaths: paths })
    const activity = taskActivityRepo(this.db).listByProject(run.project_id).find((item) => {
      if (item.task_id !== run.task_id || item.kind !== 'submitted') return false
      try { return (JSON.parse(item.details || '{}') as { submissionId?: string }).submissionId === submissionId } catch { return false }
    })
    if (activity) {
      const detail = JSON.parse(activity.details || '{}') as Record<string, unknown>
      detail.submittedByAgentId = identity.agentId
      this.db.prepare('UPDATE task_activity SET details=? WHERE id=?').run(JSON.stringify(detail), activity.id)
    }
    taskRunRepo(this.db).update(run.id, { submission_id: submissionId })
    this.hooks.onChanged(run.project_id, run.task_id)
    return { taskId: next.id, submissionId }
  }

  review(taskId: string, input: { action: 'approve' | 'return' | 'reopen'; submissionId?: string; specHash?: string; feedback?: string }): TaskRow {
    if (taskRunRepo(this.db).getActive(taskId)) throw new Error('任务仍在运行，请先停止或等待该轮结束')
    if (input.action !== 'reopen') {
      const task = taskRepo(this.db).get(taskId)
      if (!task) throw new Error('任务不存在')
      if (!input.submissionId || !input.specHash) throw new Error('验收请求缺少提交版本')
    }
    const next = taskRepo(this.db).review(taskId, {
      action: input.action,
      submissionId: input.submissionId || '',
      specHash: input.specHash || '',
      feedback: input.feedback,
    })
    this.hooks.onChanged(next.project_id, taskId)
    return next
  }

  private dependencies(task: TaskRow): string[] {
    let ids: string[] = []
    try { ids = JSON.parse(task.depends_on || '[]') as string[] } catch { /* validate on save */ }
    return ids.filter((id) => taskRepo(this.db).get(id)?.status !== 'done')
  }

  private snapshot(task: TaskRow): GroupTaskSnapshot {
    return {
      id: task.id, key: `JEF-${task.number}`, title: task.title,
      goal: task.goal || '', description: task.description || '',
      acceptanceCriteria: task.acceptance_criteria || '', reviewFeedback: task.review_feedback || '',
      resultSummary: task.result_summary || '',
    }
  }

  private validateEvidence(projectId: string, evidencePaths: string[]): string[] {
    if (!Array.isArray(evidencePaths)) throw new Error('evidence_paths 必须为路径数组')
    if (evidencePaths.length === 0) return []
    const project = projectRepo(this.db).get(projectId)
    if (!project) throw new Error('项目不存在')
    const workspace = path.resolve(project.workspace_dir || this.workspaceDir)
    const workspaceReal = fs.realpathSync(workspace)
    const output: string[] = []
    for (const raw of evidencePaths) {
      const relative = String(raw).trim()
      if (!relative || path.isAbsolute(relative)) throw new Error('验收证据必须是工作区内的相对路径')
      const candidate = path.resolve(workspaceReal, relative)
      const real = fs.realpathSync(candidate)
      if (real !== workspaceReal && !real.startsWith(`${workspaceReal}${path.sep}`)) throw new Error(`证据路径超出项目工作区：${relative}`)
      if (!fs.statSync(real).isFile()) throw new Error(`验收证据不是文件：${relative}`)
      output.push(relative)
    }
    return [...new Set(output)]
  }
}
