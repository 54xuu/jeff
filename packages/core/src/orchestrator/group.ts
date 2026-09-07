import type { DB } from '../db/db.js'
import { chatMessageRepo, projectAgentRepo, projectRepo, agentRepo, kvRepo, type ChatMessageRow } from '../db/repos.js'
import { agentSlug } from '../agents/registry.js'
import type { OcClient, AssistantInfo } from '../oc/client.js'
import type { GroupMessage } from '../ipc/contract.js'
import { GroupThreadStore, groupMsgScope } from './groupThreads.js'

export interface GroupChatHooks {
  beforeEnsure?: () => Promise<void>
  onSessionCreated?: (sessionId: string, meta: { kind: 'private' | 'group' | 'review'; agentId: string; projectId?: string; threadId?: string }) => void
  /** 群消息的记忆块注入（追加在 briefing 之后） */
  buildMemory?: (agentId: string, projectId: string) => string | undefined
  afterReply?: (scope: { kind: 'private'; agentId: string } | { kind: 'group'; projectId: string; agentId: string }) => void
}

/**
 * 群聊（项目）：消息按 thread 记在 chat_message；opencode 会话按 (project, thread, agent) 隔离。
 * 路由：默认 leader；@成员名 直达。界面上 thread = 一段群聊历史（类微信）。
 */
export class GroupChat {
  readonly threads: GroupThreadStore

  constructor(
    private db: DB,
    private getOc: () => OcClient,
    private hooks?: GroupChatHooks,
  ) {
    this.threads = new GroupThreadStore(db)
  }

  /** @deprecated 用 scope(projectId, threadId)；保留给迁移扫描 */
  static scope(projectId: string, threadId?: string): string {
    if (threadId) return groupMsgScope(projectId, threadId)
    return `group:${projectId}`
  }

  activeThreadId(projectId: string): string {
    return this.threads.ensureActiveThread(projectId)
  }

  async ensureSession(projectId: string, agentId: string, threadId?: string): Promise<string> {
    await this.hooks?.beforeEnsure?.()
    const tid = threadId || this.threads.ensureActiveThread(projectId)
    const kv = kvRepo(this.db)
    const key = this.threads.sessionKey(projectId, tid, agentId)
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
    const dir = project?.workspace_dir || undefined
    const threadMeta = this.threads.getMeta(projectId, tid)
    const s = await this.getOc().createSession({
      title: `${threadMeta?.title || '群会话'} · ${agent?.name || agentId}`,
      agent: agentSlug(agentId),
      ...(dir ? { directory: dir } : {}),
    })
    kv.set(key, s.id)
    this.hooks?.onSessionCreated?.(s.id, { kind: 'group', agentId, projectId, threadId: tid })
    return s.id
  }

  getSessionId(projectId: string, agentId: string, threadId?: string): string | null {
    const tid = threadId || this.threads.getActiveThreadId(projectId)
    if (!tid) return null
    return kvRepo(this.db).get(this.threads.sessionKey(projectId, tid, agentId))
  }

  /** 解析 @提及 */
  parseMention(text: string, members: Array<{ agent_id: string; name: string }>): string | null {
    const hits = members.filter((m) => text.includes(`@${m.name}`))
    if (hits.length === 0) return null
    hits.sort((a, b) => b.name.length - a.name.length)
    return hits[0].agent_id
  }

  buildBriefing(projectId: string, agentId: string): string {
    const project = projectRepo(this.db).get(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)
    const agents = agentRepo(this.db)
    const members = projectAgentRepo(this.db).listByProject(projectId)
    const roster = members
      .map((m) => {
        const a = agents.get(m.agent_id)
        const isLeader = m.agent_id === project.leader_agent_id
        const roleLabel = isLeader ? '群主/leader' : '工作者/worker'
        return `- ${a?.name || m.agent_id}（${roleLabel}）id=${m.agent_id}`
      })
      .join('\n')
    const isLeaderBriefing = project.leader_agent_id === agentId
    const roleLine = isLeaderBriefing
      ? '你是本群群主（leader），用户的消息默认由你统筹：能自己答就答；需要别人干活的，用委派工具交给工作者（worker）。'
      : '你是本群工作者（worker），就你职责范围内的问题作答；不做开发/产品等细分类角色。'
    const bg = (project.description || '').trim()
    return [
      `【项目群上下文】群名：${project.title}`,
      `项目背景（群简介）：${bg || '（未填写，请在群资料补充）'}`,
      `工作空间目录：${project.workspace_dir || '默认工作区'}。用户没有指定输出位置时，你产出的所有文件（代码、文档等）都保存到该目录。`,
      `成员名册（仅 leader / worker）：`,
      roster,
      roleLine,
      `用户消息里 @某成员名 表示直接指名对话；回复请用简体中文，简洁、可执行。`,
    ].join('\n')
  }

