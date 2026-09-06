import { useEffect } from 'react'

/** 轻量 Toast：错误/成功提示，可关闭；默认 5s 自动消失 */
export function Toast(props: {
  kind?: 'error' | 'success' | 'info'
  message: string
  onClose?: () => void
  autoCloseMs?: number
}): React.JSX.Element {
  const kind = props.kind || 'info'
  useEffect(() => {
    if (!props.onClose) return
    const t = setTimeout(props.onClose, props.autoCloseMs ?? 5000)
    return () => clearTimeout(t)
  }, [props.onClose, props.autoCloseMs, props.message])

  return (
    <div className={`jeff-toast jeff-toast-${kind}`} role="status" data-testid="toast">
      <span className="jeff-toast-msg">{props.message}</span>
      {props.onClose && (
        <button type="button" className="jeff-toast-close" aria-label="关闭" onClick={props.onClose}>
          ×
        </button>
      )}
    </div>
  )
}
