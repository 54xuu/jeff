import { create } from 'zustand'
import { api } from './api'
import { playNotifySound, showDesktopNotify, summarize, windowFocused } from './notify'
import { readLayout, writeLayout, defaultBrowserWidth, LIST_DEFAULT_WIDTH, type PaneLayout } from './layout/panes'
import { parseViewport, serializeViewport, VIEWPORT_STORE_KEY, type BrowserViewportRequest } from './browserViewport'
import type { AgentInfo, ChatMsg, AppInfo, AppSettings, ProviderCatalogItem, ProjectInfo, ProjectMember, TaskInfo, GroupMessage, ChatImage, CronTaskInfo, CronRunInfo, PluginInfo, ChatPluginInvoke } from '@jeff/core'
import { IPC, shouldShowDesktopNotify } from '@jeff/core'

export type Tab = 'chats' | 'contacts' | 'schedules' | 'plugins' | 'settings'
export type ActiveChat = { kind: 'agent'; id: string } | { kind: 'group'; id: string } | null
export type SettingsSection = 'providers' | 'mcp' | 'memory' | 'engine' | 'sync' | 'notification' | 'appearance' | 'about'

/** 插件快捷指令（`/` 菜单条目） */
export interface SlashCommand {
  name: string
  description?: string
  prompt: string
  pluginId: string
  pluginName: string
  icon: string
  iconSvg?: string
}

/** 内置浏览器面板状态（渲染层持有；动作请求由主进程下发） */
export interface BrowserUiState {
  visible: boolean
  url: string
  title: string
  loading: boolean
  /** 输入框里的地址（可能与已加载 url 不同，等用户回车） */
  address: string
  /** 当前页面采集到的错误数（console error / 未捕获异常 / 加载失败）：工具栏红点用，与 agent 读到的是同一份采集结果 */
  errorCount: number
  /** 视口分辨率偏好（人用工具栏菜单改、agent 用 jeff_browser_set_viewport 改，改的是同一份） */
  viewport: BrowserViewportRequest
}

/** 进行中的流式回复（key: agent:<id> / group:<id>） */
export interface StreamState {
  agentId?: string
  projectId?: string
  /** 群流所属的会话（thread）；与当前窗口不一致时不渲染，防串会话 */
  threadId?: string
  senderName: string
  senderAvatar: string
  text: string
  /** 思考过程（流式累积） */
  reasoning?: string
  /** 流式中出现的工具调用（part.updated 推送） */
  tools?: Array<{ tool: string; status?: string }>
}

interface JeffState {
  tab: Tab
  active: ActiveChat
  settingsSection: SettingsSection
  agents: AgentInfo[]
  projects: ProjectInfo[]
  messages: Record<string, ChatMsg[]>
  groupMessages: Record<string, GroupMessage[]>
  /** 项目群当前活跃会话 id（与 groupMessages 同 key；用于过滤跨会话流式事件） */
  groupThreads: Record<string, string | undefined>
  tasks: Record<string, TaskInfo[]>
  sending: Record<string, boolean>
  /** 流式回复增量（key: agent:<id> / group:<id>；完成时清空） */
  streaming: Record<string, StreamState>
  appInfo: AppInfo | null
  settings: AppSettings | null
  catalog: ProviderCatalogItem[]
  /** 定时任务列表 */
  cronTasks: CronTaskInfo[]
  /** 插件列表 */
  plugins: PluginInfo[]
  /** 内置浏览器面板状态 */
  browser: BrowserUiState
  /** 三栏布局（会话列表 / 内置浏览器）的显隐与宽度偏好 */
  layout: PaneLayout
  setTab: (t: Tab) => void
  setActive: (a: ActiveChat) => void
  setSettingsSection: (s: SettingsSection) => void
  setBrowser: (patch: Partial<BrowserUiState>) => void
  /** 改内置浏览器视口分辨率（人机共用入口：工具栏菜单与 jeff_browser_set_viewport 都走它） */
  setBrowserViewport: (viewport: BrowserViewportRequest) => void
  /** 改布局；persist:false 用于拖拽过程中的逐帧更新（松手再由 persistLayout 落盘） */
  setLayout: (patch: Partial<PaneLayout>, opts?: { persist?: boolean }) => void
  /** 把当前布局写进 localStorage */
  persistLayout: () => void
  refreshAgents: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshCron: () => Promise<void>
  refreshPlugins: () => Promise<void>
  loadCronRuns: (id: string) => Promise<CronRunInfo[]>
  loadHistory: (key: string, opts?: { resetLocal?: boolean }) => Promise<void>
  loadGroupHistory: (projectId: string) => Promise<void>
  loadTasks: (projectId: string) => Promise<void>
  sendAgent: (agentId: string, text: string, images?: ChatImage[], plugin?: ChatPluginInvoke) => Promise<void>
  sendGroup: (projectId: string, text: string, images?: ChatImage[], plugin?: ChatPluginInvoke) => Promise<void>
  newAgentSession: (agentId: string) => Promise<void>
  stopAgent: (agentId: string) => Promise<void>
  stopGroup: (projectId: string) => Promise<void>
  refreshAppInfo: () => Promise<void>
  refreshSettings: () => Promise<void>
  refreshCatalog: () => Promise<void>
  handlePush: (what: string, payload?: unknown) => void
}

