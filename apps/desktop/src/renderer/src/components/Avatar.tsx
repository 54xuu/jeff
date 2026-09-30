import Mascot, { type MascotMood } from './Mascot'
import { XIAOJIE_ID } from '@jeff/core'

/**
 * 头像：普通智能体显示 emoji；内置小杰（agentId 命中）渲染吉祥物本体。
 * 只做渲染层特判，DB 里的 avatar 字段不动；busy 时 idle 升级为 working 表情，
 * 不再叠角标绿点（状态已经在脸上）。
 */
export default function Avatar(props: {
  emoji: string
  size?: number
  busy?: boolean
  agentId?: string
  /** 显式表情（done/error 等调用方才知道的状态）；不传时按 agentId + busy 推导 */
  mood?: MascotMood
}): React.JSX.Element {
  const size = props.size || 38
  const base: MascotMood | null = props.mood ?? (props.agentId === XIAOJIE_ID ? 'idle' : null)
  if (base) {
    const mood: MascotMood = base === 'idle' && props.busy ? 'working' : base
    return (
      <div className="avatar-wrap" style={{ width: size, height: size }}>
        <Mascot size={size} mood={mood} />
      </div>
    )
  }
  return (
    <div className="avatar-wrap" style={{ width: size, height: size }}>
      <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.55 }}>
        {props.emoji}
      </div>
      {props.busy ? <span className="avatar-busy" data-testid="avatar-busy" title="忙碌中" /> : null}
    </div>
  )
}
