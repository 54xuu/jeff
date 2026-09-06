import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpServerCfg } from './parse.js'

export interface McpProbe {
  ok: boolean
  tools: string[]
  error?: string
  elapsedMs: number
}

/**
 * 直连探测一个 MCP server：连接 → tools/list → 断开。
 * 与 opencode 无关（配置生效与否以 sidecar 为准），这里只给设置页展示「能不能连、有哪些工具」。
 * 超时 10s；local 用 stdio 子进程，remote 先 Streamable HTTP 再降级 SSE。
 */
export async function probeMcpServer(name: string, cfg: McpServerCfg, timeoutMs = 10000): Promise<McpProbe> {
  const started = Date.now()
  if (!cfg.enabled) return { ok: false, tools: [], error: '已停用', elapsedMs: 0 }
  try {
    const client = new Client({ name: 'jeff-probe', version: '1.0.0' })
    const transport =
      cfg.type === 'local'
        ? new StdioClientTransport({
            command: (cfg.command || [])[0] || '',
            args: (cfg.command || []).slice(1),
            env: { ...minimalEnv(), ...(cfg.environment || {}) },
          })
        : null
    const timeout = setTimeout(() => {
      void client.close().catch(() => {})
    }, timeoutMs)
    try {
      if (transport) {
        await client.connect(transport)
      } else {
        const url = new URL(cfg.url || '')
        const headers = cfg.headers || {}
        try {
          await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
        } catch {
          await client.connect(new SSEClientTransport(url, { requestInit: { headers } }))
        }
      }
      const res = await client.listTools()
      const tools = (res.tools || []).map((t) => t.name).filter(Boolean)
      return { ok: true, tools, elapsedMs: Date.now() - started }
    } finally {
      clearTimeout(timeout)
      await client.close().catch(() => {})
    }
  } catch (err) {
    return { ok: false, tools: [], error: String((err as Error)?.message || err).slice(0, 200), elapsedMs: Date.now() - started }
  }
}

function minimalEnv(): Record<string, string> {
  // 子进程 MCP server 最小环境：PATH/HOME 必需（npx / uvx 等依赖）
  const { PATH, HOME, LANG, TMPDIR } = process.env
  return { ...(PATH ? { PATH } : {}), ...(HOME ? { HOME } : {}), ...(LANG ? { LANG } : {}), ...(TMPDIR ? { TMPDIR } : {}) }
}

/** 并发探测全部（每个独立超时，失败不影响其他） */
export async function probeMcpAll(servers: Record<string, McpServerCfg>): Promise<Record<string, McpProbe>> {
  const entries = Object.entries(servers)
  const results = await Promise.all(entries.map(async ([name, cfg]) => [name, await probeMcpServer(name, cfg)] as const))
  return Object.fromEntries(results)
}
