export default function Avatar(props: { emoji: string; size?: number }): React.JSX.Element {
  const size = props.size || 38
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.55 }}>
      {props.emoji}
    </div>
  )
}
