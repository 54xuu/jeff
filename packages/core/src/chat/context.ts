import type { ChatMsg } from './private.js'
import type { AssistantInfo, SessionMessage } from '../oc/client.js'

/** opencode overflow 默认 reserved 上限（与 sidecar overflow.ts COMPACTION_BUFFER 一致） */
export const COMPACTION_BUFFER = 20_000

export interface ContextTokens {
  total?: number
  input?: number
  output?: number
  cache?: { read?: number; write?: number }
}

export interface ContextPreviewParts {
  /** 最后一次成功 compact 的摘要文本（若有） */
  summary: string | null
  /** 仍会进入模型上下文的消息（compact 边界之后） */
  activeMessages: ChatMsg[]
  /** 被 compact 隐藏的消息条数（边界之前，不含摘要本身） */
  compactedCount: number
  /** 最近一条 assistant 的 token 用量 */
  usedTokens: number
}

/** 从 assistant tokens 字段估算用量（对齐 opencode overflow.isOverflow） */
export function tokenUsage(tokens?: ContextTokens | null): number {
  if (!tokens) return 0
  if (typeof tokens.total === 'number' && tokens.total > 0) return tokens.total
  const cacheRead = tokens.cache?.read ?? 0
  const cacheWrite = tokens.cache?.write ?? 0
  return (tokens.input ?? 0) + (tokens.output ?? 0) + cacheRead + cacheWrite
}

/**
 * 自动压缩阈值（usable）：
 * contextLimit - min(COMPACTION_BUFFER, outputLimit || COMPACTION_BUFFER)
 * 与 opencode usable() 在无 limit.input 时的行为一致的近似。
 */
export function compactionThreshold(contextLimit: number | undefined, outputLimit?: number): number | null {
  if (!contextLimit || contextLimit <= 0) return null
  const reserved = Math.min(COMPACTION_BUFFER, outputLimit && outputLimit > 0 ? outputLimit : COMPACTION_BUFFER)
  return Math.max(0, contextLimit - reserved)
}

function partsOf(m: SessionMessage): Array<Record<string, unknown>> {
  const info = m.info as { parts?: unknown[] }
  return (m.parts || info.parts || []) as Array<Record<string, unknown>>
}

function isCompactionUser(m: SessionMessage): boolean {
  return partsOf(m).some((p) => p.type === 'compaction')
}

function isCompletedSummary(m: SessionMessage): boolean {
  const info = m.info as AssistantInfo & { summary?: boolean; mode?: string; finish?: string }
  if (info.role !== 'assistant') return false
  if (info.error) return false
  if (!info.time?.completed && !info.finish) return false
  return info.summary === true || info.mode === 'compaction'
}

function summaryTextFrom(m: SessionMessage): string {
  const texts: string[] = []
  for (const p of partsOf(m)) {
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) texts.push(p.text.trim())
  }
  return texts.join('\n\n').trim()
}

/** 将 opencode session 消息映射为 UI ChatMsg（供 context preview / 测试复用） */
export function mapRawMessages(msgs: SessionMessage[]): ChatMsg[] {
  const out: ChatMsg[] = []
  for (const m of msgs) {
    const info = m.info as { id: string; role?: string; time?: { created?: number }; agent?: string }
    const role = info.role === 'user' ? 'user' : info.role === 'assistant' ? 'assistant' : 'system'
    const parts = partsOf(m)
    let text = ''
    const reasoning: string[] = []
    const tools: NonNullable<ChatMsg['tools']> = []
    const images: NonNullable<ChatMsg['images']> = []
    for (const p of parts) {
      if (p.type === 'text' && !p.synthetic && typeof p.text === 'string' && p.text.trim()) {
        text += (text ? '\n' : '') + p.text
      } else if (p.type === 'reasoning' && typeof p.text === 'string' && p.text.trim()) {
        reasoning.push(p.text)
      } else if (p.type === 'file' && typeof p.url === 'string' && p.url.startsWith('data:')) {
        images.push({ mime: String(p.mime || 'image/png'), dataUrl: p.url })
      } else if (p.type === 'tool') {
        const st = (p.state || {}) as { status?: string; output?: string; error?: string }
        tools.push({ tool: String(p.tool || ''), status: st.status, output: (st.output || '').slice(0, 2000), error: st.error })
      }
    }
    if (role === 'assistant' && !text.trim() && tools.length === 0) continue
    if (isCompactionUser(m)) continue
    out.push({
      id: info.id,
      role,
      agentId: info.agent,
      text,
      time: info.time?.created || 0,
      ...(reasoning.length ? { reasoning } : {}),
      ...(tools.length ? { tools } : {}),
      ...(images.length ? { images } : {}),
    })
  }
  return out
}

/**
 * 按最后一次成功 compact 切分上下文：
 * - summary：该 compact 的 assistant 文本
 * - active：边界之后的消息（不含 compaction user / summary assistant）
 * - compactedCount：边界之前会被隐藏的条数
 */
export function splitContextMessages(msgs: SessionMessage[]): ContextPreviewParts {
  let lastUserIdx = -1
  let lastAssistantIdx = -1
  for (let i = 0; i < msgs.length; i++) {
    if (isCompactionUser(msgs[i])) lastUserIdx = i
    if (isCompletedSummary(msgs[i]) && lastUserIdx >= 0) lastAssistantIdx = i
  }

  let summary: string | null = null
  let boundaryExclusive = 0
  if (lastAssistantIdx >= 0) {
    summary = summaryTextFrom(msgs[lastAssistantIdx]) || null
    boundaryExclusive = lastAssistantIdx + 1
  }

  const head = msgs.slice(0, boundaryExclusive)
  const tail = msgs.slice(boundaryExclusive)
  // 头部里 compaction 触发消息与摘要本身不计入「被压缩掉的对话」
  const compactedCount = head.filter((m) => !isCompactionUser(m) && !isCompletedSummary(m)).length

  const activeRaw = tail.filter((m) => !isCompactionUser(m) && !isCompletedSummary(m))
  const activeMessages = mapRawMessages(activeRaw)

  let usedTokens = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const info = msgs[i].info as AssistantInfo
    if (info.role !== 'assistant') continue
    if (info.summary || info.mode === 'compaction') continue
    usedTokens = tokenUsage(info.tokens as ContextTokens | undefined)
    if (usedTokens > 0) break
  }

  return { summary, activeMessages, compactedCount, usedTokens }
}

export interface ContextPreview {
  sessionId: string | null
  agentId: string
  projectId?: string
  usedTokens: number
  contextLimit: number | null
  outputLimit: number | null
  threshold: number | null
  autoEnabled: boolean
  system: string | null
  summary: string | null
  activeMessages: ChatMsg[]
  compactedCount: number
}
