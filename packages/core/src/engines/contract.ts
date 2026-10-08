/** Execution identity is independent of the model provider. */
export const ENGINE_IDS = ['opencode', 'opencode-system', 'codex', 'cursor', 'claude'] as const
export type EngineId = typeof ENGINE_IDS[number]
export const ENGINE_LABELS: Record<EngineId, string> = {
  opencode: 'OpenCode（Jeff）', 'opencode-system': 'OpenCode（系统）', codex: 'Codex CLI', cursor: 'Cursor CLI', claude: 'Claude Code',
}
export function engineId(value: unknown): EngineId {
  if (!ENGINE_IDS.includes(value as EngineId)) throw new Error('不支持的执行引擎')
  return value as EngineId
}
export function assertAgentEngine(agent: { execution_engine?: string }): void { engineId(agent.execution_engine || 'opencode') }
export interface EngineCapabilities {
  images: boolean
  thinking: boolean
  compression: boolean
  contextStats: boolean
}
export interface EngineStatus {
  id: EngineId
  label: string
  path: string | null
  configuredPath?: string
  sourcePath?: string
  version?: string
  available: boolean
  error?: string
  capabilities: EngineCapabilities
}
export const ENGINE_CAPABILITIES: Record<EngineId, EngineCapabilities> = {
  opencode: { images: true, thinking: true, compression: true, contextStats: true },
  'opencode-system': { images: false, thinking: true, compression: false, contextStats: false },
  codex: { images: true, thinking: true, compression: false, contextStats: false },
  cursor: { images: false, thinking: false, compression: false, contextStats: false },
  claude: { images: true, thinking: true, compression: false, contextStats: false },
}
