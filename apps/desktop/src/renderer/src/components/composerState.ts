import type { ChatPluginInvoke, DraftQuote, DraftSnapshot } from '@jeff/core'
import { clipQuote, messageWithQuotes } from '@jeff/core'

/** 输入框里的插件筹码（选中 `/` 指令后） */
export interface PluginChipState {
  pluginId: string
  pluginName: string
  command: string
  icon: string
  iconSvg?: string
}

export type ComposerQuote = DraftQuote

/** 一条草稿：可选的正文前段 + 至多一个筹码 + 正文后段 + 引用。无筹码时全文在 after。 */
export interface ComposerState {
  before: string
  chip: PluginChipState | null
  after: string
  quotes: ComposerQuote[]
}

export function emptyComposer(): ComposerState {
  return { before: '', chip: null, after: '', quotes: [] }
}

export function snapshotOf(s: ComposerState): DraftSnapshot {
  return { before: s.before, after: s.after, chip: s.chip, quotes: s.quotes || [] }
}

export function composerFromSnapshot(s: DraftSnapshot): ComposerState {
  return { before: s.before, after: s.after, chip: s.chip, quotes: s.quotes || [] }
}

/** 发给模型的正文：引用在前，人写的话在后 */
export function outgoingText(s: ComposerState): string {
  return messageWithQuotes(composerText(s), s.quotes || [])
}

export function canSendComposer(s: ComposerState, imageCount = 0): boolean {
  return !!composerText(s).trim() || !!s.chip || (s.quotes || []).length > 0 || imageCount > 0
}

let quoteSeq = 0

export function makeQuote(source: 'chat' | 'browser', text: string): ComposerQuote | null {
  const clipped = clipQuote(text)
  if (!clipped) return null
  quoteSeq += 1
  return { id: `q${quoteSeq}`, source, text: clipped }
}

/** 插件页、划词、浏览器选区丢给当前会话的一次性预填 */
export interface ComposerSeed {
  nonce: number
  target: { kind: 'agent' | 'group'; id: string }
  chip?: PluginChipState
  after?: string
  quote?: ComposerQuote
}

export function applyComposerSeed(prev: ComposerState, seed: ComposerSeed): ComposerState {
  let next: ComposerState = { ...prev, quotes: prev.quotes || [] }
  if (seed.chip) next = { ...next, chip: seed.chip }
  if (seed.after && !next.after.trim() && !next.before.trim()) next = { ...next, after: seed.after }
  if (seed.quote) next = { ...next, quotes: [...next.quotes, seed.quote].slice(-8) }
  return next
}

export function composerText(s: ComposerState): string {
  return s.chip ? `${s.before}${s.after}` : s.after
}

export function composerPlugin(s: ComposerState): ChatPluginInvoke | undefined {
  if (!s.chip) return undefined
  return {
    id: s.chip.pluginId,
    name: s.chip.pluginName,
    command: s.chip.command,
    at: s.before.length,
    ...(s.chip.icon ? { icon: s.chip.icon } : {}),
  }
}

export function chipFromCommand(cmd: {
  pluginId: string
  pluginName: string
  name: string
  icon: string
  iconSvg?: string
}): PluginChipState {
  return {
    pluginId: cmd.pluginId,
    pluginName: cmd.pluginName,
    command: cmd.name,
    icon: cmd.icon,
    ...(cmd.iconSvg ? { iconSvg: cmd.iconSvg } : {}),
  }
}
