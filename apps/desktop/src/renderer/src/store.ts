import { create } from 'zustand'
import { api } from './api'
import type { AgentInfo, ChatMsg, AppInfo, AppSettings, ProviderCatalogItem, ProjectInfo, ProjectMember, TaskInfo, GroupMessage } from '@jeff/core'
import { IPC } from '@jeff/core'

export type Tab = 'chats' | 'contacts' | 'settings'
export type ActiveChat = { kind: 'agent'; id: string } | { kind: 'group'; id: string } | null

interface JeffState {
  tab: Tab
  active: ActiveChat
  agents: AgentInfo[]
  projects: ProjectInfo[]
  messages: Record<string, ChatMsg[]>
  groupMessages: Record<string, GroupMessage[]>
  tasks: Record<string, TaskInfo[]>
  sending: Record<string, boolean>
  appInfo: AppInfo | null
  settings: AppSettings | null
  catalog: ProviderCatalogItem[]
  setTab: (t: Tab) => void
  setActive: (a: ActiveChat) => void
  refreshAgents: () => Promise<void>
  refreshProjects: () => Promise<void>
  loadHistory: (key: string) => Promise<void>
  loadGroupHistory: (projectId: string) => Promise<void>
  loadTasks: (projectId: string) => Promise<void>
  sendAgent: (agentId: string, text: string, model?: { providerID: string; modelID: string }) => Promise<void>
  sendGroup: (projectId: string, text: string, model?: { providerID: string; modelID: string }) => Promise<void>
  newAgentSession: (agentId: string) => Promise<void>
  stopAgent: (agentId: string) => Promise<void>
  refreshAppInfo: () => Promise<void>
  refreshSettings: () => Promise<void>
  refreshCatalog: () => Promise<void>
  handlePush: (what: string, payload?: unknown) => void
}

export const useStore = create<JeffState>((set, get) => ({
  tab: 'chats',
  active: null,
  agents: [],
  projects: [],
  messages: {},
  groupMessages: {},
  tasks: {},
  sending: {},
  appInfo: null,
  settings: null,
  catalog: [],

  setTab: (tab) => set({ tab }),
  setActive: (active) => set({ active }),

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

  sendAgent: async (agentId, text, model) => {
    const key = `agent:${agentId}`
    const now = Date.now()
    set((s) => ({ sending: { ...s.sending, [key]: true } }))
    set((s) => ({
      messages: {
        ...s.messages,
        [key]: [...(s.messages[key] || []), { id: `local-${now}`, role: 'user', text, time: now }],
      },
    }))
    try {
      await api.invoke(IPC.chatSend, { agentId, text, model })
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

  sendGroup: async (projectId, text, model) => {
    const key = projectId
    const now = Date.now()
    set((s) => ({ sending: { ...s.sending, [`group:${key}`]: true } }))
    set((s) => ({
      groupMessages: {
        ...s.groupMessages,
        [key]: [
          ...(s.groupMessages[key] || []),
          { id: `local-${now}`, role: 'user', text, time: now, sender_name: '我', sender_avatar: '🧑' },
        ],
      },
    }))
    try {
      await api.invoke(IPC.groupSend, { projectId, text, model })
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
    try {
      const { catalog } = await api.invoke<{ catalog: ProviderCatalogItem[] }>(IPC.providersCatalog)
      set({ catalog })
    } catch {
      set({ catalog: [] })
    }
  },

  handlePush: (what, payload) => {
    const { active } = get()
    if (what === 'chat-updated') {
      const { agentId } = (payload || {}) as { agentId?: string; sessionId?: string }
      if (agentId && active?.kind === 'agent' && active.id === agentId) {
        void get().loadHistory(`agent:${agentId}`)
      }
    } else if (what === 'group-updated') {
      const { projectId } = (payload || {}) as { projectId?: string }
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
