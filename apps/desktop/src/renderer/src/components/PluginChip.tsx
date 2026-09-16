import { useStore } from '../store'
import { PluginIcon } from './PluginIcon'

/** 对话框 / 输入框里的插件筹码：图标紧跟亮蓝中文名 */
export function PluginChip(props: {
  pluginId: string
  name: string
  icon: string
  iconSvg?: string
  testId?: string
}): React.JSX.Element {
  const live = useStore((s) => s.plugins.find((p) => p.id === props.pluginId))
  const name = live?.name || props.name
  const icon = live?.icon || props.icon
  const iconSvg = live?.iconSvg || props.iconSvg
  return (
    <span className="plugin-chip" data-testid={props.testId || 'plugin-chip'} contentEditable={false}>
      <PluginIcon icon={icon} iconSvg={iconSvg} size={16} className="plugin-chip-icon" />
      <span className="plugin-chip-name">{name}</span>
    </span>
  )
}

/** 用户气泡：在指定下标插入筹码，前后文保持原样 */
export function UserTextWithChip(props: {
  text: string
  plugin?: { id: string; name: string; command: string; at: number; icon?: string }
}): React.JSX.Element {
  const { text, plugin } = props
  if (!plugin) {
    return (
      <>
        {text.split('\n').map((line, i) => (
          <p key={i}>{line || ' '}</p>
        ))}
      </>
    )
  }
  const at = Math.max(0, Math.min(text.length, plugin.at))
  const before = text.slice(0, at)
  const after = text.slice(at)
  const live = useStore((s) => s.plugins.find((p) => p.id === plugin.id))
  return (
    <p className="msg-user-with-chip">
      {before}
      <PluginChip pluginId={plugin.id} name={plugin.name} icon={live?.icon || plugin.icon || '🧩'} iconSvg={live?.iconSvg} testId="msg-plugin-chip" />
      {after}
    </p>
  )
}
