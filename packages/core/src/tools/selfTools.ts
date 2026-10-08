import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db/db.js'
import { agentRepo } from '../db/repos.js'
import type { JeffPaths } from '../paths.js'
import type { ToolBridge } from './bridge.js'
import type { SessionScopeCtx, ToolCtx } from './memoryTools.js'

/**
 * 自我维护工具：每个 agent 只能通过会话身份维护自己的指令。
 *
 * 设计要点：
 * - **没有 id 参数**：调用者身份只认 __ctx.sessionID → resolveSession，工具在物理上只能指向自己，
 *   「群主改别人指令」这类冲突从工具形状上就不存在（与 jeff_spawn_subtask 的调用者校验同一思路）。
 * - **只改 instructions**：不暴露 name/category，避免身份自维护顺带改动通讯录属性。
 * - **写前版本校验（fail-closed）**：expected_version 不匹配即拒绝，让 agent 先 get 重读，
 *   避免静默覆盖设置页 / 另一台设备的并发修改。版本号在 agent md 的固定页脚里声明。
 * - **空串一律视为未提供**（v1.8.2 / v1.8.3 两次实测模型爱补空串）。
 */
export const SELF_TOOL_NAMES = ['jeff_self_update'] as const

/** 身份指令长度上限：防模型循环膨胀（正常指令远小于此） */
export const MAX_INSTRUCTIONS_CHARS = 20000
/** 快照保留份数（每个 agent） */
const SNAPSHOT_KEEP = 20

export type SelfToolDeps = {
  db: DB
  paths: JeffPaths
  /** opencode session → Jeff 会话语义 */
  resolveSession(sessionId: string): SessionScopeCtx | null
  /** 变更后回调（同步 md + 重启标记 + 通知 UI） */
  onChanged: () => void
}

function snapshotDir(paths: JeffPaths, agentId: string): string {
  return path.join(paths.backupsDir, 'agent-instructions', agentId)
}

/**
 * 改身份指令前的本地快照（纯本地、不进同步）。
 * 三条改 instructions 的路径共用：jeff_self_update / 小杰的 jeff_agent_update / 设置页保存。
 * 返回快照文件路径（文本为空时不快照，返回 null）。
 */
export function snapshotInstructions(paths: JeffPaths, agentId: string, text: string): string | null {
  if (!text || !text.trim()) return null
  const dir = snapshotDir(paths, agentId)
  fs.mkdirSync(dir, { recursive: true })
  // 文件名用毫秒时间戳：同毫秒多次快照时向后借毫秒，保证文件名唯一且字典序 = 时间序（revert 取「最后一个」）
  let ts = Date.now()
  while (fs.existsSync(path.join(dir, `${ts}.md`))) ts += 1
  const file = path.join(dir, `${ts}.md`)
  fs.writeFileSync(file, text, 'utf8')
  // 只保留最近 SNAPSHOT_KEEP 份
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
  for (const f of files.slice(0, Math.max(0, files.length - SNAPSHOT_KEEP))) {
    try {
      fs.rmSync(path.join(dir, f), { force: true })
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
  return file
}

/** 版本号解析：容忍 "3" / "v3" / " 3 "；其余一律视为未提供（fail-closed） */
function parseVersion(v: unknown): number | null {
  if (v == null) return null
  const s = String(v).trim().replace(/^v/i, '')
  if (!/^\d+$/.test(s)) return null
  return Number(s)
}

/** 注册自我维护工具实现（bridge 名 = opencode 工具名） */
export function registerSelfTools(reg: ToolBridge, deps: SelfToolDeps): void {
  const [T_SELF] = SELF_TOOL_NAMES

  reg.register(T_SELF, async (raw: Record<string, unknown>) => {
    const { __ctx, action, instructions, expected_version } = raw as {
      __ctx?: ToolCtx
      action?: string
      instructions?: string
      expected_version?: string
    }
    const ctx = __ctx || {}
    // 身份只认会话上下文，不做按名字兜底（群聊里可能错绑同名者）
    const resolved = ctx.sessionID ? deps.resolveSession(ctx.sessionID) : null
    if (!resolved) return { ok: false, error: '无法识别调用者身份（无会话上下文）' }
    const agents = agentRepo(deps.db)
    const agent = agents.get(resolved.agentId)
    if (!agent) return { ok: false, error: '调用者身份不存在' }
    const version = agent.instructions_version || 0

    if (action === 'get') {
      return { ok: true, version, instructions: agent.instructions, updated_at: agent.updated_at }
    }
    if (action !== 'set' && action !== 'revert') {
      return { ok: false, error: 'action 必须是 get / set / revert' }
    }

    const ev = parseVersion(expected_version)
    if (ev == null) {
      return { ok: false, error: `expected_version 必填（当前版本 v${version}，写在你自我维护页脚里；不确定就先 action=get）`, current_version: version }
    }
    if (ev !== version) {
      return {
        ok: false,
        error: `版本不匹配：你看到的是 v${ev}，当前已是 v${version}（可能在设置页或其他设备被改过）。请先 action=get 读取最新指令与版本，再基于最新文本重试`,
        current_version: version,
      }
    }

    if (action === 'set') {
      const text = String(instructions ?? '').trim()
      if (!text) return { ok: false, error: 'set 需要非空 instructions（整篇替换：把修改后的完整身份指令全文传入，不是增量描述）' }
      if (text.length > MAX_INSTRUCTIONS_CHARS) {
        return { ok: false, error: `instructions 过长：${text.length} 字符（上限 ${MAX_INSTRUCTIONS_CHARS}）。请精简后再试` }
      }
      snapshotInstructions(deps.paths, agent.id, agent.instructions)
      const row = agents.update(agent.id, { instructions: text })
      deps.onChanged()
      return {
        ok: true,
        changed: 'instructions',
        old_version: version,
        new_version: row?.instructions_version ?? version + 1,
        effective: '下一轮对话生效（引擎会自动重启；本轮系统提示仍是旧文本）',
      }
    }

    // revert：取最近一份快照写回；写回前先把当前文本也快照一份（revert 本身可再撤销）
    const dir = snapshotDir(deps.paths, agent.id)
    const files = fs
      .existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .sort()
      : []
    const latest = files[files.length - 1]
    if (!latest) {
      return { ok: false, error: '没有可用的历史快照（本机从未改过你的身份指令；快照不随 WebDAV 同步迁移）' }
    }
    const restored = fs.readFileSync(path.join(dir, latest), 'utf8')
    snapshotInstructions(deps.paths, agent.id, agent.instructions)
    const row = agents.update(agent.id, { instructions: restored })
    deps.onChanged()
    return {
      ok: true,
      changed: 'instructions',
      reverted_to: latest,
      old_version: version,
      new_version: row?.instructions_version ?? version + 1,
      effective: '下一轮对话生效（引擎会自动重启；本轮系统提示仍是旧文本）',
    }
  })
}
