import type { Part } from '../oc/client.js'

/** Stable part IDs reconcile token deltas with authoritative final snapshots. */
export class ReplyCollector {
  readonly parts = new Map<string, Part>()
  constructor(private changed: (part: Part) => void) {}
  text(id: string, type: 'text' | 'reasoning', text: string, delta = false): void {
    const previous = this.parts.get(id) as { text?: string } | undefined
    const part: Part = { id, type, text: delta ? (previous?.text || '') + text : text }
    this.parts.set(id, part)
    this.changed(part)
  }
  tool(id: string, tool: string, state: { status?: string; input?: unknown; output?: string; error?: string }): void {
    const prior = this.parts.get(id) as { state?: object } | undefined
    const part: Part = { id, type: 'tool', tool, state: { ...prior?.state, ...state } }
    this.parts.set(id, part)
    this.changed(part)
  }
  values(): Part[] { return [...this.parts.values()] }
}

export class JsonStreamParser {
  sessionId?: string
  success = false
  terminal = false
  error?: string
  tokens?: { input: number; output: number }
  private prefix = ''
  private messageSequence = 0
  private messageAliases = new Map<string, string>()
  private streamingMessage = false
  private blockTypes = new Map<string, Map<number, string>>()
  private thinkingBlock = 0
  private cursorDeltaSeen = false
  constructor(private reply: ReplyCollector, private engine: 'claude' | 'cursor') {}
  receive(event: Record<string, any>): void {
    if (event.session_id) this.sessionId = event.session_id
    if (this.engine === 'cursor' && event.type === 'thinking') {
      if (event.subtype === 'delta') this.reply.text(`cursor-thinking:${this.thinkingBlock}`, 'reasoning', event.text || '', true)
      if (event.subtype === 'completed') this.thinkingBlock++
    }
    if (event.type === 'stream_event') {
      const item = event.event
      if (item?.type === 'message_start') {
        this.prefix = item.message?.id || `claude-message:${++this.messageSequence}`
        this.streamingMessage = true
        if (item.message?.id) this.messageAliases.set(item.message.id, this.prefix)
      }
      const id = `${this.prefix}:${item?.index ?? 0}`
      if (item?.type === 'content_block_start') {
        const block = item.content_block
        const types = this.blockTypes.get(this.prefix) || new Map<number, string>()
        types.set(item.index ?? 0, block.type)
        this.blockTypes.set(this.prefix, types)
        if (block.type === 'text') this.reply.text(id, 'text', block.text || '')
        if (block.type === 'thinking') this.reply.text(id, 'reasoning', block.thinking || '')
        if (block.type === 'tool_use') this.reply.tool(block.id, block.name, { status: 'running', input: block.input })
      }
      if (item?.type === 'content_block_delta') {
        const types = this.blockTypes.get(this.prefix) || new Map<number, string>()
        if (item.delta?.type === 'text_delta') types.set(item.index ?? 0, 'text')
        if (item.delta?.type === 'thinking_delta') types.set(item.index ?? 0, 'thinking')
        this.blockTypes.set(this.prefix, types)
        if (item.delta?.type === 'text_delta') this.reply.text(id, 'text', item.delta.text, true)
        if (item.delta?.type === 'thinking_delta') this.reply.text(id, 'reasoning', item.delta.thinking, true)
      }
    }
    if (event.type === 'assistant') {
      const message = event.message || {}
      if (this.engine === 'cursor') {
        // Partial mode flushes duplicate snapshots before tools and at turn end.
        if (event.timestamp_ms !== undefined && !event.model_call_id) {
          this.cursorDeltaSeen = true
          for (const block of message.content || []) if (block.type === 'text') this.reply.text('cursor-text', 'text', block.text || '', true)
        } else if (!this.cursorDeltaSeen && event.model_call_id) {
          for (const [index, block] of (message.content || []).entries()) if (block.type === 'text') this.reply.text(`${event.model_call_id}:${index}`, 'text', block.text || '')
        }
        return
      }
      // Some providers assign a different ID to the final snapshot, or omit it.
      // Bind that snapshot to the current streamed message rather than duplicating it.
      if (message.id && this.messageAliases.has(message.id)) this.prefix = this.messageAliases.get(message.id)!
      else if (!this.streamingMessage) this.prefix = message.id || `claude-message:${++this.messageSequence}`
      if (message.id) this.messageAliases.set(message.id, this.prefix)
      for (const [index, block] of (message.content || []).entries()) {
        // Claude may emit one assistant snapshot per content block, each at index 0.
        const types = this.blockTypes.get(this.prefix)
        const candidates = [...(types?.entries() || [])].filter(([, type]) => type === block.type)
        const value = block.text || block.thinking
        const matching = candidates.find(([slot]) => (this.reply.parts.get(`${this.prefix}:${slot}`) as { text?: string })?.text === value)
        const slot = matching?.[0] ?? (types?.get(index) === block.type ? index : candidates[0]?.[0] ?? index)
        const id = `${this.prefix}:${slot}`
        if (block.type === 'text' && block.text) this.reply.text(id, 'text', block.text)
        if (block.type === 'thinking' && block.thinking) this.reply.text(id, 'reasoning', block.thinking)
        if (block.type === 'tool_use') this.reply.tool(block.id, block.name, { status: 'running', input: block.input })
      }
    }
    if (event.type === 'user') {
      for (const block of event.message?.content || []) if (block.type === 'tool_result') {
        this.reply.tool(block.tool_use_id, String((this.reply.parts.get(block.tool_use_id) as any)?.tool || ''), {
          status: block.is_error ? 'error' : 'completed', output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        })
      }
    }
    if (event.type === 'tool_call') {
      const call = event.tool_call || {}
      const [name, detail] = Object.entries(call).find(([key]) => key.endsWith('ToolCall')) || ['tool', {}]
      const native = detail as any
      const result = native.result
      const mcp = name === 'mcpToolCall'
      const tool = mcp ? native.args?.toolName || native.args?.name || 'mcp' : name.replace(/ToolCall$/, '')
      const toolInput = mcp ? native.args?.args : native.args
      const failed = !!(result?.error || result?.failure || result?.isError || result?.success === false) || (typeof result?.success?.exitCode === 'number' && result.success.exitCode !== 0)
      this.reply.tool(event.call_id || call.toolCallId || String(event.timestamp_ms || name), tool, {
        status: event.subtype === 'completed' ? failed ? 'error' : 'completed' : 'running', input: toolInput,
        output: (detail as any).result === undefined ? undefined : JSON.stringify((detail as any).result),
      })
    }
    if (event.type === 'result') {
      this.terminal = true
      this.success = event.subtype === 'success' && event.is_error !== true
      if (!this.success) this.error = event.result || event.errors?.join('\n') || 'CLI 返回执行失败'
      if (this.success && this.engine === 'cursor' && this.cursorDeltaSeen && typeof event.result === 'string') this.reply.text('cursor-text', 'text', event.result)
      if (this.success && typeof event.result === 'string' && !this.reply.values().some((p) => p.type === 'text' && (p as { text?: string }).text)) this.reply.text('result', 'text', event.result)
      if (event.usage) this.tokens = { input: event.usage.input_tokens ?? event.usage.inputTokens ?? 0, output: event.usage.output_tokens ?? event.usage.outputTokens ?? 0 }
    }
  }
}
