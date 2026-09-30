import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FILE_HREF_PREFIX } from './linkify'
import { pushBack } from './backstack'

const SCALE_MIN = 0.5
const SCALE_MAX = 6

/** 灯箱打开时先把整张图放进视口，避免细长流程图被拉满屏宽后只露出中间一截。 */
function fitWidth(svg: string): number {
  const maxW = Math.round(window.innerWidth * 0.92)
  const maxH = Math.round(window.innerHeight * 0.78)
  const m = svg.match(/viewBox\s*=\s*"([^"]+)"/)
  if (!m) return maxW
  const vb = m[1].trim().split(/[\s,]+/).map(Number)
  if (vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return maxW
  return Math.max(120, Math.round(Math.min(maxW, maxH * (vb[2] / vb[3]))))
}

function nodeText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  const obj = node as { props?: { children?: unknown } }
  if (typeof obj === 'object' && obj.props) return nodeText(obj.props.children)
  return ''
}

function extractCode(children: ReactNode): { lang?: string; raw: string } {
  const child = Array.isArray(children) ? children[0] : children
  if (child && typeof child === 'object' && 'props' in child) {
    const props = (child as { props?: { className?: string; children?: ReactNode } }).props
    const lang = /language-([\w-]+)/.exec(props?.className || '')?.[1]
    return { lang, raw: nodeText(props?.children) }
  }
  return { raw: nodeText(children) }
}

function CopyText(props: { text: string }): React.JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="md-copy-btn"
      onClick={() => {
        void navigator.clipboard?.writeText(props.text).then(
          () => {
            setDone(true)
            window.setTimeout(() => setDone(false), 1200)
          },
          () => setDone(false),
        )
      }}
    >
      {done ? '已复制' : '复制'}
    </button>
  )
}

function CodeBlock(props: { lang?: string; raw: string }): React.JSX.Element {
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{props.lang || '代码'}</span>
        <CopyText text={props.raw} />
      </div>
      <pre>
        <code>{props.raw}</code>
      </pre>
    </div>
  )
}

function useDarkTheme(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (): void => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

function MermaidLightbox(props: { svg: string; onClose: () => void }): React.JSX.Element {
  const { svg, onClose } = props
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [baseW, setBaseW] = useState(() => fitWidth(svg))
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null)
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null)
  const tapRef = useRef<{ t: number; x: number; y: number } | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => pushBack(onClose), [onClose])

  useEffect(() => {
    const onResize = (): void => setBaseW(fitWidth(svg))
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [svg])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const cur = viewRef.current
      const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, cur.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
      setView({ ...cur, scale: next })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 捕获失败仍可跟手 */
    }
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: viewRef.current.scale }
      panRef.current = null
      return
    }
    panRef.current = { x: e.clientX, y: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y, moved: false }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size >= 2 && pinchRef.current) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, pinchRef.current.scale * (dist / pinchRef.current.dist)))
      setView((v) => ({ ...v, scale }))
      return
    }
    const pan = panRef.current
    if (!pan) return
    const dx = e.clientX - pan.x
    const dy = e.clientY - pan.y
    if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true
    setView((v) => ({ ...v, x: pan.ox + dx, y: pan.oy + dy }))
  }

  const endPointer = (e: React.PointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchRef.current = null
    panRef.current = null
    if (pan?.moved) {
      tapRef.current = null
      return
    }
    if (pointers.current.size > 0) return
    const now = Date.now()
    const last = tapRef.current
    if (last && now - last.t < 320 && Math.abs(e.clientX - last.x) < 24 && Math.abs(e.clientY - last.y) < 24) {
      tapRef.current = null
      setView({ scale: 1, x: 0, y: 0 })
      return
    }
    tapRef.current = { t: now, x: e.clientX, y: e.clientY }
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="mermaid-lightbox" data-testid="mermaid-lightbox">
      <button type="button" className="mermaid-lightbox-close" data-testid="mermaid-lightbox-close" onClick={onClose}>
        关闭
      </button>
      <div
        ref={stageRef}
        className="mermaid-lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <div
          className="mermaid-lightbox-fig"
          style={{ width: Math.round(baseW * view.scale), transform: `translate(${view.x}px, ${view.y}px)` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <p className="mermaid-lightbox-tip">双指缩放 · 单指拖动 · 双击复位 · 点空白处关闭</p>
    </div>
  )
}

function MermaidBlock(props: { code: string }): React.JSX.Element {
  const { code } = props
  const dark = useDarkTheme()
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [zoom, setZoom] = useState(false)
  const closeZoom = useMemo(() => () => setZoom(false), [])

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    const id = `mmd${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
        })
        const r = await mermaid.render(id, code)
        if (!cancelled) setSvg(r.svg)
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
  }, [code, dark])

  return (
    <div className="md-mermaid" data-testid="md-mermaid">
      {showSource ? (
        <pre className="md-mermaid-src">{code}</pre>
      ) : error ? (
        <p className="md-mermaid-error">Mermaid 渲染失败：{error}</p>
      ) : svg ? (
        <div className="md-mermaid-fig" data-testid="md-mermaid-fig" onClick={() => setZoom(true)} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <p className="md-mermaid-pending">Mermaid 渲染中…</p>
      )}
      <div className="md-mermaid-bar">
        <button type="button" data-testid="md-mermaid-toggle-src" onClick={() => setShowSource((v) => !v)}>
          {showSource ? '图形' : '源码'}
        </button>
        {svg && !error ? (
          <button type="button" data-testid="md-mermaid-zoom" onClick={() => setZoom(true)}>
            放大
          </button>
        ) : null}
        <CopyText text={code} />
      </div>
      {zoom && svg ? <MermaidLightbox svg={svg} onClose={closeZoom} /> : null}
    </div>
  )
}

/**
 * 对话 Markdown：GFM（表格、任务列表、删除线）+ 代码块 + mermaid。
 * live 时 mermaid 源码往往还不完整，先按代码块展示，回合结束后再出图。
 * react-markdown 默认不渲染裸 HTML。
 * onFileLink：传入时，#jeff-file: 站内文件链接（工作区相对路径）改为回调而不是外开浏览器。
 */
function MarkdownInner(props: { text: string; live?: boolean; onFileLink?: (rel: string) => void }): React.JSX.Element {
  const liveRef = useRef(props.live)
  liveRef.current = props.live
  const fileLinkRef = useRef(props.onFileLink)
  fileLinkRef.current = props.onFileLink
  const components = useMemo<React.ComponentProps<typeof ReactMarkdown>['components']>(
    () => ({
      pre: ({ children }) => {
        const block = extractCode(children)
        if (block.lang?.toLowerCase() === 'mermaid' && !liveRef.current) return <MermaidBlock code={block.raw} />
        return <CodeBlock lang={block.lang} raw={block.raw} />
      },
      a: ({ node: _node, href, children, ...aProps }) => {
        if (href && href.startsWith(FILE_HREF_PREFIX) && fileLinkRef.current) {
          const rel = decodeURIComponent(href.slice(FILE_HREF_PREFIX.length))
          return (
            <a
              {...aProps}
              href={href}
              className="md-file-link"
              onClick={(e) => {
                e.preventDefault()
                fileLinkRef.current?.(rel)
              }}
            >
              {children}
            </a>
          )
        }
        return <a {...aProps} href={href} target="_blank" rel="noreferrer" />
      },
    }),
    [],
  )
  return (
    <div className="md-body" data-testid="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {props.text}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownInner)
