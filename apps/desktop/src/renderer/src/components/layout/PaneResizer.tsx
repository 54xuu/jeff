import { useCallback, useEffect, useRef, useState } from 'react'
import { IconChevronLeft, IconChevronRight } from '../ui/Icons'

/**
 * 分栏分隔条：鼠标拖动改变某一栏的宽度，双击回到默认宽度，hover 时浮出一个开合按钮。
 *
 * 交互参考 VS Code / Chrome DevTools / Notion：平时只看得见分栏那条 1px 边框，
 * 靠近时热区才显形（6px 可抓 + hover 亮绿 + 居中箭头按钮），界面干净但找得到。
 *
 * 拖拽用 Pointer Events + setPointerCapture（与输入区拖高同一套范式），
 * 并在拖拽期间盖一层全窗口透明遮罩：鼠标移到 <webview> 之上时事件会被 guest 页面吃掉，
 * 没有遮罩的话「往右拖窄浏览器」会中途断掉。
 *
 * 箭头按钮与分隔条共用一个热区：按在按钮上但拖动了＝照常改宽度（点一下才算收起），
 * 否则正中那条最好抓的位置会被按钮占掉，抓不动。
 */
export interface PaneResizerProps {
  /** left = 调左侧栏（手柄贴在它的右边缘）；right = 调右侧栏（手柄贴在它的左边缘） */
  side: 'left' | 'right'
  /** 当前宽度（拖拽起点） */
  width: number
  /** 把候选宽度夹到合法区间——规则由调用方持有（要参考窗口宽度与另一栏的实时宽度） */
  clamp: (width: number) => number
  /** 拖拽过程中实时回调（已按帧节流） */
  onResize: (width: number) => void
  /** 松手：调用方把当前宽度落盘 */
  onCommit: () => void
  /** 双击：回到默认宽度 */
  onReset: () => void
  /** 点箭头：收起这一栏 */
  onCollapse: () => void
  collapseTitle: string
  testId: string
}

/** 超过这个像素才算「拖动」而不是「点击」 */
const CLICK_SLOP = 3

export default function PaneResizer(props: PaneResizerProps): React.JSX.Element {
  const { side, width, clamp, onResize, onCommit, onReset, onCollapse, collapseTitle, testId } = props
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingRef = useRef<number | null>(null)
  /** 这次按下是否落在箭头按钮上、以及是否真的拖动了（决定松手时是「收起」还是「改宽度」） */
  const pressedButtonRef = useRef(false)
  const movedRef = useRef(false)
  const clickGuardRef = useRef(false)
  // 回调每次渲染都是新闭包，放进 ref 里，window 监听器就只挂一次
  const cbRef = useRef({ clamp, onResize, onCommit, onCollapse })
  cbRef.current = { clamp, onResize, onCommit, onCollapse }

  const flush = useCallback(() => {
    frameRef.current = null
    const next = pendingRef.current
    pendingRef.current = null
    if (next != null) cbRef.current.onResize(next)
  }, [])

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const deltaX = event.clientX - drag.startX
      if (Math.abs(deltaX) > CLICK_SLOP) movedRef.current = true
      // 左侧栏往右拖变宽；右侧栏反过来（手柄在它的左边缘）
      pendingRef.current = cbRef.current.clamp(drag.startWidth + deltaX * (side === 'left' ? 1 : -1))
      // 一帧只写一次：拖动中被改的是布局，活跃的 webview 会被带着重排
      if (frameRef.current == null) frameRef.current = requestAnimationFrame(flush)
    }
    const onUp = () => {
      if (!dragRef.current) return
      const wasClickOnButton = pressedButtonRef.current && !movedRef.current
      dragRef.current = null
      pressedButtonRef.current = false
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      setDragging(false)
      document.body.classList.remove('pane-resizing')
      // 松手前最后一帧还没画出来的话，先把它落地再落盘
      if (pendingRef.current != null) {
        const last = pendingRef.current
        pendingRef.current = null
        cbRef.current.onResize(last)
      }
      if (wasClickOnButton) {
        // 鼠标路径下 click 会被指针捕获吃掉（不会再触发按钮的 onClick），这里补上收起动作
        clickGuardRef.current = true
        cbRef.current.onCollapse()
      } else {
        cbRef.current.onCommit()
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('pane-resizing')
    }
  }, [side, flush])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: width }
    pressedButtonRef.current = !!(event.target as HTMLElement).closest('button')
    movedRef.current = false
    clickGuardRef.current = false
    setDragging(true)
    document.body.classList.add('pane-resizing')
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  return (
    <div
      className={`pane-resizer ${side} ${dragging ? 'is-dragging' : ''}`}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    >
      {dragging && <div className="pane-drag-overlay" />}
      <button
        className="pane-toggle"
        data-testid={`${testId}-toggle`}
        aria-label={collapseTitle}
        title={`${collapseTitle}（拖动分隔条可调宽度，双击恢复默认）`}
        onClick={() => {
          // 键盘激活走这里；鼠标点击已由上面的拖拽判定处理，别重复收起又展开
          if (clickGuardRef.current) {
            clickGuardRef.current = false
            return
          }
          onCollapse()
        }}
      >
        {side === 'left' ? <IconChevronLeft size={13} /> : <IconChevronRight size={13} />}
      </button>
    </div>
  )
}

/** 左栏收起后常驻在对话区左边缘的细条：点一下把它放回来 */
export function PaneExpandStrip(props: { title: string; testId: string; onExpand: () => void }): React.JSX.Element {
  const { title, testId, onExpand } = props
  return (
    <div className="pane-expand-strip" data-testid={testId}>
      <button className="pane-toggle" data-testid={`${testId}-btn`} aria-label={title} title={title} onClick={onExpand}>
        <IconChevronRight size={13} />
      </button>
    </div>
  )
}
