import crypto from 'node:crypto'
import type { DB } from '../db/db.js'
import { agentRepo, projectAgentRepo, projectRepo, chatMessageRepo } from '../db/repos.js'
import { agentSlug } from '../agents/registry.js'
import type { OcClient } from '../oc/client.js'
import { agentPromptOpts } from '../util/modelKey.js'
import { GROUP_TURN_TIMEOUT_MS, ensureCallbackMention, extractReplyParts } from './group.js'
import type { GroupChat } from './group.js'
import { groupMsgScope } from './groupThreads.js'

export interface DelegateCtx {
  projectId: string
  leaderAgentId: string
  /** 发起委派时的群会话（冻结归属，防界面切换后公告/消息落到别的 thread） */
  threadId?: string
}

export interface DelegateResult {
  ok: boolean
  memberName: string
  result?: string
  error?: string
}

/** 委派回合与普通群回合共用同一 30 分钟总预算（群任务可能远超 10 分钟） */
const DELEGATE_TIMEOUT_MS = GROUP_TURN_TIMEOUT_MS
const MAX_DELEGATIONS_PER_MESSAGE = 5

/**
 * 群主 leader 的委派执行器（multica squad 的进程内适配版）：
 * leader 在自己的会话里调 jeff_delegate → 成员在独立会话执行 → 结果回群 + 作为工具输出还给 leader，
 * leader 同轮汇总。防重：同 (群, 成员, 指令) 并发去重；同一条 leader 消息最多委派 5 次（防失控循环）。
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

  /** 会话上下文 → 是否可委派（群主 + 群会话） */
  resolveDelegateScope(sessionId: string, agentId: string): DelegateCtx | null {
    const project = projectRepo(this.db).list()
    for (const p of project) {
      const threadId = this.groupChat.threads.getActiveThreadId(p.id)
      if (threadId && this.groupChat.getSessionId(p.id, agentId, threadId) === sessionId) {
        if (p.leader_agent_id === agentId) return { projectId: p.id, leaderAgentId: agentId }
        return null
      }
      // 回退：扫该群所有 thread 下的 session 指针
      if (this.groupChat.getSessionId(p.id, agentId) === sessionId) {
        if (p.leader_agent_id === agentId) return { projectId: p.id, leaderAgentId: agentId }
        return null
      }
    }
    return null
  }

  async delegate(ctx: DelegateCtx, memberId: string, instruction: string, sourceMessageId?: string): Promise<DelegateResult> {
    const project = projectRepo(this.db).get(ctx.projectId)
    if (!project) return { ok: false, memberName: '', error: `项目不存在: ${ctx.projectId}` }
    if (project.leader_agent_id !== ctx.leaderAgentId) return { ok: false, memberName: '', error: '只有群主（leader）可以委派' }
    const agents = agentRepo(this.db)
    const member = agents.get(memberId)
    if (!member) return { ok: false, memberName: '', error: `成员智能体不存在: ${memberId}` }
    if (memberId === ctx.leaderAgentId) return { ok: false, memberName: member.name, error: '不能委派给自己' }
    if (!projectAgentRepo(this.db).getRole(ctx.projectId, memberId)) {
      return { ok: false, memberName: member.name, error: `${member.name} 不在本群里，先用 jeff_project_add_member 邀入` }
    }
    if (!instruction.trim()) return { ok: false, memberName: member.name, error: 'instruction 不能为空' }

    // 防失控：同一条 leader 消息的委派次数上限（条目带时间戳，顺带清理过期项防内存缓增）
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
    const leaderName = agents.get(ctx.leaderAgentId)?.name || '群主'
    try {
      // 1. 群里公告：以 leader 普通气泡发布，@发起用户（我）与被派发成员，完整指令不截断
      chatMessageRepo(this.db).add({
        scope,
        sender_type: 'agent',
        sender_id: ctx.leaderAgentId,
        content: `@我 已将任务派发给 @${member.name}，任务要求如下：\n${instruction}`,
        meta: { type: 'delegation', phase: 'dispatch', projectId: ctx.projectId, leaderId: ctx.leaderAgentId, memberId },
      })
      this.notify({ projectId: ctx.projectId, threadId })

      // 2. 成员执行（独立会话，注入群上下文 + 指派说明；模型/思考用成员自己的设置）
      const sessionId = await this.groupChat.ensureSession(ctx.projectId, memberId, threadId)
      const instructionText = `【群主 ${leaderName} 指派】${instruction}`
      const opts = agentPromptOpts(member)
      // 与普通群回合一致：briefing + 规则/记忆（用户级+项目级 AGENTS.md、成员与项目记忆）
      const memory = this.buildMemory?.(memberId, ctx.projectId)
      const system = [this.memberBriefing(ctx.projectId, memberId, leaderName), memory].filter(Boolean).join('\n\n')
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

      // 3. 结果回群：worker 普通气泡，@发起用户；完整结果不截断。
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
          delegatedBy: ctx.leaderAgentId,
          ...(reasoning.length ? { reasoning } : {}),
          ...(tools.length ? { tools } : {}),
        },
      })
      this.groupChat.threads.touch(ctx.projectId, threadId)
      this.notify({ projectId: ctx.projectId, threadId })
      return { ok: true, memberName: member.name, result: resultText }
    } catch (err) {
      // 失败回调也以 worker 普通气泡回群，完整错误 message 不截断（堆栈只进调试日志）
      const msg = String((err as Error)?.message || err)
      this.onDebugLog?.('delegate-fail', {
        projectId: ctx.projectId,
        leaderAgentId: ctx.leaderAgentId,
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
        meta: { type: 'delegation', phase: 'failed', projectId: ctx.projectId, leaderId: ctx.leaderAgentId, memberId },
      })
      this.notify({ projectId: ctx.projectId, threadId })
      return { ok: false, memberName: member.name, error: msg }
    } finally {
      this.inflight.delete(sig)
      if (this.inflight.size === 0) this.onIdle?.()
    }
  }

  /** 成员执行委派时的上下文（比 leader 的 briefing 多一层指派说明） */
  private memberBriefing(projectId: string, memberId: string, leaderName: string): string {
    const base = this.groupChat.buildBriefing(projectId, memberId)
    return `${base}\n\n【本次为群主指派任务】${leaderName} 通过委派工具把指令交给你。把它当作你的工作任务：能做就做完并给出结果与结论；做不到就明确说明原因和阻塞点。`
  }
}