  async send(input: { projectId: string; text: string; model?: { providerID: string; modelID: string }; variant?: string; images?: Array<{ mime: string; dataUrl: string }> }): Promise<{ routedTo: string }> {
    const { projectId, text } = input
    const project = projectRepo(this.db).get(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)
    if (!project.leader_agent_id) throw new Error('项目未设置群主（leader）')
    const threadId = this.threads.ensureActiveThread(projectId)
    const members = projectAgentRepo(this.db).listByProject(projectId)
    const agents = agentRepo(this.db)
    const scope = groupMsgScope(projectId, threadId)

    chatMessageRepo(this.db).add({
      scope,
      sender_type: 'user',
      content: text,
      ...(input.images && input.images.length ? { meta: { images: input.images } } : {}),
    })
    this.threads.touch(projectId, threadId)

    const memberInfos = members.map((m) => ({ agent_id: m.agent_id, name: agents.get(m.agent_id)?.name || '' }))
    const mentioned = this.parseMention(text, memberInfos)
    const targetId = mentioned ?? project.leader_agent_id
    const target = agents.get(targetId)
    if (!target) throw new Error(`路由目标不存在: ${targetId}`)

    const sessionId = await this.ensureSession(projectId, targetId, threadId)
    this.threads.setLastOcSession(projectId, sessionId)
    let reply: AssistantInfo
    const memoryBlock = this.hooks?.buildMemory?.(targetId, projectId)
    const system = memoryBlock ? `${this.buildBriefing(projectId, targetId)}\n\n${memoryBlock}` : this.buildBriefing(projectId, targetId)
    try {
      reply = await this.getOc().sendMessage({
        sessionId,
        text,
        ...(input.images && input.images.length ? { images: input.images } : {}),
        agent: agentSlug(targetId),
        system,
        ...(input.model && input.model.providerID && input.model.modelID ? { model: input.model } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
      })
    } catch (err) {
      const msg = String((err as Error)?.message || err)
      const stopped = /abort/i.test(msg)
      chatMessageRepo(this.db).add({
        scope,
        sender_type: 'system',
        content: stopped ? '⏹️ 已停止生成' : `⚠️ ${target.name} 处理消息失败：${msg.slice(0, 200)}`,
      })
      if (!stopped) throw err
      return { routedTo: targetId }
    }

    const textParts = (reply.parts || []).filter((p) => p.type === 'text') as Array<{ type: 'text'; text: string }>
    const reasoningParts = (reply.parts || [])
      .filter((p) => p.type === 'reasoning')
      .map((p) => (p as { text?: string }).text || '')
      .filter(Boolean)
    const toolParts = (reply.parts || []).filter((p) => p.type === 'tool') as Array<{ type: 'tool'; tool: string; state?: { status?: string; output?: string; error?: string } }>
    const content = textParts.map((p) => p.text).join('\n')
    chatMessageRepo(this.db).add({
      scope,
      sender_type: 'agent',
      sender_id: targetId,
      content,
      meta: {
        sessionId,
        messageId: reply.id,
        threadId,
        ...(reasoningParts.length ? { reasoning: reasoningParts } : {}),
        ...(toolParts.length
          ? {
              tools: toolParts.map((t) => ({
                tool: t.tool,
                status: t.state?.status,
                output: (t.state?.output || '').slice(0, 2000),
                error: t.state?.error,
              })),
            }
          : {}),
      },
    })
    this.hooks?.afterReply?.({ kind: 'group', projectId, agentId: targetId })
    return { routedTo: targetId }
  }

  /** 读取当前（或指定）thread 的群消息 */
  history(projectId: string, threadId?: string): GroupMessage[] {
    const tid = threadId || this.threads.ensureActiveThread(projectId)
    const agents = agentRepo(this.db)
    const scope = groupMsgScope(projectId, tid)
    const rows = chatMessageRepo(this.db).listByScope(scope)
    return rows.map((r: ChatMessageRow) => {
      const a = r.sender_id ? agents.get(r.sender_id) : undefined
      const meta = safeJson(r.meta)
      const metaImages = Array.isArray(meta.images)
        ? meta.images.filter((x): x is { mime: string; dataUrl: string } => !!x && typeof x === 'object' && typeof (x as { dataUrl?: unknown }).dataUrl === 'string')
        : undefined
      const metaReasoning = Array.isArray(meta.reasoning) ? (meta.reasoning as string[]).filter((x) => typeof x === 'string' && x.trim()) : undefined
      const metaTools = Array.isArray(meta.tools)
        ? (meta.tools as Array<{ tool?: string; status?: string; output?: string; error?: string }>)
            .filter((t) => t && typeof t.tool === 'string')
            .map((t) => ({ tool: t.tool as string, status: t.status, output: t.output, error: t.error }))
        : undefined
      return {
        id: r.id,
        role: r.sender_type === 'user' ? 'user' : r.sender_type === 'agent' ? 'assistant' : 'system',
        agentId: r.sender_id || undefined,
        text: r.content,
        time: r.created_at,
        meta,
        ...(metaReasoning?.length ? { reasoning: metaReasoning } : {}),
        ...(metaTools?.length ? { tools: metaTools } : {}),
        ...(metaImages && metaImages.length ? { images: metaImages } : {}),
        sender_name: r.sender_type === 'user' ? '我' : a?.name || '系统',
        sender_avatar: r.sender_type === 'user' ? '🧑' : a?.avatar || '⚙️',
      }
    })
  }

  addSystemMessage(projectId: string, content: string, meta?: Record<string, unknown>): void {
    const threadId = this.threads.ensureActiveThread(projectId)
    chatMessageRepo(this.db).add({
      scope: groupMsgScope(projectId, threadId),
      sender_type: 'system',
      content,
      meta,
    })
    this.threads.touch(projectId, threadId)
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return {}
  }
}