/**
 * 流式事件合并窗口：模型每秒可能吐几十上百个 token，逐个写 store 会让 React 一直重渲染（界面假死）。
 * 合并窗口随文本长度自适应放宽——每次刷新都要把「整篇」文本重新解析成 Markdown，
 * 文档越长单次渲染越贵，只有拉长间隔才能把每秒渲染占用控制在常量级。
 */
function flushDelayFor(len: number): number {
  if (len < 3000) return 40
  if (len < 10000) return 80
  if (len < 24000) return 130
  return 200
}

let streamBuf = new Map<string, StreamState>()
let streamTimer: ReturnType<typeof setTimeout> | null = null

/** 把缓冲里的流式增量一次性写进 store（同一 key 只保留最新值） */
function flushStreamBuf(): void {
  streamTimer = null
  if (streamBuf.size === 0) return
  const pending = streamBuf
  streamBuf = new Map()
  useStore.setState((s) => {
    const streaming = { ...s.streaming }
    for (const [key, value] of pending) streaming[key] = value
    return { streaming }
  })
}

function scheduleStream(key: string, value: StreamState): void {
  streamBuf.set(key, value)
  // 已有待写数据时不再重置计时器：避免长文档持续输出时被无限推迟
  if (streamTimer !== null) return
  let len = 0
  for (const v of streamBuf.values()) len = Math.max(len, v.text.length + (v.reasoning?.length ?? 0))
  streamTimer = setTimeout(flushStreamBuf, flushDelayFor(len))
}

/** 丢弃某个 key 的待写增量（完成/中断时避免旧数据把已清空的流又写回来） */
function dropStreamBuf(key: string): void {
  streamBuf.delete(key)
}

/** 本地追加条目的 id 前缀（乐观用户消息 / 已停止 / 发送失败）——引擎历史里没有这些条目 */
const LOCAL_MSG_ID = /^(local|stop|err)-/

/**
 * 历史重拉是整段替换，会把本地追加的条目一起冲掉。这不是理论问题：回复结束时服务端会推
 * chat-updated 触发重拉，而「已停止 / 发送失败」提示恰好在同一时刻写入 → 提示被冲掉，
 * 用户看不到任何反馈（停止按钮点了像没反应）。这里改成合并：
 *  - 服务端消息为准；
 *  - 本地条目里，乐观用户消息若服务端已有同内容回显则丢弃（正常情况），否则保留（本轮没发出去）；
 *  - 提示类（已停止 / 发送失败）与未被回显的用户消息按时间插回原位置（不能统一追加到末尾，
 *    否则新一轮的消息会排在上一轮提示之前，时间线错乱）。
 */
