/** Execution identity is independent of the model provider. */
export const ENGINE_IDS = ['opencode', 'codex', 'cursor', 'claude'] as const
export type EngineId = typeof ENGINE_IDS[number]
export const ENGINE_LABELS: Record<EngineId, string> = {
  opencode: 'OpenCode（默认）', codex: 'Codex CLI', cursor: 'Cursor CLI', claude: 'Claude Code',
}
export function engineId(value: unknown): EngineId {
  if (!ENGINE_IDS.includes(value as EngineId)) throw new Error('不支持的执行引擎')
  return value as EngineId
}
export function assertAgentEngine(agent: { execution_engine?: string; builtin?: number | boolean; category?: string; name?: string }): void {
  const id = engineId(agent.execution_engine || 'opencode')
  if (id !== 'opencode' && (agent.builtin || agent.category === '智慧病房' || agent.name === '医护助手')) {
    throw new Error('该智能体有专属工具或文件禁用规则，目前仅 OpenCode 能可靠执行这些规则')
  }
}
export interface EngineCapabilities {
  images: boolean
  thinking: boolean
  compression: boolean
  contextStats: boolean
  restrictedAgents: boolean
}
export interface EngineStatus {
  id: EngineId
  label: string
  path: string | null
  configuredPath?: string
  version?: string
  available: boolean
  error?: string
  capabilities: EngineCapabilities
}
export const ENGINE_CAPABILITIES: Record<EngineId, EngineCapabilities> = {
  opencode: { images: true, thinking: true, compression: true, contextStats: true, restrictedAgents: true },
  codex: { images: true, thinking: true, compression: false, contextStats: false, restrictedAgents: false },
  cursor: { images: false, thinking: false, compression: false, contextStats: false, restrictedAgents: false },
  claude: { images: true, thinking: true, compression: false, contextStats: false, restrictedAgents: false },
}
