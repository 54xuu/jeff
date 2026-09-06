/** MCP server 配置（opencode 原生格式，存 kv settings:mcp） */
export interface McpServerCfg {
  type: 'local' | 'remote'
  enabled: boolean
  /** local: 可执行命令 */
  command?: string[]
  /** local: 环境变量 */
  environment?: Record<string, string>
  /** remote: URL */
  url?: string
  headers?: Record<string, string>
}

export type McpParseResult = { ok: true; cfg: McpServerCfg } | { ok: false; error: string }
export type McpServersParseResult = { ok: true; servers: Record<string, McpServerCfg> } | { ok: false; error: string }

/** 解析单个 server 条目（不校验外层包裹），错误信息带字段定位 */
function parseServerEntry(name: string, raw: unknown): McpParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `「${name}」必须是一个 JSON 对象` }
  }
  const o = raw as Record<string, unknown>

  // 类型判定：显式 type 优先；否则 command → local、url → remote（Claude Desktop 风格无 type）
  let type: 'local' | 'remote' | null = null
  if (o.type === 'local' || o.type === 'remote' || o.type === 'stdio') type = o.type === 'remote' ? 'remote' : 'local'
  else if (o.type === 'sse' || o.type === 'http' || o.type === 'streamable-http') type = 'remote'
  else if (typeof o.command === 'string' || Array.isArray(o.command)) type = 'local'
  else if (typeof o.url === 'string') type = 'remote'
  if (!type) {
    return { ok: false, error: `「${name}」缺少 type：local 需要 command（数组），remote 需要 url（http/https）` }
  }

  if (type === 'local') {
    let cmd: string[]
    if (Array.isArray(o.command)) {
      if (o.command.length === 0 || o.command.some((c) => typeof c !== 'string')) {
        return { ok: false, error: `「${name}」是 local 类型：command 必须是非空字符串数组，如 ["npx", "-y", "@modelcontextprotocol/server-xxx"]` }
      }
      cmd = o.command as string[]
    } else if (typeof o.command === 'string') {
      // Claude Desktop 风格：command + args 分离
      const args = Array.isArray(o.args) ? o.args.map(String) : []
      cmd = [o.command, ...args]
    } else {
      return { ok: false, error: `「${name}」是 local 类型：必须提供 command（字符串数组，或 command+args）` }
    }
    if (cmd.length === 0) {
      return { ok: false, error: `「${name}」是 local 类型：command 不能为空` }
    }
    const cfg: McpServerCfg = { type: 'local', enabled: o.enabled !== false, command: cmd }
    const env = o.environment ?? o.env
    if (env !== undefined) {
      if (typeof env !== 'object' || env === null || Array.isArray(env)) {
        return { ok: false, error: `「${name}」的 environment/env 必须是字符串键值对对象` }
      }
      const e: Record<string, string> = {}
      for (const [k, v] of Object.entries(env as Record<string, unknown>)) e[k] = String(v)
      if (Object.keys(e).length > 0) cfg.environment = e
    }
    return { ok: true, cfg }
  }

  if (typeof o.url !== 'string' || !/^https?:\/\//i.test(o.url)) {
    return { ok: false, error: `「${name}」是 remote 类型：必须提供合法 url（以 http:// 或 https:// 开头）` }
  }
  const headers: Record<string, string> = {}
  if (o.headers !== undefined) {
    if (typeof o.headers !== 'object' || o.headers === null || Array.isArray(o.headers)) {
      return { ok: false, error: `「${name}」的 headers 必须是字符串键值对对象` }
    }
    for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) headers[k] = String(v)
  }
  const cfg: McpServerCfg = { type: 'remote', enabled: o.enabled !== false, url: o.url }
  if (Object.keys(headers).length > 0) cfg.headers = headers
  return { ok: true, cfg }
}

/** 校验并归一化一个 server 名（防空名/重名冲突由调用方处理） */
function validName(name: string): string | null {
  const t = name.trim()
  return t ? t : null
}

/**
 * 把用户粘贴的 JSON 文本解析为一组 MCP server 配置（双格式兼容）：
 * - {"mcpServers": {...}}：Claude Desktop / Cursor 风格包裹
 * - {name: cfg}：opencode 原生 map（local/remote/stdio 均可，command 可数组可 command+args）
 * 错误时返回带字段定位的提示。
 */
export function parseMcpServersJson(text: string): McpServersParseResult {
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
  let map: Record<string, unknown> | null = null
  if (typeof o.mcpServers === 'object' && o.mcpServers !== null && !Array.isArray(o.mcpServers)) {
    map = o.mcpServers as Record<string, unknown>
  } else {
    // 无包裹：只要任意值是合法 server 条目就当 opencode 原生 map
    map = o
  }
  const servers: Record<string, McpServerCfg> = {}
  for (const [name, raw] of Object.entries(map)) {
    const r = parseServerEntry(name, raw)
    if (!r.ok) return r
    const key = validName(name)
    if (!key) return { ok: false, error: 'server 名称不能为空' }
    servers[key] = r.cfg
  }
  if (Object.keys(servers).length === 0) {
    return { ok: false, error: '没有解析到任何 MCP server；请粘贴 {"mcpServers":{…}} 或 {名称: {type/command/url…}} 格式' }
  }
  return { ok: true, servers }
}

/**
 * 解析单个 MCP server 的 JSON（编辑弹窗用）。支持 opencode 原生条目格式。
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
  // 若是单键 map（{name: cfg}）则拆开校验内层
  if (o.type === undefined && o.command === undefined && o.url === undefined) {
    const keys = Object.keys(o)
    if (keys.length >= 1) {
      const r = parseServerEntry(keys[0], o[keys[0]])
      if (r.ok) return r
      return { ok: false, error: r.error }
    }
  }
  return parseServerEntry('(未命名)', obj)
}
