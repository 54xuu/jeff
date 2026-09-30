export type MascotMood = 'idle' | 'working' | 'done' | 'error'

/**
 * 「小杰」吉祥物：docs/assets/logo.svg 的角色本体（翡翠绿拱门 + Cue 五官）。
 * 与桌面端同名组件保持一致：idle 微笑 / working 瞳孔游移 / done 双眨眼 / error 瘪嘴。
 * key={mood} 让 mood 变化时重挂载，CSS 动画每次都从头播。
 */
export default function Mascot(props: { size?: number; mood?: MascotMood }): React.JSX.Element {
  const size = props.size || 38
  const mood = props.mood || 'idle'
  const mouth =
    mood === 'error'
      ? 'M 60.5,79.5 Q 64,74.5 68.5,78.5'
      : mood === 'done'
        ? 'M 58,75.5 Q 64,83.5 71,76'
        : 'M 60,76 Q 64,81 69,77'
  return (
    <svg key={mood} className={`mascot mascot-${mood}`} viewBox="0 0 128 128" width={size} height={size} aria-hidden="true">
      <path d="M 18,88 C 14,88 12,84 14,80 C 22,40 40,28 64,28 C 88,28 106,40 114,80 C 116,84 114,88 110,88 Z" fill="#10B981" />
      <g className="mascot-eye">
        <circle cx="51" cy="62" r="11" fill="#FFFFFF" />
        <circle className="mascot-pupil" cx="52" cy="62" r="5.5" fill="#0F172A" />
      </g>
      <g className="mascot-eye">
        <circle cx="77" cy="62" r="11" fill="#FFFFFF" />
        <circle className="mascot-pupil" cx="78" cy="62" r="5.5" fill="#0F172A" />
      </g>
      <path d={mouth} fill="none" stroke="#0F172A" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
