import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { extractThinkTags, mergeReasoning } from '@jeff/core'
import type { ChatImage } from '@jeff/core'
import Avatar from './Avatar'
import { Markdown } from './Markdown'
import { CopyButton } from './ui/CopyButton'
import { splitTextWithFileLinks } from './preview/linkify'
import FileLink from './preview/FileLink'
import { fmtFullTime } from '../format'

const COMPOSER_MIN_HEIGHT = 40
const COMPOSER_MAX_HEIGHT = 320
const COMPOSER_DEFAULT_HEIGHT = 120

/** 流式气泡（私聊/群聊共用）：只要 store 里有流就显示（不再 gate 在发送中状态上）；已有正文即可复制 */
export function StreamingBubble(props: {
  avatar: string
  name: string
  stream: { text: string; reasoning?: string; tools?: Array<{ tool: string; status?: string }> }
  /** 工作空间目录：用于识别输出里的相对路径为可点击链接 */
  workspaceDir?: string
  /** 本轮触发时间（用户发送时刻）：流式期间也显示时间，便于估算轮次耗时 */
  time?: number
}): React.JSX.Element {
  const { avatar, name, stream, workspaceDir, time } = props
  // 有些模型把思考写在正文的 <think> 里而不是原生 reasoning 字段，这里统一剥出来给折叠区
  const parsed = useMemo(() => extractThinkTags(stream.text), [stream.text])
  const reasoning = useMemo(() => mergeReasoning(stream.reasoning, parsed.reasoning), [stream.reasoning, parsed.reasoning])
  const bodyStarted = parsed.text.trim().length > 0
  return (
    <div className="msg-row left">
      <Avatar emoji={avatar} size={34} />
      <div className="msg-stack">
        <div className="msg-sender">
          {name}
          <span className="msg-time">{fmtFullTime(time)}</span>
        </div>
        <div className="msg-bubble-wrap">
          <div className="bubble assistant">
            <AssistantExtras reasoning={reasoning} tools={stream.tools} live bodyStarted={bodyStarted} workspaceDir={workspaceDir} />
            <Markdown text={parsed.text || '…'} workspaceDir={workspaceDir} live />
            <span className="stream-caret" />
          </div>
          <CopyButton className="msg-copy" text={parsed.text} label="复制消息" testId="msg-copy-streaming" />
        </div>
      </div>
    </div>
  )
}

/** 聊天输入区顶部拖拽调高/调低，限制在聊天窗口高度的一半以内。 */
export function useComposerResize(containerRef: React.RefObject<HTMLElement | null>) {
  const [height, setHeight] = useState(COMPOSER_DEFAULT_HEIGHT)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const getMaxHeight = useCallback(() => {
    const containerHeight = containerRef.current?.parentElement?.getBoundingClientRect().height ?? window.innerHeight
    return Math.max(COMPOSER_MIN_HEIGHT, Math.min(COMPOSER_MAX_HEIGHT, Math.floor(containerHeight * 0.5)))
  }, [containerRef])

  useEffect(() => {
    const clampHeight = () => setHeight((current) => Math.min(current, getMaxHeight()))
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const next = drag.startHeight + drag.startY - event.clientY
      setHeight(Math.max(COMPOSER_MIN_HEIGHT, Math.min(getMaxHeight(), next)))
    }
    const onPointerUp = () => {
      dragRef.current = null
      document.body.classList.remove('composer-resizing')
    }
    window.addEventListener('resize', clampHeight)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('resize', clampHeight)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      document.body.classList.remove('composer-resizing')
    }
  }, [getMaxHeight])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragRef.current = { startY: event.clientY, startHeight: height }
    document.body.classList.add('composer-resizing')
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [height])

  return { height, onPointerDown }
}

export const COMPOSER_MIN_HEIGHT_PX = COMPOSER_MIN_HEIGHT
export const COMPOSER_MAX_HEIGHT_PX = COMPOSER_MAX_HEIGHT

/** 距离底部多少像素内算「贴在底部」，超过就认为用户在往上翻历史 */
const STICK_THRESHOLD = 80

/**
 * 聊天区自动滚动：仅当用户贴在底部时跟随新内容，并用 requestAnimationFrame 合并写入，
 * 避免每个流式 token 都读 scrollHeight / 写 scrollTop 触发强制重排（卡顿主因之一）。
 */
export function useAutoScroll(bodyRef: React.RefObject<HTMLElement | null>, signal: string): void {
  const stickRef = useRef(true)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [bodyRef])
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !stickRef.current) return
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(id)
  }, [bodyRef, signal])
}


/** 读取 File 为 dataURL（图片附件用） */
export function fileToDataUrl(file: File): Promise<ChatImage | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) return resolve(null)
    const reader = new FileReader()
    reader.onload = () => resolve({ mime: file.type, dataUrl: String(reader.result) })
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** composer 的图片附件状态：选择/粘贴/拖拽 → dataURL 预览 → 随消息发送 */
export function useImages(limit = 6) {
  const [images, setImages] = useState<ChatImage[]>([])

  const addFiles = useCallback(
    async (files: Iterable<File>) => {
      const picked: ChatImage[] = []
      for (const f of files) {
        if (picked.length + images.length >= limit) break
        const img = await fileToDataUrl(f)
        if (img) picked.push(img)
      }
      if (picked.length) setImages((prev) => [...prev, ...picked].slice(0, limit))
    },
    [images.length, limit],
  )

  const remove = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const clear = useCallback(() => setImages([]), [])

  return { images, addFiles, remove, clear }
}

