import type { DB } from '../db/db.js'
import { chatMessageRepo, projectAgentRepo, projectRepo, agentRepo, kvRepo, type ChatMessageRow, type ProjectRow } from '../db/repos.js'
import { agentSlug } from '../agents/registry.js'
import type { OcClient, AssistantInfo } from '../oc/client.js'
import type { GroupMessage } from '../ipc/contract.js'
import { agentPromptOpts } from '../util/modelKey.js'
import { GroupThreadStore, groupMsgScope } from './groupThreads.js'

/** 单次用户消息触发的串行协作流水线最大步数（防死循环） */
const MAX_PIPELINE_HOPS = 5

/** 群消息发送结果：summaryFailed 表示 worker 成果已保留但 leader 最终总结失败（可手动再次请求总结） */
export interface GroupSendResult {
  routedTo: string
  summaryFailed?: boolean
  summaryError?: string
}

export interface GroupChatHooks {
  beforeEnsure?: () => Promise<void>
  onSessionCreated?: (sessionId: string, meta: { kind: 'private' | 'group' | 'review'; agentId: string; projectId?: string; threadId?: string }) => void

  /** 群消息的记忆块注入（追加在 briefing 之后） */
  buildMemory?: (agentId: string, projectId: string) => string | undefined
  afterReply?: (scope: { kind: 'private'; agentId: string } | { kind: 'group'; projectId: string; agentId: string }) => void
  /** 智能体未绑定模型时的会话兜底 */
  defaultModel?: () => { providerID: string; modelID: string } | null
  /** 调试日志（消息处理失败等现场） */
  onDebugLog?: (tag: string, detail: unknown) => void
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

  /** 单次群发送的运行态：冻结发起时的 thread，跟踪当前会话与取消标记（stream/stop/system 公告都归属它） */
  private runStates = new Map<string, { threadId: string; cancelled: boolean; sessionId: string | null }>()

  /** 该项目群是否有在途发送（用于禁止切换/删除 thread，防止消息串线） */
  isBusy(projectId: string): boolean {
    return this.runStates.has(projectId)
  }

  /**
   * 停止该群的在途流水线：标记取消（未开始的 worker 回合与最终总结不再执行），
   * 并 abort 当前正在生成的会话。返回是否命中了在途流程。
   */
  async abort(projectId: string): Promise<boolean> {
    const st = this.runStates.get(projectId)
    if (!st) return false
    st.cancelled = true
    if (st.sessionId) await this.getOc().abortSession(st.sessionId).catch(() => {})
    return true
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
    const tid = threadId || this.threads.ensureActiveThread(projectId)
    const key = this.threads.sessionKey(projectId, tid, agentId)
    // per-key 创建锁：并发 ensureSession 同一 (群,thread,agent) 只建一次会话，防 KV 指针互相覆盖
    const inflight = this.sessionEnsureInflight.get(key)
    if (inflight) return inflight
    const p = this.doEnsureSession(projectId, agentId, tid, key).finally(() => this.sessionEnsureInflight.delete(key))
    this.sessionEnsureInflight.set(key, p)
    return p
  }

  private sessionEnsureInflight = new Map<string, Promise<string>>()

