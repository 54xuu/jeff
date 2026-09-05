import type { ChatMsg } from '../chat/private.js'
import type { ProviderSetting } from '../oc/configWriter.js'

// 渲染进程把 @jeff/core 别名到本文件（避免 node 依赖进浏览器 bundle）；
// parseMcpServerJson / McpServerCfg 是纯 TS，从这里再导出供渲染层使用。
export { parseMcpServerJson } from '../mcp/parse.js'
export type { McpServerCfg } from '../mcp/parse.js'

/** 内置小杰（管家）agent id —— 渲染进程也要用，放契约里（无 node 依赖） */
export const XIAOJIE_ID = 'agt_xiaojie'

/** 内置 provider 预设（纯数据，走 models.dev 目录，只需 key） */
export const BUILTIN_PROVIDER_PRESETS: Array<{ id: string; name: string }> = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'moonshotai', name: 'Moonshot (Kimi)' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'google', name: 'Google Gemini' },
  { id: 'zhipuai', name: '智谱 GLM' },
  { id: 'siliconflow-cn', name: '硅基流动（中国站）' },
  { id: 'siliconflow', name: '硅基流动（国际站）' },
]

export type { ChatMsg }

// ---------- IPC 频道名 ----------
export const IPC = {
  // invoke（渲染 → 主）
  appInfo: 'app:info',
  agentsList: 'agents:list',
  agentsGet: 'agents:get',
  agentsUpsert: 'agents:upsert',
  agentsDelete: 'agents:delete',
  chatHistory: 'chat:history',
  chatSend: 'chat:send',
  chatNew: 'chat:new',
  chatStop: 'chat:stop',
  projectsList: 'projects:list',
  projectSave: 'project:save',
  projectDelete: 'project:delete',
  projectMembers: 'project:members',
  projectAddMember: 'project:addMember',
  projectRemoveMember: 'project:removeMember',
  tasksList: 'tasks:list',
  taskSave: 'task:save',
  taskDelete: 'task:delete',
  groupHistory: 'group:history',
  groupSend: 'group:send',
  providersList: 'providers:list',
  providersSave: 'providers:save',
  providersCatalog: 'providers:catalog',
  modelsDefault: 'models:default',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  mcpList: 'mcp:list',
  mcpSave: 'mcp:save',
  memoryScopes: 'memory:scopes',
  memoryGet: 'memory:get',
  memorySave: 'memory:save',
  syncNow: 'sync:now',
  syncStatus: 'sync:status',
  syncConfigure: 'sync:configure',
  // 冒烟钩子（仅 JEFF_SMOKE=1 时注册）
  smokeShot: 'smoke:shot',
  smokeDone: 'smoke:done',
  // 事件（主 → 渲染）
  evStatus: 'ev:status',
  evSidecarLog: 'ev:sidecar-log',
  evChatUpdated: 'ev:chat-updated',
  evDataChanged: 'ev:data-changed',
  evGroupUpdated: 'ev:group-updated',
  evSync: 'ev:sync',
  evChatStream: 'ev:chat-stream',
} as const

// ---------- 共享类型 ----------
export interface AgentInfo {
  id: string
  name: string
  avatar: string
  description: string
  instructions: string
  model_provider: string
  model_id: string
  builtin: boolean
  archived: boolean
}

export interface ProjectInfo {
  id: string
  title: string
  description: string
  icon: string
  status: string
  leader_agent_id: string | null
  updated_at: number
  memberCount: number
}

export interface ProjectMember {
  agent_id: string
  role: string
  name: string
  avatar: string
}

export interface TaskInfo {
  id: string
  project_id: string
  number: number
  key: string // JEF-n
  title: string
  description: string
  status: string
  priority: string
  assignee_type: string
  assignee_id: string
  parent_task_id: string | null
}

export interface GroupMessage extends ChatMsg {
  sender_name: string
  sender_avatar: string
}

export interface ModelOption {
  providerID: string
  modelID: string
  label: string
}

