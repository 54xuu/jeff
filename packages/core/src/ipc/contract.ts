import type { ChatMsg } from '../chat/private.js'
import type { ProviderSetting } from '../oc/configWriter.js'
import type { ChatPluginInvoke } from '../plugins/invoke.js'

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
  notifyDesktop: 'notify:desktop',
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
  debugLogOpenDir: 'debugLog:openDir',
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
  // 定时任务
  cronList: 'cron:list',
  cronSave: 'cron:save',
  cronDelete: 'cron:delete',
  cronRun: 'cron:run',
  cronRuns: 'cron:runs',
  // 插件
  pluginsList: 'plugins:list',
  pluginSetEnabled: 'plugin:setEnabled',
  pluginSaveSecret: 'plugin:saveSecret',
  pluginSaveSettings: 'plugin:saveSettings',
  pluginImport: 'plugin:import',
  pluginDelete: 'plugin:delete',
  pluginRefresh: 'plugin:refresh',
  pluginBackupNow: 'plugin:backupNow',
  pluginRestore: 'plugin:restore',
  pluginBackupLast: 'plugin:backupLast',
  // 内置浏览器：主进程 → 渲染层下发动作后，渲染层回传结果
  browserResult: 'browser:result',
  // 渲染层上报面板状态（是否可见 + 当前页），供 agent 工具判断可用性与上下文
  browserState: 'browser:state',
  // 页面截图：渲染层 → 主进程（capturePage 拿的是「可见帧」，尺寸不可控；改由主进程走 CDP 按矩形重新栅格化）
  browserPageShot: 'browser:pageShot',
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
  /** 分组分类（空 = 默认分组） */
  category: string
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
  /** AI 回复完成时弹系统桌面通知（文本提醒） */
  notifyDesktop: boolean
  /** AI 回复完成时播放提示音（声音提醒） */
  notifySound: boolean
  /** 仅当 Jeff 不在前台时才弹桌面通知（前台查看别的会话时只响提示音，不打扰视线） */
  notifyOnlyBackground: boolean
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

/** skills 备份报告（整目录镜像：远端 skills/ 与本地 ~/.agents/skills 保持一致） */
export interface SkillsBackupReport {
  ok: boolean
  at: number
  /** 上传的文件数（新增 + 内容变化） */
  uploaded: number
  /** 归档到 skills-versions 的旧版本数（覆盖或删除前各归档一次） */
  archived: number
  /** 跳过（内容未变化）的文件数 */
  skipped: number
  /** 远端删除的文件数（本地已不存在 → 远端同步删除，删除前归档） */
  deleted: number
  /** 本次备份的本地文件总数（ok 时返回；设置页展示） */
  fileCount?: number
  /** 本次备份总耗时 ms（设置页展示） */
  elapsedMs?: number
  error?: string
}

/** skills 恢复（两段式：stage 下载到暂存区预览 → apply 快照本地后整目录替换） */
export interface SkillsRestoreStage {
  ok: boolean
  files: string[]
  total: number
  /** 服务端坏条目等非致命告警（已跳过，不阻塞恢复） */
  warnings?: string[]
  error?: string
}

