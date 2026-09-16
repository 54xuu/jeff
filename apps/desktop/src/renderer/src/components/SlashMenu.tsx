import type { SlashCommand } from '../store'
import { PluginIcon } from './PluginIcon'

/** 聊天框 `/` 指令菜单：按组渲染（本轮只有「插件」） */
export function SlashMenu(props: {
  candidates: SlashCommand[]
  index: number
  setIndex: (i: number) => void
  onPick: (cmd: SlashCommand) => void
}): React.JSX.Element {
  return (
    <div className="mention-pop slash-pop" data-testid="slash-pop">
      {props.candidates.length > 0 && (
        <div className="slash-head" data-testid="slash-group-plugin">
          插件
        </div>
      )}
      {props.candidates.map((c, i) => (
        <button
          key={`${c.pluginId}${c.name}`}
          type="button"
          data-testid={`slash-item-${i}`}
          className={`slash-item ${i === props.index ? 'active' : ''}`}
          onMouseEnter={() => props.setIndex(i)}
          onClick={() => props.onPick(c)}
        >
          <span className="slash-cmd">{c.name}</span>
          <PluginIcon icon={c.icon} iconSvg={c.iconSvg} size={16} className="slash-item-icon" />
          <span className="slash-name">{c.pluginName}</span>
          {c.description ? <span className="slash-desc">{c.description}</span> : null}
        </button>
      ))}
    </div>
  )
}
