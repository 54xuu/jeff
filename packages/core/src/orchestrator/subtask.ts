import type { DB } from '../db/db.js'
import { agentRepo } from '../db/repos.js'
import { agentSlug } from '../agents/registry.js'
import type { OcClient } from '../oc/client.js'
import { agentPromptOpts } from '../util/modelKey.js'
import { DEFAULT_SEND_TIMEOUT_MS } from '../oc/client.js'

/** 内部工具名（bridge handler 名 = opencode 工具名）。用户不需要记住它。 */
export const SUBTASK_TOOL = 'jeff_spawn_subtask'

/**
 * 用户用中文声明「这些材料要分开处理」时，追加到本轮 system 的硬指令。
 * 只给模型看，不写进用户气泡。子任务会话本身不走这条（它直接调 oc.sendMessage）。
 */
export const SUBTASK_STEER = [
  '【独立子任务】用户已经用中文说明：这些材料彼此独立，要分开处理。',
  '你必须对每一个独立文件单独调用 jeff_spawn_subtask（串行，等上一个结果回来再发下一个），由子任务自己读取原文并写盘。',
  '当前对话里禁止用 read 读取这些原始文件的正文。',
  '同一条消息里如果还有合并、总结、汇总：等各子任务完成、提取文件已经落盘之后，再在当前对话里只读那些提取结果来合并；不要把合并本身交给子任务，也不要回头读原始文件。',
].join('\n')

const INDEPENDENCE_RE = /独立处理|各自单独|各自独立|分开处理|分别处理|互不相关|彼此独立|逐个处理|逐份处理|单独处理/
const BATCH_RE = /每个文件|每一个文件|每一份|各文件|这些文件|所有[\s\S]{0,16}文件|目录下|逐个|逐份|\.md\b/
const NEGATED_RE = /不要独立|别独立|无需独立|不需要独立|不用独立|不要用子任务|不用子任务|不要分开处理/

/** 用户原文是否在要求「批量且彼此独立」。单独说「独立子任务」也算明确要求。 */
export function wantsIndependentSubtasks(text: string): boolean {
  const t = text || ''
  if (NEGATED_RE.test(t)) return false
  if (/独立子任务/.test(t)) return true
  return INDEPENDENCE_RE.test(t) && BATCH_RE.test(t)
}

/** 命中中文触发时把硬指令接到本轮 system 后面；小杰没有该工具，不注入。 */
export function withSubtaskSteer(system: string | undefined, text: string, opts?: { builtin?: boolean }): string | undefined {
  if (opts?.builtin || !wantsIndependentSubtasks(text)) return system
  return system ? `${system}\n\n${SUBTASK_STEER}` : SUBTASK_STEER
}

/** 单条触发消息内最多派生的子任务数（防失控循环；比 jeff_delegate 的 5 次上限高很多，
 * 覆盖真实批量场景如几十份标书，超过则拦下让调用方先汇总）。 */
const MAX_SUBTASKS_PER_MESSAGE = 80
const PRUNE_MS = 30 * 60 * 1000
/** 子任务结果回传给调用方的正文长度上限：只给一个可读摘要，不把完整产出灌回父上下文 */
const SUMMARY_MAX_CHARS = 300

export interface SubtaskCtx {
  agentId: string
  kind: 'private' | 'group'
  projectId?: string
  /** 工作空间目录（群有 workspace_dir 时传入；私聊默认走引擎默认工作区，不传） */
  directory?: string
}

export interface SubtaskParams {
  label?: string
  instruction: string
  target_path?: string
}

export interface SubtaskResult {
  ok: boolean
  label?: string
  target_path?: string
  summary?: string
  error?: string
  /** 子任务底层 opencode session id：不进全局会话搜索，仅供发起方按需查看完整过程 */
  subtask_session?: string
}

/**
 * 子任务派生器：把一项工作丢进全新会话独立执行，用同一个调用者身份（同模型/指令/工具集），
 * 只回传简短状态给父会话，避免批量处理多个互相独立目标时上下文被逐项完整内容撑爆。
 * 与 Delegator（项目群 leader→worker，回传完整结果）刻意不同：这里回传契约是「短状态」。
 */
