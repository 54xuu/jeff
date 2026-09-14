/**
 * Mermaid 图表块：懒加载 mermaid（约 1MB，按需 import）按当前亮/暗主题渲染；
 * 工具栏图标：查看源码/图形切换、复制代码、放大灯箱（填满视口 + 滚轮缩放，矢量无损）。
 */
import { useEffect, useRef, useState } from 'react'
import { CopyButton } from '../ui/CopyButton'
import { IconCode, IconDiagram, IconZoomIn } from '../ui/Icons'

/** 灯箱「填满」基准：视口宽/高占比（高留出余量给内边距与提示行） */
const FIT_W = 0.88
const FIT_H = 0.78
const SCALE_MIN = 0.25
const SCALE_MAX = 6
const WHEEL_STEP = 1.12
/** 灯箱面板左右内边距（styles.css 的 .mermaid-lightbox-fig padding），JS 算宽时要补回去 */
const LIGHTBOX_PAD = 18

export default function MermaidBlock(props: { code: string }): React.JSX.Element {
  const { code } = props
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [fitW, setFitW] = useState(0)
  const [scale, setScale] = useState(1)
  const [dragging, setDragging] = useState(false)
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`)
  const boxRef = useRef<HTMLDivElement | null>(null)
  /** 拖拽平移的起点（含按下时的滚动位置）；moved 用来区分「拖拽」与「点击手势」 */
  const dragRef = useRef<{ x: number; y: number; sl: number; st: number; moved: boolean } | null>(null)
  /** 上一次「点击手势」的时间与位置，用于自己判定双击复位 */
  const tapRef = useRef<{ t: number; x: number; y: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
        })
        const r = await mermaid.render(idRef.current, code)
        if (!cancelled) {
          setSvg(r.svg)
        }
      } catch (err) {
        if (!cancelled) {
          setSvg(null)
          setError(String((err as Error)?.message || err).slice(0, 200))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code])

  /** 从 svg 字符串解析 viewBox 纵横比，按视口算「填满」基准宽（px） */
  const computeFit = (): number => {
    if (!svg) return 0
    const m = svg.match(/viewBox\s*=\s*"([^"]+)"/)
    if (!m) return 0
    const vb = m[1].trim().split(/[\s,]+/).map(Number)
    if (vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return 0
    const aspect = vb[2] / vb[3]
    return Math.max(160, Math.round(Math.min(window.innerWidth * FIT_W, window.innerHeight * FIT_H * aspect)))
  }

  // 灯箱宽度必须由 JS 定死成 px：mermaid 的 svg 是 width="100%" + 内联 style="max-width: NNNpx"，
  // 交给 CSS 收缩盒会循环依赖、解析成默认 300px——这正是「点放大反而变小」的根因。
  useEffect(() => {
    if (!zoom) return
    const onResize = (): void => setFitW(computeFit())
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, svg])

  // 滚轮缩放：React 的 onWheel 走 passive 监听，preventDefault 无效，必须挂原生非 passive
  useEffect(() => {
    if (!zoom) return
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      setScale((k) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, k * (e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom])

  const openZoom = (): void => {
    setScale(1)
    setFitW(computeFit())
    setZoom(true)
  }

  /**
   * 左键按住拖拽平移：内容跟手走（改容器的 scrollLeft/scrollTop）；指针捕获只在「真的开始拖」之后设。
   * 点击语义不依赖浏览器合成的 click/dblclick —— 实测在这个灯箱上 mousedown/mouseup 都会派发，
   * 但 Chromium 不合成后续 click（事件轨迹里一个 click 都没有），所以「点空白关闭 / 双击复位」
   * 一律在 pointerup 上自己判定。
   */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = boxRef.current
    if (!el || e.button !== 0) return
    dragRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop, moved: false }
    setDragging(true) // 按下即给「抓住」反馈（与是否拖动无关）
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = boxRef.current
    const d = dragRef.current
    if (!el || !d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return // 抖动阈值：小于 4px 仍算点击手势
      d.moved = true
      try {
        e.currentTarget.setPointerCapture(e.pointerId) // 开始拖了才捕获，拖出面板也不丢
      } catch {
        /* 捕获失败不影响基本拖拽 */
      }
    }
    el.scrollLeft = d.sl - dx
    el.scrollTop = d.st - dy
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const moved = !!dragRef.current?.moved
    dragRef.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* 已释放 */
      }
    }
    if (moved) {
      tapRef.current = null
      return
    }
    // 未拖动 = 一次点击手势：同位置 320ms 内再来一次算双击（复位），否则单击空白处关闭
    const now = Date.now()
    const last = tapRef.current
    if (last && now - last.t < 320 && Math.abs(e.clientX - last.x) < 6 && Math.abs(e.clientY - last.y) < 6) {
      tapRef.current = null
      setScale(1)
      return
    }
    tapRef.current = { t: now, x: e.clientX, y: e.clientY }
    if (e.target === e.currentTarget) setZoom(false) // 只有点遮罩本身才关（点图不关）
  }

  return (
    <div className="md-mermaid" data-testid="md-mermaid">
      {showSource ? (
        <pre className="md-mermaid-src">{code}</pre>
      ) : error ? (
        <p className="md-mermaid-error">Mermaid 渲染失败：{error}</p>
      ) : svg ? (
        <div className="md-mermaid-fig" title="点击放大查看" onClick={openZoom} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <p className="settings-tip">Mermaid 渲染中…</p>
      )}
      <div className="md-mermaid-bar">
        <button
          className="icon-btn"
          data-testid="md-mermaid-toggle-src"
          title={showSource ? '查看图形' : '查看源码'}
          aria-label={showSource ? '查看图形' : '查看源码'}
          onClick={() => setShowSource((v) => !v)}
        >
          {showSource ? <IconDiagram /> : <IconCode />}
        </button>
        {svg && !error && (
          <button className="icon-btn" data-testid="md-mermaid-zoom" title="放大查看" aria-label="放大查看" onClick={openZoom}>
            <IconZoomIn />
          </button>
        )}
        <CopyButton className="md-copy-btn" text={code} label="复制源码" testId="md-copy-mermaid" />
      </div>
      {zoom && svg && (
        <div
          ref={boxRef}
          className={`mermaid-lightbox${dragging ? ' is-dragging' : ''}`}
          data-testid="mermaid-lightbox"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            className="mermaid-lightbox-fig"
            style={{ width: fitW ? Math.round(fitW * scale) + LIGHTBOX_PAD * 2 : 'min(88vw, 900px)' }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <p className="mermaid-lightbox-tip">滚轮缩放 · 按住拖动平移 · 双击复位 · 点击空白处关闭</p>
        </div>
      )}
    </div>
  )
}
