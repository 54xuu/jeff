/**
 * 统一图标集：顶栏 / 抽屉的操作一律用 SVG，禁用 emoji。
 * emoji 的字形与配色由系统字体决定（各平台长得不一样、颜色也不跟主题走），
 * 图标走 currentColor 才能跟随主题变量。
 */
import type { ReactNode } from 'react'

export interface IconProps {
  size?: number
}

function Svg(props: IconProps & { children: ReactNode }): React.JSX.Element {
  const { size = 17, children } = props
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** 压缩上下文：四角向内收拢 + 对角箭头 */
export function IconCompress(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 14h6v6" />
      <path d="M20 10h-6V4" />
      <path d="M14 10l7-7" />
      <path d="M3 21l7-7" />
    </Svg>
  )
}

/** 新会话：对话气泡加号 */
export function IconNewSession(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v6" />
      <path d="M9 10h6" />
    </Svg>
  )
}

/** 智能体资料（单人头像） */
export function IconProfile(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21a7 7 0 0 1 14 0" />
    </Svg>
  )
}

/** 群资料（多人群组） */
export function IconGroupProfile(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M18 21a8 8 0 0 0-16 0" />
      <circle cx="10" cy="8" r="5" />
      <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
    </Svg>
  )
}

/** 关闭（抽屉右上角等） */
export function IconClose(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  )
}

/** 查看源码（</> 代码符号） */
export function IconCode(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </Svg>
  )
}

/** 查看图形（图表符号）——源码态切回图形用 */
export function IconDiagram(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M8 16v-5" />
      <path d="M12 16V8" />
      <path d="M16 16v-3" />
    </Svg>
  )
}

/** 放大查看（放大镜加号） */
export function IconZoomIn(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
      <path d="M11 8v6" />
      <path d="M8 11h6" />
    </Svg>
  )
}
