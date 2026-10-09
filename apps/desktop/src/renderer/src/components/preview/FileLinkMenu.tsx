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
    const onPointer = (e: PointerEvent) => {
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
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
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
