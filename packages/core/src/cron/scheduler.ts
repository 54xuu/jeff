import type { DB } from '../db/db.js'
import { agentRepo, cronRunRepo, cronTaskRepo, projectRepo, type CronTaskRow } from '../db/repos.js'
import { nextRunAt } from './expr.js'

/** 调度器依赖：触发动作由 JeffCore 注入（保持调度逻辑与聊天链路解耦，便于单测） */
export interface CronSchedulerDeps {
  db: DB
  /** 真正执行一次任务（私聊发给 agent / 群聊投递到项目群）；抛错=本次运行失败 */
  runTask: (task: CronTaskRow, isCatchup: boolean) => Promise<{ threadId?: string; sessionId?: string } | void>
  /** 任务/运行状态变化后的通知（前端刷新用） */
  onChanged?: () => void
  /**
   * 任务真正跑完（产出了一条新消息）后的回调。
   * 失败、跳过、目标缺失都不调——只在成功产出回复时才让 UI 响铃 / 弹桌面通知。
   */
  onTurnDone?: (task: CronTaskRow, ctx?: { threadId?: string; sessionId?: string }) => void
  log?: (tag: string, detail?: unknown) => void
}

/** tick 间隔：40s（cron 只到分钟粒度，留出充裕余量即可，不必每秒空转） */
const TICK_MS = 40_000

/**
 * 定时任务调度器。
 *
 * 设计要点（都对应真实约束，改动前请先读）：
 *  - 触发动作是**阻塞式**的（私聊一轮最长 600s、群聊流水线最长 30min），因此 tick 只负责
 *    「入队 + 立刻推进 next_run_at」，绝不 await 执行；否则一次群任务会把整个调度器卡死。
 *  - 全局并发上限（默认 2）：同一时刻多个任务到点（如 8 点整排了 5 个）时排队跑，
 *    避免同时开多条群流水线把 token 和 sidecar 打满。
 *  - 同一任务上一轮还在跑/排队时又到点 → 跳过本次并记 skipped，防堆叠。
 *  - 错过策略按任务取：catchup 在启动时补跑一次，skip 直接顺延（记 missed）。
 *  - 失败不自动重试：只记 failed + 原因，由用户在界面手动「立即执行」。
 */
export class CronScheduler {
  private timer: NodeJS.Timeout | null = null
  private readonly tasks
  private readonly runs
  /** 在途（排队 + 执行中）任务 id */
  private readonly inFlight = new Set<string>()
  private queue: Array<{ task: CronTaskRow; isCatchup: boolean; runId: string }> = []
  private running = 0
  maxConcurrent = 2

  constructor(private deps: CronSchedulerDeps) {
    this.tasks = cronTaskRepo(deps.db)
    this.runs = cronRunRepo(deps.db)
  }

