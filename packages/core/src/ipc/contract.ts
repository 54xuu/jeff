import type { ChatMsg } from '../chat/private.js'
import type { ProviderSetting } from '../oc/configWriter.js'

// 渲染进程把 @jeff/core 别名到本文件（避免 node 依赖进浏览器 bundle）；
// parseMcpServersJson / parseMcpServerJson / McpServerCfg 是纯 TS，从这里再导出供渲染层使用。
export { parseMcpServersJson, parseMcpServerJson } from '../mcp/parse.js'
export type { McpServerCfg } from '../mcp/parse.js'

/** 内置小杰（管家）agent id —— 渲染进程也要用，放契约里（无 node 依赖） */
export const XIAOJIE_ID = 'agt_xiaojie'

/** 模型思考档位（跨厂商统一：见 thinkingVariant；Chat 关思考用 thinking.type=disabled） */
export type ThinkingTier = 'none' | 'low' | 'high' | 'max'
export const THINKING_TIERS: ThinkingTier[] = ['none', 'low', 'high', 'max']

/** 供应商 API 格式：决定 opencode 使用的适配包 */
export type ApiFormat = 'chat' | 'responses' | 'anthropic'
export const API_FORMATS: Array<{ id: ApiFormat; label: string; hint: string }> = [
  { id: 'chat', label: 'Chat 格式', hint: 'OpenAI 兼容 /chat/completions，绝大多数中转站与国产模型' },
  { id: 'responses', label: 'Responses 格式', hint: 'OpenAI 官方 /responses 接口（GPT-5 / o 系列推荐）' },
  { id: 'anthropic', label: 'Anthropic 格式', hint: 'Anthropic 官方 /v1/messages，如 Claude 系列' },
]

export type { ChatMsg }

// ---------- IPC 频道名 ----------
export const IPC = {
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
  groupStop: 'group:stop',
  providersList: 'providers:list',
  providersSave: 'providers:save',
  providersCatalog: 'providers:catalog',
  providersProbe: 'providers:probe',
  modelsConfigured: 'models:configured',
  sessionsList: 'sessions:list',
  sessionPreview: 'session:preview',
  sessionActivate: 'session:activate',
  sessionDelete: 'session:delete',
  sessionRename: 'session:rename',
  groupThreadsList: 'group:threadsList',
  groupThreadNew: 'group:threadNew',
  groupThreadActivate: 'group:threadActivate',
  groupThreadRename: 'group:threadRename',
  groupThreadDelete: 'group:threadDelete',
  groupThreadPreview: 'group:threadPreview',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  mcpList: 'mcp:list',
  mcpSave: 'mcp:save',
  mcpProbe: 'mcp:probe',
  memoryScopes: 'memory:scopes',
  memoryGet: 'memory:get',
  memorySave: 'memory:save',
  agentsMdList: 'agentsmd:list',
  agentsMdGet: 'agentsmd:get',
  agentsMdSave: 'agentsmd:save',
  sidecarRestart: 'sidecar:restart',
  sidecarLogs: 'sidecar:logs',
  llmTlsGet: 'llmTls:get',
  llmTlsSet: 'llmTls:set',
  debugLogGet: 'debugLog:get',
  debugLogSet: 'debugLog:set',
  dialogPickDir: 'dialog:pickDir',
  skillsBackupNow: 'skills:backupNow',
  skillsLast: 'skills:last',
  skillsRestoreStage: 'skills:restoreStage',
  skillsRestoreApply: 'skills:restoreApply',
  syncNow: 'sync:now',
  syncStatus: 'sync:status',
  syncConfigure: 'sync:configure',
  contextPreview: 'context:preview',
  contextCompress: 'context:compress',
  // 工作空间文件浏览（资料抽屉「工作区文件」Tab + Markdown 预览器）
  fsListFiles: 'fs:listFiles',
  fsReadFile: 'fs:readFile',
  fsOpenPath: 'fs:openPath',
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
  /** 默认思考档位（'' = 跟随模型配置） */
  thinking: string
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
  /** 工作空间目录（空 = 全局 workspace；未指定输出目录时文件都保存到工作空间） */
  workspace_dir: string
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
  /** 该模型支持的思考档位（来自供应商配置；空 = 无思考下拉） */
  thinkingTiers?: ThinkingTier[]
}

export interface ProviderCatalogItem {
  id: string
  name: string
  models: ModelOption[]
}

/** 历史会话简要（私聊聊天记录抽屉） */
export interface SessionBrief {
  id: string
  title: string
  /** 最近更新时间（ms） */
  updatedAt: number
  /** 是否为当前会话 */
  active: boolean
  /** 归属 agent（私聊） */
  agentId: string
  agentName: string
}

