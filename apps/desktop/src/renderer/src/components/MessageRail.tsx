import { useCallback, useEffect, useRef, useState } from 'react'
import { extractThinkTags } from '@jeff/core'
import { fmtFullTime } from '../format'

const PREVIEW_MAX = 100
const FLASH_MS = 1200
const HIDE_DELAY_MS = 160

export type NavRole = 'user' | 'assistant' | 'system'

export interface NavItem {
  id: string
  role: NavRole
  preview: string
  time?: number
  sender?: string
}

/** 导航条预览：助手消息剥掉 think 后取前 100 字；纯图片退化为「[图片]」。 */
export function toNavPreview(msg: { role: string; text: string; images?: Array<unknown> }): string {
  const raw = msg.role === 'assistant' ? extractThinkTags(msg.text).text : msg.text
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return msg.images && msg.images.length > 0 ? '[图片]' : '（空消息）'
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text
}

export function useMessageAnchors(): {
  anchors: React.MutableRefObject<Map<string, HTMLElement>>
  bindAnchor: (id: string) => (el: HTMLElement | null) => void
} {
  const anchors = useRef(new Map<string, HTMLElement>())
  const bindAnchor = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) anchors.current.set(id, el)
      else anchors.current.delete(id)
    },
    [],
  )
  return { anchors, bindAnchor }
}

export default function MessageRail(props: {
  items: NavItem[]
  bodyRef: React.RefObject<HTMLElement | null>
  anchors: React.MutableRefObject<Map<string, HTMLElement>>
}): React.JSX.Element | null {
  const { items, bodyRef, anchors } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<number | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hover, setHover] = useState<{ id: string; top: number } | null>(null)

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    let raf = 0
    const update = () => {
      raf = 0
      const top = el.getBoundingClientRect().top
      let next: string | null = items[0]?.id ?? null
      for (const item of items) {
        const node = anchors.current.get(item.id)
        if (!node) continue
        if (node.getBoundingClientRect().bottom > top + 8) {
          next = item.id
          break
        }
      }
      setActiveId(next)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [bodyRef, items, anchors])

  useEffect(() => {
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    }
  }, [])

  if (items.length === 0) return null

  const hoverItem = hover ? items.find((it) => it.id === hover.id) : undefined

  const showHover = (id: string, bar: HTMLElement) => {
    const wrap = wrapRef.current
    if (!wrap) return
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
    const wr = wrap.getBoundingClientRect()
    const br = bar.getBoundingClientRect()
    setHover({ id, top: br.top - wr.top + br.height / 2 })
  }

  const hideHover = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setHover(null), HIDE_DELAY_MS)
  }

  const jumpTo = (id: string) => {
    const node = anchors.current.get(id)
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
    node.classList.add('msg-flash')
    window.setTimeout(() => node.classList.remove('msg-flash'), FLASH_MS)
    setHover(null)
  }

  return (
    <div className="msg-rail-wrap" ref={wrapRef} data-testid="msg-rail">
      <div className="msg-rail" role="navigation" aria-label="对话记录快速定位">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`msg-rail-bar role-${item.role}${item.id === activeId ? ' active' : ''}`}
            data-testid={`msg-rail-bar-${item.id}`}
            aria-label={`定位到${item.sender || '消息'}：${item.preview}`}
            onMouseEnter={(e) => showHover(item.id, e.currentTarget)}
            onMouseLeave={hideHover}
            onFocus={(e) => showHover(item.id, e.currentTarget)}
            onBlur={hideHover}
            onClick={() => jumpTo(item.id)}
          />
        ))}
      </div>
      {hover && hoverItem && (
        <div
          className="msg-rail-pop"
          data-testid="msg-rail-pop"
          style={{ top: hover.top }}
          onMouseEnter={() => {
            if (hideTimer.current) {
              window.clearTimeout(hideTimer.current)
              hideTimer.current = null
            }
          }}
          onMouseLeave={hideHover}
        >
          <div className="msg-rail-pop-meta">
            <span>{hoverItem.sender || (hoverItem.role === 'user' ? '我' : hoverItem.role === 'system' ? '系统' : '智能体')}</span>
            {hoverItem.time ? <span>{fmtFullTime(hoverItem.time)}</span> : null}
          </div>
          <div className="msg-rail-pop-text">{hoverItem.preview}</div>
        </div>
      )}
    </div>
  )
}
