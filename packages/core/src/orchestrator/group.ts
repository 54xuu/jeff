import type { DB } from '../db/db.js'
import { chatMessageRepo, projectAgentRepo, projectRepo, agentRepo, kvRepo, type ChatMessageRow } from '../db/repos.js'
import { agentSlug } from '../agents/registry.js'
import type { OcClient, AssistantInfo } from '../oc/client.js'
import type { GroupMessage } from '../ipc/contract.js'

const SESSION_KEY = (projectId: string, agentId: string) => `session:group:${projectId}:${agentId}`

export interface GroupChatHooks {
  beforeEnsure?: () => Promise<void>
}

/**
 * 群聊（项目）：消息记录在 chat_message，会话语义在 opencode。
 * M2 路由：默认给 leader；@成员名 直达该成员。M3 在此基础上加 leader 委派与防重。
 */
export class GroupChat {
  constructor(
    private db: DB,
    private getOc: () => OcClient,
    private hooks?: GroupChatHooks,
  ) {}

  /** 项目 scope（chat_message 的 scope 值） */
  static scope(projectId: string): string {
    return `group:${projectId}`
  }

  async ensureSession(projectId: string, agentId: string): Promise<string> {
    await this.hooks?.beforeEnsure?.()
    const kv = kvRepo(this.db)
    const key = SESSION_KEY(projectId, agentId)
    const existing = kv.get(key)
    if (existing) {
      try {
        await this.getOc().getSession(existing)
        return existing
      } catch {
        kv.delete(key)
      }
    }
    const project = projectRepo(this.db).get(projectId)
    const agent = agentRepo(this.db).get(agentId)
    const s = await this.getOc().createSession({
      title: `群「${project?.title || projectId}」· ${agent?.name || agentId}`,
      agent: agentSlug(agentId),
    })
    kv.set(key, s.id)
    return s.id
  }

  getSessionId(projectId: string, agentId: string): string | null {
    return kvRepo(this.db).get(SESSION_KEY(projectId, agentId))
  }

  /** 解析 @提及：返回命中的成员 agentId（按名字精确匹配优先、包含匹配兜底） */
  parseMention(text: string, members: Array<{ agent_id: string; name: string }>): string | null {
    const hits = members.filter((m) => text.includes(`@${m.name}`))
    if (hits.length === 0) return null
    // 名字最长的优先（避免「开发」匹配到「开发-后端」时误判）
    hits.sort((a, b) => b.name.length - a.name.length)
    return hits[0].agent_id
  }

  /** leader 的 roster briefing（注入到每条群消息的 system，保持会话内上下文新鲜） */
  buildBriefing(projectId: string): string {
    const project = projectRepo(this.db).get(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)
    const agents = agentRepo(this.db)
    const members = projectAgentRepo(this.db).listByProject(projectId)
    const roster = members
      .map((m) => {
        const a = agents.get(m.agent_id)
        return `- ${a?.name || m.agent_id}（角色: ${m.role}${m.agent_id === project.leader_agent_id ? '，群主/leader' : ''}）id=${m.agent_id}`
      })
      .join('\n')
    const isLeaderBriefing = project.leader_agent_id === this.currentAgentId
    const leaderLine = isLeaderBriefing
      ? '你是本群群主（leader），用户的消息默认由你统筹：能自己答就答；需要别人干活的，说明你打算怎么做（M3 将支持直接委派工具）。'
      : '你是本群成员，就你职责范围内的问题作答。'
    return [
      `【项目群上下文】群名：${project.title}`,
      project.description ? `群简介：${project.description}` : '',
      `成员名册：`,
      roster,
      leaderLine,
      `用户消息里 @某成员名 表示直接指名对话；回复请用简体中文，简洁、可执行。`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  private currentAgentId = ''

  /** 用户在群里发消息：存储 + 路由（@直达 或 leader）+ 回帖 */
  async send(input: { projectId: string; text: string; model?: { providerID: string; modelID: string } }): Promise<{ routedTo: string }> {
    const { projectId, text } = input
    const project = projectRepo(this.db).get(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)
    if (!project.leader_agent_id) throw new Error('项目未设置群主（leader）')
    const members = projectAgentRepo(this.db).listByProject(projectId)
    const agents = agentRepo(this.db)
    const scope = GroupChat.scope(projectId)

    // 1. 存用户消息
    chatMessageRepo(this.db).add({ scope, sender_type: 'user', content: text })

    // 2. 路由：@直达 or leader
    const memberInfos = members.map((m) => ({ agent_id: m.agent_id, name: agents.get(m.agent_id)?.name || '' }))
    const mentioned = this.parseMention(text, memberInfos)
    const targetId = mentioned ?? project.leader_agent_id
    const target = agents.get(targetId)
    if (!target) throw new Error(`路由目标不存在: ${targetId}`)
    this.currentAgentId = targetId

    // 3. 会话发送（system 注入群上下文）
    const sessionId = await this.ensureSession(projectId, targetId)
    let reply: AssistantInfo
    try {
      reply = await this.getOc().sendMessage({
        sessionId,
        text,
        agent: agentSlug(targetId),
        system: this.buildBriefing(projectId),
        ...(input.model && input.model.providerID && input.model.modelID ? { model: input.model } : {}),
      })
    } catch (err) {
      chatMessageRepo(this.db).add({
        scope,
        sender_type: 'system',
        content: `⚠️ ${target.name} 处理消息失败：${String((err as Error)?.message || err).slice(0, 200)}`,
      })
      throw err
    }

    // 4. 回帖（提取文本 + 工具摘要）
    const textParts = (reply.parts || []).filter((p) => p.type === 'text') as Array<{ type: 'text'; text: string }>
    const toolParts = (reply.parts || []).filter((p) => p.type === 'tool') as Array<{ type: 'tool'; tool: string; state?: { output?: string } }>
    let content = textParts.map((p) => p.text).join('\n')
    if (toolParts.length > 0) {
      const toolLine = toolParts.map((t) => `🔧 ${t.tool}`).join('、')
      content = `${toolLine}\n${content}`
    }
    chatMessageRepo(this.db).add({
      scope,
      sender_type: 'agent',
      sender_id: targetId,
      content,
      meta: { sessionId, messageId: reply.id },
    })
    return { routedTo: targetId }
  }

  /** 读取群消息（映射 UI 形状，含发送者信息） */
  history(projectId: string): GroupMessage[] {
    const agents = agentRepo(this.db)
    const scope = GroupChat.scope(projectId)
    const rows = chatMessageRepo(this.db).listByScope(scope)
    return rows.map((r: ChatMessageRow) => {
      const a = r.sender_id ? agents.get(r.sender_id) : undefined
      return {
        id: r.id,
        role: r.sender_type === 'user' ? 'user' : r.sender_type === 'agent' ? 'assistant' : 'system',
        agentId: r.sender_id || undefined,
        text: r.content,
        time: r.created_at,
        meta: safeJson(r.meta),
        sender_name: r.sender_type === 'user' ? '我' : a?.name || '系统',
        sender_avatar: r.sender_type === 'user' ? '🧑' : a?.avatar || '⚙️',
      }
    })
  }

  /** 追加系统消息（任务卡片等） */
  addSystemMessage(projectId: string, content: string, meta?: Record<string, unknown>): void {
    chatMessageRepo(this.db).add({
      scope: GroupChat.scope(projectId),
      sender_type: 'system',
      content,
      meta,
    })
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return {}
  }
}
