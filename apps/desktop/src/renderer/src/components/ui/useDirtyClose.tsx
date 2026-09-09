import { useEffect, useRef, useState } from 'react'
import { Dialog } from './Dialog'

/**
 * 重型弹窗统一关闭守卫：有未保存修改（dirty）时先弹「放弃修改？」确认框，否则直接关闭。
 * 点遮罩、取消/× 按钮与 Esc 都走 requestClose()，防止误触静默丢数据。
 *
 * 约定：其他「消费 Esc」的组件（emoji 选择器、模型下拉、行内改名输入框）在处理 Escape 时
 * 调用 e.preventDefault()，本 hook 检测到 defaultPrevented 即跳过，避免一次 Esc 连关两层。
 * disabled：存在嵌套弹窗（如添加成员）时暂停本层 Esc 监听。
 */
export function useDirtyClose(props: { dirty: boolean; onClose: () => void; disabled?: boolean }): {
  requestClose: () => void
  guard: React.JSX.Element | null
} {
  const [confirming, setConfirming] = useState(false)
  const stateRef = useRef(props)
  stateRef.current = props
  const confirmingRef = useRef(false)
  confirmingRef.current = confirming

  useEffect(() => {
    if (props.disabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (confirmingRef.current) return // 确认框打开时由 Dialog 自行处理 Esc
      if (stateRef.current.dirty) setConfirming(true)
      else stateRef.current.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props.disabled])

  const requestClose = () => {
    if (stateRef.current.dirty) setConfirming(true)
    else stateRef.current.onClose()
  }

  const guard = confirming ? (
    <Dialog
      title="放弃未保存的修改？"
      confirmLabel="放弃修改"
      cancelLabel="继续编辑"
      onClose={() => setConfirming(false)}
      onConfirm={() => stateRef.current.onClose()}
    >
      当前有未保存的修改，关闭后将全部丢失。
    </Dialog>
  ) : null

  return { requestClose, guard }
}