function mergeLocalMessages(local: ChatMsg[], server: ChatMsg[]): ChatMsg[] {
  const echoed = new Set(server.filter((m) => m.role === 'user').map((m) => m.text))
  const kept = local.filter((m) => LOCAL_MSG_ID.test(m.id) && !(m.role === 'user' && echoed.has(m.text)))
  if (kept.length === 0) return server
  const out = [...server]
  for (const m of kept.sort((a, b) => a.time - b.time)) {
    const idx = out.findIndex((x) => x.time > m.time)
    out.splice(idx < 0 ? out.length : idx, 0, m)
  }
  return out
}

/** 取最后一条助手消息（通知摘要用） */
function lastAssistantOf<T extends { role: string }>(list?: T[]): T | null {
  if (!list) return null
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'assistant') return list[i]
  }
  return null
}

/**
 * AI 回复完成 → 按设置响铃 / 弹系统桌面通知。
 *
 * 判定规则对齐 IM 桌面端的惯例：
 *  - 用户正盯着这个会话（窗口在前台 + 停在聊天页 + 选中的就是它）→ 什么都不做，别打扰视线；
 *  - 其余情况 → 响提示音；桌面通知再看窗口是否在前台（设置里可放开「仅后台提醒」）。
 *
 * 触发点是「一轮发送真正结束」（sendAgent/sendGroup 的 await 返回），而不是流式 done 事件：
 * 群聊一轮可能串行跑多个 agent，流式 done 每跳都会来一次，按它提醒会把用户轰炸 3~5 次。
 */
function notifyTurnDone(key: string, kind: 'agent' | 'group', threadId?: string, override?: { title?: string; body?: string }): void {
  // 提醒只是收尾的副作用，绝不能让它把"发送成功"变成"发送失败"（调用点在 send 的 try 里）
  try {
    notifyTurnDoneInner(key, kind, threadId, override)
  } catch {
    /* 忽略：提醒失败不影响聊天 */
  }
}

function notifyTurnDoneInner(key: string, kind: 'agent' | 'group', threadId?: string, override?: { title?: string; body?: string }): void {
  const s = useStore.getState()
  const st = s.settings
  if (st?.notifySound === false && st?.notifyDesktop === false) return
  const id = kind === 'agent' ? key.slice('agent:'.length) : key
  const active = s.active
  // 群聊还要对上会话（thread）：用户切到了同一个群的下一个话题时，旧话题的回复也算"没在看"
  const onThisChat =
    s.tab === 'chats' && active?.kind === kind && active.id === id && (kind !== 'group' || !threadId || s.groupThreads[id] === threadId)
  if (onThisChat && windowFocused()) return

  const focused = windowFocused()
  if (st?.notifySound !== false) playNotifySound()

  const platform = window.jeff?.env?.platform || ''
  const wantDesktop = shouldShowDesktopNotify({
    notifyDesktop: st?.notifyDesktop !== false,
    notifyOnlyBackground: st?.notifyOnlyBackground !== false,
    focused,
    platform,
  })
  if (!wantDesktop) return

  if (kind === 'agent') {
    const agent = s.agents.find((a) => a.id === id)
    const last = lastAssistantOf(s.messages[key])
    showDesktopNotify({
      title: override?.title || agent?.name || '新回复',
      body: override?.body || (last && summarize(last.text)) || '有新回复',
      kind,
      id,
    })
  } else {
    const project = s.projects.find((p) => p.id === id)
    const last = lastAssistantOf(s.groupMessages[id])
    const body = last ? `${last.sender_name ? `${last.sender_name}：` : ''}${summarize(last.text) || '有新回复'}` : '群里有新回复'
    showDesktopNotify({ title: override?.title || project?.title || '项目群', body: override?.body || body, kind, id })
  }
}

