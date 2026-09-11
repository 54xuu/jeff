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
