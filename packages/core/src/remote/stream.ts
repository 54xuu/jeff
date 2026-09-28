/**
 * 桌面端 chat-stream 每次推的是累计全文。走公网只发增量。
 * 若新文本不是旧文本的延伸（压缩、替换），reset=true，delta 为全文。
 */
export function streamDelta(prev: string, next: string): { reset: boolean; delta: string } {
  if (next.startsWith(prev)) return { reset: false, delta: next.slice(prev.length) }
  return { reset: true, delta: next }
}

export interface StreamFlush {
  reset: boolean
  delta: string
}

/**
 * 把细碎增量合并成约 intervalMs 一帧。force=true（回合结束）立即吐出。
 * now 可注入，单测不必真等。
 */
export interface RemoteStreamIn {
  kind: 'private' | 'group'
  agentId: string
  projectId?: string
  threadId?: string
  messageId: string
  text: string
  reasoning?: string
  tools?: Array<{ tool: string; status?: string }>
  done: boolean
}

/** 手机收到的一帧。reset 时两段 delta 都是全文。 */
export interface RemoteStreamFrame {
  kind: 'private' | 'group'
  agentId: string
  projectId?: string
  threadId?: string
  messageId: string
  reset: boolean
  textDelta: string
  reasoningDelta: string
  textLen: number
  reasoningLen: number
  tools?: Array<{ tool: string; status?: string }>
  done: boolean
}

interface StreamSlot {
  text: string
  reasoning: string
  pendingText: string
  pendingReasoning: string
  reset: boolean
  lastFlush: number
}

/**
 * 把桌面端的累计全文收成约 intervalMs 一帧增量。
 * done 帧不再带空正文（核心用空 text 表示结束），只带已见到的长度供手机核对。
 */
export function createChatStreamGate(intervalMs: number, now: () => number = Date.now) {
  const slots = new Map<string, StreamSlot>()
  const keyOf = (p: RemoteStreamIn) => p.messageId || `${p.kind}:${p.agentId}:${p.projectId || ''}`
  function frame(slot: StreamSlot, p: RemoteStreamIn, done: boolean): RemoteStreamFrame {
    const out: RemoteStreamFrame = {
      kind: p.kind,
      agentId: p.agentId,
      projectId: p.projectId,
      threadId: p.threadId,
      messageId: p.messageId,
      reset: slot.reset,
      textDelta: slot.pendingText,
      reasoningDelta: slot.pendingReasoning,
      textLen: slot.text.length,
      reasoningLen: slot.reasoning.length,
      tools: p.tools,
      done,
    }
    slot.pendingText = ''
    slot.pendingReasoning = ''
    slot.reset = false
    slot.lastFlush = now()
    return out
  }
  return {
    push(p: RemoteStreamIn): RemoteStreamFrame | null {
      const key = keyOf(p)
      if (p.done) {
        const slot = slots.get(key)
        slots.delete(key)
        if (!slot) {
          return {
            kind: p.kind,
            agentId: p.agentId,
            projectId: p.projectId,
            threadId: p.threadId,
            messageId: p.messageId,
            reset: false,
            textDelta: '',
            reasoningDelta: '',
            textLen: 0,
            reasoningLen: 0,
            tools: p.tools,
            done: true,
          }
        }
        return frame(slot, p, true)
      }
      let slot = slots.get(key)
      if (!slot) {
        slot = { text: '', reasoning: '', pendingText: '', pendingReasoning: '', reset: false, lastFlush: Number.NEGATIVE_INFINITY }
        slots.set(key, slot)
      }
      const text = p.text || ''
      const reasoning = p.reasoning || ''
      const td = streamDelta(slot.text, text)
      const rd = streamDelta(slot.reasoning, reasoning)
      slot.text = text
      slot.reasoning = reasoning
      if (td.reset || rd.reset) {
        slot.pendingText = text
        slot.pendingReasoning = reasoning
        slot.reset = true
      } else {
        slot.pendingText += td.delta
        slot.pendingReasoning += rd.delta
      }
      if (now() - slot.lastFlush < intervalMs) return null
      if (!slot.pendingText && !slot.pendingReasoning && !slot.reset) return null
      return frame(slot, p, false)
    },
  }
}

export function applyRemoteStream(
  prev: { text: string; reasoning: string },
  frame: Pick<RemoteStreamFrame, 'reset' | 'textDelta' | 'reasoningDelta' | 'textLen' | 'reasoningLen'>,
): { text: string; reasoning: string; ok: boolean } {
  const text = frame.reset ? frame.textDelta : prev.text + frame.textDelta
  const reasoning = frame.reset ? frame.reasoningDelta : prev.reasoning + frame.reasoningDelta
  return { text, reasoning, ok: text.length === frame.textLen && reasoning.length === frame.reasoningLen }
}

export function createStreamCoalescer(intervalMs: number, now: () => number = Date.now) {
  let lastFlush = Number.NEGATIVE_INFINITY
  let pending = ''
  let pendingReset = false
  return {
    push(delta: string, reset: boolean, force = false): StreamFlush | null {
      if (reset) {
        pending = delta
        pendingReset = true
      } else {
        pending += delta
      }
      const t = now()
      if (!force && t - lastFlush < intervalMs) return null
      if (pending.length === 0 && !pendingReset) return null
      const out: StreamFlush = { reset: pendingReset, delta: pending }
      pending = ''
      pendingReset = false
      lastFlush = t
      return out
    },
  }
}
