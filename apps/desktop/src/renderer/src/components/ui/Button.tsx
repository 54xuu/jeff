import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'default' | 'primary' | 'danger' | 'ghost'

/**
 * 统一按钮：高度/字号吃 CSS 变量，variant 映射到现有 .btn 类。
 */
export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant
    children: ReactNode
  },
): React.JSX.Element {
  const { variant = 'default', className, children, type, ...rest } = props
  const variantClass =
    variant === 'primary' ? 'btn primary' : variant === 'danger' ? 'btn danger' : variant === 'ghost' ? 'btn ghost' : 'btn'
  return (
    <button type={type || 'button'} className={`${variantClass}${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </button>
  )
}
