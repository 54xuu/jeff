import { useEffect } from 'react'
import { Button } from './Button'

/** 简易对话框：点击遮罩或 Esc 关闭；确认/取消 */
export function Dialog(props: {
  title: string
  children: React.ReactNode
  onClose: () => void
  onConfirm?: () => void
  confirmLabel?: string
  cancelLabel?: string
  confirmDisabled?: boolean
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props.onClose])

  return (
    <div
      className="jeff-dialog-mask"
      data-testid="dialog-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="jeff-dialog" role="dialog" aria-modal="true" data-testid="dialog">
        <div className="jeff-dialog-head">
          <h3>{props.title}</h3>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div className="jeff-dialog-body">{props.children}</div>
        <div className="jeff-dialog-foot">
          <Button onClick={props.onClose}>{props.cancelLabel || '取消'}</Button>
          {props.onConfirm && (
            <Button variant="primary" disabled={props.confirmDisabled} onClick={props.onConfirm}>
              {props.confirmLabel || '确定'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
