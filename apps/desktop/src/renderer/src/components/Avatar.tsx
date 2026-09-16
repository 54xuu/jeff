export default function Avatar(props: { emoji: string; size?: number; busy?: boolean }): React.JSX.Element {
  const size = props.size || 38
  return (
    <div className="avatar-wrap" style={{ width: size, height: size }}>
      <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.55 }}>
        {props.emoji}
      </div>
      {props.busy ? <span className="avatar-busy" data-testid="avatar-busy" title="忙碌中" /> : null}
    </div>
  )
}
