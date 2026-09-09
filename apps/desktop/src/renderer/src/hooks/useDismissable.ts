import { useEffect, type RefObject } from 'react'

/** Esc 立即关闭；点空白延后挂载，避免打开当次点击立刻关掉 */
export function useDismissable(open: boolean, onClose: () => void, rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 约定：消费 Esc 的组件 preventDefault，外层弹窗守卫（useDirtyClose）检测后跳过
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    let onDoc: ((e: MouseEvent) => void) | null = null
    const timer = window.setTimeout(() => {
      onDoc = (e: MouseEvent) => {
        if (!rootRef.current?.contains(e.target as Node)) onClose()
      }
      document.addEventListener('mousedown', onDoc)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      if (onDoc) document.removeEventListener('mousedown', onDoc)
    }
  }, [open, onClose, rootRef])
}
