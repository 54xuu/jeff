import { PLUGIN_MCP_PREFIX } from './const.js'

/**
 * 用户消息里的一次插件调用（一条消息最多一个）。
 * 落在用户可见正文之外：气泡渲染筹码，发给模型时再拼短约束。
 */
export interface ChatPluginInvoke {
  /** 插件 id（与 MCP 前缀 plugin-{id} 对应） */
  id: string
  /** 中文名快照（插件卸载后气泡仍能显示名字） */
  name: string
  /** 快捷指令，如 /zhbf */
  command: string
  /** 筹码插在 displayText 里的下标 */
  at: number
  /** emoji 快照（无 SVG 时的退化；有 icon.svg 时渲染层优先用当前插件的 SVG） */
  icon?: string
}

const HEADER_RE = /^<!--jeff-plugin:([\s\S]*?)-->\n?/

/** 发给模型的短约束：点名插件与 MCP 前缀，不枚举工具 */
export function pluginConstraint(invoke: Pick<ChatPluginInvoke, 'id' | 'name' | 'command'>): string {
  return `请使用插件「${invoke.name}」（指令 ${invoke.command}，MCP 前缀 ${PLUGIN_MCP_PREFIX}${invoke.id}）回答下面的问题。只调用该插件提供的工具。`
}

/** 把「用户可见正文 + 插件筹码」编成发给引擎 / 落库的文本 */
export function encodePluginUserMessage(invoke: ChatPluginInvoke, displayText: string): string {
  const header = `<!--jeff-plugin:${JSON.stringify({
    id: invoke.id,
    name: invoke.name,
    cmd: invoke.command,
    at: Math.max(0, invoke.at | 0),
    ...(invoke.icon ? { icon: invoke.icon } : {}),
  })}-->`
  const constraint = pluginConstraint(invoke)
  const body = displayText ? `${constraint}\n\n${displayText}` : constraint
  return `${header}\n${body}`
}

export interface DecodedPluginUserMessage {
  invoke?: ChatPluginInvoke
  /** 气泡 / 输入框展示的用户原话（不含约束、不含注释头） */
  displayText: string
}

/** 从引擎历史或群聊 content 解出筹码与用户原话；不是插件消息则原样返回 */
export function decodePluginUserMessage(raw: string): DecodedPluginUserMessage {
  const text = String(raw || '')
  const m = text.match(HEADER_RE)
  if (!m) return { displayText: text }
  let parsed: { id?: unknown; name?: unknown; cmd?: unknown; at?: unknown; icon?: unknown }
  try {
    parsed = JSON.parse(m[1] || '') as { id?: unknown; name?: unknown; cmd?: unknown; at?: unknown; icon?: unknown }
  } catch {
    return { displayText: text }
  }
  const id = typeof parsed.id === 'string' ? parsed.id : ''
  const name = typeof parsed.name === 'string' ? parsed.name : ''
  const command = typeof parsed.cmd === 'string' ? parsed.cmd : ''
  if (!id || !name || !command) return { displayText: text }
  let rest = text.slice(m[0].length)
  const constraint = pluginConstraint({ id, name, command })
  if (rest.startsWith(constraint)) {
    rest = rest.slice(constraint.length)
    if (rest.startsWith('\n\n')) rest = rest.slice(2)
    else if (rest.startsWith('\n')) rest = rest.slice(1)
  }
  const at = typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? Math.max(0, Math.min(rest.length, parsed.at)) : 0
  const invoke: ChatPluginInvoke = {
    id,
    name,
    command,
    at,
    ...(typeof parsed.icon === 'string' && parsed.icon ? { icon: parsed.icon } : {}),
  }
  return { invoke, displayText: rest }
}

/** 发送前：有插件调用就编码，否则原样 */
export function resolveSendText(text: string, plugin?: ChatPluginInvoke | null): string {
  if (!plugin?.id) return text
  return encodePluginUserMessage(plugin, text)
}
