import { create } from 'zustand'
import { api } from './api'
import type { AgentInfo, ChatMsg, AppInfo, AppSettings, ProviderCatalogItem, ProjectInfo, ProjectMember, TaskInfo, GroupMessage, ChatImage } from '@jeff/core'
import { IPC } from '@jeff/core'

export type Tab = 'chats' | 'contacts' | 'settings'
export type ActiveChat = { kind: 'agent'; id: string } | { kind: 'group'; id: string } | null
export type SettingsSection = 'providers' | 'mcp' | 'memory' | 'engine' | 'sync' | 'appearance' | 'about'

/** 进行中的流式回复（key: agent:<id> / group:<id>） */
export interface StreamState {
  agentId?: string
  projectId?: string
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
  tasks: Record<string, TaskInfo[]>
  sending: Record<string, boolean>
  /** 流式回复增量（key: agent:<id> / group:<id>；完成时清空） */
  streaming: Record<string, StreamState>
  appInfo: AppInfo | null
  settings: AppSettings | null
  catalog: ProviderCatalogItem[]
  setTab: (t: Tab) => void
  setActive: (a: ActiveChat) => void
  setSettingsSection: (s: SettingsSection) => void
  refreshAgents: () => Promise<void>
  refreshProjects: () => Promise<void>
  loadHistory: (key: string) => Promise<void>
  loadGroupHistory: (projectId: string) => Promise<void>
  loadTasks: (projectId: string) => Promise<void>
  sendAgent: (agentId: string, text: string, model?: { providerID: string; modelID: string }, images?: ChatImage[], variant?: string) => Promise<void>
  sendGroup: (projectId: string, text: string, model?: { providerID: string; modelID: string }, images?: ChatImage[], variant?: string) => Promise<void>
  newAgentSession: (agentId: string) => Promise<void>
  stopAgent: (agentId: string) => Promise<void>
  stopGroup: (projectId: string) => Promise<void>
  refreshAppInfo: () => Promise<void>
  refreshSettings: () => Promise<void>
  refreshCatalog: () => Promise<void>
  handlePush: (what: string, payload?: unknown) => void
}

export const useStore = create<JeffState>((set, get) => ({
  tab: 'chats',
  active: null,
  settingsSection: 'providers',
  agents: [],
  projects: [],
  messages: {},
  groupMessages: {},
  tasks: {},
  sending: {},
  streaming: {},
  appInfo: null,
  settings: null,
  catalog: [],

  setTab: (tab) => set({ tab }),
  setActive: (active) => set({ active }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),

  refreshAgents: async () => {
    const agents = await api.invoke<AgentInfo[]>(IPC.agentsList)
    set({ agents })
  },

  refreshProjects: async () => {
    const projects = await api.invoke<ProjectInfo[]>(IPC.projectsList)
    set({ projects })
  },

  loadHistory: async (key) => {
    if (key.startsWith('agent:')) {
      const agentId = key.slice(6)
      const msgs = await api.invoke<ChatMsg[]>(IPC.chatHistory, { agentId })
      set((s) => ({ messages: { ...s.messages, [key]: msgs } }))
    }
  },

  loadGroupHistory: async (projectId) => {
    const msgs = await api.invoke<GroupMessage[]>(IPC.groupHistory, { projectId })
    set((s) => ({ groupMessages: { ...s.groupMessages, [projectId]: msgs } }))
  },

  loadTasks: async (projectId) => {
    const tasks = await api.invoke<TaskInfo[]>(IPC.tasksList, { projectId })
    set((s) => ({ tasks: { ...s.tasks, [projectId]: tasks } }))
  },

  sendAgent: async (agentId, text, model, images, variant) => {
    const key = `agent:${agentId}`
    const now = Date.now()
    set((s) => ({ sending: { ...s.sending, [key]: true } }))
    set((s) => ({
      messages: {
        ...s.messages,
        [key]: [...(s.messages[key] || []), { id: `local-${now}`, role: 'user', text, time: now, ...(images && images.length ? { images } : {}) }],
      },
    }))
    try {
      await api.invoke(IPC.chatSend, { agentId, text, model, ...(variant ? { variant } : {}), ...(images && images.length ? { images } : {}) })
    } catch (err) {
      set((s) => ({
        messages: {
          ...s.messages,
          [key]: [...(s.messages[key] || []), { id: `err-${now}`, role: 'system', text: `⚠️ 发送失败：${String((err as Error).message).slice(0, 200)}`, time: Date.now() }],
        },
      }))
    } finally {
      set((s) => ({ sending: { ...s.sending, [key]: false } }))
      await get().loadHistory(key)
    }
  },

  sendGroup: async (projectId, text, model, images, variant) => {
    const key = projectId
    const now = Date.now()
    set((s) => ({ sending: { ...s.sending, [`group:${key}`]: true } }))
    set((s) => ({
      groupMessages: {
        ...s.groupMessages,
        [key]: [
          ...(s.groupMessages[key] || []),
          { id: `local-${now}`, role: 'user', text, time: now, ...(images && images.length ? { images } : {}), sender_name: '我', sender_avatar: '🧑' },
        ],
      },
    }))
    try {
      await api.invoke(IPC.groupSend, { projectId, text, model, ...(variant ? { variant } : {}), ...(images && images.length ? { images } : {}) })
    } catch (err) {
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
      await get().loadGroupHistory(key)
      await get().loadTasks(key)
    }
  },

  newAgentSession: async (agentId) => {
    await api.invoke(IPC.chatNew, { agentId })
    await get().loadHistory(`agent:${agentId}`)
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
      const p = (payload || {}) as { kind: 'private' | 'group'; agentId: string; projectId?: string; text: string; reasoning?: string; tools?: Array<{ tool: string; status?: string }>; done: boolean }
      const key = p.kind === 'group' ? `group:${p.projectId}` : `agent:${p.agentId}`
      if (p.done) {
        set((s) => {
          if (!(key in s.streaming)) return s
          const streaming = { ...s.streaming }
          delete streaming[key]
          return { streaming }
        })
      } else {
        const agent = get().agents.find((a) => a.id === p.agentId)
        set((s) => ({
          streaming: {
            ...s.streaming,
            [key]: { agentId: p.agentId, projectId: p.projectId, senderName: agent?.name || '对方', senderAvatar: agent?.avatar || '🤖', text: p.text, ...(p.reasoning ? { reasoning: p.reasoning } : {}), ...(p.tools?.length ? { tools: p.tools } : {}) },
          },
        }))
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
      }
    } else if (what === 'chat-updated') {
      const { agentId } = (payload || {}) as { agentId?: string; sessionId?: string }
      const key = `agent:${agentId}`
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
      const { projectId } = (payload || {}) as { projectId?: string }
      const key = `group:${projectId}`
      set((s) => {
        if (!(key in s.streaming)) return s
        const streaming = { ...s.streaming }
        delete streaming[key]
        return { streaming }
      })
      if (projectId && active?.kind === 'group' && active.id === projectId) {
        void get().loadGroupHistory(projectId)
      }
      void get().refreshProjects()
    } else if (what === 'agents') {
      void get().refreshAgents()
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

/** 把 system 主题解析为实际生效的亮/深夜 */
export function effectiveTheme(theme: 'system' | 'light' | 'dark' | undefined): 'light' | 'dark' {
  if (theme === 'dark' || theme === 'light') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
