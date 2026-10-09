/**
 * 文件链接右键菜单：打开、在文件夹中显示、复制完整路径。全局只挂一份。
 */
import { useEffect } from 'react'
import { usePreviewStore } from './previewStore'

export default function FileLinkMenu(): React.JSX.Element | null {
  const menu = usePreviewStore((s) => s.fileMenu)
  const closeFileMenu = usePreviewStore((s) => s.closeFileMenu)
  const openAbs = usePreviewStore((s) => s.openAbs)
  const revealAbs = usePreviewStore((s) => s.revealAbs)
  const copyAbs = usePreviewStore((s) => s.copyAbs)

  useEffect(() => {
    if (!menu) return
    // 右键手势在 Windows 上会在 contextmenu 之后再补一次 pointerdown。
    // 若立刻监听 pointerdown，菜单会在画出之前被这次事件关掉。
    // 与会话列表右键菜单一样，只在后续左键 click 时关闭，并错过打开这一下。
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('[data-testid="file-link-menu"]')) return
      closeFileMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      closeFileMenu()
    }
    const timer = window.setTimeout(() => window.addEventListener('click', onClick), 0)
    document.addEventListener('keydown', onKey, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [menu, closeFileMenu])

  if (!menu) return null
  return (
    <div
      className="chat-row-menu file-link-menu"
      data-testid="file-link-menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" data-testid="file-link-open" onClick={() => { closeFileMenu(); void openAbs(menu.abs) }}>打开</button>
      <button type="button" data-testid="file-link-reveal" onClick={() => { closeFileMenu(); void revealAbs(menu.abs) }}>在文件夹中显示</button>
      <button type="button" data-testid="file-link-copy" onClick={() => { closeFileMenu(); void copyAbs(menu.abs) }}>复制路径</button>
    </div>
  )
}