export interface SkillsRestoreApply {
  ok: boolean
  /** 从备份恢复的文件数 */
  restored: number
  /** 替换前本地原有、备份中没有而被移除的文件数 */
  removed: number
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

// ---------- 定时任务 ----------

/** 定时任务展示信息（左侧「定时」视图） */
export interface CronTaskInfo {
  id: string
  name: string
  target_type: 'agent' | 'project'
  target_id: string
  /** 目标显示名（智能体名 / 群名；目标已删时标注） */
  target_label: string
  /** 目标是否仍然存在（false = 已失效，任务会被自动停用） */
  target_exists: boolean
  cron_expr: string
  /** cron 的人性化描述（每天 08:00 等） */
  cron_human: string
  prompt: string
  miss_policy: 'catchup' | 'skip'
  enabled: boolean
  last_run_at: number | null
  next_run_at: number | null
  /** 最近一次运行状态（running/ok/failed/missed/skipped） */
  last_status: string | null
  last_error: string | null
}

/** 一次运行记录 */
export interface CronRunInfo {
  id: string
  task_id: string
  started_at: number
  finished_at: number | null
  status: string
  is_catchup: boolean
  error: string
}

// ---------- 插件 ----------

/** 插件快捷指令（聊天框 `/` 可呼出） */
export interface PluginCommand {
  name: string
  description?: string
  /** 选中后插入聊天框的提示词 */
  prompt: string
}

/** 插件声明的 MCP 接入（启用插件时自动注入 Jeff 的 MCP 配置，免手工配置） */
export interface PluginMcp {
  type?: 'local' | 'remote'
  /** remote：MCP 服务地址（如 http://127.0.0.1:8080/mcp） */
  url?: string
  /** local：启动命令 */
  command?: string[]
  environment?: Record<string, string>
  /** 认证等自定义请求头（敏感值可用 ${SECRET} 占位，取本机保存的密钥） */
  headers?: Record<string, string>
  /** 该插件关心的工具名（仅作展示，实际以服务端 tools/list 为准） */
  tools?: string[]
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  /** 图标 emoji（无 icon.svg 时的退化显示） */
  icon: string
  /** 插件目录内 icon.svg 原文（有则 UI 优先用 SVG） */
  iconSvg?: string
  description: string
  /** 插件首页（用内置浏览器打开；空 = 无首页） */
  homepage: string
  commands: PluginCommand[]
  mcp: PluginMcp | null
  /** 是否已在 Jeff 内启用（启用后其 MCP 注入引擎、指令进入 `/` 菜单） */
  enabled: boolean
  /** 插件目录绝对路径 */
  dir: string
  /** plugin.json 解析/校验失败原因 */
  error?: string
  /** 是否已保存密钥（敏感值存本机 kv，不进 WebDAV） */
  hasSecret?: boolean
}

/** 内置浏览器：主进程下发给渲染层的动作 */
export type BrowserAction =
  | 'navigate'
  | 'click'
  | 'type'
  | 'upload'
  | 'screenshot'
  | 'get_content'
  | 'console'
  /** 设置视口分辨率（比例自适应 / 精确像素），渲染层回报实际生效尺寸 */
  | 'set_viewport'
  | 'back'
  | 'forward'
  | 'reload'
  | 'state'

/** 页面控制台/加载错误的一条记录（agent「分析错误」的原材料，也是面板上红点的数据） */
export interface BrowserConsoleEntry {
  /** error=控制台 error / 未捕获异常；warning；info；load=主帧加载失败 */
  level: 'error' | 'warning' | 'info' | 'load'
  message: string
  /** 来源文件（控制台消息通常带） */
  source?: string
  line?: number
  at: number
}

export interface BrowserRequest {
  id: string
  action: BrowserAction
  args: Record<string, unknown>
}

export interface BrowserResult {
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

/** 浏览器面板状态（渲染层同步给主进程/工具层共享） */
export interface BrowserState {
  visible: boolean
  url: string
  title: string
  loading: boolean
}

/**
 * 页面截图结果。
 * width/height 是**实际拿到的**像素尺寸（可能被 Chromium 的光栅化上限截短），
 * 调用方必须按它对账，不要拿请求值当结果（曾经用「把图拉伸到请求尺寸」掩盖过一整张空白图）。
 */
export interface BrowserPageShot {
  dataUrl: string
  width: number
  height: number
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
    /** 分组分类（空串 = 归入默认分组） */
    category?: string
  }
  [IPC.agentsDelete]: { id: string }
  [IPC.chatHistory]: { agentId: string }
  [IPC.chatSend]: { agentId: string; text: string; model?: { providerID: string; modelID: string }; variant?: string; images?: ChatImage[]; plugin?: ChatPluginInvoke }
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
  [IPC.groupSend]: { projectId: string; text: string; model?: { providerID: string; modelID: string }; variant?: string; images?: ChatImage[]; plugin?: ChatPluginInvoke }
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
  [IPC.settingsSet]: Partial<Pick<AppSettings, 'theme' | 'themePack' | 'notifyDesktop' | 'notifySound' | 'notifyOnlyBackground'>>
  [IPC.notifyDesktop]: { title: string; body?: string; kind?: 'agent' | 'group'; id?: string }
  [IPC.mcpList]: void
  [IPC.mcpSave]: { servers: Record<string, { type: 'local' | 'remote'; enabled: boolean; command?: string[]; environment?: Record<string, string>; url?: string; headers?: Record<string, string> }> }
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
  [IPC.debugLogOpenDir]: void
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
  // 定时任务
  [IPC.cronList]: void
  [IPC.cronSave]: {
    id?: string
    name: string
    target_type: 'agent' | 'project'
    target_id: string
    cron_expr: string
    prompt?: string
    miss_policy?: 'catchup' | 'skip'
    enabled?: boolean
  }
  [IPC.cronDelete]: { id: string }
  [IPC.cronRun]: { id: string }
  [IPC.cronRuns]: { id: string }
  // 插件
  [IPC.pluginsList]: void
  [IPC.pluginSetEnabled]: { id: string; enabled: boolean }
  [IPC.pluginSaveSecret]: { id: string; secret: string }
  [IPC.pluginImport]: { dir?: string }
  [IPC.pluginDelete]: { id: string }
  [IPC.pluginRefresh]: void
  [IPC.pluginBackupNow]: void
  [IPC.pluginRestore]: void
  [IPC.pluginBackupLast]: void
  // 内置浏览器（渲染层回报主进程下发的动作结果）
  [IPC.browserResult]: BrowserResult
  [IPC.browserState]: BrowserState
  [IPC.browserPageShot]: { webContentsId: number; width: number; height: number; beyondViewport: boolean; y?: number }
  [IPC.smokeShot]: { name: string }
  [IPC.smokeDone]: void
}

export type EventPayloads = {
  [IPC.evStatus]: { status: string; error?: string }
  [IPC.evSidecarLog]: { line: string }
  [IPC.evChatUpdated]: { agentId: string; sessionId: string }
  [IPC.evDataChanged]: { what: 'agents' | 'projects' | 'tasks' | 'settings' | 'memory' | 'agentsmd' | 'plugins' | 'cron' }
  [IPC.evGroupUpdated]: { projectId: string; threadId?: string }
  [IPC.evSync]: { state: string; detail?: string }
  [IPC.evChatStream]: { kind: 'private' | 'group'; agentId: string; projectId?: string; threadId?: string; messageId: string; text: string; reasoning?: string; currentTool?: string; tools?: Array<{ tool: string; status?: string }>; done: boolean }
}
