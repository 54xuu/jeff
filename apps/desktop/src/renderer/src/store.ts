import { create } from 'zustand'
import { api } from './api'
import type { AgentInfo, ChatMsg, AppInfo, AppSettings, ProviderCatalogItem } from '@jeff/core'
import { IPC } from '@jeff/core'

export type Tab = 'chats' | 'contacts' | 'settings'
export type ActiveChat = { kind: 'agent'; id: string } | { kind: 'group'; id: string } | null

interface JeffState {
  tab: Tab
  active: ActiveChat
  agents: AgentInfo[]
  messages: Record<string, ChatMsg[]> // key: agent:<id> | group:<id>
  sending: Record<string, boolean>
  appInfo: AppInfo | null
  settings: AppSettings | null
  catalog: ProviderCatalogItem[]
  setTab: (t: Tab) => void
  setActive: (a: ActiveChat) => void
  refreshAgents: () => Promise<void>
  loadHistory: (key: string) => Promise<void>
  sendAgent: (agentId: string, text: string, model?: { providerID: string; modelID: string }) => Promise<void>
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
  messages: {},
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

  loadHistory: async (key) => {
    if (key.startsWith('agent:')) {
      const agentId = key.slice(6)
      const msgs = await api.invoke<ChatMsg[]>(IPC.chatHistory, { agentId })
      set((s) => ({ messages: { ...s.messages, [key]: msgs } }))
    }
  },

  sendAgent: async (agentId, text, model) => {
    const key = `agent:${agentId}`
    const now = Date.now()
    set((s) => ({ sending: { ...s.sending, [key]: true } }))
    // 乐观追加用户消息（去重：SSE 刷新会覆盖）
    set((s) => ({
      messages: {
        ...s.messages,
        [key]: [...(s.messages[key] || []), { id: `local-${now}`, role: 'user', text, time: now }],
      },
    }))
    try {
      await api.invoke(IPC.chatSend, { agentId, text, model })
    } finally {
      set((s) => ({ sending: { ...s.sending, [key]: false } }))
      await get().loadHistory(key)
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
      const { agentId, sessionId } = payload as { agentId: string; sessionId: string }
      if (active?.kind === 'agent' && active.id === agentId) {
        void get().loadHistory(`agent:${agentId}`)
      }
    } else if (what === 'agents') {
      void get().refreshAgents()
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
