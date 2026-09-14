import { useEffect, useState } from 'react'

/**
 * 窗口宽度的响应式读数。
 *
 * 三栏宽度都是「偏好值 + 渲染时 clamp」，clamp 依赖窗口宽度；没有这个 hook 的话
 * 窗口缩放不会触发重渲染，面板会一直用旧窗口算出来的宽度（撑出可视区）。
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}
