/** 插件图标：优先 icon.svg，无则退化 emoji */
export function PluginIcon(props: { icon: string; iconSvg?: string; size?: number; className?: string }): React.JSX.Element {
  const size = props.size ?? 24
  const cls = props.className ? `plugin-svg-wrap ${props.className}` : 'plugin-svg-wrap'
  if (props.iconSvg) {
    const svg = props.iconSvg.replace(/<svg([^>]*)>/i, (_m, attrs: string) => {
      const cleaned = String(attrs)
        .replace(/\s(width|height)=["'][^"']*["']/gi, '')
        .trim()
      return `<svg ${cleaned} width="${size}" height="${size}">`
    })
    return <span className={cls} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} aria-hidden />
  }
  return (
    <span className={props.className ? `plugin-emoji-icon ${props.className}` : 'plugin-emoji-icon'} style={{ fontSize: size * 0.85, lineHeight: 1 }}>
      {props.icon}
    </span>
  )
}
