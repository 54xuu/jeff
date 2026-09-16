import type { DB } from '../db/db.js'
import type { PluginManager } from '../plugins/manager.js'
import { isLocalCommandPlugin } from '../plugins/const.js'
import type { PluginCommand, PluginMcp } from '../ipc/contract.js'
import type { ToolBridge } from './bridge.js'

/**
 * 插件开发工具（管家小杰"对话式开发插件"的能力面）。
 *
 * 为什么这些工具**只给小杰**（注册进 XIAOJIE_ONLY_TOOLS，非内置 agent 的 md 里被禁用）：
 * 插件的 mcp.command 会被引擎当子进程拉起、mcp.url 会把内网地址接进模型工具面——
 * 这等于把「写一个能执行命令的配置」的能力交给了模型。管家是用户直接对话的可信角色，
 * 与 jeff_agent_* 同级；项目群里的 worker agent（可能处理不可信内容）不应拥有。
 *
 * 再叠一道闸：**带本地命令的插件只能由人在插件页启用**，agent 调 enable 会被拒绝并提示去点开关。
 *
 * 参数形状上刻意**只用标量与标量数组**：实测（live12 R7）把 MCP 声明写成 `type:'object'` 时，
 * 模型侧会把整个对象丢成空串，插件就落成了「没有 MCP、没有附带文件」的半成品。
 * 现在 MCP 拆成 mcp_url / mcp_headers / mcp_tools / mcp_command / mcp_env 几个平铺参数，
 * 同时兼容传 JSON 文本或（老形状的）对象；空串一律当作「没传」，避免模型补默认值把已有字段抹掉。
 */
export const PLUGIN_TOOL_NAMES = ['jeff_plugin_create', 'jeff_plugin_update', 'jeff_plugin_enable', 'jeff_plugin_delete', 'jeff_plugin_read'] as const

export type PluginToolDeps = {
  db: DB
  plugins: PluginManager
  /** 变更后通知 UI + 触发引擎重载（与插件页开关同一套路径） */
  onChanged: () => void
}

/** 把「模型可能给的任意形状」归一成字符串；空串/空白视为未提供（返回 undefined） */
function str(v: unknown): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v.trim() ? v : undefined
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

/** 接受对象、JSON 文本（模型常把嵌套结构写成字符串） */
function asObject(v: unknown): Record<string, unknown> | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return undefined
    try {
      const parsed: unknown = JSON.parse(t)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return undefined
}

/** 接受数组、JSON 文本、单个标量 */
function asArray(v: unknown): unknown[] | undefined {
  if (v == null) return undefined
  if (Array.isArray(v)) return v.length ? v : undefined
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return undefined
    try {
      const parsed: unknown = JSON.parse(t)
      return Array.isArray(parsed) && parsed.length ? parsed : undefined
    } catch {
      return [t]
    }
  }
  return [v]
}

/** 命令数组：接受 ["npx","-y","x"] / "npx -y x" / JSON 文本 */
function asCommand(v: unknown): string[] | undefined {
  const arr = asArray(v)
  if (!arr) return undefined
  const flat = arr.map((x) => String(x).trim()).filter(Boolean)
  if (flat.length === 0) return undefined
  if (flat.length === 1 && /\s/.test(flat[0]) && !flat[0].startsWith('"')) return flat[0].split(/\s+/)
  return flat
}

/**
 * 单条快捷指令：优先平铺标量 command / command_prompt / command_description
 * （嵌套对象模型侧会丢）；兼容旧形 commands 数组/JSON。
 * name 自动补 / 前缀；缺 prompt 视为未提供。
 */
function asSingleCommand(args: {
  command?: unknown
  command_prompt?: unknown
  command_description?: unknown
  commands?: unknown
}): PluginCommand[] | undefined {
  const name = str(args.command)
  const prompt = str(args.command_prompt)
  if (name && prompt) {
    const cmd: PluginCommand = { name: name.startsWith('/') ? name : `/${name}`, prompt }
    const desc = str(args.command_description)
    if (desc) cmd.description = desc
    return [cmd]
  }
  // 兼容旧形：数组 / JSON（写盘前仍会被 parseManifest 截成最多 1 条）
  const arr = asArray(args.commands)
  if (!arr) return undefined
  const out: PluginCommand[] = []
  for (const item of arr) {
    const o = asObject(item)
    const raw = str(o?.name ?? o?.command)
    const pr = str(o?.prompt)
    if (!raw || !pr) continue
    const cmd: PluginCommand = { name: raw.startsWith('/') ? raw : `/${raw}`, prompt: pr }
    const desc = str(o?.description)
    if (desc) cmd.description = desc
    out.push(cmd)
  }
  return out.length ? out : undefined
}

/** 附带文件：接受 [{path,content}] / {"a.md":"x"} / JSON 文本 */
function asFiles(v: unknown): Record<string, string> | undefined {
  if (Array.isArray(v)) {
    const out: Record<string, string> = {}
    for (const item of v) {
      const o = asObject(item)
      const p = str(o?.path ?? o?.file ?? o?.name)
      if (!p) continue
      out[p] = typeof o?.content === 'string' ? (o.content as string) : String(o?.content ?? '')
    }
    return Object.keys(out).length ? out : undefined
  }
  const o = asObject(v)
  if (!o) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(o)) out[k] = typeof val === 'string' ? val : JSON.stringify(val)
  return Object.keys(out).length ? out : undefined
}

