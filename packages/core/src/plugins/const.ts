/**
 * 插件相关的常量（单独成文件，避免 pluginTools 与 manager 互相导入成环）。
 */
/** 注入 MCP 的 key 前缀：避免覆盖用户手配的同名 server */
export const PLUGIN_MCP_PREFIX = 'plugin-'

/** 本地（stdio）型 MCP：其 command 会被引擎当子进程拉起，属可执行能力，启用需人工确认 */
export function isLocalCommandPlugin(mcp: { command?: string[]; url?: string } | null | undefined): boolean {
  return !!mcp?.command?.length && !mcp?.url
}
