import { Capacitor } from '@capacitor/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IPC, XIAOJIE_ID, TOOL_ACTION_LABEL, extractThinkTags, mergeReasoning, sortedPinKeys, decodePluginUserMessage, parseProjectWorkspaceState, serializeProjectWorkspaceState } from '@jeff/core'
import type { AgentInfo, AppInfo, ChatMsg, FileNode, FsDirEntry, GroupMessage, ProjectInfo, ContextPreviewInfo, PluginCommand, PluginInfo } from '@jeff/core'
import type { RemoteStreamFrame } from '@jeff/core/remote'
import { consumeBack } from './backstack'
import Mascot from './Mascot'
import { Markdown } from './Markdown'
import { isMarkdownPath, joinWorkspacePath, linkifyWorkspaceMarkdown } from './linkify'
import { Native, PhoneLink, mergeStream, shrinkImage } from './session'

type Tab = 'messages' | 'me'
type Screen = 'list' | 'chat' | 'dirs' | 'files' | 'file' | 'project'
type ChatTarget =
  | { kind: 'agent'; id: string; name: string; avatar?: string }
  | { kind: 'group'; id: string; name: string; icon?: string }

const DEFAULT_GROUP = '默认'

const phone = new PhoneLink()
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __phone?: PhoneLink }).__phone = phone
}
const LOCK_MS = 5 * 60 * 1000

async function cacheGet(desktopId: string, key: string): Promise<string | null> {
  if (!desktopId) return null
  if (Capacitor.isNativePlatform()) {
    const r = await Native.cacheGet({ desktopId, key })
    return r.json || null
  }
  return localStorage.getItem(`jeff-cache:${desktopId}:${key}`)
}

async function cachePut(desktopId: string, key: string, json: string): Promise<void> {
  if (!desktopId) return
  if (Capacitor.isNativePlatform()) {
    await Native.cachePut({ desktopId, key, json })
    return
  }
  localStorage.setItem(`jeff-cache:${desktopId}:${key}`, json)
}