export const useStore = create<JeffState>((set, get) => ({
  tab: 'chats',
  active: null,
  settingsSection: 'providers',
  agents: [],
  projects: [],
  messages: {},
  groupMessages: {},
  groupThreads: {},
  tasks: {},
  sending: {},
  streaming: {},
  appInfo: null,
  settings: null,
  catalog: [],
  cronTasks: [],
  plugins: [],
  browser: { visible: false, url: '', title: '', loading: false, address: '', errorCount: 0, viewport: parseViewport(localStorage.getItem(VIEWPORT_STORE_KEY)) },
  layout: readLayout(),

  setTab: (tab) => set({ tab }),
  setActive: (active) => set({ active }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setBrowser: (patch) => set((s) => ({ browser: { ...s.browser, ...patch } })),
  setBrowserViewport: (viewport) => {
    set((s) => ({ browser: { ...s.browser, viewport } }))
    try {
      localStorage.setItem(VIEWPORT_STORE_KEY, serializeViewport(viewport))
    } catch {
      /* localStorage 不可写（隐私模式等）：本次会话内仍然生效 */
    }
  },
  setLayout: (patch, opts) => {
    set((s) => ({ layout: { ...s.layout, ...patch } }))
    if (opts?.persist !== false) writeLayout(get().layout)
  },
  persistLayout: () => writeLayout(get().layout),

  refreshAgents: async () => {
    const agents = await api.invoke<AgentInfo[]>(IPC.agentsList)
    set({ agents })
  },

  refreshProjects: async () => {
    const projects = await api.invoke<ProjectInfo[]>(IPC.projectsList)
    set({ projects })
  },

  refreshCron: async () => {
    const cronTasks = await api.invoke<CronTaskInfo[]>(IPC.cronList)
    set({ cronTasks })
  },

  refreshPlugins: async () => {
    const plugins = await api.invoke<PluginInfo[]>(IPC.pluginsList)
    set({ plugins })
  },

  loadCronRuns: async (id) => api.invoke<CronRunInfo[]>(IPC.cronRuns, { id }),

  loadHistory: async (key, opts) => {
    if (!key.startsWith('agent:')) return
    const agentId = key.slice(6)
    const msgs = await api.invoke<ChatMsg[]>(IPC.chatHistory, { agentId })
    set((s) => ({ messages: { ...s.messages, [key]: opts?.resetLocal ? msgs : mergeLocalMessages(s.messages[key] || [], msgs) } }))
  },

  loadGroupHistory: async (projectId) => {
    const r = await api.invoke<{ threadId: string; messages: GroupMessage[] }>(IPC.groupHistory, { projectId })
    set((s) => ({ groupMessages: { ...s.groupMessages, [projectId]: r.messages }, groupThreads: { ...s.groupThreads, [projectId]: r.threadId } }))
  },

  loadTasks: async (projectId) => {
    const tasks = await api.invoke<TaskInfo[]>(IPC.tasksList, { projectId })
    set((s) => ({ tasks: { ...s.tasks, [projectId]: tasks } }))
  },

  sendAgent: async (agentId, text, images, plugin) => {
    const key = `agent:${agentId}`
    const now = Date.now()
    const localUser: ChatMsg = { id: `local-${now}`, role: 'user', text, time: now, ...(images && images.length ? { images } : {}), ...(plugin ? { plugin } : {}) }
    set((s) => ({ sending: { ...s.sending, [key]: true } }))
    set((s) => ({ messages: { ...s.messages, [key]: [...(s.messages[key] || []), localUser] } }))
    try {
      const r = await api.invoke<{ ok: boolean; stopped?: boolean; cancelled?: boolean }>(IPC.chatSend, { agentId, text, ...(images && images.length ? { images } : {}), ...(plugin ? { plugin } : {}) })
      // 先重拉历史（整段替换）再补提示，否则刚插入的提示会被冲掉
      await get().loadHistory(key)
      if (r?.stopped) {
        // 用户主动停止是预期结果：显示「已停止」而非「发送失败」
        set((s) => {
          const cur = s.messages[key] || []
          // cancelled：本轮在建会话期间就被取消，请求从未发给引擎 —— 引擎历史里没有这条用户消息，
          // 直接采用重拉结果会让用户刚敲的内容凭空消失，这里补回本地记录
          const base = r.cancelled && !cur.some((m) => m.id === localUser.id) ? [...cur, localUser] : cur
          return { messages: { ...s.messages, [key]: [...base, { id: `stop-${now}`, role: 'system', text: '⏹️ 已停止生成', time: Date.now() }] } }
        })
      } else {
        // 正常回复完成：此刻历史已重拉，摘要取的就是刚落库的正文
        notifyTurnDone(key, 'agent')
      }
    } catch (err) {
      // 真失败：保留本地用户消息与失败气泡（重拉历史会把刚插入的提示瞬间冲掉，用户再也看不到失败原因）
      set((s) => ({
        messages: {
          ...s.messages,
          [key]: [...(s.messages[key] || []), { id: `err-${now}`, role: 'system', text: `⚠️ 发送失败：${String((err as Error).message).slice(0, 200)}`, time: Date.now() }],
        },
      }))
    } finally {
      set((s) => ({ sending: { ...s.sending, [key]: false } }))
    }
  },

  sendGroup: async (projectId, text, images, plugin) => {
    const key = projectId
    // 先记下这轮落在哪个话题：用户中途切了话题，回复就不算"正在看的会话"
    const threadId = get().groupThreads[projectId]
    const now = Date.now()
    set((s) => ({ sending: { ...s.sending, [`group:${key}`]: true } }))
    set((s) => ({
      groupMessages: {
        ...s.groupMessages,
        [key]: [
          ...(s.groupMessages[key] || []),
          { id: `local-${now}`, role: 'user', text, time: now, ...(images && images.length ? { images } : {}), ...(plugin ? { plugin } : {}), sender_name: '我', sender_avatar: '🧑' },
        ],
      },
    }))
    try {
      await api.invoke(IPC.groupSend, { projectId, text, ...(images && images.length ? { images } : {}), ...(plugin ? { plugin } : {}) })
      await get().loadGroupHistory(key)
      await get().loadTasks(key)
      // 整条协作流水线跑完（await 返回）才提醒一次，中间每一跳的流式 done 不响
      notifyTurnDone(key, 'group', threadId)
    } catch (err) {
      // 同私聊：失败时保留本地气泡与失败原因，不用历史刷新覆盖
      set((s) => ({
        groupMessages: {
          ...s.groupMessages,
          [key]: [
            ...(s.groupMessages[key] || []),
            { id: `err-${now}`, role: 'system', text: `⚠️ 消息处理失败：${String((err as Error).message).slice(0, 200)}`, time: Date.now(), sender_name: '系统', sender_avatar: '⚙️' },
          ],
        },
      }))
    } finally {
      set((s) => ({ sending: { ...s.sending, [`group:${key}`]: false } }))
    }
  },

  newAgentSession: async (agentId) => {
    // 生成中新会话会切走当前会话指针（回复丢失、停止打到新会话），拒绝
    const key = `agent:${agentId}`
    if (get().sending[key]) return
    await api.invoke(IPC.chatNew, { agentId })
    // 换了会话：上一会话的本地提示（已停止/发送失败）不再适用
    await get().loadHistory(key, { resetLocal: true })
  },

  stopAgent: async (agentId) => {
    await api.invoke(IPC.chatStop, { agentId })
  },

  stopGroup: async (projectId) => {
    await api.invoke(IPC.groupStop, { projectId })
  },

  refreshAppInfo: async () => {
    const appInfo = await api.invoke<AppInfo>(IPC.appInfo)
    set({ appInfo })
  },

  refreshSettings: async () => {
    const settings = await api.invoke<AppSettings>(IPC.settingsGet)
    set({ settings })
    applyTheme(settings.theme)
    applyThemePack(settings.themePack)
  },

  refreshCatalog: async () => {
    // sidecar 就绪通常晚于渲染层首帧：重试到拿到非空目录为止（12 次 × 2s ≈ 24s 上限）
    for (let i = 0; i < 12; i++) {
      try {
        const { catalog } = await api.invoke<{ catalog: ProviderCatalogItem[] }>(IPC.providersCatalog)
        if (catalog.length > 0 || i === 11) {
          set({ catalog })
          return
        }
      } catch {
        if (i === 11) set({ catalog: [] })
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
  },

  handlePush: (what, payload) => {
    const { active } = get()
    if (what === 'chat-stream') {
      const p = (payload || {}) as { kind: 'private' | 'group'; agentId: string; projectId?: string; threadId?: string; text: string; reasoning?: string; tools?: Array<{ tool: string; status?: string }>; done: boolean }
      const key = p.kind === 'group' ? `group:${p.projectId}` : `agent:${p.agentId}`
      if (p.done) {
        dropStreamBuf(key)
        set((s) => {
          if (!(key in s.streaming)) return s
          const streaming = { ...s.streaming }
          delete streaming[key]
          return { streaming }
        })
      } else {
        const agent = get().agents.find((a) => a.id === p.agentId)
        // 不直接写 store：进缓冲区，50ms 合并一次，避免每个 token 触发一轮 React 渲染
        scheduleStream(key, {
          agentId: p.agentId,
          projectId: p.projectId,
          threadId: p.threadId,
          senderName: agent?.name || '对方',
          senderAvatar: agent?.avatar || '🤖',
          text: p.text,
          ...(p.reasoning ? { reasoning: p.reasoning } : {}),
          ...(p.tools?.length ? { tools: p.tools } : {}),
        })
      }
    } else if (what === 'menu-action') {
      // 应用菜单动作（主进程转发）
      const { action, value } = (payload || {}) as { action: string; value?: string }
      if (action === 'settings') {
        set({ tab: 'settings' })
      } else if (action === 'theme' && (value === 'light' || value === 'dark' || value === 'system')) {
        void api.invoke(IPC.settingsSet, { theme: value })
        applyTheme(value)
        void get().refreshSettings()
      } else if (action === 'new-session') {
        const { active } = get()
        if (active?.kind === 'agent') void get().newAgentSession(active.id)
      } else if (action === 'new-group') {
        window.dispatchEvent(new CustomEvent('jeff:new-group'))
      } else if (action === 'usage') {
        const xiaojie = get().agents.find((a) => a.builtin)
        if (xiaojie) {
          set({ tab: 'chats', active: { kind: 'agent', id: xiaojie.id } })
        }
      } else if (action === 'browser') {
        const b = get().browser
        set({ browser: { ...b, visible: !b.visible } })
      } else if (action === 'toggle-list') {
        get().setLayout({ listVisible: !get().layout.listVisible })
      } else if (action === 'reset-layout') {
        // 「显示 → 重置窗口布局」：把三栏宽度与显隐恢复出厂（浏览器可见性不动，那是面板开关不是布局）
        get().setLayout({
          listVisible: true,
          listWidth: LIST_DEFAULT_WIDTH,
          browserWidth: defaultBrowserWidth(window.innerWidth),
        })
      } else if (action === 'schedules') {
        set({ tab: 'schedules' })
        void get().refreshCron()
      } else if (action === 'plugins') {
        set({ tab: 'plugins' })
        void get().refreshPlugins()
      }
    } else if (what === 'navigate-chat') {
      // 点击系统通知 → 主进程唤起窗口并指路，这里切到对应会话（ChatWindow 挂载时会自己拉历史）
      const { kind, id } = (payload || {}) as { kind?: 'agent' | 'group'; id?: string }
      if ((kind === 'agent' || kind === 'group') && id) set({ tab: 'chats', active: { kind, id } })
    } else if (what === 'chat-updated') {
      const { agentId } = (payload || {}) as { agentId?: string; sessionId?: string }
      const key = `agent:${agentId}`
      dropStreamBuf(key)
      set((s) => {
        if (!(key in s.streaming)) return s
        const streaming = { ...s.streaming }
        delete streaming[key]
        return { streaming }
      })
      if (agentId && active?.kind === 'agent' && active.id === agentId) {
        void get().loadHistory(`agent:${agentId}`)
      }
    } else if (what === 'group-updated') {
      const { projectId, threadId } = (payload || {}) as { projectId?: string; threadId?: string }
      const key = `group:${projectId}`
      dropStreamBuf(key)
      set((s) => {
        if (!(key in s.streaming)) return s
        const streaming = { ...s.streaming }
        delete streaming[key]
        return { streaming }
      })
      // 只刷新事件归属的会话：带 threadId 且与当前加载的不一致时，不动当前窗口（防旧会话的完成事件串进新会话）
      const curThread = projectId ? get().groupThreads[projectId] : undefined
      if (projectId && (!threadId || !curThread || threadId === curThread) && active?.kind === 'group' && active.id === projectId) {
        void get().loadGroupHistory(projectId)
      }
      void get().refreshProjects()
    } else if (what === 'agents') {
      void get().refreshAgents()
    } else if (what === 'plugins') {
      void get().refreshPlugins()
    } else if (what === 'cron-turn-done') {
      // 定时任务有自己的会话/话题，不能重拉用户正在看的聊天（会把别人的回复摘要塞进当前窗口的通知）
      const p = (payload || {}) as { kind?: 'agent' | 'group'; id?: string; taskName?: string; threadId?: string }
      const { active, tab } = get()
      if (p.kind === 'group' && p.id && p.threadId && tab === 'chats' && active?.kind === 'group' && active.id === p.id && get().groupThreads[p.id] === p.threadId) {
        void get().loadGroupHistory(p.id).catch(() => {})
      }
      notifyTurnDone(p.kind === 'agent' ? `agent:${p.id || ''}` : p.id || '', p.kind === 'group' ? 'group' : 'agent', p.threadId, {
        title: p.taskName || '定时任务',
        body: '定时任务已完成',
      })
    } else if (what === 'cron' || what === 'cron-updated') {
      void get().refreshCron()
      // 任务定义/运行状态变了即可；专属会话的消息不刷进用户当前窗口
      void get().refreshProjects()
    } else if (what === 'projects' || what === 'tasks') {
      void get().refreshProjects()
      if (active?.kind === 'group') void get().loadTasks(active.id)
      if (active?.kind === 'group') void get().loadGroupHistory(active.id)
    } else if (what === 'sidecar-status') {
      void get().refreshAppInfo()
      // 引擎就绪后补拉模型目录（启动竞态兜底）
      const st = (payload || {}) as { status?: string }
      if (st.status === 'running') void get().refreshCatalog()
    } else if (what === 'settings') {
      void get().refreshSettings()
    }
  },
}))

export function applyTheme(theme: 'system' | 'light' | 'dark' | undefined): void {
  const root = document.documentElement
  if (!theme || theme === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = dark ? 'dark' : 'light'
  } else {
    root.dataset.theme = theme
  }
}

/** 主题包（皮肤）：当前仅 weui */
export function applyThemePack(pack: 'weui' | undefined): void {
  document.documentElement.dataset.themePack = pack || 'weui'
}

/**
 * 由插件清单派生 `/` 指令列表：只有已启用且清单合法的插件才提供指令。
 * 派生而非单独存 state —— 指令永远是插件状态的函数，存两份必然出现漂移。
 */
export function slashCommandsOf(plugins: PluginInfo[]): SlashCommand[] {
  const out: SlashCommand[] = []
  for (const p of plugins) {
    if (!p.enabled || p.error) continue
    for (const c of p.commands) {
      out.push({
        name: c.name,
        ...(c.description ? { description: c.description } : {}),
        prompt: c.prompt,
        pluginId: p.id,
        pluginName: p.name,
        icon: p.icon,
        ...(p.iconSvg ? { iconSvg: p.iconSvg } : {}),
      })
    }
  }
  return out
}

/** 把 system 主题解析为实际生效的亮/深夜 */
export function effectiveTheme(theme: 'system' | 'light' | 'dark' | undefined): 'light' | 'dark' {
  if (theme === 'dark' || theme === 'light') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