/** 项目群话题（一段群聊历史，类微信） */
export interface GroupThreadBrief {
  id: string
  title: string
  updatedAt: number
  createdAt: number
  active: boolean
  /** 消息条数（可选展示） */
  messageCount?: number
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  /** 主题包（视觉皮肤）；当前仅 weui，为后续扩展预留 */
  themePack: 'weui'
  /** 会话无覆盖且 agent 无绑定时的兜底模型（动态计算 = 第一个启用提供商的第一个模型） */
  defaultModel: { providerID: string; modelID: string } | null
  webdav?: {
    url: string
    username: string
    basePath: string
    autoSync: boolean
    /** 单次请求超时 ms；默认 60000 */
    timeoutMs?: number
    /** 是否校验证书；默认 true */
    tlsVerify?: boolean
  } | null
}

/** 对话上下文预览（占用 + system / 摘要 / 活跃消息） */
export interface ContextPreviewInfo {
  sessionId: string | null
  agentId: string
  projectId?: string
  usedTokens: number
  contextLimit: number | null
  outputLimit: number | null
  /** 自动压缩阈值；null = 未配置 contextLimit，自动压缩未启用 */
  threshold: number | null
  autoEnabled: boolean
  system: string | null
  summary: string | null
  activeMessages: ChatMsg[]
  compactedCount: number
}

export interface AppInfo {
  version: string
  sidecarStatus: string
  sidecarError?: string
  sidecarPort?: number
  opencodeBinary: string | null
  opencodeVersion?: string
  dataDir: string
  jeffVersion: string
}

export interface MemoryScopeInfo {
  kind: 'user' | 'agent' | 'project'
  id: string // user | agentId | projectId
  label: string
  file: string
}

/** AGENTS.md 文件信息（用户级 / 项目级） */
export interface AgentsMdInfo {
  kind: 'user' | 'project'
  id: string // user | projectId
  label: string
  file: string
  /** 是否存在 */
  exists: boolean
}

/** 聊天里随文本一起发送的图片（dataURL 内联，≤ 若干 MB） */
export interface ChatImage {
  mime: string
  dataUrl: string
}

/** MCP 探测结果（设置页展示连接状态与工具清单） */
export interface McpProbeResult {
  name: string
  status: 'ok' | 'error' | 'disabled'
  tools: string[]
  toolCount: number
  error?: string
  /** 探测耗时 ms */
  elapsedMs: number
}

/** 模型连通探测结果（设置页模型行「测试」按钮） */
export interface ProviderProbeResult {
  ok: boolean
  error?: string
  /** 探测耗时 ms */
  elapsedMs: number
}

/** skills 备份报告（单向备份，永不删除远端） */
export interface SkillsBackupReport {
  ok: boolean
  at: number
  /** 上传/归档的文件数 */
  uploaded: number
  /** 归档到 skills-versions 的旧版本数 */
  archived: number
  /** 跳过（内容未变化）的文件数 */
  skipped: number
  error?: string
}

/** skills 恢复（两段式：stage 下载到暂存区预览 → apply 快照本地后覆盖） */
export interface SkillsRestoreStage {
  ok: boolean
  files: string[]
  total: number
  error?: string
}

export interface SkillsRestoreApply {
  ok: boolean
  restored: number
  /** 恢复前本地快照目录（可手工回退） */
  snapshotDir: string
  error?: string
}

/** 工作空间文件树节点（fsListFiles 返回；目录在前、按名排序） */
export interface FileNode {
  name: string
  /** 相对列出目录的路径（POSIX 风格 / 分隔） */
  rel: string
  /** 绝对路径 */
  abs: string
  dir: boolean
  ext: string
  /** 字节（文件） */
  size: number
  /** 修改时间 ms */
  mtime: number
  children?: FileNode[]
  /** 子节点被截断（超出单节点上限） */
  truncated?: boolean
}

