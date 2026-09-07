import { describe, expect, it } from 'vitest'
import {
  compactionThreshold,
  COMPACTION_BUFFER,
  splitContextMessages,
  tokenUsage,
} from '../src/chat/context.js'
import type { SessionMessage } from '../src/oc/client.js'

function msg(
  id: string,
  role: 'user' | 'assistant',
  opts: {
    text?: string
    compaction?: boolean
    summary?: boolean
    tokens?: { total?: number; input?: number; output?: number }
    completed?: boolean
    error?: unknown
  } = {},
): SessionMessage {
  const parts: Array<Record<string, unknown>> = []
  if (opts.compaction) parts.push({ id: `${id}-c`, type: 'compaction', auto: false })
  if (opts.text) parts.push({ id: `${id}-t`, type: 'text', text: opts.text })
  return {
    info: {
      id,
      role,
      ...(opts.summary ? { summary: true, mode: 'compaction' } : {}),
      ...(opts.tokens ? { tokens: opts.tokens } : {}),
      ...(opts.completed !== false && role === 'assistant' ? { time: { created: 1, completed: 2 }, finish: 'stop' } : { time: { created: 1 } }),
      ...(opts.error ? { error: opts.error } : {}),
    },
    parts: parts as SessionMessage['parts'],
  }
}

describe('context compaction helpers', () => {
  it('tokenUsage prefers total then sums parts', () => {
    expect(tokenUsage({ total: 100, input: 1, output: 2 })).toBe(100)
    expect(tokenUsage({ input: 10, output: 5, cache: { read: 3, write: 2 } })).toBe(20)
    expect(tokenUsage(null)).toBe(0)
  })

  it('compactionThreshold mirrors opencode reserved buffer', () => {
    expect(compactionThreshold(undefined)).toBeNull()
    expect(compactionThreshold(0)).toBeNull()
    expect(compactionThreshold(128000)).toBe(128000 - COMPACTION_BUFFER)
    expect(compactionThreshold(128000, 8192)).toBe(128000 - 8192)
    expect(compactionThreshold(128000, 40000)).toBe(128000 - COMPACTION_BUFFER)
  })

  it('splitContextMessages keeps all when no compact', () => {
    const msgs = [msg('u1', 'user', { text: 'hi' }), msg('a1', 'assistant', { text: 'yo', tokens: { total: 1200 } })]
    const parts = splitContextMessages(msgs)
    expect(parts.summary).toBeNull()
    expect(parts.compactedCount).toBe(0)
    expect(parts.activeMessages).toHaveLength(2)
    expect(parts.usedTokens).toBe(1200)
  })

  it('splitContextMessages cuts at last successful compact', () => {
    const msgs = [
      msg('u0', 'user', { text: 'old' }),
      msg('a0', 'assistant', { text: 'old reply' }),
      msg('uc', 'user', { compaction: true }),
      msg('ac', 'assistant', { summary: true, text: '## Objective\nKeep going' }),
      msg('u1', 'user', { text: 'new' }),
      msg('a1', 'assistant', { text: 'new reply', tokens: { input: 800, output: 200 } }),
    ]
    const parts = splitContextMessages(msgs)
    expect(parts.summary).toContain('## Objective')
    expect(parts.compactedCount).toBe(2) // u0 + a0
    expect(parts.activeMessages.map((m) => m.text)).toEqual(['new', 'new reply'])
    expect(parts.usedTokens).toBe(1000)
  })

  it('ignores failed summary when choosing boundary', () => {
    const msgs = [
      msg('u0', 'user', { text: 'old' }),
      msg('uc', 'user', { compaction: true }),
      msg('ac', 'assistant', { summary: true, text: '', error: { message: 'boom' }, completed: true }),
      msg('u1', 'user', { text: 'still full' }),
    ]
    const parts = splitContextMessages(msgs)
    expect(parts.summary).toBeNull()
    expect(parts.activeMessages.map((m) => m.text)).toEqual(['old', 'still full'])
  })
})
