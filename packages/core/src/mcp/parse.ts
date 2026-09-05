/** MCP server 配置（opencode 原生格式，存 kv settings:mcp） */
export interface McpServerCfg {
  type: 'local' | 'remote'
  enabled: boolean
  /** local: 可执行命令 */
  command?: string[]
  /** remote: URL */
  url?: string
  headers?: Record<string, string>
}

export type McpParseResult = { ok: true; cfg: McpServerCfg } | { ok: false; error: string }

/**
 * 把用户编辑的 JSON 文本解析为一个 MCP server 配置（opencode 原生格式）。
 * local → 必须有非空字符串数组 command；remote → 必须有 http(s) url；headers/可选。
 */
export function parseMcpServerJson(text: string): McpParseResult {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${String((err as Error)?.message || err).slice(0, 200)}` }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: '必须是一个 JSON 对象（不是数组或标量）' }
  }
  const o = obj as Record<string, unknown>
  if (o.type !== 'local' && o.type !== 'remote') {
    return { ok: false, error: 'type 必须是 "local" 或 "remote"' }
  }
  if (o.type === 'local') {
    const cmd = o.command
    if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((c) => typeof c !== 'string')) {
      return { ok: false, error: 'local 类型必须提供 command：非空字符串数组，如 ["npx", "-y", "@modelcontextprotocol/server-xxx"]' }
    }
    const cfg: McpServerCfg = { type: 'local', enabled: o.enabled !== false, command: cmd as string[] }
    return { ok: true, cfg }
  }
  if (typeof o.url !== 'string' || !/^https?:\/\//i.test(o.url)) {
    return { ok: false, error: 'remote 类型必须提供合法 url（以 http:// 或 https:// 开头）' }
  }
  const headers: Record<string, string> = {}
  if (o.headers !== undefined) {
    if (typeof o.headers !== 'object' || o.headers === null || Array.isArray(o.headers)) {
      return { ok: false, error: 'headers 必须是字符串键值对对象' }
    }
    for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) headers[k] = String(v)
  }
  const cfg: McpServerCfg = { type: 'remote', enabled: o.enabled !== false, url: o.url }
  if (Object.keys(headers).length > 0) cfg.headers = headers
  return { ok: true, cfg }
}