export class SubtaskRunner {
  private perMessageCount = new Map<string, { count: number; ts: number }>()
  /** 规则/记忆注入（用户级+项目级 AGENTS.md 与记忆），与私聊/群聊回合保持一致；由 JeffCore 注入 */
  buildSystem?: (agentId: string, projectId?: string) => string | undefined
  /** 子任务会话创建后回调：调用方据此写 session 元数据（标 isSubtask，供嵌套检测与会话隐藏） */
  onSessionCreated?: (sessionId: string, meta: { kind: 'private' | 'group'; agentId: string; projectId?: string }) => void
  /** 智能体未绑定模型时的会话兜底 */
  defaultModel?: () => { providerID: string; modelID: string } | null
  /** 调试日志（子任务失败等现场） */
  onDebugLog?: (tag: string, detail: unknown) => void

  constructor(
    private db: DB,
    private getOc: () => OcClient,
  ) {}

  async run(ctx: SubtaskCtx, params: SubtaskParams, callKey: string): Promise<SubtaskResult> {
    if (!params.instruction?.trim()) return { ok: false, error: 'instruction 不能为空' }

    // 防失控：同一条触发消息的子任务次数上限（条目带时间戳，顺带清理过期项防内存缓增）
    const now = Date.now()
    for (const [k, v] of this.perMessageCount) {
      if (now - v.ts > PRUNE_MS) this.perMessageCount.delete(k)
    }
    const entry = this.perMessageCount.get(callKey) || { count: 0, ts: now }
    entry.count += 1
    entry.ts = now
    if (entry.count > MAX_SUBTASKS_PER_MESSAGE) {
      return { ok: false, label: params.label, target_path: params.target_path, error: `同一条消息的子任务已达上限（${MAX_SUBTASKS_PER_MESSAGE} 次），请先汇总当前进展` }
    }
    this.perMessageCount.set(callKey, entry)

    const agent = agentRepo(this.db).get(ctx.agentId)
    if (!agent) return { ok: false, label: params.label, target_path: params.target_path, error: '智能体不存在' }

    const title = (params.label || '').trim().slice(0, 60) || '子任务'
    let sessionId: string
    try {
      const s = await this.getOc().createSession({ title, agent: agentSlug(ctx.agentId), ...(ctx.directory ? { directory: ctx.directory } : {}) })
      sessionId = s.id
    } catch (err) {
      const msg = String((err as Error)?.message || err)
      this.onDebugLog?.('subtask-create-fail', { agentId: ctx.agentId, label: params.label, error: msg })
      return { ok: false, label: params.label, target_path: params.target_path, error: `创建子任务会话失败：${msg}` }
    }
    this.onSessionCreated?.(sessionId, { kind: ctx.kind, agentId: ctx.agentId, ...(ctx.projectId ? { projectId: ctx.projectId } : {}) })

    const opts = agentPromptOpts(agent, this.defaultModel?.() ?? null)
    const system = this.buildSystem?.(ctx.agentId, ctx.projectId)
    const text = [
      '【独立子任务】你正在一个全新的、空白的会话里执行下面这一项任务。',
      '这是一批互相独立目标中的一项，只关注本条指令本身，不要假设它与其它同类任务有关联。',
      '如果任务要求把产出保存为文件，请你自己用文件工具完成写入，不要只把内容写在回复正文里。',
      '完成后请直接给出简洁的结果说明（做了什么、产出在哪里、关键结论），不需要重复原始材料全文。',
      '',
      params.instruction,
    ].join('\n')

    try {
      const reply = await this.getOc().sendMessage({
        sessionId,
        text,
        agent: agentSlug(ctx.agentId),
        system,
        timeoutMs: DEFAULT_SEND_TIMEOUT_MS,
        ...opts,
      })
      const parts = (reply.parts || []).filter((p) => p.type === 'text') as Array<{ type: 'text'; text: string }>
      const resultText = parts.map((p) => p.text).join('\n').trim()
      const summary = resultText ? (resultText.length > SUMMARY_MAX_CHARS ? `${resultText.slice(0, SUMMARY_MAX_CHARS)}…` : resultText) : '（子任务没有返回文本内容）'
      return { ok: true, label: params.label, target_path: params.target_path, summary, subtask_session: sessionId }
    } catch (err) {
      const msg = String((err as Error)?.message || err)
      this.onDebugLog?.('subtask-fail', {
        agentId: ctx.agentId,
        label: params.label,
        target_path: params.target_path,
        sessionId,
        error: msg,
        stack: (err as Error)?.stack,
      })
      return { ok: false, label: params.label, target_path: params.target_path, error: msg, subtask_session: sessionId }
    }
  }
}
