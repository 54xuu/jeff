import type { SlashCommand } from '../store'
import { PluginIcon } from './PluginIcon'

/** 聊天框 `/` 插件指令菜单（私聊 / 群聊共用） */
export function SlashMenu(props: {
  candidates: SlashCommand[]
  index: number
  setIndex: (i: number) => void
  onPick: (cmd: SlashCommand) => void
}): React.JSX.Element {
  return (
    <div className="mention-pop slash-pop" data-testid="slash-pop">
      <div className="slash-head">插件指令</div>
      {props.candidates.map((c, i) => (
        <button
          key={`${c.pluginId}${c.name}`}
          type="button"
          data-testid={`slash-item-${i}`}
          className={`slash-item ${i === props.index ? 'active' : ''}`}
          onMouseEnter={() => props.setIndex(i)}
          onClick={() => props.onPick(c)}
        >
          <span className="slash-plugin-tag">
            <PluginIcon icon={c.icon} iconSvg={c.iconSvg} size={18} className="slash-plugin-icon" />
            <span className="slash-plugin-name">{c.pluginName}</span>
          </span>
          <code className="slash-cmd-tag">{c.name}</code>
          {c.description && <span className="slash-desc">{c.description}</span>}
        </button>
      ))}
    </div>
  )
}
