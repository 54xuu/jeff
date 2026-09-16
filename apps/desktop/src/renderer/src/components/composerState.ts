import type { ChatPluginInvoke } from '@jeff/core'

/** 输入框里的插件筹码（选中 `/` 指令后） */
export interface PluginChipState {
  pluginId: string
  pluginName: string
  command: string
  icon: string
  iconSvg?: string
}

/** 一条草稿：可选的正文前段 + 至多一个筹码 + 正文后段。无筹码时全文在 after。 */
export interface ComposerState {
  before: string
  chip: PluginChipState | null
  after: string
}

export function emptyComposer(): ComposerState {
  return { before: '', chip: null, after: '' }
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
