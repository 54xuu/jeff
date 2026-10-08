import crypto from 'node:crypto'
import type { DB } from '../db/db.js'
import { agentRepo, projectAgentRepo, projectRepo, chatMessageRepo } from '../db/repos.js'
import { agentSlug } from '../agents/registry.js'
import type { OcClient } from '../oc/client.js'
import { projectMemberPromptOpts } from '../util/modelKey.js'
import { GROUP_TURN_TIMEOUT_MS, ensureCallbackMention, extractReplyParts } from './group.js'
import type { GroupChat } from './group.js'
import { groupMsgScope } from './groupThreads.js'

export interface DelegateCtx {
  projectId: string
  actorAgentId: string
  /** 发起委派时的群会话（冻结归属，防界面切换后公告/消息落到别的 thread） */
  threadId?: string
}

export interface DelegateResult {
  ok: boolean
  memberName: string
  result?: string
  error?: string
}

/** 委派回合与普通群回合共用同一 90 分钟总预算（渲染视频等长阻塞工具可能远超 10 分钟） */
const DELEGATE_TIMEOUT_MS = GROUP_TURN_TIMEOUT_MS
const MAX_DELEGATIONS_PER_MESSAGE = 5

/**
 * 项目群委派执行器：群成员可按群规则调用，真实调用者与目标成员必须属于同一群。
 * 防重：同 (群, 成员, 指令) 并发去重；同一条消息最多委派 5 次（防失控循环）。
 */
export class Delegator {
  private inflight = new Set<string>()
  private perMessageCount = new Map<string, { count: number; ts: number }>()
  private static PRUNE_MS = 30 * 60 * 1000
  /** 调试日志（委派失败等现场） */
  onDebugLog?: (tag: string, detail: unknown) => void
  /** 规则/记忆注入（用户级+项目级 AGENTS.md 与记忆），与普通群回合保持一致；由 JeffCore 注入 */
  buildMemory?: (agentId: string, projectId: string) => string | undefined
  /** 委派全部结束后回调（无在途委派时触发）；用于 sidecar 待重启的延迟落闸 */
  onIdle?: () => void

  constructor(
    private db: DB,
    private getOc: () => OcClient,
    private groupChat: GroupChat,
    private notify: (payload: { projectId: string; threadId?: string }) => void,
  ) {}

  /** 在途委派数（sidecar 重启前检查用：重启会终止正在执行的委派请求） */
  get activeCount(): number {
    return this.inflight.size
  }

  /** 会话上下文 → 项目群调用者身份 */
  resolveDelegateScope(sessionId: string, agentId: string): DelegateCtx | null {
    const project = projectRepo(this.db).list()
    for (const p of project) {
      const threadId = this.groupChat.threads.getActiveThreadId(p.id)
      if (threadId && this.groupChat.getSessionId(p.id, agentId, threadId) === sessionId) {
        if (projectAgentRepo(this.db).getRole(p.id, agentId)) return { projectId: p.id, actorAgentId: agentId }
        return null
      }
      // 回退：扫该群所有 thread 下的 session 指针
      if (this.groupChat.getSessionId(p.id, agentId) === sessionId) {
        if (projectAgentRepo(this.db).getRole(p.id, agentId)) return { projectId: p.id, actorAgentId: agentId }
        return null
      }
    }
    return null
  }

