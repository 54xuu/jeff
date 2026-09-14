import type { DB } from '../db/db.js'
import { agentRepo, cronRunRepo, cronTaskRepo, projectRepo } from '../db/repos.js'
import { describeCron, isValidCron, nextRunAt } from '../cron/expr.js'
import type { ToolBridge } from './bridge.js'

/** 定时任务工具名（小杰代操用：「每天早上 8 点帮我问 AI 资讯助手」→ jeff_cron_create） */
export const CRON_TOOL_NAMES = ['jeff_cron_create', 'jeff_cron_list', 'jeff_cron_update', 'jeff_cron_delete'] as const

export type CronToolDeps = {
  db: DB
  /** 变更后通知 UI */
  onChanged: () => void
  /** 「立即执行一次」（由 core 转给调度器，保证并发锁与运行记录一致） */
  runNow?: (taskId: string) => { runId: string }
}

/** 在工具桥上注册定时任务工具 */
export function registerCronTools(reg: ToolBridge, deps: CronToolDeps): void {
  const tasks = cronTaskRepo(deps.db)
  const [T_CREATE, T_LIST, T_UPDATE, T_DELETE] = CRON_TOOL_NAMES

  const resolveTarget = (targetType: string, targetId: string) => {
    if (targetType === 'agent') {
      const a = agentRepo(deps.db).get(targetId)
      if (!a || a.deleted_at != null) throw new Error(`智能体不存在: ${targetId}`)
      return a.name
    }
    const p = projectRepo(deps.db).get(targetId)
    if (!p || p.deleted_at != null) throw new Error(`项目群不存在: ${targetId}`)
    return `${p.icon} ${p.title}`
  }

  reg.register(T_CREATE, async (args: { name?: string; target_type?: string; target_id?: string; cron_expr?: string; prompt?: string; miss_policy?: string }) => {
    const name = (args.name || '').trim()
    if (!name) throw new Error('name 不能为空')
    if (args.target_type !== 'agent' && args.target_type !== 'project') throw new Error('target_type 必须是 agent 或 project')
    if (!args.target_id) throw new Error('target_id 不能为空')
    const expr = (args.cron_expr || '').trim()
    if (!isValidCron(expr)) throw new Error(`cron 表达式非法（需 5 段：分 时 日 月 周，如 0 8 * * *）: ${expr}`)
    if (!(args.prompt || '').trim()) throw new Error('prompt 不能为空（到点要发给对方的话）')
    const targetLabel = resolveTarget(args.target_type, args.target_id)
    const row = tasks.create({
      name,
      target_type: args.target_type,
      target_id: args.target_id,
      cron_expr: expr,
      prompt: (args.prompt || '').trim(),
      miss_policy: args.miss_policy === 'skip' ? 'skip' : 'catchup',
      next_run_at: nextRunAt(expr, Date.now()),
    })
    deps.onChanged()
    return { id: row.id, name: row.name, target: targetLabel, schedule: describeCron(expr), next_run_at: row.next_run_at }
  })

  reg.register(T_LIST, async () => {
    const agents = agentRepo(deps.db)
    const runs = cronRunRepo(deps.db).lastStatusMap()
    return tasks.list().map((t) => ({
      id: t.id,
      name: t.name,
      target_type: t.target_type,
      target_id: t.target_id,
      target_label: t.target_type === 'agent' ? agents.get(t.target_id)?.name || '(已删除)' : projectRepo(deps.db).get(t.target_id)?.title || '(已解散)',
      cron_expr: t.cron_expr,
      schedule: describeCron(t.cron_expr),
      prompt: t.prompt,
      miss_policy: t.miss_policy,
      enabled: !!t.enabled,
      last_run_at: t.last_run_at,
      next_run_at: t.next_run_at,
      last_status: runs[t.id]?.status ?? null,
    }))
  })

  reg.register(T_UPDATE, async (args: { id?: string; name?: string; cron_expr?: string; prompt?: string; miss_policy?: string; enabled?: boolean }) => {
    if (!args.id) throw new Error('id 不能为空')
    const cur = tasks.get(args.id)
    if (!cur) throw new Error(`定时任务不存在: ${args.id}`)
    const patch: Parameters<typeof tasks.update>[1] = {}
    if (args.name !== undefined) patch.name = args.name
    if (args.prompt !== undefined) patch.prompt = args.prompt
    if (args.miss_policy !== undefined) patch.miss_policy = args.miss_policy === 'skip' ? 'skip' : 'catchup'
    if (args.enabled !== undefined) patch.enabled = args.enabled ? 1 : 0
    if (args.cron_expr !== undefined) {
      if (!isValidCron(args.cron_expr)) throw new Error(`cron 表达式非法: ${args.cron_expr}`)
      patch.cron_expr = args.cron_expr
      patch.next_run_at = nextRunAt(args.cron_expr, Date.now())
    }
    const row = tasks.update(args.id, patch)
    deps.onChanged()
    return { id: row!.id, name: row!.name, enabled: !!row!.enabled, next_run_at: row!.next_run_at }
  })

  reg.register(T_DELETE, async (args: { id?: string }) => {
    if (!args.id) throw new Error('id 不能为空')
    const ok = tasks.softDelete(args.id)
    if (!ok) throw new Error(`删除失败: ${args.id}`)
    deps.onChanged()
    return { deleted: true }
  })
}