export type InvokeMap = {
  [IPC.appInfo]: void
  [IPC.agentsList]: void
  [IPC.agentsGet]: { id: string }
  [IPC.agentsUpsert]: {
    id?: string
    name: string
    avatar?: string
    description?: string
    instructions?: string
    model_provider?: string
    model_id?: string
    thinking?: string
  }
  [IPC.agentsDelete]: { id: string }
  [IPC.chatHistory]: { agentId: string }
  [IPC.chatSend]: { agentId: string; text: string; model?: { providerID: string; modelID: string }; variant?: string; images?: ChatImage[] }
  [IPC.chatNew]: { agentId: string }
  [IPC.chatStop]: { agentId: string }
  [IPC.projectsList]: void
  [IPC.projectSave]: { id?: string; title: string; description?: string; icon?: string; leader_agent_id?: string | null; memberAgentIds?: string[]; workspace_dir?: string }
  [IPC.projectDelete]: { id: string }
  [IPC.projectMembers]: { projectId: string }
  [IPC.projectAddMember]: { projectId: string; agentId: string; role?: string }
  [IPC.projectRemoveMember]: { projectId: string; agentId: string }
  [IPC.tasksList]: { projectId: string }
  [IPC.taskSave]: { id?: string; project_id: string; title: string; description?: string; status?: string; priority?: string; assignee_id?: string }
  [IPC.taskDelete]: { id: string }
  [IPC.groupHistory]: { projectId: string }
  [IPC.groupSend]: { projectId: string; text: string; model?: { providerID: string; modelID: string }; variant?: string; images?: ChatImage[] }
  [IPC.groupStop]: { projectId: string }
  [IPC.providersList]: void
  [IPC.providersSave]: { providers: ProviderSetting[] }
  [IPC.providersCatalog]: void
  [IPC.providersProbe]: { provider: ProviderSetting; modelId: string }
  [IPC.modelsConfigured]: void
  [IPC.sessionsList]: { agentId?: string; projectId?: string }
  [IPC.sessionPreview]: { sessionId: string }
  [IPC.sessionActivate]: { scope: 'private' | 'group'; agentId: string; projectId?: string; sessionId: string }
  [IPC.sessionDelete]: { sessionId: string }
  [IPC.sessionRename]: { sessionId: string; title: string }
  [IPC.groupThreadsList]: { projectId: string }
  [IPC.groupThreadNew]: { projectId: string; title?: string }
  [IPC.groupThreadActivate]: { projectId: string; threadId: string }
  [IPC.groupThreadRename]: { projectId: string; threadId: string; title: string }
  [IPC.groupThreadDelete]: { projectId: string; threadId: string }
  [IPC.groupThreadPreview]: { projectId: string; threadId: string }
  [IPC.settingsGet]: void
  [IPC.settingsSet]: { theme?: AppSettings['theme']; themePack?: AppSettings['themePack'] }
  [IPC.mcpList]: void
  [IPC.mcpSave]: { servers: Record<string, { type: 'local' | 'remote'; enabled: boolean; command?: string[]; url?: string; headers?: Record<string, string> }> }
  [IPC.mcpProbe]: void
  [IPC.memoryScopes]: void
  [IPC.memoryGet]: { kind: 'user' | 'agent' | 'project'; id: string }
  [IPC.memorySave]: { kind: 'user' | 'agent' | 'project'; id: string; content: string }
  [IPC.agentsMdList]: void
  [IPC.agentsMdGet]: { kind: 'user' | 'project'; id: string }
  [IPC.agentsMdSave]: { kind: 'user' | 'project'; id: string; content: string }
  [IPC.sidecarRestart]: void
  [IPC.sidecarLogs]: void
  [IPC.llmTlsGet]: void
  [IPC.llmTlsSet]: { skip: boolean }
  [IPC.debugLogGet]: void
  [IPC.debugLogSet]: { enabled: boolean }
  [IPC.dialogPickDir]: { title?: string; defaultPath?: string }
  [IPC.skillsBackupNow]: void
  [IPC.skillsLast]: void
  [IPC.skillsRestoreStage]: void
  [IPC.skillsRestoreApply]: void
  [IPC.syncNow]: void
  [IPC.syncStatus]: void
  [IPC.syncConfigure]: {
    url: string
    username: string
    password: string
    basePath: string
    autoSync: boolean
    timeoutMs?: number
    tlsVerify?: boolean
  }
  [IPC.contextPreview]: { agentId: string; projectId?: string; model?: { providerID: string; modelID: string } }
  [IPC.contextCompress]: { agentId: string; projectId?: string; model?: { providerID: string; modelID: string } }
  [IPC.fsListFiles]: { dir: string }
  [IPC.fsReadFile]: { file: string }
  [IPC.fsOpenPath]: { target: string; reveal?: boolean }
  [IPC.smokeShot]: { name: string }
  [IPC.smokeDone]: void
}

export type EventPayloads = {
  [IPC.evStatus]: { status: string; error?: string }
  [IPC.evSidecarLog]: { line: string }
  [IPC.evChatUpdated]: { agentId: string; sessionId: string }
  [IPC.evDataChanged]: { what: 'agents' | 'projects' | 'tasks' | 'settings' }
  [IPC.evGroupUpdated]: { projectId: string; threadId?: string }
  [IPC.evSync]: { state: string; detail?: string }
  [IPC.evChatStream]: { kind: 'private' | 'group'; agentId: string; projectId?: string; threadId?: string; messageId: string; text: string; reasoning?: string; currentTool?: string; tools?: Array<{ tool: string; status?: string }>; done: boolean }
}