/** 消息气泡内的时间戳：固定 HH:MM */
function formatClock(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 消息流里的日期分隔：今天 / 昨天 / M月D日 / YYYY年M月D日 */
function formatDaySep(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return '今天'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 文件大小：B / KB / MB（工作区文件列表用） */
function formatFileSize(n?: number): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 上下文 token 数短格式：980 → 980，12340 → 12k（F-1 顶栏徽标用，对齐桌面 fmtTokens） */
function fmtTokensShort(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

/** 长按区域：450ms 长按触发，移动超过 8px 视为滚动取消；桌面端右键同样触发 */
function LongPressArea(props: { className?: string; children: React.ReactNode; onLongPress: () => void; onClick?: () => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPos = useRef({ x: 0, y: 0 })
  const moved = useRef(false)

  const start = (x: number, y: number) => {
    moved.current = false
    startPos.current = { x, y }
    timerRef.current = setTimeout(() => {
      if (!moved.current) props.onLongPress()
    }, 450)
  }
  const move = (x: number, y: number) => {
    if (Math.abs(x - startPos.current.x) > 8 || Math.abs(y - startPos.current.y) > 8) {
      moved.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }
  const end = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }

  return (
    <div
      className={props.className}
      onClick={props.onClick}
      onTouchStart={(e) => {
        const t = e.touches[0]
        if (t) start(t.clientX, t.clientY)
      }}
      onTouchMove={(e) => {
        const t = e.touches[0]
        if (t) move(t.clientX, t.clientY)
      }}
      onTouchEnd={end}
      onTouchCancel={end}
      onContextMenu={(e) => {
        e.preventDefault()
        props.onLongPress()
      }}
    >
      {props.children}
    </div>
  )
}

function formatWeChatTime(ts?: number): string {  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const isSameDay = d.toDateString() === now.toDateString()
  if (isSameDay) {
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) {
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `昨天 ${hh}:${mm}`
  }
  const isSameYear = d.getFullYear() === now.getFullYear()
  if (isSameYear) {
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export function WeChatAvatar({
  kind,
  name,
  emoji,
  size = 48,
  busy = false,
  agentId,
}: {
  kind: 'user' | 'agent' | 'group'
  name: string
  emoji?: string
  size?: number
  busy?: boolean
  /** 内置小杰按吉祥物渲染（DB avatar 不动，纯渲染层特判） */
  agentId?: string
}) {
  const initial = (name || '').trim().slice(0, 1).toUpperCase() || 'J'
  const isGroup = kind === 'group'
  const isUser = kind === 'user'
  const trimmedEmoji = (emoji || '').trim()
  const isXiaojie = agentId === XIAOJIE_ID

  if (isXiaojie) {
    return (
      <div className="wechat-avatar emoji-avatar" style={{ width: size, height: size, minWidth: size, minHeight: size }}>
        <Mascot size={size * 0.94} mood={busy ? 'working' : 'idle'} />
      </div>
    )
  }

  return (
    <div
      className={`wechat-avatar ${isUser ? 'user' : trimmedEmoji ? (isGroup ? 'group-avatar' : 'emoji-avatar') : isGroup ? 'group' : 'agent'}`}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
    >
      {trimmedEmoji ? (
        <span className="wechat-avatar-emoji" style={{ fontSize: size * 0.54 }}>
          {trimmedEmoji}
        </span>
      ) : isUser ? (
        <svg viewBox="0 0 24 24" width={size * 0.52} height={size * 0.52} fill="currentColor">
          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
        </svg>
      ) : isGroup ? (
        <svg viewBox="0 0 24 24" width={size * 0.54} height={size * 0.54} fill="currentColor">
          <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
        </svg>
      ) : (
        <span className="wechat-avatar-char">{initial}</span>
      )}
      {busy ? <span className="wechat-avatar-busy" /> : null}
    </div>
  )
}

export function WeChatItemRow(props: {
  title: string
  sub: string
  time?: number
  avatar?: string
  /** 私聊对方的智能体 id：内置小杰按吉祥物渲染 */
  agentId?: string
  kind: 'agent' | 'group'
  isGroup?: boolean
  isBuiltin?: boolean
  pinned?: boolean
  busy?: boolean
  /** 未读条数（>0 显示数字，<0 只显示红点） */
  unread?: number
  onClick: () => void
  onLongPress: () => void
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPos = useRef({ x: 0, y: 0 })
  const moved = useRef(false)

  const handleTouchStart = (e: React.TouchEvent) => {
    moved.current = false
    const t = e.touches[0]
    if (t) startPos.current = { x: t.clientX, y: t.clientY }
    timerRef.current = setTimeout(() => {
      if (!moved.current) {
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          try { navigator.vibrate(35) } catch {}
        }
        props.onLongPress()
      }
    }, 450)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0]
    if (t) {
      const dx = Math.abs(t.clientX - startPos.current.x)
      const dy = Math.abs(t.clientY - startPos.current.y)
      if (dx > 8 || dy > 8) {
        moved.current = true
        if (timerRef.current) clearTimeout(timerRef.current)
      }
    }
  }

  const handleTouchEnd = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }

  return (
    <li
      className={`wechat-item ${props.pinned ? 'pinned' : ''}`}
      data-testid={props.isGroup ? `chat-group-${props.title}` : `chat-agent-${props.title}`}
    >
      <button
        type="button"
        className="wechat-item-btn"
        onClick={() => {
          if (!moved.current) props.onClick()
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onContextMenu={(e) => {
          e.preventDefault()
          props.onLongPress()
        }}
      >
        <span className="wechat-item-lead">
          <WeChatAvatar
            kind={props.kind}
            name={props.title}
            emoji={props.avatar}
            size={48}
            busy={props.busy}
            agentId={props.agentId}
          />
        </span>
        <div className="wechat-item-main">
          <div className="wechat-item-top">
            <b className="wechat-item-title">{props.title}</b>
            {props.isBuiltin ? <span className="wechat-tag wechat-tag-blue">管家</span> : null}
            {props.pinned ? <span className="wechat-tag wechat-tag-green">置顶</span> : null}
            {props.isGroup ? <span className="wechat-tag wechat-tag-gray">群</span> : null}
            {props.time ? <span className="wechat-time">{formatWeChatTime(props.time)}</span> : null}
          </div>
          <div className="wechat-item-bot">
            <span className="wechat-item-sub">{props.sub}</span>
            {props.unread !== undefined && props.unread !== 0 ? (
              props.unread > 0 ? (
                <span className="wechat-unread-badge">{props.unread > 99 ? '99+' : props.unread}</span>
              ) : (
                <span className="wechat-unread-dot" />
              )
            ) : null}
          </div>
        </div>
      </button>
    </li>
  )
}

function ReasoningView({ reasoning, live, elapsedMs }: { reasoning?: string | string[]; live?: boolean; elapsedMs?: number }) {
  const [open, setOpen] = useState(false)
  const text = Array.isArray(reasoning) ? reasoning.join('\n\n') : reasoning || ''
  if (!text || !text.trim()) return null

  const lines = text.trim().split('\n').filter(Boolean)
  const lastLine = lines[lines.length - 1] || ''
  const preview = lastLine.length > 32 ? lastLine.slice(0, 32) + '…' : lastLine

  return (
    <div className={`wechat-reasoning ${open ? 'open' : ''} ${live ? 'live' : ''}`}>
      <button type="button" className="wechat-reasoning-summary" onClick={() => setOpen((v) => !v)}>
        <span className="wechat-reasoning-icon">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
          </svg>
        </span>
        <span className="wechat-reasoning-title">{live ? '思考中' : '思考过程'}</span>
        {live && <span className="wechat-live-pulse" />}
        {!!elapsedMs && elapsedMs > 0 ? <span className="wechat-reasoning-time">{elapsedMs >= 60_000 ? `${Math.floor(elapsedMs / 60_000)}分${Math.round((elapsedMs % 60_000) / 1000)}秒` : `${(elapsedMs / 1000).toFixed(1)}s`}</span> : null}
        {!open && preview ? <span className="wechat-reasoning-preview">{preview}</span> : null}
        <span className={`wechat-arrow ${open ? 'down' : ''}`}>›</span>
      </button>
      {open ? (
        <div className="wechat-reasoning-content">
          <Markdown text={text} />
        </div>
      ) : null}
    </div>
  )
}

type ToolItem = { tool: string; status?: string; output?: string; error?: string }

function AssistantText(props: { text: string; reasoning?: string | string[]; tools?: ToolItem[]; live?: boolean; reasonMs?: number }): React.JSX.Element {
  const parsed = useMemo(() => extractThinkTags(props.text), [props.text])
  const reasoning = useMemo(() => mergeReasoning(props.reasoning, parsed.reasoning), [props.reasoning, parsed])
  return (
    <>
      {reasoning ? <ReasoningView reasoning={reasoning} live={props.live} elapsedMs={props.reasonMs} /> : null}
      {props.tools && props.tools.length > 0 ? <ToolsView tools={props.tools} /> : null}
      {parsed.text ? <Markdown text={parsed.text} live={props.live} /> : props.live && !reasoning ? <p>…</p> : null}
    </>
  )
}

function StepIcon({ status, failed }: { status?: string; failed?: boolean }): React.JSX.Element {
  if (failed || status === 'error') {
    return (
      <svg className="step-icon danger" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    )
  }
  if (status === 'completed') {
    return (
      <svg className="step-icon done" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 12.5l5 5L20 6.5" />
      </svg>
    )
  }
  if (status === 'running') return <span className="step-icon spinner" />
  return <span className="step-icon idle" />
}

function ToolsView({ tools }: { tools?: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  if (!tools || tools.length === 0) return null

  const running = tools.find((t) => t.status === 'running')
  const failed = tools.find((t) => t.status === 'error' || t.error)
  const statusLabel = running
    ? `运行中… ${TOOL_ACTION_LABEL[running.tool] || running.tool}`
    : failed
      ? `执行失败 · ${TOOL_ACTION_LABEL[failed.tool] || failed.tool}`
      : '完成'
  const statusClass = running ? 'running' : failed ? 'failed' : 'done'

  return (
    <div className={`wechat-tools ${open ? 'open' : ''}`}>
      <button type="button" className="wechat-tools-summary" onClick={() => setOpen((v) => !v)}>
        <span className="wechat-tools-icon">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z" />
          </svg>
        </span>
        <span className="wechat-tools-title">工具调用 ({tools.length})</span>
        <span className={`wechat-tools-badge ${statusClass}`}>{statusLabel}</span>
        <span className={`wechat-arrow ${open ? 'down' : ''}`}>›</span>
      </button>
      {open ? (
        <div className="wechat-tools-body wechat-timeline">
          {tools.map((t, idx) => {
            const failedRow = t.status === 'error' || !!t.error
            const label = TOOL_ACTION_LABEL[t.tool] || t.tool
            return (
              <div key={idx} className="wechat-tool-row">
                <div className="wechat-tool-head">
                  <StepIcon status={t.status} failed={failedRow} />
                  <span className="wechat-tool-name">
                    {label}
                    {label !== t.tool ? <span className="wechat-tool-en">{t.tool}</span> : null}
                  </span>
                  <span className={`wechat-tool-tag ${t.status || ''}`}>
                    {t.status === 'running' ? '运行中' : failedRow ? '失败' : '完成'}
                  </span>
                </div>
                {t.error ? <pre className="wechat-tool-err">{t.error}</pre> : null}
                {t.output ? <pre className="wechat-tool-out">{t.output.length > 240 ? t.output.slice(0, 240) + '…' : t.output}</pre> : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function App() {
  const [locked, setLocked] = useState(Capacitor.isNativePlatform())
  const [tab, setTab] = useState<Tab>('messages')
  const [screen, setScreen] = useState<Screen>('list')
  const [paste, setPaste] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [target, setTarget] = useState<ChatTarget | null>(null)
  const targetRef = useRef<ChatTarget | null>(null)
  targetRef.current = target
  const [messages, setMessages] = useState<Array<ChatMsg | GroupMessage>>([])
  const [draft, setDraft] = useState('')
  const [stream, setStream] = useState<{ text: string; reasoning: string; agentId?: string; tools?: Array<{ tool: string; status?: string }>; reasonMs?: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const offlineRef = useRef(false)
  const markOffline = (v: boolean) => {
    offlineRef.current = v
    setOffline(v)
  }
  const [syncedAt, setSyncedAt] = useState(0)
  const [plus, setPlus] = useState(false)
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; active?: boolean }>>([])
  const [dirs, setDirs] = useState<{ dir: string; parent?: string; entries: FsDirEntry[] } | null>(null)
  // 工作区文件浏览：一次 fs:listFiles 拉整棵树（fs 忽略名单已滤 node_modules 等），页内用 trail 逐级下钻
  const [filesData, setFilesData] = useState<{ root: string; exists: boolean; nodes: FileNode[] } | null>(null)
  const [fileTrail, setFileTrail] = useState<Array<{ name: string; abs: string }>>([])
  const [filePreview, setFilePreview] = useState<{ name: string; content: string; truncated?: boolean } | null>(null)
  const [filesTip, setFilesTip] = useState('')
  const [workspaceDraft, setWorkspaceDraft] = useState(() => parseProjectWorkspaceState('{}'))
  const [workspaceSaving, setWorkspaceSaving] = useState(false)
  const [workspaceSaved, setWorkspaceSaved] = useState('')
  const dataDirRef = useRef('')
  const [computers, setComputers] = useState(phone.desktops)
  const [activeId, setActiveId] = useState('')
  const [, bump] = useState(0)
  const [recentMap, setRecentMap] = useState<Record<string, { text: string; time: number }>>({})
  const [copied, setCopied] = useState(false)
  const [pins, setPins] = useState<Record<string, number>>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [actionMenu, setActionMenu] = useState<{
    key: string
    title: string
    avatar?: string
    /** 智能体 id：内置小杰按吉祥物渲染 */
    agentId?: string
    isPinned: boolean
    isBuiltin?: boolean
    target: ChatTarget
  } | null>(null)
  const [sessionDrawer, setSessionDrawer] = useState(false)
  const bubblesEndRef = useRef<HTMLDivElement>(null)
  // 每个会话独立的草稿（key = kind:id），切换会话互不串
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // 未读：key = agent:<id> / group:<id>，值 = 未读条数
  const [unread, setUnread] = useState<Record<string, number>>({})
  // 乐观发送失败的本地消息 id（点击可重发）
  const [failedLocal, setFailedLocal] = useState<string | null>(null)
  // 长按消息菜单 / 图片查看器
  const [msgMenu, setMsgMenu] = useState<{ msgId: string; text: string; canCopy: boolean; canResend: boolean } | null>(null)
  const [viewer, setViewer] = useState<string | null>(null)
  // F-1 上下文用量（对齐桌面 ContextUsageBar）：进会话 / 每回合结束刷新，支持一键压缩
  const [ctx, setCtx] = useState<ContextPreviewInfo | null>(null)
  const [ctxOpen, setCtxOpen] = useState(false)
  const [ctxBusy, setCtxBusy] = useState(false)
  // F-2 `/` 快捷指令：已启用插件的指令 + 固定动作；选中后挂筹码随消息发送
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [chip, setChip] = useState<{ id: string; name: string; command: string } | null>(null)
  // F-4 对话内查找
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIdx, setFindIdx] = useState(0)
  // F-5 下拉刷新：列表与聊天共用一套手势状态
  const [pullPx, setPullPx] = useState(0)
  const pullRef = useRef<{ y: number; on: boolean } | null>(null)
  // U-1 思考耗时：首条 reasoning 起表、首条正文停表（仅流式气泡显示）
  const reasonTimerRef = useRef<{ start: number; end?: number } | null>(null)
  // 聊天区是否贴底（不贴底时新消息不拽滚动、显示回到底部浮球）
  const atBottomRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  // 历史加载竞态守卫：只有最新一次请求能写 messages
  const loadSeqRef = useRef(0)
  // 本地隐藏的消息（长按删除只删本地视图，不动服务端）
  const [hiddenIds, setHiddenIds] = useState<Record<string, true>>({})
  const targetKey = target ? `${target.kind}:${target.id}` : ''
  // 草稿写透：当前会话的输入同步进 drafts map，切走再回来不丢
  const updateDraft = (v: string) => {
    setDraft(v)
    const cur = targetRef.current
    if (cur) setDrafts((d) => ({ ...d, [`${cur.kind}:${cur.id}`]: v }))
  }

  // X-3 触感反馈：发送 / 切换会话 / 选中指令等轻操作给轻微震动（长按菜单已有 35ms）
  const haptic = (ms = 15) => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(ms) } catch {}
    }
  }

  // ---------- F-1 上下文用量与一键压缩 ----------
  /** 群聊看群主的会话（流水线汇报都经群主），私聊看本人；拿不到成员就不显示 */
  function ctxAgentIdFor(t: ChatTarget): string | null {
    if (t.kind === 'agent') return t.id
    const p = projectsRef.current.find((pr) => pr.id === t.id)
    return p?.leader_agent_id || null
  }

  const isCurrentTarget = (t: ChatTarget) => !!targetRef.current && targetRef.current.kind === t.kind && targetRef.current.id === t.id

  async function refreshCtx(t: ChatTarget) {
    if (offlineRef.current) return
    const agentId = ctxAgentIdFor(t)
    if (!agentId) {
      setCtx(null)
      return
    }
    try {
      const p = await phone.invoke<ContextPreviewInfo>(IPC.contextPreview, { agentId, ...(t.kind === 'group' ? { projectId: t.id } : {}) })
      if (isCurrentTarget(t)) setCtx(p)
    } catch {
      if (isCurrentTarget(t)) setCtx(null)
    }
  }

  async function compressCtx() {
    const t = targetRef.current
    if (!t || ctxBusy) return
    const agentId = ctxAgentIdFor(t)
    if (!agentId) {
      setError('该项目群还没有可用成员，无法压缩上下文')
      return
    }
    setCtxBusy(true)
    try {
      const p = await phone.invoke<ContextPreviewInfo>(IPC.contextCompress, { agentId, ...(t.kind === 'group' ? { projectId: t.id } : {}) })
      setCtx(p)
      setCtxOpen(true)
      await loadHistory(t)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCtxBusy(false)
    }
  }

  // ---------- F-5 下拉刷新 ----------
  const onPullStart = (e: React.TouchEvent) => {
    const el = e.currentTarget as HTMLElement
    pullRef.current = { y: e.touches[0]?.clientY ?? 0, on: el.scrollTop <= 0 }
  }
  const onPullMove = (e: React.TouchEvent) => {
    const pr = pullRef.current
    if (!pr?.on) return
    const dy = (e.touches[0]?.clientY ?? 0) - pr.y
    setPullPx(dy > 0 ? Math.min(72, Math.round(dy * 0.5)) : 0)
  }
  const onPullEnd = () => {
    const go = pullPx >= 28
    pullRef.current = null
    setPullPx(0)
    if (!go) return
    haptic(12)
    if (screenRef.current === 'chat' && targetRef.current) {
      void loadHistory(targetRef.current)
      void refreshCtx(targetRef.current)
    } else {
      void loadLists()
    }
  }

  const screenRef = useRef<Screen>('list')
  screenRef.current = screen

  const tabRef = useRef<Tab>('messages')
  tabRef.current = tab

  const plusRef = useRef(false)
  plusRef.current = plus

  const addingRef = useRef(false)
  addingRef.current = adding

  const handleBack = () => {
    if (consumeBack()) return
    if (viewer) {
      setViewer(null)
      return
    }
    if (msgMenu) {
      setMsgMenu(null)
      return
    }
    if (actionMenu) {
      setActionMenu(null)
      return
    }
    if (sessionDrawer) {
      setSessionDrawer(false)
      return
    }
    if (plusRef.current) {
      setPlus(false)
      return
    }
    if (screenRef.current === 'file') {
      setScreen('files')
      return
    }
    if (screenRef.current === 'project') {
      setScreen('chat')
      return
    }
    if (screenRef.current === 'files') {
      setScreen('chat')
      return
    }
    if (screenRef.current === 'dirs') {
      setScreen('files')
      return
    }
    if (screenRef.current === 'chat') {
      setScreen('list')
      // 离开聊天就清掉当前会话：否则推送仍把最后聊过的会话当「正在看」，列表永远不记未读
      setTarget(null)
      return
    }
    if (tabRef.current === 'me') {
      if (addingRef.current) {
        setAdding(false)
        return
      }
      setTab('messages')
      return
    }
    if (Capacitor.isNativePlatform()) {
      void Native.minimize()
    }
  }

  const refreshPeers = () => {
    setComputers(new Map(phone.desktops))
    setActiveId(phone.activeId)
    const peer = phone.desktops.get(phone.activeId)
    if (phone.activeId && !peer?.online) markOffline(true)
    bump((n) => n + 1)
  }

  // 供通知跳转等异步路径读取最新列表（避免闭包拿到旧 state）
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const projectsRef = useRef(projects)
  projectsRef.current = projects

  // 列表没拉过就补拉一次（幂等：已有数据时直接返回）
  const ensureLists = async () => {
    if (agentsRef.current.length || projectsRef.current.length) return
    await loadLists()
  }

  // 滚动治理：贴底时才自动跟随；离底时显示「回到底部」浮球
  const onBubblesScroll = () => {
    const el = bubblesEndRef.current?.parentElement
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = nearBottom
    setShowJump(!nearBottom)
  }

  const jumpToLatest = () => {
    atBottomRef.current = true
    setShowJump(false)
    bubblesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    const off = phone.onPush((ev) => {
      if (ev.what === 'presence' || ev.what === 'unbound') {
        refreshPeers()
        const p = (ev.p || {}) as { desktopId?: string; online?: boolean }
        if (ev.what === 'presence' && p.online && p.desktopId === phone.activeId && offlineRef.current) void loadLists()
      }
      if (ev.what === 'chat-stream') {
        const frame = ev.p as RemoteStreamFrame
        const current = targetRef.current
        if (!current) return
        const mine = frame.kind === 'group' ? frame.projectId === current.id : frame.agentId === current.id
        if (!mine) return
        if (frame.done) {
          setStream(null)
          reasonTimerRef.current = null
          void loadHistory(current)
          void refreshCtx(current)
          return
        }
        setStream((prev) => {
          const merged = mergeStream(prev || { text: '', reasoning: '' }, frame)
          if (!merged.ok) return prev
          // U-1 思考耗时：首条 reasoning 起表，正文出现停表；流式期间实时走秒
          if (merged.reasoning && !merged.text) {
            if (!reasonTimerRef.current) reasonTimerRef.current = { start: Date.now() }
          } else if (merged.text && reasonTimerRef.current && !reasonTimerRef.current.end) {
            reasonTimerRef.current = { ...reasonTimerRef.current, end: Date.now() }
          }
          const rt = reasonTimerRef.current
          const reasonMs = rt ? (rt.end ?? Date.now()) - rt.start : undefined
          return { text: merged.text, reasoning: merged.reasoning, agentId: frame.agentId, tools: frame.tools, ...(reasonMs ? { reasonMs } : {}) }
        })
      }
      if (ev.what === 'chat-updated' || ev.what === 'group-updated') {
        const current = targetRef.current
        const p = (ev.p || {}) as { agentId?: string; projectId?: string }
        const key = ev.what === 'chat-updated' ? `agent:${p.agentId || ''}` : `group:${p.projectId || ''}`
        const isCurrent = current && (ev.what === 'chat-updated' ? current.kind === 'agent' && current.id === p.agentId : current.kind === 'group' && current.id === p.projectId)
        if (isCurrent) {
          void loadHistory(current)
        } else {
          // 不是当前打开的会话：记未读 + 轻量拉最后一条做列表摘要
          setUnread((prev) => ({ ...prev, [key]: (prev[key] || 0) + 1 }))
          const [kind, id] = key.split(':')
          if (id) {
            void (kind === 'agent'
              ? phone.invoke<ChatMsg[]>(IPC.chatHistory, { agentId: id, limit: 1 })
              : phone.invoke<GroupMessage[]>(IPC.groupHistory, { projectId: id, limit: 1 })
            )
              .then((rows) => {
                const list = Array.isArray(rows) ? rows : (rows as { messages?: GroupMessage[] })?.messages || []
                const last = list[list.length - 1]
                if (last) setRecentMap((prev) => ({ ...prev, [key]: { text: last.text, time: last.time } }))
              })
              .catch(() => {})
          }
        }
      }
    })
    void boot().finally(() => {
      void openFromNote()
    })
    const openFromNote = async () => {
      await phone.pullNative()
      const note = await phone.takeNote()
      const kind = note.kind === 'agent' || note.kind === 'group' ? note.kind : ''
      if (!note.id || !kind) return
      // 通知标题可能是「私聊/项目群/任务名」这类占位，进会话前用已加载列表把真实名字查出来；
      // 查不到就先叫「会话」，进会话后顶栏会随 agents/projects 刷新
      void ensureLists().then(() => {
        const name =
          kind === 'agent'
            ? (agentsRef.current.find((a) => a.id === note.id)?.name ?? '会话')
            : (projectsRef.current.find((pr) => pr.id === note.id)?.title ?? '会话')
        void openChat({ kind, id: note.id, name })
      })
    }
    const onVis = () => (document.hidden ? onHide() : onShow())
    const onShow = () => {
      const left = Number(sessionStorage.getItem('jeff-hidden-at') || 0)
      if (left && Date.now() - left > LOCK_MS && Capacitor.isNativePlatform()) setLocked(true)
      void openFromNote()
    }
    const onHide = () => sessionStorage.setItem('jeff-hidden-at', String(Date.now()))
    document.addEventListener('visibilitychange', onVis)
    let resumeHandle: { remove: () => Promise<void> } | null = null
    let backHandle: { remove: () => Promise<void> } | null = null
    if (Capacitor.isNativePlatform()) {
      void Native.addListener('resume', () => {
        void openFromNote()
      }).then((handle) => {
        resumeHandle = handle
      })
      void Native.addListener('back', () => {
        handleBack()
      }).then((handle) => {
        backHandle = handle
      })
    }
    return () => {
      off()
      document.removeEventListener('visibilitychange', onVis)
      void resumeHandle?.remove()
      void backHandle?.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (screen !== 'chat') return
    if (!atBottomRef.current) return
    bubblesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, stream, screen])

  async function boot() {
    if (Capacitor.isNativePlatform()) {
      try {
        const unlocked = await Native.unlock()
        if (unlocked.ok || unlocked.skipped) setLocked(false)
      } catch (err) {
        setUnlockError((err as Error).message || '解锁未通过，请点击下方按钮重试')
      }
    } else {
      setLocked(false)
    }

    // 核心：优先从持久化存储（SharedPreferences/备份文件/localStorage）恢复凭据与已配对电脑
    await phone.init()
    refreshPeers()
    if (phone.activeId) {
      void loadLists()
    }

    if (Capacitor.isNativePlatform()) {
      const dbg = await Native.readDebugPair().catch(() => ({ text: '' }))
      if (dbg.text) await acceptPair(dbg.text)
      // 电池优化豁免：只在已绑定电脑时请求（替代冷启动无条件弹窗）；已授权静默跳过
      if (phone.desktops.size > 0) {
        void Native.requestBattery().catch(() => {})
      }
    }
  }

  async function acceptPair(raw: string) {
    setError('')
    setBusy(true)
    try {
      await phone.pair(raw, '我的手机')
      refreshPeers()
      await loadLists()
      setPaste('')
      setAdding(false)
      setTab('messages')
      setScreen('list')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function loadLists() {
    const id = phone.activeId
    if (!id) return

    // 1. 瞬时从本地缓存填充，消灭白屏与空列表
    const cachedA = await cacheGet(id, 'agents')
    const cachedP = await cacheGet(id, 'projects')
    const cachedPins = await cacheGet(id, 'pins')
    if (cachedA) {
      try { setAgents(JSON.parse(cachedA) as AgentInfo[]) } catch {}
    }
    if (cachedP) {
      try { setProjects(JSON.parse(cachedP) as ProjectInfo[]) } catch {}
    }
    if (cachedPins) {
      try { setPins(JSON.parse(cachedPins) as Record<string, number>) } catch {}
    }
    refreshPeers()

    // 2. 远端拉取最新列表
    let failed = false
    try {
      const [a, p] = await Promise.all([phone.invoke<AgentInfo[]>(IPC.agentsList), phone.invoke<ProjectInfo[]>(IPC.projectsList)])
      setAgents(a)
      setProjects(p)
      markOffline(false)
      setSyncedAt(Date.now())
      await cachePut(id, 'agents', JSON.stringify(a))
      await cachePut(id, 'projects', JSON.stringify(p))
      // F-2：插件指令菜单的数据源（失败不打扰主流程，菜单回退成只有固定动作）
      void phone.invoke<PluginInfo[]>(IPC.pluginsList)
        .then((list) => setPlugins(Array.isArray(list) ? list : []))
        .catch(() => setPlugins([]))

      // 预读各个会话的最新消息，提供微信般的摘要预览
      for (const ag of a) {
        void cacheGet(id, `history:agent:${ag.id}`).then((c) => {
          if (!c) return
          try {
            const list = JSON.parse(c) as ChatMsg[]
            const last = list[list.length - 1]
            if (last) {
              setRecentMap((prev) => ({ ...prev, [`agent:${ag.id}`]: { text: last.text, time: last.time } }))
            }
          } catch {}
        })
      }
      for (const pr of p) {
        void cacheGet(id, `history:group:${pr.id}`).then((c) => {
          if (!c) return
          try {
            const list = JSON.parse(c) as GroupMessage[]
            const last = list[list.length - 1]
            if (last) {
              setRecentMap((prev) => ({ ...prev, [`group:${pr.id}`]: { text: last.text, time: last.time } }))
            }
          } catch {}
        })
      }
    } catch {
      failed = true
    }
    refreshPeers()
    if (failed) markOffline(true)
  }

  async function loadHistory(t: ChatTarget, opts?: { limit?: number }) {
    const id = phone.activeId
    const key = `history:${t.kind}:${t.id}`
    // 竞态守卫：慢响应不许覆盖新会话的消息
    const seq = ++loadSeqRef.current
    const apply = (rows: Array<ChatMsg | GroupMessage>) => {
      if (seq !== loadSeqRef.current) return
      setMessages(rows)
    }
    try {
      if (t.kind === 'agent') {
        const rows = await phone.invoke<ChatMsg[]>(IPC.chatHistory, { agentId: t.id, ...(opts?.limit ? { limit: opts.limit } : {}) })
        apply(rows)
        if (opts?.limit) {
          const last = rows[rows.length - 1]
          if (last) setRecentMap((prev) => ({ ...prev, [`agent:${t.id}`]: { text: last.text, time: last.time } }))
          return
        }
        await cachePut(id, key, JSON.stringify(rows))
        const last = rows[rows.length - 1]
        if (last) setRecentMap((prev) => ({ ...prev, [`agent:${t.id}`]: { text: last.text, time: last.time } }))
      } else {
        const r = await phone.invoke<{ threadId: string; messages: GroupMessage[] } | GroupMessage[]>(IPC.groupHistory, { projectId: t.id, ...(opts?.limit ? { limit: opts.limit } : {}) })
        const rows = Array.isArray(r) ? r : r?.messages || []
        apply(rows)
        if (opts?.limit) {
          const last = rows[rows.length - 1]
          if (last) setRecentMap((prev) => ({ ...prev, [`group:${t.id}`]: { text: last.text, time: last.time } }))
          return
        }
        await cachePut(id, key, JSON.stringify(rows))
        const last = rows[rows.length - 1]
        if (last) setRecentMap((prev) => ({ ...prev, [`group:${t.id}`]: { text: last.text, time: last.time } }))
      }
      if (seq !== loadSeqRef.current) return
      markOffline(false)
      setSyncedAt(Date.now())
      // F-1：历史刷新即刷新上下文用量（进会话、每回合结束、压缩后都会走到这里）
      if (!opts?.limit) void refreshCtx(t)
    } catch {
      if (seq !== loadSeqRef.current) return
      markOffline(true)
      const cached = await cacheGet(id, key)
      if (cached) {
        const raw = JSON.parse(cached) as ChatMsg[] | { messages?: ChatMsg[] }
        const rows = Array.isArray(raw) ? raw : raw?.messages || []
        apply(rows)
        const last = rows[rows.length - 1]
        if (last) setRecentMap((prev) => ({ ...prev, [`${t.kind}:${t.id}`]: { text: last.text, time: last.time } }))
      }
    }
  }

  async function openChat(t: ChatTarget) {
    const same = targetRef.current && targetRef.current.kind === t.kind && targetRef.current.id === t.id
    setTarget(t)
    setScreen('chat')
    setStream(null)
    setPlus(false)
    setSessionDrawer(false)
    setError('')
    setFailedLocal(null)
    setMsgMenu(null)
    setViewer(null)
    setCtx(null)
    setCtxOpen(false)
    setFindOpen(false)
    setFindQuery('')
    setChip(null)
    reasonTimerRef.current = null
    haptic(10)
    atBottomRef.current = true
    setShowJump(false)
    // 草稿按会话隔离：进来取自己的草稿，别的会话不动
    setDraft(drafts[`${t.kind}:${t.id}`] || '')
    if (!same) setMessages([])
    setUnread((prev) => {
      if (!prev[`${t.kind}:${t.id}`]) return prev
      const next = { ...prev }
      delete next[`${t.kind}:${t.id}`]
      return next
    })
    await loadHistory(t)
  }

  function doSendText(t: ChatTarget, text: string, images?: Array<{ mime: string; dataUrl: string }>, plugin?: { id: string; name: string; command: string; at: number }) {
    const now = Date.now()
    const localId = `local-${now}`
    // 乐观回显：不等电脑回复，自己的消息立刻上屏
    setMessages((prev) => [...prev, { id: localId, role: 'user', text, time: now, ...(images ? { images } : {}) } as ChatMsg])
    atBottomRef.current = true
    setBusy(true)
    void (async () => {
      try {
        if (t.kind === 'agent') await phone.invoke(IPC.chatSend, { agentId: t.id, text, ...(images ? { images } : {}), ...(plugin ? { plugin } : {}) })
        else await phone.invoke(IPC.groupSend, { projectId: t.id, text, ...(images ? { images } : {}), ...(plugin ? { plugin } : {}) })
        if (targetRef.current?.id === t.id && targetRef.current?.kind === t.kind) {
          setFailedLocal(null)
          await loadHistory(t)
        }
      } catch (err) {
        setFailedLocal(localId)
        setError((err as Error).message)
      } finally {
        setBusy(false)
      }
    })()
  }

  async function send() {
    if (!target || !draft.trim()) return
    const text = draft.trim()
    const chipNow = chip
    updateDraft('')
    setChip(null)
    setPlus(false)
    haptic(18)
    doSendText(target, text, undefined, chipNow ? { id: chipNow.id, name: chipNow.name, command: chipNow.command, at: 0 } : undefined)
  }

  async function resend(msgId: string) {
    if (!target) return
    const local = messages.find((m) => m.id === msgId)
    if (!local || !local.text) return
    setFailedLocal(null)
    setHiddenIds((prev) => ({ ...prev, [msgId]: true }))
    doSendText(target, local.text, local.images)
  }

  async function sendImage(dataUrl: string) {
    if (!target) return
    setBusy(true)
    try {
      const image = await shrinkImage(dataUrl)
      const text = draft.trim() || '（图片）'
      updateDraft('')
      setBusy(false)
      doSendText(target, text, [image])
      return
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      setPlus(false)
    }
  }

  async function stop() {
    if (!target) return
    if (target.kind === 'agent') await phone.invoke(IPC.chatStop, { agentId: target.id })
    else await phone.invoke(IPC.groupStop, { projectId: target.id })
  }

  async function loadSessions() {
    if (!target) return
    if (target.kind === 'agent') {
      const r = await phone.invoke<{ sessions: Array<{ id: string; title: string; active?: boolean }> }>(IPC.sessionsList, { agentId: target.id })
      setSessions(r.sessions || [])
    } else {
      const r = await phone.invoke<{ threads: Array<{ id: string; title: string; active?: boolean }> }>(IPC.groupThreadsList, { projectId: target.id })
      setSessions((r.threads || []).map((t) => ({ id: t.id, title: t.title, active: t.active })))
    }
    setPlus(true)
  }

  async function openSessionDrawer() {
    if (!target) return
    setSessionDrawer(true)
    try {
      if (target.kind === 'agent') {
        const r = await phone.invoke<{ sessions: Array<{ id: string; title: string; active?: boolean }> }>(IPC.sessionsList, { agentId: target.id })
        setSessions(r.sessions || [])
      } else {
        const r = await phone.invoke<{ threads: Array<{ id: string; title: string; active?: boolean }> }>(IPC.groupThreadsList, { projectId: target.id })
        setSessions((r.threads || []).map((t) => ({ id: t.id, title: t.title, active: t.active })))
      }
    } catch {}
  }

  async function activateSession(sessionId: string) {
    if (!target) return
    if (target.kind === 'agent') await phone.invoke(IPC.sessionActivate, { scope: 'private', agentId: target.id, sessionId })
    else await phone.invoke(IPC.groupThreadActivate, { projectId: target.id, threadId: sessionId })
    setPlus(false)
    setSessionDrawer(false)
    await loadHistory(target)
  }

  async function newSession() {
    if (!target) return
    if (target.kind === 'agent') await phone.invoke(IPC.chatNew, { agentId: target.id })
    else await phone.invoke(IPC.groupThreadNew, { projectId: target.id })
    setPlus(false)
    setSessionDrawer(false)
    await loadHistory(target)
  }

  const togglePin = (key: string) => {
    setPins((prev) => {
      const next = { ...prev }
      if (key in next) {
        delete next[key]
      } else {
        next[key] = Date.now()
      }
      if (phone.activeId) {
        void cachePut(phone.activeId, 'pins', JSON.stringify(next))
      }
      return next
    })
    setActionMenu(null)
  }

  async function openDirs(dir?: string) {
    const listed = await phone.invoke<{ dir: string; parent?: string; entries: FsDirEntry[] }>(IPC.fsListDirs, dir ? { dir } : {})
    setDirs(listed)
    setScreen('dirs')
  }

  async function chooseDir(dir: string) {
    if (!target || target.kind !== 'group') return
    const project = projects.find((p) => p.id === target.id)
    if (!project) return
    await phone.invoke(IPC.projectSave, {
      id: project.id,
      title: project.title,
      description: project.description,
      icon: project.icon,
      leader_agent_id: project.leader_agent_id,
      workspace_dir: dir,
    })
    // 本地同步改 workspace_dir，避免「工作区文件」还按旧目录解析
    setProjects((arr) => arr.map((p) => (p.id === project.id ? { ...p, workspace_dir: dir } : p)))
    await loadFiles(dir)
  }

  /** 手机端 dataDir 只为解析默认工作区（与桌面端 GroupInfoDrawer 同规则），懒取一次缓存 */
  async function ensureDataDir(): Promise<string> {
    if (dataDirRef.current) return dataDirRef.current
    const info = await phone.invoke<AppInfo>(IPC.appInfo)
    dataDirRef.current = (info.dataDir || '').replace(/[\\/]+$/, '')
    return dataDirRef.current
  }

  /** 群聊顶栏「工作空间」：打开该群工作区的文件浏览（未配置工作空间时退回默认 dataDir/workspace） */
  async function openWorkspaceFiles() {
    if (!target || target.kind !== 'group') return
    const project = projects.find((p) => p.id === target.id)
    if (!project) return
    let dir = (project.workspace_dir || '').trim()
    if (!dir) {
      try {
        const dataDir = await ensureDataDir()
        if (dataDir) dir = `${dataDir}/workspace`
      } catch {
        /* 拿不到 dataDir 时按未配置处理 */
      }
    }
    if (!dir) {
      setFilesData(null)
      setFileTrail([])
      setFilesTip('该群还没有配置工作空间，点右上角「换目录」选择一个。')
      setScreen('files')
      return
    }
    await loadFiles(dir)
  }

  function openProjectWorkspace() {
    if (!target || target.kind !== 'group') return
    const project = projects.find((p) => p.id === target.id)
    if (!project) return
    setWorkspaceDraft(parseProjectWorkspaceState(project.workspace_state))
    setWorkspaceSaved('')
    setScreen('project')
  }

  async function saveProjectWorkspace() {
    if (!target || target.kind !== 'group') return
    const project = projects.find((p) => p.id === target.id)
    if (!project) return
    setWorkspaceSaving(true)
    setWorkspaceSaved('')
    try {
      const updated = await phone.invoke<ProjectInfo>(IPC.projectSave, {
        id: project.id,
        title: project.title,
        description: project.description,
        icon: project.icon,
        leader_agent_id: project.leader_agent_id,
        workspace_dir: project.workspace_dir,
        workspace_state: serializeProjectWorkspaceState(workspaceDraft),
      })
      setProjects((items) => items.map((item) => item.id === project.id ? updated : item))
      setWorkspaceSaved('已保存到项目资料')
    } catch (err) {
      setWorkspaceSaved(`保存失败：${String((err as Error).message).slice(0, 100)}`)
    } finally {
      setWorkspaceSaving(false)
    }
  }

  async function loadFiles(dir: string) {
    try {
      const r = await phone.invoke<{ dir: string; exists: boolean; nodes: FileNode[] }>(IPC.fsListFiles, { dir })
      setFilesData({ root: dir.replace(/[\\/]+$/, ''), exists: r.exists, nodes: r.nodes || [] })
      setFileTrail([])
      setFilesTip('')
      setScreen('files')
    } catch (err) {
      setFilesData(null)
      setFileTrail([])
      setFilesTip(`读取工作区文件失败：${(err as Error).message}`)
      setScreen('files')
    }
  }

  /** 读远端文本文件进预览：markdown 才支持，其他类型提示去电脑上看（fs:openPath 已被远程白名单替换，不能调系统程序） */
  async function openRemoteFile(path: string, name: string) {
    if (!isMarkdownPath(name)) {
      setFilesTip('该文件类型暂不支持手机预览，请在电脑上查看')
      return
    }
    try {
      const r = await phone.invoke<{ content: string; truncated?: boolean }>(IPC.fsReadFile, { file: path })
      setFilePreview({ name, content: r.content, truncated: r.truncated })
      setScreen('file')
    } catch (err) {
      setFilesTip(`读取失败：${(err as Error).message}`)
    }
  }

  const xiaojie = useMemo(() => agents.find((a) => a.builtin), [agents])
  const others = useMemo(() => agents.filter((a) => !a.builtin), [agents])

  // 工作区文件：按 fileTrail 从整棵树里走当前目录层
  const currentNodes = useMemo<FileNode[]>(() => {
    if (!filesData) return []
    let nodes = filesData.nodes
    for (const t of fileTrail) {
      const next = nodes.find((n) => n.dir && n.name === t.name)
      if (!next?.children) return []
      nodes = next.children
    }
    return nodes
  }, [filesData, fileTrail])

  const groups = useMemo(() => {
    const map = new Map<string, AgentInfo[]>()
    for (const a of others) {
      const key = (a.category || '').trim() || DEFAULT_GROUP
      const arr = map.get(key)
      if (arr) arr.push(a)
      else map.set(key, [a])
    }
    return Array.from(map.entries()).sort(([x], [y]) =>
      x === DEFAULT_GROUP ? 1 : y === DEFAULT_GROUP ? -1 : x.localeCompare(y, 'zh-CN')
    )
  }, [others])

  const pinOrder = useMemo(() => sortedPinKeys(pins), [pins])
  const pinnedAgents = useMemo(
    () =>
      pinOrder
        .filter((k) => k.startsWith('agent:'))
        .map((k) => others.find((a) => `agent:${a.id}` === k))
        .filter((a): a is AgentInfo => !!a),
    [pinOrder, others]
  )
  const pinnedProjects = useMemo(
    () =>
      pinOrder
        .filter((k) => k.startsWith('group:'))
        .map((k) => projects.find((p) => `group:${p.id}` === k))
        .filter((p): p is ProjectInfo => !!p),
    [pinOrder, projects]
  )
  const pinnedAgentIds = useMemo(() => new Set(pinnedAgents.map((a) => a.id)), [pinnedAgents])
  const pinnedProjectIds = useMemo(() => new Set(pinnedProjects.map((p) => p.id)), [pinnedProjects])

  const totalChatCount = (xiaojie ? 1 : 0) + others.length + projects.length

  const peer = computers.get(activeId)
  const bound = computers.size > 0

  // ---------- F-2 `/` 快捷指令 ----------
  const slashCmds = useMemo(() => {
    const out: Array<{ cmd: PluginCommand; pluginId: string; pluginName: string }> = []
    for (const p of plugins) {
      if (!p.enabled || p.error) continue
      for (const c of p.commands) out.push({ cmd: c, pluginId: p.id, pluginName: p.name })
    }
    return out
  }, [plugins])
  const slashOpen = draft.trimStart().startsWith('/')
  const slashQuery = slashOpen ? draft.trim().slice(1).trim().toLowerCase() : ''
  const slashMatches = useMemo(
    () => (slashQuery ? slashCmds.filter((s) => s.cmd.name.toLowerCase().includes(slashQuery)) : slashCmds),
    [slashCmds, slashQuery]
  )

  const pickSlash = (entry: { cmd: PluginCommand; pluginId: string; pluginName: string }) => {
    haptic(12)
    setChip({ id: entry.pluginId, name: entry.pluginName, command: entry.cmd.name })
    updateDraft('')
  }

  const runQuickAction = (action: 'compress' | 'clear') => {
    haptic(12)
    updateDraft('')
    if (action === 'compress') void compressCtx()
    else void newSession()
  }

  // ---------- F-4 对话内查找（对齐桌面 useConversationFind：命中跳转 + 上下循环） ----------
  const findHits = useMemo(() => {
    const q = findQuery.trim().toLowerCase()
    if (!q) return []
    return messages.filter((m) => !hiddenIds[m.id] && (m.text || '').toLowerCase().includes(q)).map((m) => m.id)
  }, [messages, findQuery, hiddenIds])
  useEffect(() => {
    setFindIdx(0)
  }, [findQuery])
  useEffect(() => {
    const id = findHits[findIdx]
    if (!findOpen || !id) return
    document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' })
  }, [findOpen, findHits, findIdx])
  const findNext = () => setFindIdx((i) => (findHits.length ? (i + 1) % findHits.length : 0))
  const findPrev = () => setFindIdx((i) => (findHits.length ? (i - 1 + findHits.length) % findHits.length : 0))

  // ---------- X-2 群聊点击头像/名字快速 @成员 ----------
  const mentionSender = (senderName: string) => {
    if (!targetRef.current || targetRef.current.kind !== 'group' || !senderName) return
    haptic(10)
    updateDraft(draft ? `${draft} @${senderName} ` : `@${senderName} `)
  }

  const [authenticating, setAuthenticating] = useState(false)
  const [unlockError, setUnlockError] = useState('')

  const requestUnlock = async () => {
    if (authenticating) return
    setAuthenticating(true)
    setUnlockError('')
    try {
      const r = await Native.unlock()
      if (r.ok || r.skipped) {
        setLocked(false)
      }
    } catch (err) {
      setUnlockError((err as Error).message || '解锁未通过，请重试')
    } finally {
      setAuthenticating(false)
    }
  }

  if (locked) {
    return (
      <main className="lock">
        <div className="wechat-lock-card">
          <div className="wechat-lock-logo">
            <Mascot size={56} mood="idle" />
          </div>
          <h1>Jeff 手机遥控</h1>
          <p>已启用安全锁，请验证指纹或锁屏密码</p>
          <button
            type="button"
            data-testid="unlock"
            disabled={authenticating}
            onClick={() => void requestUnlock()}
          >
            {authenticating ? '正在调起解锁…' : '指纹或锁屏密码解锁'}
          </button>
          {unlockError ? <p className="err">{unlockError}</p> : null}
        </div>
      </main>
    )
  }

  return (
    <main className="shell">
      {screen === 'list' && tab === 'messages' && (
        <>
          <header className="bar wechat-bar">
            <div className="bar-left">
              <button type="button" className="bar-title" data-testid="computer-switch" onClick={() => setTab('me')}>
                <i className={!bound || offline ? 'dot off' : 'dot'} />
                <span className="bar-pc-name">{peer?.name || '未绑定电脑'}</span>
              </button>
            </div>
            <div className="bar-right">
              {bound ? (
                <button
                  type="button"
                  className="bar-icon-btn"
                  title="添加/设置"
                  onClick={() => setTab('me')}
                >
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
                  </svg>
                </button>
              ) : null}
            </div>
          </header>
          {offline && bound ? (
            <button
              type="button"
              className="banner wechat-offline-banner"
              data-testid="reconnect"
              onClick={() => {
                haptic(12)
                void loadLists()
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
              </svg>
              <span>电脑离线，当前为本地只读缓存{syncedAt ? ` (同步于 ${new Date(syncedAt).toLocaleTimeString()})` : ''} · 点击重新连接</span>
            </button>
          ) : null}
          {!bound ? (
            <section className="pair wechat-pair-panel" data-testid="pair-panel">
              <div className="pair-hero">
                <div className="pair-logo-wrap">
                  <Mascot size={56} mood="idle" />
                </div>
                <h2>绑定电脑</h2>
                <p className="hint">在电脑 Jeff 的「设置 → 远程控制」里点击绑定手机，使用下方方式一键绑定。</p>
              </div>
              {Capacitor.isNativePlatform() ? (
                <button
                  type="button"
                  data-testid="pair-scan"
                  className="btn-scan"
                  disabled={busy}
                  onClick={() => {
                    setError('')
                    void Native.scan()
                      .then((r) => acceptPair(r.text))
                      .catch((err) => {
                        const msg = (err as Error).message || ''
                        if (msg && !msg.includes('取消')) setError(msg)
                      })
                  }}
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M3 4b1 1 0 011-1h4a1 1 0 010 2H5v3a1 1 0 01-2 0V4zm16-1a1 1 0 011 1v4a1 1 0 11-2 0V5h-3a1 1 0 110-2h4zM3 19a1 1 0 001 1h4a1 1 0 100-2H5v-3a1 1 0 10-2 0v4zm17 0a1 1 0 01-1 1h-4a1 1 0 110-2h3v-3a1 1 0 112 0v4zM8 8h8v8H8V8z" />
                  </svg>
                  扫码绑定电脑
                </button>
              ) : null}
              <div className="pair-divider">
                <span>或手动粘贴绑定码</span>
              </div>
              <textarea
                data-testid="pair-paste"
                value={paste}
                placeholder="在此粘贴电脑端生成的绑定码或 JSON 字符串"
                onChange={(e) => setPaste(e.target.value)}
              />
              <button
                type="button"
                data-testid="pair-go"
                className="btn-paste-go"
                disabled={busy || !paste.trim()}
                onClick={() => void acceptPair(paste)}
              >
                {busy ? '正在绑定…' : '使用粘贴内容绑定'}
              </button>
              {error ? <p className="err">{error}</p> : null}
            </section>
          ) : (
            <ul
              className="msgs wechat-list"
              data-testid="msg-list"
              onTouchStart={onPullStart}
              onTouchMove={onPullMove}
              onTouchEnd={onPullEnd}
              onTouchCancel={onPullEnd}
            >
              {pullPx > 0 ? (
                <li className="wechat-pull-tip" style={{ opacity: Math.min(1, pullPx / 40) }}>
                  {pullPx >= 28 ? '松开刷新' : '下拉刷新…'}
                </li>
              ) : null}
              {xiaojie && (
                <WeChatItemRow
                  title={xiaojie.name}
                  agentId={xiaojie.id}
                  sub={
                    recentMap[`agent:${xiaojie.id}`]?.text
                      ? (recentMap[`agent:${xiaojie.id}`].text.length > 40
                          ? recentMap[`agent:${xiaojie.id}`].text.slice(0, 40) + '…'
                          : recentMap[`agent:${xiaojie.id}`].text)
                      : 'Jeff 内置管家 · 问我什么都能办'
                  }
                  time={recentMap[`agent:${xiaojie.id}`]?.time}
                  avatar={xiaojie.avatar || '🤖'}
                  kind="agent"
                  isBuiltin
                  pinned
                  busy={stream !== null && target?.id === xiaojie.id}
                  unread={unread[`agent:${xiaojie.id}`] || 0}
                  onClick={() => void openChat({ kind: 'agent', id: xiaojie.id, name: xiaojie.name, avatar: xiaojie.avatar })}
                  onLongPress={() =>
                    setActionMenu({
                      key: `agent:${xiaojie.id}`,
                      title: xiaojie.name,
                      agentId: xiaojie.id,
                      avatar: xiaojie.avatar || '🤖',
                      isPinned: true,
                      isBuiltin: true,
                      target: { kind: 'agent', id: xiaojie.id, name: xiaojie.name, avatar: xiaojie.avatar },
                    })
                  }
                />
              )}

              {(pinnedAgents.length > 0 || pinnedProjects.length > 0) && (
                <>
                  <li className="wechat-section-header" data-testid="chat-pin-section">
                    <span>置顶</span>
                    <span className="wechat-section-count">{pinnedAgents.length + pinnedProjects.length}</span>
                  </li>
                  {pinnedProjects.map((p) => {
                    const rec = recentMap[`group:${p.id}`]
                    return (
                      <WeChatItemRow
                        key={`pin:g:${p.id}`}
                        title={p.title}
                        sub={
                          rec?.text
                            ? (rec.text.length > 40 ? rec.text.slice(0, 40) + '…' : rec.text)
                            : `${p.memberCount || 0} 个成员 · 群主统筹`
                        }
                        time={rec?.time}
                        avatar={p.icon}
                        kind="group"
                        isGroup
                        pinned
                        busy={stream !== null && target?.id === p.id}
                        unread={unread[`group:${p.id}`] || 0}
                        onClick={() => void openChat({ kind: 'group', id: p.id, name: p.title, icon: p.icon })}
                        onLongPress={() =>
                          setActionMenu({
                            key: `group:${p.id}`,
                            title: p.title,
                            avatar: p.icon,
                            isPinned: true,
                            target: { kind: 'group', id: p.id, name: p.title, icon: p.icon },
                          })
                        }
                      />
                    )
                  })}
                  {pinnedAgents.map((a) => {
                    const rec = recentMap[`agent:${a.id}`]
                    return (
                      <WeChatItemRow
                        key={`pin:a:${a.id}`}
                        title={a.name}
                        agentId={a.id}
                        sub={
                          rec?.text
                            ? (rec.text.length > 40 ? rec.text.slice(0, 40) + '…' : rec.text)
                            : (a.description || '（无简介）')
                        }
                        time={rec?.time}
                        avatar={a.avatar}
                        kind="agent"
                        pinned
                        busy={stream !== null && target?.id === a.id}
                        unread={unread[`agent:${a.id}`] || 0}
                        onClick={() => void openChat({ kind: 'agent', id: a.id, name: a.name, avatar: a.avatar })}
                        onLongPress={() =>
                          setActionMenu({
                            key: `agent:${a.id}`,
                            title: a.name,
                            avatar: a.avatar,
                            agentId: a.id,
                            isPinned: true,
                            target: { kind: 'agent', id: a.id, name: a.name, avatar: a.avatar },
                          })
                        }
                      />
                    )
                  })}
                </>
              )}

              <li className="wechat-section-header">
                <span>项目群</span>
                <span className="wechat-section-count">{projects.length}</span>
              </li>
              {projects.length === 0 && <li className="wechat-empty-hint">还没有项目群，可在电脑端发起群聊</li>}
              {projects
                .filter((p) => !pinnedProjectIds.has(p.id))
                .map((p) => {
                  const rec = recentMap[`group:${p.id}`]
                  return (
                    <WeChatItemRow
                      key={`g:${p.id}`}
                      title={p.title}
                      sub={
                        rec?.text
                          ? (rec.text.length > 40 ? rec.text.slice(0, 40) + '…' : rec.text)
                          : `${p.memberCount || 0} 个成员 · 群主统筹`
                      }
                      time={rec?.time}
                      avatar={p.icon}
                      kind="group"
                      isGroup
                      busy={stream !== null && target?.id === p.id}
                      unread={unread[`group:${p.id}`] || 0}
                      onClick={() => void openChat({ kind: 'group', id: p.id, name: p.title, icon: p.icon })}
                      onLongPress={() =>
                        setActionMenu({
                          key: `group:${p.id}`,
                          title: p.title,
                          avatar: p.icon,
                          isPinned: false,
                          target: { kind: 'group', id: p.id, name: p.title, icon: p.icon },
                        })
                      }
                    />
                  )
                })}

              <li className="wechat-section-header">
                <span>智能体</span>
                <span className="wechat-section-count">{others.length}</span>
              </li>
              {others.length === 0 && <li className="wechat-empty-hint">还没有其他智能体，可在电脑端或找小杰创建</li>}
              {groups.map(([name, list]) => {
                const isCollapsed = !!collapsed[name]
                return (
                  <li className="wechat-group-block" key={name}>
                    <button
                      type="button"
                      className="wechat-group-head"
                      data-testid={`chat-agent-group-${name}`}
                      onClick={() => setCollapsed((c) => ({ ...c, [name]: !c[name] }))}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="12"
                        height="12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={isCollapsed ? 'rot' : ''}
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                      <span>{name}</span>
                      <span className="wechat-group-count">{list.length}</span>
                    </button>
                    {!isCollapsed &&
                      list
                        .filter((a) => !pinnedAgentIds.has(a.id))
                        .map((a) => {
                          const rec = recentMap[`agent:${a.id}`]
                          return (
                            <WeChatItemRow
                              key={`a:${a.id}`}
                              title={a.name}
                              agentId={a.id}
                              sub={
                                rec?.text
                                  ? (rec.text.length > 40 ? rec.text.slice(0, 40) + '…' : rec.text)
                                  : (a.description || '（无简介）')
                              }
                              time={rec?.time}
                              avatar={a.avatar}
                              kind="agent"
                              busy={stream !== null && target?.id === a.id}
                              unread={unread[`agent:${a.id}`] || 0}
                              onClick={() => void openChat({ kind: 'agent', id: a.id, name: a.name, avatar: a.avatar })}
                              onLongPress={() =>
                                setActionMenu({
                                  key: `agent:${a.id}`,
                                  title: a.name,
                                  avatar: a.avatar,
                                  agentId: a.id,
                                  isPinned: false,
                                  target: { kind: 'agent', id: a.id, name: a.name, avatar: a.avatar },
                                })
                              }
                            />
                          )
                        })}
                  </li>
                )
              })}
              {totalChatCount === 0 && <li className="empty">这台电脑上还没有会话</li>}
            </ul>
          )}
        </>
      )}

      {screen === 'chat' && target && (
        <section className="chat wechat-chat" data-testid="chat">
          <header className="bar wechat-bar wechat-chat-bar">
            <button type="button" className="btn-nav-back" data-testid="chat-back" onClick={() => { setScreen('list'); setTarget(null) }}>
              <span className="wechat-back-chevron">‹</span>
              <span className="wechat-back-text">返回</span>
            </button>
            <div className="wechat-chat-title">
              <b style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{target.name}</b>
              {target.kind === 'group' ? <span className="wechat-group-tag">群聊</span> : null}
              {ctx?.contextLimit ? (
                <button
                  type="button"
                  className={`wechat-ctx-badge ${ctx.threshold != null && ctx.usedTokens >= ctx.threshold ? 'danger' : ctx.threshold != null && ctx.usedTokens >= ctx.threshold * 0.85 ? 'warn' : ''}`}
                  data-testid="ctx-badge"
                  onClick={() => setCtxOpen((v) => !v)}
                >
                  {fmtTokensShort(ctx.usedTokens)}/{fmtTokensShort(ctx.contextLimit)}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              className="bar-icon-btn"
              data-testid="chat-find"
              title="查找聊天内容"
              onClick={() => {
                haptic(10)
                setFindOpen((v) => !v)
                if (findOpen) setFindQuery('')
              }}
            >
              <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
            </button>
            {target.kind === 'group' ? (
              <>
                <button
                  type="button"
                  className="bar-icon-btn"
                  data-testid="session-history"
                  title="话题"
                  onClick={() => void openSessionDrawer()}
                >
                  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a8 8 0 1 1-3.1-6.3L21 4l-.9 3.4A8 8 0 0 1 21 12z" />
                    <path d="M8.5 10.5h7M8.5 14h4.5" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="bar-icon-btn"
                  data-testid="project-workspace"
                  title="项目资料与内容大纲"
                  onClick={openProjectWorkspace}
                >
                  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
                    <path d="M8 8h7M8 12h7M8 16h4" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="bar-icon-btn"
                  data-testid="workspace"
                  title="工作区文件"
                  onClick={() => void openWorkspaceFiles()}
                >
                  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="bar-icon-btn"
                data-testid="session-history"
                title="会话"
                onClick={() => void openSessionDrawer()}
              >
                <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a8 8 0 1 1-3.1-6.3L21 4l-.9 3.4A8 8 0 0 1 21 12z" />
                  <path d="M8.5 10.5h7M8.5 14h4.5" />
                </svg>
              </button>
            )}
          </header>
          {offline && bound ? (
            <button
              type="button"
              className="banner"
              data-testid="chat-reconnect"
              onClick={() => {
                haptic(12)
                void loadHistory(target)
                void refreshCtx(target)
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
              </svg>
              <span>电脑离线，当前为本地只读缓存{syncedAt ? ` (同步于 ${new Date(syncedAt).toLocaleTimeString()})` : ''} · 点击重新连接</span>
            </button>
          ) : null}
          {findOpen ? (
            <div className="wechat-search-bar" data-testid="chat-find-bar">
              <input
                autoFocus
                value={findQuery}
                placeholder="查找聊天内容"
                onChange={(e) => setFindQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (e.shiftKey) findPrev()
                    else findNext()
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setFindOpen(false)
                    setFindQuery('')
                  }
                }}
              />
              <span className="wechat-search-count">{findQuery.trim() ? `${findHits.length ? Math.min(findIdx + 1, findHits.length) : 0}/${findHits.length}` : ''}</span>
              <button type="button" onClick={findPrev}>↑</button>
              <button type="button" onClick={findNext}>↓</button>
              <button
                type="button"
                onClick={() => {
                  setFindOpen(false)
                  setFindQuery('')
                }}
              >
                关闭
              </button>
            </div>
          ) : null}
          {ctxOpen ? (
            <div className="wechat-ctx-box" data-testid="ctx-panel">
              <div className="wechat-ctx-header">
                <span>
                  上下文占用 {fmtTokensShort(ctx?.usedTokens ?? 0)}
                  {ctx?.contextLimit ? ` / ${fmtTokensShort(ctx.contextLimit)}` : ' · 未配置窗口'}
                </span>
                <button type="button" className="wechat-btn-compress" data-testid="ctx-compress" disabled={ctxBusy || !ctx?.sessionId} onClick={() => void compressCtx()}>
                  {ctxBusy ? '压缩中…' : '一键压缩'}
                </button>
              </div>
              {ctx?.contextLimit ? (
                <div className="wechat-ctx-track">
                  <div
                    className="wechat-ctx-fill"
                    style={{
                      width: `${Math.min(100, Math.round((ctx.usedTokens / ctx.contextLimit) * 100))}%`,
                      background: ctx.threshold != null && ctx.usedTokens >= ctx.threshold ? '#e64340' : undefined,
                    }}
                  />
                </div>
              ) : null}
              <div className="wechat-ctx-actions">
                <span className="wechat-ctx-sub">
                  {ctx
                    ? ctx.threshold != null
                      ? `自动压缩线 ${fmtTokensShort(ctx.threshold)}${ctx.compactedCount > 0 ? ` · 已压缩隐藏 ${ctx.compactedCount} 条` : ''}`
                      : '未配置上下文窗口，自动压缩未启用'
                    : '打开会话后显示占用'}
                </span>
                <button type="button" className="wechat-ctx-sub" onClick={() => setCtxOpen(false)}>
                  收起
                </button>
              </div>
            </div>
          ) : null}
          <div className="bubbles wechat-bubbles" data-testid="bubbles" onScroll={onBubblesScroll} onTouchStart={onPullStart} onTouchMove={onPullMove} onTouchEnd={onPullEnd} onTouchCancel={onPullEnd}>
            {messages.filter((m) => !hiddenIds[m.id]).map((m, idx, list) => {
              const isMe = m.role === 'user'
              // F-2：桌面端用插件指令发的消息带 <!--jeff-plugin:...--> 头，手机端解出原话与筹码展示
              const decodedUser = m.role === 'user' ? decodePluginUserMessage(m.text) : null
              if (m.role === 'system') {
                return (
                  <div key={m.id} className="day-sep">
                    <span>{m.text.slice(0, 80)}</span>
                  </div>
                )
              }
              const prev = list[idx - 1]
              const needDaySep = !prev || new Date(prev.time).toDateString() !== new Date(m.time).toDateString()
              const senderName = target.kind === 'group' ? ('sender_name' in m && m.sender_name ? m.sender_name : target.name) : target.name
              const senderAvatar = target.kind === 'agent' ? target.avatar : ('agentId' in m && m.agentId ? agents.find((a) => a.id === m.agentId)?.avatar : undefined) || target.icon
              const senderAgentId = target.kind === 'agent' ? target.id : 'agentId' in m ? m.agentId : undefined
              const isLocal = m.id.startsWith('local-')
              const isFailed = failedLocal === m.id
              const findHitNow = findOpen && findHits[findIdx] === m.id
              const openMenu = () => {
                if (typeof navigator !== 'undefined' && navigator.vibrate) {
                  try { navigator.vibrate(35) } catch {}
                }
                setMsgMenu({ msgId: m.id, text: m.text, canCopy: !!m.text.trim(), canResend: isMe })
              }
              return (
                <div key={m.id}>
                  {needDaySep ? (
                    <div className="day-sep">
                      <span>{formatDaySep(m.time)}</span>
                    </div>
                  ) : null}
                  <div className={`wechat-msg-row ${isMe ? 'me' : 'other'}${findHitNow ? ' search-hit' : ''}`} data-msg-id={m.id}>
                    {!isMe && (
                      <div
                        className="wechat-msg-avatar"
                        style={target.kind === 'group' ? { cursor: 'pointer' } : undefined}
                        title={target.kind === 'group' ? `@ ${senderName}` : undefined}
                        onClick={() => target.kind === 'group' && mentionSender(senderName)}
                      >
                        <WeChatAvatar
                          kind={target.kind === 'group' ? 'group' : 'agent'}
                          name={senderName}
                          agentId={senderAgentId}
                          emoji={senderAvatar}
                          size={28}
                        />
                      </div>
                    )}
                    <div className="wechat-msg-content" onContextMenu={(e) => { e.preventDefault(); openMenu() }}>
                      {!isMe && (
                        <div className="msg-who">
                          <b
                            style={target.kind === 'group' ? { cursor: 'pointer' } : undefined}
                            onClick={() => target.kind === 'group' && mentionSender(senderName)}
                          >
                            {senderName}
                          </b>
                          <span>{formatClock(m.time)}</span>
                        </div>
                      )}
                      {m.role === 'assistant' ? (
                        <div className="wechat-ai-body">
                          <AssistantText text={m.text} reasoning={m.reasoning} tools={m.tools} />
                        </div>
                      ) : (
                        <>
                          {decodedUser?.invoke ? <span className="wechat-msg-chip">{decodedUser.invoke.command} · {decodedUser.invoke.name}</span> : null}
                          <LongPressArea className="wechat-user-bubble" onLongPress={openMenu} onClick={isFailed ? () => void resend(m.id) : undefined}>
                            {m.images?.length ? (
                              m.images.map((img, i) => (
                                <img
                                  key={i}
                                  src={img.dataUrl}
                                  alt=""
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setViewer(img.dataUrl)
                                  }}
                                />
                              ))
                            ) : null}
                            {decodedUser && decodedUser.displayText && decodedUser.displayText !== '（图片）' ? decodedUser.displayText : null}
                          </LongPressArea>
                          <div className="msg-meta">
                            <span>{formatClock(m.time)}</span>
                            {isLocal ? (
                              isFailed ? (
                                <span className="msg-status fail">⚠ 发送失败 · 点击重试</span>
                              ) : (
                                <span className="msg-status">✓ 已送达</span>
                              )
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {stream ? (
              <div className="wechat-msg-row other" data-testid="stream">
                <div className="wechat-msg-avatar">
                  <WeChatAvatar
                    kind={target.kind === 'group' ? 'group' : 'agent'}
                    name={target.name}
                    agentId={target.kind === 'agent' ? target.id : stream.agentId}
                    emoji={target.kind === 'agent' ? target.avatar : target.icon}
                    size={28}
                    busy
                  />
                </div>
                <div className="wechat-msg-content">
                  <div className="msg-who">
                    <b>{target.name}</b>
                    <span>正在回复…</span>
                  </div>
                  <div className="wechat-ai-body live">
                    <AssistantText text={stream.text} reasoning={stream.reasoning} tools={stream.tools} live reasonMs={stream.reasonMs} />
                  </div>
                </div>
              </div>
            ) : null}
            <div ref={bubblesEndRef} />
          </div>
          {showJump ? (
            <button type="button" className="jump-latest" data-testid="jump-latest" onClick={jumpToLatest}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M6 13l6 6 6-6" />
              </svg>
              回到底部
            </button>
          ) : null}
          {error ? <p className="err">{error}</p> : null}
          {plus ? (
            <div className="plus wechat-plus-sheet" data-testid="plus-panel">
              <div className="wechat-plus-grid">
                <button
                  type="button"
                  className="wechat-plus-cell"
                  data-testid="new-session"
                  onClick={() => void newSession()}
                >
                  <div className="wechat-plus-icon">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
                      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                    </svg>
                  </div>
                  <span>新建会话</span>
                </button>
                <button
                  type="button"
                  className="wechat-plus-cell"
                  data-testid="plus-find"
                  onClick={() => {
                    setPlus(false)
                    setFindOpen(true)
                  }}
                >
                  <div className="wechat-plus-icon">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="7" />
                      <path d="M21 21l-4.35-4.35" />
                    </svg>
                  </div>
                  <span>查找聊天内容</span>
                </button>
                <button
                  type="button"
                  className="wechat-plus-cell"
                  data-testid="plus-compress"
                  disabled={ctxBusy || !ctx?.sessionId}
                  onClick={() => {
                    setPlus(false)
                    void compressCtx()
                  }}
                >
                  <div className="wechat-plus-icon">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 5h16M4 19h16M8 9h8M8 15h8" />
                    </svg>
                  </div>
                  <span>压缩上下文</span>
                </button>
                {Capacitor.isNativePlatform() ? (
                  <button
                    type="button"
                    className="wechat-plus-cell"
                    data-testid="pick-image"
                    onClick={() => {
                      void Native.pickImage().then((r) => sendImage(r.dataUrl))
                    }}
                  >
                    <div className="wechat-plus-icon">
                      <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
                        <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
                      </svg>
                    </div>
                    <span>相册</span>
                  </button>
                ) : (
                  <label className="wechat-plus-cell file">
                    <div className="wechat-plus-icon">
                      <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
                        <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
                      </svg>
                    </div>
                    <span>相册</span>
                    <input
                      data-testid="file-image"
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        const reader = new FileReader()
                        reader.onload = () => void sendImage(String(reader.result))
                        reader.readAsDataURL(file)
                      }}
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="wechat-plus-cell"
                  onClick={() => void loadSessions()}
                >
                  <div className="wechat-plus-icon">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
                      <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z" />
                    </svg>
                  </div>
                  <span>切换会话</span>
                </button>
                {target.kind === 'group' ? (
                  <button
                    type="button"
                    className="wechat-plus-cell"
                    onClick={() => void openDirs()}
                  >
                    <div className="wechat-plus-icon">
                      <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
                        <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                      </svg>
                    </div>
                    <span>工作空间</span>
                  </button>
                ) : null}
              </div>
              {sessions.length > 0 ? (
                <div className="wechat-plus-sessions">
                  <div className="wechat-plus-sessions-title">已有历史会话</div>
                  <ul>
                    {sessions.map((s) => (
                      <li key={s.id}>
                        <button type="button" onClick={() => void activateSession(s.id)}>
                          <span className="wechat-session-name">{s.title || s.id}</span>
                          <span className="wechat-session-switch">切换 ›</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          {slashOpen ? (
            <div className="wechat-slash-pills" data-testid="slash-pills">
              {slashMatches.map((s) => (
                <button key={`${s.pluginId}:${s.cmd.name}`} type="button" className="wechat-slash-pill" data-testid={`slash-${s.cmd.name}`} onClick={() => pickSlash(s)}>
                  {s.cmd.name} · {s.pluginName}
                </button>
              ))}
              <button type="button" className="wechat-slash-pill" data-testid="slash-action-compress" onClick={() => runQuickAction('compress')}>
                /压缩上下文
              </button>
              <button type="button" className="wechat-slash-pill" data-testid="slash-action-new" onClick={() => runQuickAction('clear')}>
                /新会话
              </button>
            </div>
          ) : null}
          <form
            className="composer wechat-composer"
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
          >
            {chip ? (
              <div className="wechat-chip-row" data-testid="composer-chip">
                <span className="wechat-msg-chip">
                  {chip.command} · {chip.name}
                  <button type="button" aria-label="移除插件指令" onClick={() => setChip(null)}>
                    ×
                  </button>
                </span>
              </div>
            ) : null}
            <button
              type="button"
              className="wechat-composer-plus"
              data-testid="plus"
              onClick={() => (plus ? setPlus(false) : void loadSessions())}
            >
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="9.2" />
                <path d="M12 8.2v7.6M8.2 12h7.6" />
              </svg>
            </button>
            <textarea
              data-testid="chat-input"
              value={draft}
              rows={1}
              placeholder={offline ? '电脑离线，不能发送' : '发消息，Enter 换行'}
              disabled={offline}
              onChange={(e) => {
                updateDraft(e.target.value)
                const el = e.target
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, 110)}px`
              }}
              onKeyDown={(e) => {
                // 桌面浏览器里 Enter 发送、Shift+Enter 换行；真机软键盘自带换行键
                if (e.key === 'Enter' && !e.shiftKey && !Capacitor.isNativePlatform()) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            {stream || busy ? (
              <button type="button" className="btn-chat-stop" data-testid="chat-stop" onClick={() => void stop()}>
                停止
              </button>
            ) : draft.trim() ? (
              <button type="submit" className="btn-chat-send" data-testid="chat-send" disabled={offline || !draft.trim()}>
                发送
              </button>
            ) : null}
          </form>
        </section>
      )}

      {screen === 'dirs' && dirs && (
        <section className="dirs wechat-dirs" data-testid="dir-picker">
          <header className="bar wechat-bar">
            <button type="button" className="btn-nav-back" onClick={() => setScreen('files')}>
              <span className="wechat-back-chevron">‹</span>
              <span className="wechat-back-text">返回</span>
            </button>
            <b>选择工作空间目录</b>
            <span style={{ width: 48 }} />
          </header>
          <div className="wechat-dir-crumb">
            <span>当前路径：</span>
            <b>{dirs.dir || '工作空间根目录'}</b>
          </div>
          <ul className="wechat-dir-list">
            {dirs.parent ? (
              <li className="wechat-dir-parent">
                <button type="button" onClick={() => void openDirs(dirs.parent)}>
                  📁 .. (上级目录)
                </button>
              </li>
            ) : null}
            {dirs.entries.map((e) => (
              <li key={e.path} className="wechat-dir-item">
                <button type="button" className="wechat-dir-name" onClick={() => void openDirs(e.path)}>
                  📁 {e.name}
                </button>
                <button type="button" className="wechat-dir-use" data-testid={`use-${e.name}`} onClick={() => void chooseDir(e.path)}>
                  选定
                </button>
              </li>
            ))}
          </ul>
          <form
            className="wechat-dir-mkdir"
            onSubmit={(e) => {
              e.preventDefault()
              const name = new FormData(e.currentTarget).get('name')
              if (!dirs.dir || typeof name !== 'string' || !name.trim()) return
              void phone.invoke(IPC.fsMkdir, { dir: `${dirs.dir.replace(/[\\/]$/, '')}/${name.trim()}` }).then(() => openDirs(dirs.dir))
            }}
          >
            <input name="name" placeholder="新建文件夹" data-testid="mkdir-name" />
            <button type="submit">新建</button>
          </form>
        </section>
      )}

      {screen === 'files' && (
        <section className="dirs wechat-dirs" data-testid="workspace-files">
          <header className="bar wechat-bar">
            <button type="button" className="btn-nav-back" onClick={() => setScreen('chat')}>
              <span className="wechat-back-chevron">‹</span>
              <span className="wechat-back-text">返回</span>
            </button>
            <b>工作区文件</b>
            <button type="button" className="btn-nav-action" data-testid="workspace-change-dir" onClick={() => void openDirs()}>
              换目录
            </button>
          </header>
          <div className="wechat-dir-crumb" data-testid="workspace-file-path">
            <span>当前路径：</span>
            <b>{filesData ? [filesData.root, ...fileTrail.map((t) => t.name)].join(' / ') : '—'}</b>
          </div>
          {filesTip ? (
            <p className="err wechat-file-tip" data-testid="workspace-files-tip">{filesTip}</p>
          ) : null}
          {!filesData ? null : !filesData.exists ? (
            <p className="wechat-file-empty">工作空间目录还不存在（可能还没跑过任务产出文件）。可点「换目录」指定别的目录。</p>
          ) : (
            <ul className="wechat-dir-list" data-testid="workspace-file-list">
              {fileTrail.length ? (
                <li className="wechat-dir-parent">
                  <button type="button" onClick={() => setFileTrail(fileTrail.slice(0, -1))}>
                    📁 .. (上级目录)
                  </button>
                </li>
              ) : null}
              {currentNodes.map((n) => (
                <li key={n.abs} className="wechat-dir-item">
                  <button
                    type="button"
                    className="wechat-dir-name"
                    data-testid={n.dir ? `dir-${n.name}` : `file-${n.name}`}
                    onClick={() => {
                      if (n.dir) setFileTrail([...fileTrail, { name: n.name, abs: n.abs }])
                      else void openRemoteFile(n.abs, n.name)
                    }}
                  >
                    {n.dir ? '📁' : '📄'} {n.name}
                  </button>
                  {!n.dir && (
                    <span className="wechat-file-meta">
                      {formatFileSize(n.size)}
                      {n.mtime ? ` · ${new Date(n.mtime).toLocaleDateString('zh-CN')}` : ''}
                    </span>
                  )}
                </li>
              ))}
              {currentNodes.length === 0 && !fileTrail.length && <li className="wechat-file-empty">目录为空。</li>}
            </ul>
          )}
          <p className="wechat-file-hint">Markdown 文件点击即可预览；其他类型请在电脑上查看</p>
        </section>
      )}

      {screen === 'project' && target?.kind === 'group' && (
        <section className="dirs wechat-dirs project-workspace-screen" data-testid="project-workspace-screen">
          <header className="bar wechat-bar">
            <button type="button" className="btn-nav-back" onClick={() => setScreen('chat')}>
              <span className="wechat-back-chevron">‹</span>
              <span className="wechat-back-text">返回</span>
            </button>
            <b>项目资料</b>
            <span style={{ width: 48 }} />
          </header>
          <p className="wechat-file-hint">保存项目目标、受众、传播渠道与系统大纲，桌面端和手机共用。</p>
          <div className="project-workspace-form">
            <label><span>阶段目标</span><textarea rows={3} data-testid="mobile-workspace-goal" value={workspaceDraft.goal} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, goal: e.target.value }))} placeholder="这个项目当前要达成什么结果？" /></label>
            <label><span>销售对象</span><input data-testid="mobile-workspace-sales-audience" value={workspaceDraft.salesAudience} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, salesAudience: e.target.value }))} placeholder="例如：渠道商与集成商" /></label>
            <label><span>内容呈现对象</span><input data-testid="mobile-workspace-story-audience" value={workspaceDraft.storyAudience} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, storyAudience: e.target.value }))} placeholder="例如：一线医护人员" /></label>
            <label><span>传播渠道（每行一个）</span><textarea rows={2} data-testid="mobile-workspace-channels" value={workspaceDraft.channels.join('\n')} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, channels: e.target.value.split('\n') }))} placeholder="微信私聊\n渠道群转发\n现场讲解" /></label>
            <label><span>系统介绍大纲（每行一章）</span><textarea rows={7} data-testid="mobile-workspace-outline" value={workspaceDraft.systemOutline.join('\n')} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, systemOutline: e.target.value.split('\n') }))} placeholder="整体方案\n功能与医护使用场景\n对接与部署" /></label>
            <label><span>每周推进节奏</span><textarea rows={2} data-testid="mobile-workspace-cadence" value={workspaceDraft.weeklyCadence} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, weeklyCadence: e.target.value }))} placeholder="每周提交一批选题与素材缺口" /></label>
            <button type="button" className="btn-primary" data-testid="mobile-workspace-save" disabled={workspaceSaving} onClick={() => void saveProjectWorkspace()}>{workspaceSaving ? '保存中…' : '保存项目资料'}</button>
            {workspaceSaved ? <p className="project-workspace-result" data-testid="mobile-workspace-result">{workspaceSaved}</p> : null}
          </div>
        </section>
      )}

      {screen === 'file' && filePreview && (
        <section className="fileview wechat-fileview" data-testid="file-preview">
          <header className="bar wechat-bar">
            <button type="button" className="btn-nav-back" onClick={() => setScreen('files')}>
              <span className="wechat-back-chevron">‹</span>
              <span className="wechat-back-text">返回</span>
            </button>
            <b data-testid="file-preview-title">{filePreview.name}</b>
            <span style={{ width: 48 }} />
          </header>
          {filePreview.truncated ? <p className="wechat-file-tip">文件过大，仅显示开头部分</p> : null}
          <div className="wechat-file-body" data-testid="file-preview-body">
            <Markdown
              text={linkifyWorkspaceMarkdown(filePreview.content)}
              onFileLink={(rel) => {
                if (!filesData) return
                void openRemoteFile(joinWorkspacePath(filesData.root, rel), rel.split('/').pop() || rel)
              }}
            />
          </div>
        </section>
      )}

      {tab === 'me' && screen === 'list' && (
        <section className="me wechat-me" data-testid="me">
          <div className="wechat-me-profile" data-testid="me-profile">
            <div className="wechat-me-avatar-wrap">
              <WeChatAvatar kind="user" name="我" size={60} />
            </div>
            <div className="wechat-me-info">
              <div className="wechat-me-title-row">
                <h3 className="wechat-me-name">我的手机</h3>
                <span className={`wechat-me-status-pill ${bound ? (peer?.online ? 'online' : 'offline') : 'unbound'}`}>
                  <span className="dot" />
                  {bound ? (peer?.online ? '已连接' : '已离线') : '未绑定'}
                </span>
              </div>
              <div
                className="wechat-me-id-row"
                title="点击复制完整ID"
                onClick={() => {
                  void navigator.clipboard?.writeText(phone.me.id)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                <span className="wechat-me-id-label">Jeff ID:</span>
                <span className="wechat-me-id-val">{phone.me.id.slice(0, 10)}…</span>
                <span className="wechat-copy-icon">
                  {copied ? (
                    <span className="wechat-copied-tip">已复制</span>
                  ) : (
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </span>
              </div>
            </div>
            <div className="wechat-me-profile-arrow">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </div>
          </div>

          {computers.size > 0 && (
            <div className="wechat-group-section">
              <div className="wechat-group-header">已连接电脑 ({computers.size})</div>
              <div className="wechat-card-group">
                {[...computers.values()].map((c, idx) => {
                  const isCurrent = c.id === activeId
                  return (
                    <div key={c.id} className="wechat-group-row">
                      {idx > 0 && <div className="wechat-cell-divider" />}
                      <button
                        type="button"
                        className={`wechat-comp-cell ${isCurrent ? 'current' : ''}`}
                        data-testid={`comp-item-${c.id}`}
                        onClick={() => {
                          phone.select(c.id)
                          refreshPeers()
                          void loadLists()
                          setTab('messages')
                        }}
                      >
                        <div className="wechat-cell-icon-wrap" style={{ background: c.online ? '#07c160' : '#888888' }}>
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="3" width="20" height="14" rx="2" />
                            <line x1="8" y1="21" x2="16" y2="21" />
                            <line x1="12" y1="17" x2="12" y2="21" />
                          </svg>
                        </div>
                        <div className="wechat-comp-meta">
                          <span className="wechat-comp-title" title={c.name}>{c.name}</span>
                          <span className="wechat-comp-sub">
                            <span className={`wechat-status-dot ${c.online ? 'online' : 'offline'}`} />
                            {c.online ? (isCurrent ? '在线 · 当前主控' : '在线 · 点击切换主控') : '离线'}
                          </span>
                        </div>
                        <div className="wechat-comp-action">
                          {isCurrent ? (
                            <span className="wechat-badge-pill">当前使用</span>
                          ) : (
                            <span className="wechat-switch-text">切换 ›</span>
                          )}
                        </div>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="wechat-group-section">
            <div className="wechat-group-header">设备连接</div>
            <div className="wechat-card-group">
              {bound ? (
                <div className="wechat-group-row">
                  <button
                    type="button"
                    className="wechat-cell-btn"
                    data-testid="pair-another"
                    onClick={() => setAdding((v) => !v)}
                  >
                    <div className="wechat-cell-icon-wrap" style={{ background: '#10aeff' }}>
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="16" />
                        <line x1="8" y1="12" x2="16" y2="12" />
                      </svg>
                    </div>
                    <div className="wechat-cell-content">
                      <span className="wechat-cell-label">绑定另一台电脑</span>
                    </div>
                    <span className={`wechat-arrow ${adding ? 'down' : ''}`}>
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </span>
                  </button>
                </div>
              ) : null}

              {(adding || !bound) && (
                <div className="wechat-me-pair-box" data-testid="pair-box">
                  {Capacitor.isNativePlatform() ? (
                    <button
                      type="button"
                      data-testid="pair-scan"
                      className="btn-scan"
                      disabled={busy}
                      onClick={() => {
                        setError('')
                        void Native.scan()
                          .then((r) => acceptPair(r.text))
                          .catch((err) => {
                            const msg = (err as Error).message || ''
                            if (msg && !msg.includes('取消')) setError(msg)
                          })
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                        <path d="M4 4h6v6H4V4zm2 2v2h2V6H6zm8-2h6v6h-6V4zm2 2v2h2V6h-2zM4 14h6v6H4v-6zm2 2v2h2v-2H6zm10 0h2v2h-2v-2zm2-2h2v2h-2v-2zm-2 4h4v2h-4v-2zm-2-2h2v2h-2v-2zm0-2h2v2h-2v-2z" />
                      </svg>
                      <span>扫码绑定电脑</span>
                    </button>
                  ) : null}
                  <div className="pair-divider">
                    <span>{Capacitor.isNativePlatform() ? '或手动粘贴绑定码' : '手动粘贴绑定码'}</span>
                  </div>
                  <textarea
                    data-testid="pair-paste"
                    value={paste}
                    placeholder="在此粘贴电脑端生成的绑定码或 JSON 字符串"
                    onChange={(e) => setPaste(e.target.value)}
                  />
                  <button
                    type="button"
                    data-testid="pair-go"
                    className="btn-paste-go"
                    disabled={busy || !paste.trim()}
                    onClick={() => void acceptPair(paste)}
                  >
                    {busy ? '正在绑定…' : '使用粘贴内容绑定这台电脑'}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="wechat-group-section">
            <div className="wechat-group-header">系统与安全</div>
            <div className="wechat-card-group">
              {Capacitor.isNativePlatform() ? (
                <>
                  <div className="wechat-group-row">
                    <button type="button" className="wechat-cell-btn" onClick={() => void Native.openBattery()}>
                      <div className="wechat-cell-icon-wrap" style={{ background: '#fa9d3b' }}>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="7" width="16" height="10" rx="2" />
                          <line x1="20" y1="11" x2="20" y2="13" />
                          <line x1="6" y1="12" x2="12" y2="12" />
                        </svg>
                      </div>
                      <div className="wechat-cell-content">
                        <span className="wechat-cell-label">忽略电池优化</span>
                        <span className="wechat-cell-desc">防止熄屏后被系统杀后台</span>
                      </div>
                      <span className="wechat-cell-right">
                        去设置
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </span>
                    </button>
                  </div>
                  <div className="wechat-cell-divider" />
                </>
              ) : null}

              <div className="wechat-group-row">
                <button type="button" className="wechat-cell-btn" data-testid="lock-app" onClick={() => setLocked(true)}>
                  <div className="wechat-cell-icon-wrap" style={{ background: '#576b95' }}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </div>
                  <div className="wechat-cell-content">
                    <span className="wechat-cell-label">锁屏安全保护</span>
                    <span className="wechat-cell-desc">需指纹或系统凭证解锁</span>
                  </div>
                  <span className="wechat-cell-right">
                    立即锁定
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </span>
                </button>
              </div>
            </div>
          </div>

          {bound ? (
            <div className="wechat-group-section danger-zone">
              <div className="wechat-card-group">
                <div className="wechat-group-row">
                  <button
                    type="button"
                    className="wechat-cell-btn danger"
                    data-testid="unbind"
                    onClick={() => {
                      phone.unbind()
                      refreshPeers()
                      setAgents([])
                      setProjects([])
                    }}
                  >
                    <div className="wechat-cell-icon-wrap" style={{ background: '#fa5151' }}>
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                        <line x1="2" y1="2" x2="22" y2="22" />
                      </svg>
                    </div>
                    <div className="wechat-cell-content">
                      <span className="wechat-cell-label danger-text">解除当前电脑绑定</span>
                    </div>
                    <span className="wechat-arrow danger-arrow">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </span>
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="wechat-me-hint-card">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
            </svg>
            <p className="wechat-hint">
              华为/荣耀等机型请在「系统设置 → 应用启动管理」中，将 Jeff 设为「手动管理」并允许「允许后台活动」，以防熄屏后连接被系统阻断。
            </p>
          </div>
        </section>
      )}

      {screen === 'list' && (
        <nav className="tabs wechat-tabs">
          <button
            type="button"
            className={tab === 'messages' ? 'on' : ''}
            data-testid="tab-messages"
            onClick={() => setTab('messages')}
          >
            <div className="wechat-tab-icon">
              {tab === 'messages' ? (
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                  <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              )}
            </div>
            <span>消息</span>
          </button>
          <button
            type="button"
            className={tab === 'me' ? 'on' : ''}
            data-testid="tab-me"
            onClick={() => setTab('me')}
          >
            <div className="wechat-tab-icon">
              {tab === 'me' ? (
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                  <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              )}
            </div>
            <span>我</span>
          </button>
        </nav>
      )}

      {actionMenu && (
        <div className="wechat-sheet-mask" onClick={() => setActionMenu(null)}>
          <div className="wechat-sheet-panel" onClick={(e) => e.stopPropagation()}>
            <div className="wechat-sheet-head">
              <WeChatAvatar
                kind={actionMenu.target.kind}
                name={actionMenu.title}
                emoji={actionMenu.avatar}
                size={38}
                agentId={actionMenu.agentId}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="wechat-sheet-title">{actionMenu.title}</div>
                <div className="wechat-sheet-sub">{actionMenu.target.kind === 'group' ? '项目群' : '智能体'}</div>
              </div>
            </div>
            {!actionMenu.isBuiltin && (
              <button
                type="button"
                className="wechat-sheet-btn"
                data-testid="sheet-toggle-pin"
                onClick={() => togglePin(actionMenu.key)}
              >
                {actionMenu.isPinned ? '取消置顶' : '置顶该聊天'}
              </button>
            )}
            <button
              type="button"
              className="wechat-sheet-btn"
              onClick={() => {
                const t = actionMenu.target
                setActionMenu(null)
                void openChat(t)
              }}
            >
              打开会话
            </button>
            <button
              type="button"
              className="wechat-sheet-btn wechat-sheet-cancel"
              onClick={() => setActionMenu(null)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {sessionDrawer && target && (
        <div className="wechat-drawer-mask" onClick={() => setSessionDrawer(false)}>
          <div className="wechat-drawer-panel" onClick={(e) => e.stopPropagation()}>
            <div className="wechat-drawer-bar">
              <button type="button" className="wechat-drawer-btn cancel" onClick={() => setSessionDrawer(false)}>
                取消
              </button>
              <span className="wechat-drawer-title">{target.kind === 'group' ? '群话题记录' : '会话记录'}</span>
              <button
                type="button"
                className="wechat-drawer-btn"
                data-testid="drawer-new-session"
                onClick={() => void newSession()}
              >
                + 新会话
              </button>
            </div>
            <ul className="wechat-drawer-list">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className={`wechat-drawer-item ${s.active ? 'active' : ''}`}
                  onClick={() => void activateSession(s.id)}
                >
                  <div className="wechat-drawer-item-info">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <b className="wechat-drawer-item-title">{s.title || s.id}</b>
                      {s.active ? <span className="wechat-tag wechat-tag-green">当前</span> : null}
                    </div>
                  </div>
                  <span className="wechat-drawer-item-action">{s.active ? '进行中' : '切换 ›'}</span>
                </li>
              ))}
              {sessions.length === 0 && (
                <li className="wechat-empty-hint">暂无其他历史会话，点击右上角「+ 新会话」开启</li>
              )}
            </ul>
          </div>
        </div>
      )}

      {msgMenu && (
        <div className="wechat-msgmenu-mask" data-testid="msg-menu" onClick={() => setMsgMenu(null)}>
          <div className="wechat-msgmenu" onClick={(e) => e.stopPropagation()}>
            {msgMenu.canCopy ? (
              <button
                type="button"
                data-testid="menu-copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(msgMenu.text).catch(() => {})
                  setMsgMenu(null)
                }}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="8" y="8" width="12" height="12" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                复制
              </button>
            ) : null}
            {msgMenu.canResend ? (
              <button
                type="button"
                data-testid="menu-resend"
                onClick={() => {
                  setMsgMenu(null)
                  void resend(msgMenu.msgId)
                }}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                重新发送
              </button>
            ) : null}
            <button
              type="button"
              className="danger"
              data-testid="menu-hide"
              onClick={() => {
                setMsgMenu(null)
                setHiddenIds((prev) => ({ ...prev, [msgMenu.msgId]: true }))
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13" />
              </svg>
              删除本地记录
            </button>
          </div>
        </div>
      )}

      {viewer ? (
        <div className="wechat-viewer-mask" data-testid="image-viewer" onClick={() => setViewer(null)}>
          <img src={viewer} alt="" />
        </div>
      ) : null}
    </main>
  )
}