  private async doEnsureSession(projectId: string, agentId: string, tid: string, key: string): Promise<string> {
    await this.hooks?.beforeEnsure?.()
    const kv = kvRepo(this.db)
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

  /** 解析首个 @提及（兼容旧逻辑） */
  parseMention(text: string, members: Array<{ agent_id: string; name: string }>): string | null {
    const mentions = this.parseAllMentions(text, members)
    return mentions.length > 0 ? mentions[0].agent_id : null
  }

  /**
   * 解析文本中所有有效的 @提及成员，按在文本中出现的先后顺序排列，去重返回。
   * 同一位置匹配到多个成员名（如「开发」与「开发-后端」）时取最长名。
   */
  parseAllMentions(text: string, members: Array<{ agent_id: string; name: string }>): Array<{ agent_id: string; name: string }> {
    const seen = new Set<string>()
    const result: Array<{ agent_id: string; name: string }> = []
    let i = text.indexOf('@')
    while (i !== -1 && i < text.length) {
      let best: { agent_id: string; name: string } | null = null
      for (const m of members) {
        if (!m.name) continue
        if (text.startsWith(m.name, i + 1) && (!best || m.name.length > best.name.length)) best = m
      }
      if (best) {
        if (!seen.has(best.agent_id)) {
          seen.add(best.agent_id)
          result.push({ agent_id: best.agent_id, name: best.name })
        }
        i = text.indexOf('@', i + 1 + best.name.length)
        continue
      }
      i = text.indexOf('@', i + 1)
    }
    return result
  }

  buildBriefing(projectId: string, agentId: string): string {
    const project = projectRepo(this.db).get(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)
    const agents = agentRepo(this.db)
    const members = projectAgentRepo(this.db).listByProject(projectId)
    const isLeaderBriefing = project.leader_agent_id === agentId
    const leaderAgent = project.leader_agent_id ? agents.get(project.leader_agent_id) : undefined
    const leaderName = leaderAgent?.name || '群主'

    const roster = members
      .map((m) => {
        const a = agents.get(m.agent_id)
        const isLeader = m.agent_id === project.leader_agent_id
        const roleLabel = isLeader ? '群主/leader' : '工作者/worker'
        const descParts: string[] = []
        if (a?.description?.trim()) descParts.push(a.description.trim())
        if (a?.instructions?.trim()) descParts.push(`职责设定：${a.instructions.trim().slice(0, 150)}`)
        const desc = descParts.length > 0 ? ` - ${descParts.join('；')}` : ''
        return `- ${a?.name || m.agent_id}（${roleLabel}）id=${m.agent_id}${desc}`
      })
      .join('\n')

    const roleLine = isLeaderBriefing
      ? `你是本群群主（leader），负责统筹协调与任务派发：
1. 简单打招呼、寒暄、纯信息问答或群内仅有你一人时，直接用清晰友好的语言回复用户；
2. 凡涉及具体工作与执行任务（如写代码、查验文件、执行操作、排查问题等），【严禁自己包揽全部执行】！必须仔细分析上方《群成员名册与技能清单》，评估各项子任务最适合哪位 worker 执行；
3. 将任务分解为具体子步骤，在回复中按执行顺序依次使用「@成员名 <具体子任务要求>」进行明确派发（例如：“@开发小李 请修改前端页面... @测试小王 请执行测试...”）；
4. 系统调度器会严格按顺序驱动各 worker 串行执行并在群内向你汇报；待所有 worker 汇报完毕后，系统会自动触发你进行最终验收与向用户的汇总答复。`
      : `你是本群工作者（worker）。
1. 当群主 @ 你并指派任务时，请根据指派要求全力执行（结合工作空间完成代码编写、文件查验等）；
2. 任务执行完成后，你【必须】在回复最后以「@${leaderName} 汇报：<任务执行结果与结论总结>」的格式在群里公开汇报，以便群主验收与向用户汇总。`

    const bg = (project.description || '').trim()
    return [
      `【项目群上下文】群名：${project.title}`,
      `项目背景（群简介）：${bg || '（未填写，请在群资料补充）'}`,
      `工作空间目录：${project.workspace_dir || '默认工作区'}。用户没有指定输出位置时，产出的所有文件（代码、文档等）都保存到该目录。`,
      `【群成员名册与技能清单】：`,
      roster,
      `【协作与执行规范】：`,
      roleLine,
      `群内所有沟通均使用简体中文，清晰、专业、可执行。`,
    ].join('\n')
  }

  /**
   * 发送群消息。模型/思考取路由目标智能体自己的设置；入参 model/variant 忽略。
   *
   * 协作流程（串行流水线，避免工作空间文件/git 资源竞争）：
   * 1. 用户消息默认路由 leader（@成员名 直达该成员）；
   * 2. leader 拆解任务后在回复里 @worker 派发 → 调度器解析全部 @，按出现顺序串行驱动各 worker 执行；
   * 3. worker 完成后在群里 @leader 汇报（也可再 @其他 worker 续入队列）；
   * 4. 队列执行完毕后自动唤醒 leader 做最终验收总结回复用户。
   * 单次用户消息全链路最多 MAX_PIPELINE_HOPS 步，防死循环。
   *
   * 并发控制：同一 projectId 的完整流程按队列串行（防同一 leader/worker session 交叉请求）；
   * 不同项目并行。leader 回合内的 jeff_delegate 天然在本流程锁内执行，不再取锁。
   */
  async send(input: { projectId: string; text: string; model?: { providerID: string; modelID: string }; variant?: string; images?: Array<{ mime: string; dataUrl: string }> }): Promise<GroupSendResult> {
    return this.withProjectLock(input.projectId, () => this.doSend(input))
  }

  private projectLocks = new Map<string, Promise<void>>()

  private async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.projectLocks.get(projectId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    this.projectLocks.set(projectId, gate)
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.projectLocks.get(projectId) === gate) this.projectLocks.delete(projectId)
    }
  }

  private async doSend(input: { projectId: string; text: string; model?: { providerID: string; modelID: string }; variant?: string; images?: Array<{ mime: string; dataUrl: string }> }): Promise<GroupSendResult> {
    const { projectId, text } = input
    const project = projectRepo(this.db).get(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)
    if (!project.leader_agent_id) throw new Error('项目未设置群主（leader）')
    const threadId = this.threads.ensureActiveThread(projectId)
    // 冻结本次流程的归属：后续 stream/system 公告/取消都只认这个 thread，不随界面切换漂移
    const runState = { threadId, cancelled: false, sessionId: null as string | null }
    this.runStates.set(projectId, runState)
    try {
      return await this.doSendPipeline(input, project, threadId, runState)
    } finally {
      // 仅清理仍属于本次运行的状态（期间不可能有并发 send，防御性判断）
      if (this.runStates.get(projectId) === runState) this.runStates.delete(projectId)
    }
  }

  private async doSendPipeline(
    input: { projectId: string; text: string; model?: { providerID: string; modelID: string }; variant?: string; images?: Array<{ mime: string; dataUrl: string }> },
    project: ProjectRow,
    threadId: string,
    runState: { threadId: string; cancelled: boolean; sessionId: string | null },
  ): Promise<GroupSendResult> {
    const { projectId, text } = input
    const leaderId = project.leader_agent_id
    if (!leaderId) throw new Error('项目未设置群主（leader）')
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
    const firstTargetId = mentioned ?? leaderId
    const firstTarget = agents.get(firstTargetId)
    if (!firstTarget) throw new Error(`路由目标不存在: ${firstTargetId}`)

    // 第一回合：响应用户
    const first = await this.runTurn({ projectId, threadId, agentId: firstTargetId, text, images: input.images, runState })
    let routedTo = firstTargetId
    if (first.stopped) return { routedTo }

    // 串行流水线：解析第一回合回复中的 @ 派发队列
    // （用户直连 worker 时，其回复里的 @leader 是「汇报」，进总结分支而非派发队列）
    // 队列携带「指派来源文本」：worker 二级转派时，下游拿到的是转派者的实际任务说明，而非回退到最初用户输入
    let hops = 0
    let dispatchedAny = false
    let queue: Array<{ agentId: string; source: string }> = this.parseAllMentions(first.content, memberInfos)
      .filter((m) => m.agent_id !== firstTargetId && !(firstTargetId !== leaderId && m.agent_id === leaderId))
      .map((m) => ({ agentId: m.agent_id, source: first.content }))
    if (firstTargetId === leaderId && queue.length > 0) {
      this.addSystemMessage(projectId, `📋 ${firstTarget.name} 已拆解任务，开始按序派发给 ${queue.length} 位成员执行…`, undefined, threadId)
    }
    while (queue.length > 0 && hops < MAX_PIPELINE_HOPS) {
      if (runState.cancelled) return { routedTo }
      const item = queue.shift() as { agentId: string; source: string }
      const workerId = item.agentId
      const worker = agents.get(workerId)
      if (!worker) continue
      routedTo = workerId
      hops += 1
      dispatchedAny = true
      const taskText = this.extractMentionTask(item.source, worker.name, memberInfos)
      // 二级转派（worker → worker）时说明来源是同事，避免误导为群主指派
      const from = firstTargetId === leaderId ? `群主 ${agents.get(leaderId)?.name || '群主'} 在群里指派` : `${firstTarget.name} 转派`
      const prompt = `【${from}】${taskText || text}\n请执行上述任务；完成后在群里以「@${agents.get(leaderId)?.name || '群主'} 汇报：<结果>」公开汇报。`
      const turn = await this.runTurn({ projectId, threadId, agentId: workerId, text: prompt, runState })
      if (turn.stopped) return { routedTo }
      // worker 回复里继续 @ 的人：leader 代表汇报到位；其他 worker 续入队列串行执行（来源文本 = 该 worker 的回复）
      for (const nm of this.parseAllMentions(turn.content, memberInfos)) {
        if (nm.agent_id === workerId) continue
        if (nm.agent_id !== leaderId && !queue.some((q) => q.agentId === nm.agent_id)) queue.push({ agentId: nm.agent_id, source: turn.content })
      }
    }
    if (runState.cancelled) return { routedTo }
    if (hops >= MAX_PIPELINE_HOPS && queue.length > 0) {
      this.addSystemMessage(projectId, `⚠️ 本轮协作步数已达上限（${MAX_PIPELINE_HOPS} 步），剩余任务不再派发，由群主直接汇总。`, undefined, threadId)
    }

    // 闭环：有派发（或用户直连 worker 且 worker 向 leader 汇报）时，唤醒 leader 做最终总结
    let summaryFailed = false
    let summaryError: string | undefined
    if (dispatchedAny || (firstTargetId !== leaderId && this.parseAllMentions(first.content, memberInfos).some((m) => m.agent_id === leaderId))) {
      routedTo = leaderId
      const summaryPrompt = dispatchedAny
        ? '【系统通知】你派发的任务已全部由成员执行完毕并回群汇报。请对照各成员的汇报验收成果，直接向用户给出清晰、完整的最终总结答复（无需再派发新任务）。'
        : `【系统通知】${firstTarget.name} 已在群里向你汇报。请验收其结果，直接向用户给出最终答复。`
      try {
        await this.runTurn({ projectId, threadId, agentId: leaderId, text: summaryPrompt, runState })
      } catch (err) {
        // 部分成功可恢复：worker 成果与失败系统消息已落库，不再自动重试 leader 的 POST（防重复执行）
        summaryError = String((err as Error)?.message || err).slice(0, 200)
        summaryFailed = true
        this.addSystemMessage(projectId, `ℹ️ 成员执行结果已保留。群主最终总结未完成（${summaryError}），可直接再发一条消息让其总结。`, undefined, threadId)
      }
    }
    return summaryFailed ? { routedTo, summaryFailed, summaryError } : { routedTo }
  }

  /** 从派发文本中截取 @成员名 后、下一个 @提及前的那段任务说明 */
  extractMentionTask(text: string, memberName: string, members: Array<{ agent_id: string; name: string }>): string {
    const start = text.indexOf(`@${memberName}`)
    if (start === -1) return ''
    const from = start + memberName.length + 1
    let end = text.length
    for (const m of members) {
      if (!m.name || m.name === memberName) continue
      const idx = text.indexOf(`@${m.name}`, from)
      if (idx !== -1 && idx < end) end = idx
    }
    return text
      .slice(from, end)
      .replace(/^[：:，,、\s-]+/, '')
      .trim()
  }

  /**
   * 驱动单个 agent 回合一轮：调 opencode、落库、错误兜底。
   * 返回回复文本与是否被用户停止。
   */
  private async runTurn(input: { projectId: string; threadId: string; agentId: string; text: string; images?: Array<{ mime: string; dataUrl: string }>; runState?: { threadId: string; cancelled: boolean; sessionId: string | null } }): Promise<{ content: string; stopped: boolean }> {
    const { projectId, threadId, agentId, text } = input
    const agents = agentRepo(this.db)
    const target = agents.get(agentId)
    const scope = groupMsgScope(projectId, threadId)
    if (!target) throw new Error(`路由目标不存在: ${agentId}`)

    const sessionId = await this.ensureSession(projectId, agentId, threadId)
    // 记录到运行态供停止使用（非流水线调用如 jeff_delegate 沿用旧 last-session 兜底）
    if (input.runState) input.runState.sessionId = sessionId
    this.threads.setLastOcSession(projectId, sessionId)
    let reply: AssistantInfo
    const memoryBlock = this.hooks?.buildMemory?.(agentId, projectId)
    const system = memoryBlock ? `${this.buildBriefing(projectId, agentId)}\n\n${memoryBlock}` : this.buildBriefing(projectId, agentId)
    const opts = agentPromptOpts(target, this.hooks?.defaultModel?.() ?? null)
    // 用户已点停止：不再发起本回合，直接按已停止收敛（流水线后续回合也会被取消标记拦下）
    if (input.runState?.cancelled) return { content: '', stopped: true }
    try {
      reply = await this.getOc().sendMessage({
        sessionId,
        text,
        ...(input.images && input.images.length ? { images: input.images } : {}),
        agent: agentSlug(agentId),
        system,
        ...opts,
      })
    } catch (err) {
      const msg = String((err as Error)?.message || err)
      // 只有最近确实点过停止才算「已停止生成」；provider 超时/中断等也含 abort 字样，须暴露真实错误
      const stopped = /abort/i.test(msg) && this.getOc().isAbortRequested(sessionId)
      this.hooks?.onDebugLog?.(stopped ? 'group-send-stop' : 'group-send-fail', {
        projectId,
        threadId,
        agentId,
        agent: target.name,
        sessionId,
        error: msg,
        stack: (err as Error)?.stack,
      })
      chatMessageRepo(this.db).add({
        scope,
        sender_type: 'system',
        content: stopped ? '⏹️ 已停止生成' : `⚠️ ${target.name} 处理消息失败：${msg.slice(0, 200)}`,
      })
      if (stopped) return { content: '', stopped: true }
      throw err
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
      sender_id: agentId,
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
    this.hooks?.afterReply?.({ kind: 'group', projectId, agentId })
    // 落库后刷新 thread 时间线，保证 worker 结果/失败状态能更新 thread 排序
    this.threads.touch(projectId, threadId)
    return { content, stopped: false }
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

  /** 写群系统公告；显式传 threadId 时落指定会话（流水线内防切换漂移），缺省写当前活跃会话 */
  addSystemMessage(projectId: string, content: string, meta?: Record<string, unknown>, threadId?: string): void {
    const tid = threadId || this.threads.ensureActiveThread(projectId)
    chatMessageRepo(this.db).add({
      scope: groupMsgScope(projectId, tid),
      sender_type: 'system',
      content,
      meta,
    })
    this.threads.touch(projectId, tid)
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return {}
  }
}
