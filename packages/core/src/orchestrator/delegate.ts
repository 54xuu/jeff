import crypto from 'node:crypto'
import type { DB } from '../db/db.js'
import { agentRepo, projectAgentRepo, projectRepo, chatMessageRepo } from '../db/repos.js'
import { agentSlug } from '../agents/registry.js'
import type { OcClient } from '../oc/client.js'
import type { GroupChat } from './group.js'

export interface DelegateCtx {
  projectId: string
  leaderAgentId: string
}

export interface DelegateResult {
  ok: boolean
  memberName: string
  result?: string
  error?: string
}

const DELEGATE_TIMEOUT_MS = 10 * 60 * 1000
const MAX_DELEGATIONS_PER_MESSAGE = 5

/**
 * 群主 leader 的委派执行器（multica squad 的进程内适配版）：
 * leader 在自己的会话里调 jeff_delegate → 成员在独立会话执行 → 结果回群 + 作为工具输出还给 leader，
 * leader 同轮汇总。防重：同 (群, 成员, 指令) 并发去重；同一条 leader 消息最多委派 5 次（防失控循环）。
 */
export class Delegator {
  private inflight = new Set<string>()
  private perMessageCount = new Map<string, number>()

  constructor(
    private db: DB,
    private getOc: () => OcClient,
    private groupChat: GroupChat,
    private notify: (projectId: string) => void,
  ) {}

  /** 会话上下文 → 是否可委派（群主 + 群会话） */
  resolveDelegateScope(sessionId: string, agentId: string): DelegateCtx | null {
    const project = projectRepo(this.db).list()
    for (const p of project) {
      if (this.groupChat.getSessionId(p.id, agentId) === sessionId) {
        if (p.leader_agent_id === agentId) return { projectId: p.id, leaderAgentId: agentId }
        return null // 群会话但不是 leader
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

    // 防失控：同一条 leader 消息的委派次数上限
    const mid = sourceMessageId || 'unknown'
    const count = (this.perMessageCount.get(mid) || 0) + 1
    if (count > MAX_DELEGATIONS_PER_MESSAGE) {
      return { ok: false, memberName: member.name, error: `同一条消息的委派已达上限（${MAX_DELEGATIONS_PER_MESSAGE} 次），请先汇总当前进展` }
    }
    this.perMessageCount.set(mid, count)

    // 防重：同 (群, 成员, 归一化指令) 正在执行 → 拒绝重复
    const sig = `${ctx.projectId}:${memberId}:${crypto.createHash('sha1').update(instruction.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12)}`
    if (this.inflight.has(sig)) {
      return { ok: false, memberName: member.name, error: `已有一个相同的委派给 ${member.name} 正在进行，请等待其完成，不要重复发起` }
    }
    this.inflight.add(sig)

    const scope = GroupChatScope(ctx.projectId)
    const leaderName = agents.get(ctx.leaderAgentId)?.name || '群主'
    try {
      // 1. 群里公告
      chatMessageRepo(this.db).add({
        scope,
        sender_type: 'system',
        content: `🔗 ${leaderName} 委派任务给 ${member.name}：${instruction.slice(0, 120)}${instruction.length > 120 ? '…' : ''}`,
        meta: { type: 'delegation', projectId: ctx.projectId, leaderId: ctx.leaderAgentId, memberId },
      })
      this.notify(ctx.projectId)

      // 2. 成员执行（独立会话，注入群上下文 + 指派说明）
      const sessionId = await this.groupChat.ensureSession(ctx.projectId, memberId)
      const instructionText = `【群主 ${leaderName} 指派】${instruction}`
      const reply = await this.getOc().sendMessage({
        sessionId,
        text: instructionText,
        agent: agentSlug(memberId),
        system: this.memberBriefing(ctx.projectId, memberId, leaderName),
        timeoutMs: DELEGATE_TIMEOUT_MS,
      })
      const parts = (reply.parts || []).filter((p) => p.type === 'text') as Array<{ type: 'text'; text: string }>
      const resultText = parts.map((p) => p.text).join('\n') || '（成员没有返回文本内容）'

      // 3. 结果回群
      chatMessageRepo(this.db).add({
        scope,
        sender_type: 'agent',
        sender_id: memberId,
        content: resultText,
        meta: { sessionId, messageId: reply.id, delegatedBy: ctx.leaderAgentId },
      })
      this.notify(ctx.projectId)
      return { ok: true, memberName: member.name, result: resultText }
    } catch (err) {
      const msg = String((err as Error)?.message || err).slice(0, 300)
      chatMessageRepo(this.db).add({
        scope,
        sender_type: 'system',
        content: `⚠️ ${member.name} 执行委派任务失败：${msg}`,
      })
      this.notify(ctx.projectId)
      return { ok: false, memberName: member.name, error: msg }
    } finally {
      this.inflight.delete(sig)
    }
  }

  /** 成员执行委派时的上下文（比 leader 的 briefing 多一层指派说明） */
  private memberBriefing(projectId: string, memberId: string, leaderName: string): string {
    const base = this.groupChat.buildBriefing(projectId, memberId)
    return `${base}\n\n【本次为群主指派任务】${leaderName} 通过委派工具把指令交给你。把它当作你的工作任务：能做就做完并给出结果与结论；做不到就明确说明原因和阻塞点。`
  }
}

function GroupChatScope(projectId: string): string {
  return `group:${projectId}`
}
