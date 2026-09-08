import { useEffect, useRef, useState } from 'react'

/** 复制图标：两个叠加的小正方形（lucide copy） */
export function CopyIcon(props: { size?: number }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={props.size ?? 14} height={props.size ?? 14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

/** 成功对勾 */
function CheckIcon(props: { size?: number }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={props.size ?? 14} height={props.size ?? 14} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

/**
 * 统一复制按钮：写剪贴板 + 1.5s 成功回执 + 失败可见反馈（不再静默吞异常）。
 * 消息气泡与代码块复制共用，保证回执和无障碍行为一致。
 */
export function CopyButton(props: {
  /** 要复制的纯文本；为空时按钮不渲染（避免出现无意义控件） */
  text: string | undefined | null
  className?: string
  /** 无障碍标签与悬浮提示 */
  label?: string
  testId?: string
}): React.JSX.Element | null {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | null>(null)
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  if (!props.text) return null
  const label = props.label || '复制'
  const done = (next: 'copied' | 'failed') => {
    setState(next)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 1500)
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text || '')
      done('copied')
    } catch (err) {
      console.error('复制失败', err)
      done('failed')
    }
  }
  return (
    <button
      type="button"
      className={`${props.className || ''} ${state === 'copied' ? 'done' : ''} ${state === 'failed' ? 'failed' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        void copy()
      }}
      title={state === 'failed' ? '复制失败，请重试' : label}
      aria-label={state === 'failed' ? '复制失败' : label}
      data-testid={props.testId}
    >
      {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}