export interface ProviderCatalogItem {
  id: string
  name: string
  models: ModelOption[]
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  defaultModel: { providerID: string; modelID: string } | null
  webdav?: { url: string; username: string; basePath: string; autoSync: boolean } | null
}

export interface AppInfo {
  version: string
  sidecarStatus: string
  opencodeBinary: string | null
  dataDir: string
  jeffVersion: string
}

export interface MemoryScopeInfo {
  kind: 'user' | 'agent' | 'project'
  id: string // user | agentId | projectId
  label: string
  file: string
}

/** 聊天里随文本一起发送的图片（dataURL 内联，≤ 若干 MB） */
export interface ChatImage {
  mime: string
  dataUrl: string
}

export type InvokeMap = {
  [IPC.appInfo]: void
  [IPC.agentsList]: void
  [IPC.agentsGet]: { id: string }
  [IPC.agentsUpsert]: { id?: string; name: string; avatar?: string; description?: string; instructions?: string; model_provider?: string; model_id?: string }
  [IPC.agentsDelete]: { id: string }
  [IPC.chatHistory]: { agentId: string }
  [IPC.chatSend]: { agentId: string; text: string; model?: { providerID: string; modelID: string }; images?: ChatImage[] }
  [IPC.chatNew]: { agentId: string }
  [IPC.chatStop]: { agentId: string }
  [IPC.projectsList]: void
  [IPC.projectSave]: { id?: string; title: string; description?: string; icon?: string; leader_agent_id?: string | null; memberAgentIds?: string[] }
  [IPC.projectDelete]: { id: string }
  [IPC.projectMembers]: { projectId: string }
  [IPC.projectAddMember]: { projectId: string; agentId: string; role?: string }
  [IPC.projectRemoveMember]: { projectId: string; agentId: string }
  [IPC.tasksList]: { projectId: string }
  [IPC.taskSave]: { id?: string; project_id: string; title: string; description?: string; status?: string; priority?: string; assignee_id?: string }
  [IPC.taskDelete]: { id: string }
  [IPC.groupHistory]: { projectId: string }
  [IPC.groupSend]: { projectId: string; text: string; model?: { providerID: string; modelID: string }; images?: ChatImage[] }
  [IPC.providersList]: void
  [IPC.providersSave]: { providers: ProviderSetting[]; defaultModel?: { providerID: string; modelID: string } | null }
  [IPC.providersCatalog]: void
  [IPC.modelsDefault]: { defaultModel?: { providerID: string; modelID: string } | null }
  [IPC.settingsGet]: void
  [IPC.settingsSet]: { theme?: AppSettings['theme'] }
  [IPC.mcpList]: void
  [IPC.mcpSave]: { servers: Record<string, { type: 'local' | 'remote'; enabled: boolean; command?: string[]; url?: string; headers?: Record<string, string> }> }
  [IPC.memoryScopes]: void
  [IPC.memoryGet]: { kind: 'user' | 'agent' | 'project'; id: string }
  [IPC.memorySave]: { kind: 'user' | 'agent' | 'project'; id: string; content: string }
  [IPC.syncNow]: void
  [IPC.syncStatus]: void
  [IPC.syncConfigure]: { url: string; username: string; password: string; basePath: string; autoSync: boolean }
  [IPC.smokeShot]: { name: string }
  [IPC.smokeDone]: void
}

export type EventPayloads = {
  [IPC.evStatus]: { status: string; error?: string }
  [IPC.evSidecarLog]: { line: string }
  [IPC.evChatUpdated]: { agentId: string; sessionId: string }
  [IPC.evDataChanged]: { what: 'agents' | 'projects' | 'tasks' | 'settings' }
  [IPC.evGroupUpdated]: { projectId: string }
  [IPC.evSync]: { state: string; detail?: string }
  [IPC.evChatStream]: { kind: 'private' | 'group'; agentId: string; projectId?: string; messageId: string; text: string; done: boolean }
}