  /** 启动：先处理错过，再进入周期 tick */
  start(): void {
    if (this.timer) return
    try {
      this.recoverOnStart()
    } catch (err) {
      this.deps.log?.('cron-start-error', String((err as Error)?.message || err))
    }
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 启动时对齐：next_run_at 缺失则算出来；已过期按 miss_policy 处理（补跑 or 顺延）。
   * 补跑只针对「最后一次错过」，不做多次补齐——用户要的是当天那次提醒，不是补历史欠账。
   */
  private recoverOnStart(): void {
    const now = Date.now()
    // 上次进程被关闭/强杀时会留下 running 记录（回合被打断）：先收尾成失败，否则界面永远显示「执行中」
    const stale = this.runs.failStale()
    if (stale > 0) this.deps.log?.('cron-stale-runs', { count: stale })
    for (const task of this.tasks.listEnabled()) {
      if (task.run_at != null) {
        this.alignOnce(task, now)
        continue
      }
      let next = task.next_run_at
      if (!next) {
        this.tasks.markRun(task.id, task.last_run_at ?? 0, this.computeNext(task, now))
        continue
      }
      if (next > now) continue
      if (task.miss_policy === 'catchup') {
        this.deps.log?.('cron-catchup', { id: task.id, name: task.name, missedAt: next })
        this.enqueue(task, true)
      } else {
        this.runs.log(task.id, 'missed', `错过的触发时间：${new Date(next).toLocaleString()}`)
      }
      this.tasks.setNextRun(task.id, this.computeNext(task, now))
    }
    this.deps.onChanged?.()
  }

  /** 周期检查：到点即入队，并立刻把 next_run_at 推到下一次 */
  tick(): void {
    const now = Date.now()
    let changed = false
    for (const task of this.tasks.listEnabled()) {
      if (task.run_at != null) {
        const at = task.next_run_at ?? task.run_at
        if (at > now) continue
        if (this.inFlight.has(task.id)) this.runs.log(task.id, 'skipped', '上一轮尚未结束，跳过本次')
        else this.enqueue(task, false)
        // 跑完即停：不要按 cron 滚到明年同一天
        this.tasks.finishOnce(task.id)
        changed = true
        continue
      }
      const next = task.next_run_at ?? this.computeNext(task, now)
      if (next === null) continue
      if (next > now) continue
      // 上一轮还没跑完：跳过本次（next_run_at 继续前推，不堆积）
      if (this.inFlight.has(task.id)) this.runs.log(task.id, 'skipped', '上一轮尚未结束，跳过本次')
      else this.enqueue(task, false)
      this.tasks.setNextRun(task.id, this.computeNext(task, now))
      changed = true
    }
    if (changed) this.deps.onChanged?.()
    this.pump()
  }

  /** 手动「立即执行一次」（不受 enabled 限制；返回 runId 便于前端跟踪） */
  runNow(taskId: string): { runId: string } {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('定时任务不存在')
    if (this.inFlight.has(taskId)) throw new Error('该任务正在执行中，请稍候')
    return this.enqueue(task, false)
  }

  private enqueue(task: CronTaskRow, isCatchup: boolean): { runId: string } {
    const run = this.runs.start(task.id, isCatchup)
    this.inFlight.add(task.id)
    this.queue.push({ task: { ...task }, isCatchup, runId: run.id })
    this.deps.log?.('cron-enqueue', { id: task.id, name: task.name, isCatchup })
    this.deps.onChanged?.()
    this.pump()
    return { runId: run.id }
  }

  /** 队列泵：在并发额度内取任务执行（不阻塞调用方） */
  private pump(): void {
    while (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const item = this.queue.shift()!
      this.running += 1
      void this.execute(item)
        .catch(() => {
          /* execute 内部已兜底记录 */
        })
        .finally(() => {
          this.running -= 1
          this.pump()
        })
    }
  }

  private async execute(item: { task: CronTaskRow; isCatchup: boolean; runId: string }): Promise<void> {
    const { task, isCatchup, runId } = item
    try {
      // 目标失效（智能体/项目群被删）→ 停用任务并把原因写进运行记录，避免每次到点都空跑失败
      const missing = this.targetMissingReason(task)
      if (missing) {
        this.tasks.update(task.id, { enabled: 0 })
        this.runs.finish(runId, 'failed', missing)
        this.deps.log?.('cron-target-missing', { id: task.id, name: task.name, reason: missing })
        return
      }
      const startedAt = Date.now()
      const result = await this.deps.runTask(task, isCatchup)
      this.runs.finish(runId, 'ok')
      this.deps.log?.('cron-run-ok', { id: task.id, name: task.name, elapsedMs: Date.now() - startedAt, isCatchup })
      try {
        this.deps.onTurnDone?.(task, result || undefined)
      } catch (err) {
        this.deps.log?.('cron-turn-done-error', String((err as Error)?.message || err))
      }
    } catch (err) {
      const message = String((err as Error)?.message || err)
      this.runs.finish(runId, 'failed', message)
      this.deps.log?.('cron-run-failed', { id: task.id, name: task.name, error: message, isCatchup })
    } finally {
      this.inFlight.delete(task.id)
      try {
        this.tasks.setLastRun(task.id, Date.now())
        this.runs.prune(50)
      } catch {
        /* 清理失败不影响调度 */
      }
      this.deps.onChanged?.()
    }
  }

  private targetMissingReason(task: CronTaskRow): string | null {
    if (task.target_type === 'agent') {
      const a = agentRepo(this.deps.db).get(task.target_id)
      if (!a || a.deleted_at != null) return '目标智能体已被删除，任务已自动停用'
      return null
    }
    const p = projectRepo(this.deps.db).get(task.target_id)
    if (!p || p.deleted_at != null) return '目标项目群已被解散，任务已自动停用'
    if (!p.leader_agent_id) return '目标项目群未设置群主，无法触发'
    return null
  }

  /**
   * 一次性任务：未来的时刻只对齐 next_run_at；已经到点则补跑或记错过，然后停用。
   * 不调用 nextRunAt——固定月日 cron 过点后会滚到下一年。
   */
  private alignOnce(task: CronTaskRow, now: number): void {
    const at = task.next_run_at ?? task.run_at ?? now
    if (at > now) {
      if (task.next_run_at !== task.run_at) this.tasks.setNextRun(task.id, task.run_at)
      return
    }
    if (this.inFlight.has(task.id)) return
    if (task.miss_policy === 'catchup') {
      this.deps.log?.('cron-catchup', { id: task.id, name: task.name, missedAt: at, once: true })
      this.enqueue(task, true)
    } else {
      this.runs.log(task.id, 'missed', `错过的一次性触发：${new Date(at).toLocaleString()}`)
    }
    this.tasks.finishOnce(task.id)
  }

  private computeNext(task: CronTaskRow, from: number): number | null {
    try {
      return nextRunAt(task.cron_expr, from)
    } catch (err) {
      this.deps.log?.('cron-expr-error', { id: task.id, expr: task.cron_expr, error: String((err as Error)?.message || err) })
      return null
    }
  }
}
