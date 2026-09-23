import { useEffect, useMemo, useState } from 'react'
import { XIAOJIE_SUGGESTIONS } from '@jeff/core'
import { makeQuote, type ComposerQuote, type ComposerState } from './composerState'

export function QuotePills(props: { quotes: ComposerQuote[]; onRemove: (id: string) => void }): React.JSX.Element | null {
  if (!props.quotes.length) return null
  return (
    <div className="quote-pills" data-testid="quote-pills">
      {props.quotes.map((q) => (
        <span key={q.id} className="quote-pill" data-testid="quote-pill" title={q.text}>
          <span className="quote-pill-label">{q.source === 'browser' ? '网页' : '对话'}</span>
          <span className="quote-pill-text">{q.text}</span>
          <button type="button" className="quote-pill-x" aria-label="移除引用" onClick={() => props.onRemove(q.id)}>
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

export function SuggestionChips(props: { onPick: (text: string) => void }): React.JSX.Element {
  return (
    <div className="suggest-row" data-testid="xiaojie-suggests">
      {XIAOJIE_SUGGESTIONS.map((text, i) => (
        <button key={text} type="button" className="suggest-chip" data-testid={`xiaojie-suggest-${i}`} onClick={() => props.onPick(text)}>
          {text}
        </button>
      ))}
    </div>
  )
}

export function BackToBottom(props: { onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="back-bottom" data-testid="chat-back-bottom" onClick={props.onClick}>
      回到底部
    </button>
  )
}

/** 在已加载消息正文里查找。Ctrl/Cmd+F 打开，Esc 关闭。思考和工具块不参与。 */
export function useConversationFind(messages: Array<{ id: string; text: string }>): {
  open: boolean
  query: string
  setQuery: (q: string) => void
  close: () => void
  hitId: string | null
  count: number
  index: number
  next: () => void
  prev: () => void
} {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return messages.filter((m) => (m.text || '').toLowerCase().includes(q)).map((m) => m.id)
  }, [messages, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const id = hits[index]
    if (!open || !id) return
    document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' })
  }, [open, hits, index])

  return {
    open,
    query,
    setQuery,
    close: () => setOpen(false),
    hitId: hits[index] ?? null,
    count: hits.length,
    index,
    next: () => setIndex((i) => (hits.length ? (i + 1) % hits.length : 0)),
    prev: () => setIndex((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0)),
  }
}

export function FindBar(props: {
  query: string
  count: number
  index: number
  onQuery: (q: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="conv-find" data-testid="chat-find">
      <input
        className="conv-find-input"
        data-testid="chat-find-input"
        autoFocus
        placeholder="在当前会话中查找"
        value={props.query}
        onChange={(e) => props.onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            props.onClose()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) props.onPrev()
            else props.onNext()
          }
        }}
      />
      <span className="conv-find-count">{props.query.trim() ? `${props.count ? props.index + 1 : 0}/${props.count}` : ''}</span>
      <button type="button" className="icon-btn" data-testid="chat-find-prev" title="上一条" onClick={props.onPrev}>
        ↑
      </button>
      <button type="button" className="icon-btn" data-testid="chat-find-next" title="下一条" onClick={props.onNext}>
        ↓
      </button>
      <button type="button" className="icon-btn" title="关闭" onClick={props.onClose}>
        ×
      </button>
    </div>
  )
}

/** 气泡里划词后出现「引用」。工具和思考折叠区不触发。 */
export function useTextQuote(bodyRef: React.RefObject<HTMLElement | null>, onQuote: (text: string) => void): React.JSX.Element | null {
  const [pos, setPos] = useState<{ x: number; y: number; text: string } | null>(null)
  useEffect(() => {
    const onUp = () => {
      const sel = window.getSelection()
      const text = sel?.toString() ?? ''
      if (!sel || sel.isCollapsed || !text.trim()) {
        setPos(null)
        return
      }
      const node = sel.anchorNode
      const el = node instanceof Element ? node : node?.parentElement
      const root = bodyRef.current
      if (!el || !root || !root.contains(el)) {
        setPos(null)
        return
      }
      if (el.closest('.msg-extras, .extra-tools, .extra-reasoning, .conv-find')) {
        setPos(null)
        return
      }
      if (!el.closest('.bubble, .msg-system')) {
        setPos(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      setPos({ x: rect.left, y: Math.max(8, rect.top - 32), text })
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [bodyRef])
  if (!pos) return null
  return (
    <button
      type="button"
      className="quote-pop"
      data-testid="quote-selection"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(pos.text)
        window.getSelection()?.removeAllRanges()
        setPos(null)
      }}
    >
      引用
    </button>
  )
}

export function addQuote(setComposer: (fn: (prev: ComposerState) => ComposerState) => void, source: 'chat' | 'browser', text: string): void {
  const quote = makeQuote(source, text)
  if (!quote) return
  setComposer((prev) => ({ ...prev, quotes: [...(prev.quotes || []), quote].slice(-8) }))
}