/** MCP 声明：优先用平铺参数拼（模型最稳），其次吃整体传入的 mcp（对象或 JSON 文本） */
function asMcp(args: { mcp_url?: unknown; mcp_headers?: unknown; mcp_tools?: unknown; mcp_command?: unknown; mcp_env?: unknown; mcp?: unknown }): PluginMcp | null | undefined {
  const url = str(args.mcp_url)
  const command = asCommand(args.mcp_command)
  if (url || command) {
    const mcp: PluginMcp = url ? { url } : { command: command! }
    const headers = asObject(args.mcp_headers)
    if (headers && Object.keys(headers).length) mcp.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]))
    const tools = asArray(args.mcp_tools)
    if (tools) {
      const names = tools.map((t) => String(t).trim()).filter(Boolean)
      if (names.length) mcp.tools = names
    }
    const env = asObject(args.mcp_env)
    if (env && Object.keys(env).length) mcp.environment = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]))
    return mcp
  }
  if (args.mcp === null) return null
  const whole = asObject(args.mcp)
  if (whole) return whole as PluginMcp
  return undefined
}

export function registerPluginTools(reg: ToolBridge, deps: PluginToolDeps): void {
  const [T_CREATE, T_UPDATE, T_ENABLE, T_DELETE, T_READ] = PLUGIN_TOOL_NAMES

  type WriteArgs = {
    id?: string
    name?: string
    version?: string
    icon?: string
    description?: string
    homepage?: string
    /** 单条快捷指令（平铺；嵌套对象模型侧会丢） */
    command?: unknown
    command_prompt?: unknown
    command_description?: unknown
    /** @deprecated 兼容旧形；内部仍写成最多一条 */
    commands?: unknown
    mcp_url?: unknown
    mcp_headers?: unknown
    mcp_tools?: unknown
    mcp_command?: unknown
    mcp_env?: unknown
    mcp?: unknown
    without_mcp?: unknown
    files?: unknown
  }

  const write = (args: WriteArgs, mustExist: boolean) => {
    const id = String(args.id || '').trim()
    if (!id) throw new Error('id 不能为空（插件唯一标识，只允许字母数字 . _ -）')
    const existing = deps.plugins.get(id)
    if (mustExist && !existing) throw new Error(`插件不存在，无法更新：${id}（改 id 请用 jeff_plugin_create）`)
    const name = String(args.name || '').trim() || existing?.name || ''
    if (!name) throw new Error('name 不能为空（插件显示名）')

    const withoutMcp = args.without_mcp === true || args.mcp === null
    const parsedMcp = asMcp(args)
    const mcp = withoutMcp ? null : (parsedMcp ?? existing?.mcp ?? null)
    const files = asFiles(args.files)

    const info = deps.plugins.write({
      id,
      name,
      // 空值一律视为「没传」，保留插件已有内容（模型常把未填字段补成空串，不能让它抹掉已配置的东西）
      version: str(args.version) ?? existing?.version ?? '',
      icon: str(args.icon) ?? existing?.icon ?? '🧩',
      description: str(args.description) ?? existing?.description ?? '',
      homepage: str(args.homepage) ?? existing?.homepage ?? '',
      commands: asSingleCommand(args) ?? existing?.commands ?? [],
      mcp,
      ...(files ? { files } : {}),
    })
    deps.onChanged()
    return {
      id: info.id,
      name: info.name,
      dir: info.dir,
      enabled: info.enabled,
      icon: info.icon,
      description: info.description,
      mcp: info.mcp ? { kind: info.mcp.url ? 'remote' : 'local', target: info.mcp.url || (info.mcp.command || []).join(' ') } : null,
      commands: info.commands.map((c) => c.name),
      files: deps.plugins.read(info.id).files,
      next: info.enabled
        ? '插件已启用，其 MCP 会在引擎重启后生效'
        : info.mcp && isLocalCommandPlugin(info.mcp)
          ? '插件已创建但未启用：它带本地命令（会拉起子进程），必须由用户在「插件」页手动点开关启用'
          : '插件已创建但未启用：确认要接入后调用 jeff_plugin_enable 启用（或让用户在插件页打开开关）',
    }
  }

  reg.register(T_CREATE, async (args: WriteArgs) => write(args, false))
  reg.register(T_UPDATE, async (args: WriteArgs) => write(args, true))

  reg.register(T_ENABLE, async (args: { id?: string; enabled?: boolean }) => {
    const id = String(args.id || '').trim()
    if (!id) throw new Error('id 不能为空')
    const info = deps.plugins.get(id)
    if (!info) throw new Error(`插件不存在：${id}`)
    const enabled = args.enabled !== false
    if (enabled && isLocalCommandPlugin(info.mcp)) {
      throw new Error(
        `「${info.name}」带本地命令（${(info.mcp?.command || []).join(' ')}），它会作为子进程被执行，不能由我开启。` +
          '请让用户在左侧「插件」页手动点它的开关来启用。',
      )
    }
    const after = deps.plugins.setEnabled(id, enabled)
    deps.onChanged()
    return { id: after.id, enabled: after.enabled, note: enabled ? '已启用，MCP 会在引擎重启后可用' : '已停用，其 MCP 工具已从引擎摘除' }
  })

  reg.register(T_DELETE, async (args: { id?: string }) => {
    const id = String(args.id || '').trim()
    if (!id) throw new Error('id 不能为空')
    if (!deps.plugins.get(id)) throw new Error(`插件不存在：${id}`)
    deps.plugins.delete(id)
    deps.onChanged()
    return { deleted: true, note: '插件目录、启用状态与密钥都已清除；如需找回请用「设置 → 同步」的插件备份恢复' }
  })

  reg.register(T_READ, async (args: { id?: string }) => {
    const id = String(args.id || '').trim()
    if (!id) throw new Error('id 不能为空')
    const { manifest, files, dir } = deps.plugins.read(id)
    const info = deps.plugins.get(id)
    return {
      id,
      dir,
      files,
      enabled: info?.enabled ?? false,
      has_secret: info?.hasSecret ?? false,
      manifest,
    }
  })
}