  async delegate(ctx: DelegateCtx, memberId: string, instruction: string, sourceMessageId?: string): Promise<DelegateResult> {
    const project = projectRepo(this.db).get(ctx.projectId)
    if (!project) return { ok: false, memberName: '', error: `项目不存在: ${ctx.projectId}` }
    const agents = agentRepo(this.db)
    const actor = agents.get(ctx.actorAgentId)
    if (!actor || !projectAgentRepo(this.db).getRole(ctx.projectId, ctx.actorAgentId)) return { ok: false, memberName: '', error: '调用者不属于本项目群' }
    const member = agents.get(memberId)
    if (!member) return { ok: false, memberName: '', error: `成员智能体不存在: ${memberId}` }
    if (memberId === ctx.actorAgentId) return { ok: false, memberName: member.name, error: '不能委派给自己' }
    if (!projectAgentRepo(this.db).getRole(ctx.projectId, memberId)) {
      return { ok: false, memberName: member.name, error: `${member.name} 不在本群里，先用 jeff_project_add_member 邀入` }
    }
    if (!instruction.trim()) return { ok: false, memberName: member.name, error: 'instruction 不能为空' }

    // 防失控：同一条消息的委派次数上限（条目带时间戳，顺带清理过期项防内存缓增）
    const now = Date.now()
    for (const [k, v] of this.perMessageCount) {
      if (now - v.ts > Delegator.PRUNE_MS) this.perMessageCount.delete(k)
    }
    const mid = sourceMessageId || 'unknown'
    const entry = this.perMessageCount.get(mid) || { count: 0, ts: now }
    entry.count += 1
    entry.ts = now
    if (entry.count > MAX_DELEGATIONS_PER_MESSAGE) {
      return { ok: false, memberName: member.name, error: `同一条消息的委派已达上限（${MAX_DELEGATIONS_PER_MESSAGE} 次），请先汇总当前进展` }
    }
    this.perMessageCount.set(mid, entry)

    // 防重：同 (群, 成员, 归一化指令) 正在执行 → 拒绝重复
    const sig = `${ctx.projectId}:${memberId}:${crypto.createHash('sha1').update(instruction.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12)}`
    if (this.inflight.has(sig)) {
      return { ok: false, memberName: member.name, error: `已有一个相同的委派给 ${member.name} 正在进行，请等待其完成，不要重复发起` }
    }
    this.inflight.add(sig)

    const threadId = ctx.threadId || this.groupChat.threads.ensureActiveThread(ctx.projectId)
    const scope = groupMsgScope(ctx.projectId, threadId)
    const actorName = actor.name
    try {
      // 1. 群里公告：以调用者普通气泡发布，完整指令不截断
      chatMessageRepo(this.db).add({
        scope,
        sender_type: 'agent',
        sender_id: ctx.actorAgentId,
        content: `@我 已将任务交给 @${member.name}，任务要求如下：\n${instruction}`,
        meta: { type: 'delegation', phase: 'dispatch', projectId: ctx.projectId, actorId: ctx.actorAgentId, memberId },
      })
      this.notify({ projectId: ctx.projectId, threadId })

      // 2. 成员执行（独立会话，注入群上下文 + 委派说明；模型/思考用成员群内生效配置）
      const sessionId = await this.groupChat.ensureSession(ctx.projectId, memberId, threadId)
      const instructionText = `【${actorName} 委派】${instruction}`
      const memberConfig = projectAgentRepo(this.db).listByProject(ctx.projectId).find((row) => row.agent_id === memberId)
      const opts = projectMemberPromptOpts(member, memberConfig || {})
      // 与普通群回合一致：briefing + 规则/记忆（用户级+项目级 AGENTS.md、成员与项目记忆）
      const memory = this.buildMemory?.(memberId, ctx.projectId)
      const system = [this.memberBriefing(ctx.projectId, memberId, actorName), memory].filter(Boolean).join('\n\n')
      const reply = await this.getOc().sendMessage({
        sessionId,
        text: instructionText,
        agent: agentSlug(memberId),
        system,
        timeoutMs: DELEGATE_TIMEOUT_MS,
        ...opts,
      })
      const parts = (reply.parts || []).filter((p) => p.type === 'text') as Array<{ type: 'text'; text: string }>
      const resultText = parts.map((p) => p.text).join('\n') || '（成员没有返回文本内容）'

      // 3. 结果回群：成员普通气泡并 @发起用户；完整结果不截断。
      //    同时把成员的思考过程与工具调用一并落库——只回文本会让成员「流式期间很长、完成后整段消失」。
      const { reasoning, tools } = extractReplyParts(reply)
      chatMessageRepo(this.db).add({
        scope,
        sender_type: 'agent',
        sender_id: memberId,
        content: ensureCallbackMention(resultText),
        meta: {
          type: 'delegation',
          phase: 'result',
          sessionId,
          messageId: reply.id,
          delegatedBy: ctx.actorAgentId,
          ...(reasoning.length ? { reasoning } : {}),
          ...(tools.length ? { tools } : {}),
        },
      })
      this.groupChat.threads.touch(ctx.projectId, threadId)
      this.notify({ projectId: ctx.projectId, threadId })
      return { ok: true, memberName: member.name, result: resultText }
    } catch (err) {
      // 失败回调也以成员普通气泡回群，完整错误 message 不截断（堆栈只进调试日志）
      const msg = String((err as Error)?.message || err)
      this.onDebugLog?.('delegate-fail', {
        projectId: ctx.projectId,
        actorAgentId: ctx.actorAgentId,
        memberId,
        instruction: instruction.slice(0, 500),
        error: msg,
        stack: (err as Error)?.stack,
      })
      chatMessageRepo(this.db).add({
        scope,
        sender_type: 'agent',
        sender_id: memberId,
        content: `@我 任务执行失败：${msg}`,
        meta: { type: 'delegation', phase: 'failed', projectId: ctx.projectId, actorId: ctx.actorAgentId, memberId },
      })
      this.notify({ projectId: ctx.projectId, threadId })
      return { ok: false, memberName: member.name, error: msg }
    } finally {
      this.inflight.delete(sig)
      if (this.inflight.size === 0) this.onIdle?.()
    }
  }

  /** 成员执行委派时的本群上下文 */
  private memberBriefing(projectId: string, memberId: string, actorName: string): string {
    const base = this.groupChat.buildBriefing(projectId, memberId)
    return `${base}\n\n【本次由群成员 ${actorName} 委派任务】按群规则与本群职责执行；能做就完成并给出结果，做不到就说明原因和阻塞点。`
  }
}
