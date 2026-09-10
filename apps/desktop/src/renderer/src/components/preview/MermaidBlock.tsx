/**
 * Mermaid 图表块：懒加载 mermaid（约 1MB，按需 import）按当前亮/暗主题渲染；
 * 工具栏支持「查看源码 / 图形」切换、复制代码、点击/放大按钮全屏查看（矢量无损）。
 */
import { useEffect, useRef, useState } from 'react'
import { CopyButton } from '../ui/CopyButton'

export default function MermaidBlock(props: { code: string }): React.JSX.Element {
  const { code } = props
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [zoom, setZoom] = useState(false)
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`)

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

  return (
    <div className="md-mermaid" data-testid="md-mermaid">
      {showSource ? (
        <pre className="md-mermaid-src">{code}</pre>
      ) : error ? (
        <p className="md-mermaid-error">Mermaid 渲染失败：{error}</p>
      ) : svg ? (
        <div
          className="md-mermaid-fig"
          title="点击放大查看"
          onClick={() => setZoom(true)}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p className="settings-tip">Mermaid 渲染中…</p>
      )}
      <div className="md-mermaid-bar">
        <button className="text-btn" onClick={() => setShowSource((v) => !v)}>
          {showSource ? '查看图形' : '查看源码'}
        </button>
        {svg && !error && (
          <button className="text-btn" onClick={() => setZoom(true)}>
            放大
          </button>
        )}
        <CopyButton className="md-copy-btn" text={code} label="复制源码" testId="md-copy-mermaid" />
      </div>
      {zoom && svg && (
        <div className="mermaid-lightbox" onClick={() => setZoom(false)}>
          <div className="mermaid-lightbox-fig" dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="mermaid-lightbox-tip">点击任意处关闭 · 矢量图可无损缩放</p>
        </div>
      )}
    </div>
  )
}
