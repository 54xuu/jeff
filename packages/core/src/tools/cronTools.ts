import type { DB } from '../db/db.js'
import { agentRepo, cronRunRepo, cronTaskRepo, projectRepo } from '../db/repos.js'
import { describeCron, isValidCron, nextRunAt } from '../cron/expr.js'
import type { ToolBridge } from './bridge.js'

/** 定时任务工具名（小杰代操用：「每天早上 8 点帮我问 AI 资讯助手」→ jeff_cron_create） */
export const CRON_TOOL_NAMES = ['jeff_cron_create', 'jeff_cron_list', 'jeff_cron_update', 'jeff_cron_delete'] as const

/**
 * 空串/空白一律视为「没传」。
 *
 * 为什么必须有这层：真模型改任务时会把自己没打算改的字段补成空值（live12 在插件上实测过），
 * 而 `'' !== undefined`，于是 `name:''` 清空任务名、`miss_policy:''` 把「错过跳过」改回「补跑」、
 * `enabled:''` 被当成 false **静默停用**任务——用户看到的是「我只是让它改个时间，任务怎么停了」。
 */
function nonEmpty(v: unknown): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v.trim() ? v : undefined
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

/** enabled 的三态归一：true/false（含 'true'/'false'/'1'/'0'/'启用'/'停用'）；空值/无法识别 = 没传 */
function boolOrUndefined(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : undefined
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (!t) return undefined
    if (['true', '1', 'yes', 'on', '启用', '开启'].includes(t)) return true
    if (['false', '0', 'no', 'off', '停用', '关闭'].includes(t)) return false
  }
  return undefined
}

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
    // 只认「真的有值」的字段：空串/空数组一律跳过（否则模型一次补默认值就会抹掉已有配置）
    const name = nonEmpty(args.name)
    if (name !== undefined) patch.name = name
    const prompt = nonEmpty(args.prompt)
    if (prompt !== undefined) patch.prompt = prompt
    const miss = nonEmpty(args.miss_policy)
    if (miss !== undefined) patch.miss_policy = miss === 'skip' ? 'skip' : 'catchup'
    const enabled = boolOrUndefined(args.enabled)
    if (enabled !== undefined) patch.enabled = enabled ? 1 : 0
    const expr = nonEmpty(args.cron_expr)
    if (expr !== undefined) {
      if (!isValidCron(expr)) throw new Error(`cron 表达式非法: ${expr}`)
      patch.cron_expr = expr
      patch.next_run_at = nextRunAt(expr, Date.now())
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('没有要修改的字段：name / cron_expr / prompt / miss_policy / enabled 至少要传一个有值的（空串会被当成没传）')
    }
    const row = tasks.update(args.id, patch)
    deps.onChanged()
    return { id: row!.id, name: row!.name, enabled: !!row!.enabled, next_run_at: row!.next_run_at, changed: Object.keys(patch) }
  })

  reg.register(T_DELETE, async (args: { id?: string }) => {
    if (!args.id) throw new Error('id 不能为空')
    const ok = tasks.softDelete(args.id)
    if (!ok) throw new Error(`删除失败: ${args.id}`)
    deps.onChanged()
    return { deleted: true }
  })
}