/** composer 里的缩略图预览条 */
export function ImagePreviews(props: { images: ChatImage[]; onRemove: (idx: number) => void }): React.JSX.Element | null {
  if (props.images.length === 0) return null
  return (
    <div className="attach-previews">
      {props.images.map((img, i) => (
        <div key={i} className="attach-preview">
          <img src={img.dataUrl} alt={`附件 ${i + 1}`} />
          <button className="attach-preview-remove" onClick={() => props.onRemove(i)} title="移除">
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

/** 消息气泡里的图片（点击看大图） */
export function MsgImages(props: { images: ChatImage[] }): React.JSX.Element | null {
  const [view, setView] = useState<string | null>(null)
  if (props.images.length === 0) return null
  return (
    <>
      <div className="msg-images">
        {props.images.map((img, i) => (
          <img key={i} src={img.dataUrl} alt="图片消息" onClick={() => setView(img.dataUrl)} />
        ))}
      </div>
      {view && (
        <div className="img-viewer-mask" onClick={() => setView(null)}>
          <img src={view} alt="预览" />
        </div>
      )}
    </>
  )
}

const TOOL_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  completed: '完成',
  error: '出错',
  pending: '等待',
}

const TRUNCATE_LEN = 2000

/** 工具输出预览：超长截断 + 展开全文；输出里的相对路径渲染为可点击链接 */
function ToolOutput(props: { text: string; workspaceDir?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const full = props.text
  const truncated = full.length > TRUNCATE_LEN
  const shown = expanded || !truncated ? full : `${full.slice(0, TRUNCATE_LEN)}…`
  return (
    <>
      <pre className="tool-output">
        {splitTextWithFileLinks(shown).map((seg, i) =>
          seg.type === 'path' ? (
            <FileLink key={i} rel={seg.value} workspaceDir={props.workspaceDir} />
          ) : (
            <span key={i}>{seg.value}</span>
          ),
        )}
      </pre>
      {truncated && (
        <button className="text-btn tool-expand" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : `展开全文（${full.length} 字符）`}
        </button>
      )}
    </>
  )
}

/** 单行流式预览：只取末尾片段（最新生成的内容），过长交给 CSS 省略号截断 */
function tailPreview(text: string, max = 140): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const last = lines.length > 0 ? lines[lines.length - 1] : text.trim()
  return last.length > max ? `…${last.slice(-max)}` : last
}

/**
 * assistant 气泡内折叠区：思考过程 + 工具调用（历史消息与流式共用）。
 * 统一「一行折叠条」形态：流式期间也不自动展开，只在同一行内滚动展示最新内容，
 * 不撑爆版面；要看完整推导或工具明细由用户点开。
 */
export function AssistantExtras(props: {
  reasoning?: string[]
  tools?: Array<{ tool: string; status?: string; output?: string; error?: string }>
  live?: boolean
  /** 正文已开始输出：不再显示思考实时预览 */
  bodyStarted?: boolean
  /** 工作空间目录：工具输出里的相对路径可点击打开 */
  workspaceDir?: string
}): React.JSX.Element | null {
  const { reasoning, tools, live, bodyStarted } = props
  const hasReasoning = !!reasoning && reasoning.length > 0
  const hasTools = !!tools && tools.length > 0
  const reasonRef = useRef<HTMLDivElement>(null)
  // 恒为收起：一行折叠条是常态，展开只由用户点击触发
  const [reasonOpen, setReasonOpen] = useState(false)
  const reasonText = reasoning ? reasoning.join('\n') : ''
  // 思考进行中（流式且正文未开始）：单行预览最新推导
  const thinking = !!live && !bodyStarted
  const reasonPreview = thinking ? tailPreview(reasonText) : ''
  const runningTool = live ? (tools || []).find((t) => t.status === 'running') : undefined
  // 用户展开时小窗内部跟随最新一行滚动（窗口本身限高，不撑爆气泡）
  useEffect(() => {
    const el = reasonRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [reasonText, reasonOpen])
  if (!hasReasoning && !hasTools) return null
  return (
    <div className="msg-extras">
      {hasReasoning && (
        <details className="msg-extra" open={reasonOpen} onToggle={(e) => setReasonOpen(e.currentTarget.open)}>
          <summary>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
            </svg>
            <span className="extra-label">思考过程</span>
            {thinking && <span className="extra-live">思考中…</span>}
            {reasonPreview && <span className="extra-preview">{reasonPreview}</span>}
          </summary>
          <div className={`extra-reasoning${thinking ? ' thinking' : ''}`} ref={reasonRef}>
            {reasoning!.map((r, i) => (
              <p key={i}>{r}</p>
            ))}
          </div>
        </details>
      )}
      {hasTools && (
        <details className="msg-extra">
          <summary>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z" />
            </svg>
            <span className="extra-label">工具调用 {tools!.length}</span>
            {runningTool && <span className="extra-live">运行中…</span>}
            {runningTool && <span className="extra-preview">{runningTool.tool}</span>}
          </summary>
          <div className="extra-tools">
            {tools!.map((t, i) => (
              <details key={i} className="extra-tool">
                <summary>
                  <span className="extra-tool-name">{t.tool}</span>
                  <span className={`extra-tool-status ${t.status === 'error' ? 'danger' : ''}`}>{TOOL_STATUS_LABEL[t.status || ''] || t.status || ''}</span>
                </summary>
                {t.error ? <pre className="tool-output danger">{t.error}</pre> : <ToolOutput text={t.output || '（无输出）'} workspaceDir={props.workspaceDir} />}
              </details>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

