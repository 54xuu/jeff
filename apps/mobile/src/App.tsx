import MemorySettings from './MemorySettings'
import EngineSelector from './EngineSelector'
import { Capacitor } from '@capacitor/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IPC, ENGINE_LABELS, XIAOJIE_ID, TOOL_ACTION_LABEL, extractThinkTags, mergeReasoning, sortedPinKeys, decodePluginUserMessage, currentWeekRange,
  parseProjectWorkspaceState, serializeProjectWorkspaceState, canStartCampaignProduction,
} from '@jeff/core'
import type { AgentInfo, AppInfo, ChatMsg, FileNode, FsDirEntry, GroupMessage, ProjectInfo, ProjectMember, ContextPreviewInfo, PluginCommand, PluginInfo, CampaignKind, CampaignProposalInput, CampaignProposal, TaskInfo, ProjectDocumentInfo, ProjectReportInfo, SiYuanSearchResult } from '@jeff/core'
import type { RemoteStreamFrame } from '@jeff/core/remote'
import { consumeBack } from './backstack'
import Mascot from './Mascot'
import { Markdown } from './Markdown'
import { isMarkdownPath, joinWorkspacePath, linkifyWorkspaceMarkdown } from './linkify'
import { type PairProgress, Native, PhoneLink, mergeStream, shrinkImage } from './session'

type Tab = 'messages' | 'contacts' | 'me'
type Screen = 'list' | 'chat' | 'dirs' | 'files' | 'file' | 'project'
type ChatFilter = 'all' | 'agent' | 'group'
type ProjectSection = 'overview' | 'profile' | 'members' | 'reports' | 'tasks' | 'assets' | 'campaigns'
type ChatTarget =
  | { kind: 'agent'; id: string; name: string; avatar?: string }
  | { kind: 'group'; id: string; name: string; icon?: string }
type ConversationEntry = {
  key: string
  target: ChatTarget
  title: string
  sub: string
  time?: number
  avatar?: string
  agentId?: string
  kind: 'agent' | 'group'
  isGroup: boolean
  isBuiltin: boolean
  pinned: boolean
  busy: boolean
  unread: number
  pinOrder: number
}

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
  selected?: boolean
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
      className={`wechat-item ${props.pinned ? 'pinned' : ''} ${props.selected ? 'selected' : ''}`}
      data-testid={props.isGroup ? `chat-group-${props.title}` : `chat-agent-${props.title}`}
    >
      <button
        type="button"
        className="wechat-item-btn"
        aria-current={props.selected ? 'true' : undefined}
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

function PairingNotice({ progress }: { progress: PairProgress | null }) {
  if (!progress) return null
  return <div className="pair-progress" role="status" aria-live="polite" data-testid="pair-progress">
    <strong>{progress.stage === 'connecting' ? '正在连接中转站…' : progress.stage === 'confirming' ? '等待电脑确认绑定' : '电脑已确认，正在建立安全连接…'}</strong>
    {progress.stage === 'confirming' && <><p>请在电脑「{progress.desktopName}」打开 Jeff，在弹出的窗口中点击「确认绑定」。电脑确认后，手机会自动完成绑定。</p><p>两端安全码应一致：<b data-testid="pair-safety">{progress.safety}</b></p></>}
  </div>
}

export function App() {
  const [locked, setLocked] = useState(Capacitor.isNativePlatform())
  const [tab, setTab] = useState<Tab>('messages')
  const [screen, setScreen] = useState<Screen>('list')
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all')
  const [listQuery, setListQuery] = useState('')
  const [listMenuOpen, setListMenuOpen] = useState(false)
  const [chatMenuOpen, setChatMenuOpen] = useState(false)
  const [projectSection, setProjectSection] = useState<ProjectSection>('overview')
  const [pairProgress, setPairProgress] = useState<PairProgress | null>(null)
  const [paste, setPaste] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const memoryBackAction = useRef<(() => void) | null>(null)
  const [memorySettingsOpen, setMemorySettingsOpen] = useState(false)
  const [engineSelectorOpen, setEngineSelectorOpen] = useState(false)
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
  const [fileReturnScreen, setFileReturnScreen] = useState<Screen>('files')
  const [fileTrail, setFileTrail] = useState<Array<{ name: string; abs: string }>>([])
  const [filePreview, setFilePreview] = useState<{ name: string; content: string; truncated?: boolean } | null>(null)
  const [filesTip, setFilesTip] = useState('')
  const [workspaceDraft, setWorkspaceDraft] = useState(() => parseProjectWorkspaceState('{}'))
  const [groupRules, setGroupRules] = useState('')
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([])
  const [selectedMemberId, setSelectedMemberId] = useState('')
  const [projectMemberModels, setProjectMemberModels] = useState<Array<{ id: string; label: string }>>([])
  const [workspaceSaving, setWorkspaceSaving] = useState(false)
  const [workspaceSaved, setWorkspaceSaved] = useState('')
  const [projectTasks, setProjectTasks] = useState<TaskInfo[]>([])
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskDue, setNewTaskDue] = useState('')
  const [newTaskCriteria, setNewTaskCriteria] = useState('')
  const [newTaskDepends, setNewTaskDepends] = useState<string[]>([])
  const [weeklyStartDate, setWeeklyStartDate] = useState(() => currentWeekRange().startDate)
  const [weeklyEndDate, setWeeklyEndDate] = useState(() => currentWeekRange().endDate)
  const [reportQuery, setReportQuery] = useState('')
  const [reportHits, setReportHits] = useState<SiYuanSearchResult[]>([])
  const [reportSelected, setReportSelected] = useState<string[]>([])
  const [reportDates, setReportDates] = useState<Record<string, string>>({})
  const [reportTemplateId, setReportTemplateId] = useState('')
  const [reportTemplateName, setReportTemplateName] = useState('')
  const [reportPeriodType, setReportPeriodType] = useState('季度')
  const [reportSections, setReportSections] = useState('工作重点\n主要进展\n量化成果\n风险与下一步')
  const [reportStartDate, setReportStartDate] = useState(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`)
  const [reportEndDate, setReportEndDate] = useState(new Date().toISOString().slice(0, 10))
  const [reportBusy, setReportBusy] = useState(false)
  const [reportMessage, setReportMessage] = useState('')
  const [reportResult, setReportResult] = useState<ProjectReportInfo | null>(null)
  const [campaignDraft, setCampaignDraft] = useState<CampaignProposalInput>({ kind: 'feature_video', title: '', feature: '', story: '', channels: [], sellingPoints: [], materialsNeeded: [] })
  const [editingCampaignId, setEditingCampaignId] = useState('')
  const [campaignFeedback, setCampaignFeedback] = useState<Record<string, string>>({})
  const [campaignPaths, setCampaignPaths] = useState<Record<string, string>>({})
  const [campaignAssetChoices, setCampaignAssetChoices] = useState<Record<string, string>>({})
  const [captureDraft, setCaptureDraft] = useState({ title: '', feature: '', fullPage: false, redactionConfirmed: false })
  const [assetScanDirectory, setAssetScanDirectory] = useState('素材')
  const [assetDraft, setAssetDraft] = useState<{ title: string; path: string; feature: string; kind: 'image' | 'video' | 'document' | 'demo_url'; source: 'user_provided' | 'authorized_screenshot' | 'generated_illustration' | 'demo_material'; sourceNote: string; isReal: boolean }>({ title: '', path: '', feature: '', kind: 'image', source: 'user_provided', sourceNote: '', isReal: false })
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
    if (memorySettingsOpen) { memoryBackAction.current?.(); return }
    if (engineSelectorOpen) { setEngineSelectorOpen(false); return }
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
      setScreen(fileReturnScreen)
      return
    }
    if (screenRef.current === 'project') {
      if (projectSection !== 'overview') {
        setProjectSection('overview')
        return
      }
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
    if (tabRef.current === 'contacts') {
      setTab('messages')
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
    setPairProgress(null)
    setError('')
    setBusy(true)
    try {
      await phone.pair(raw, '我的手机', setPairProgress)
      refreshPeers()
      await loadLists()
      setPaste('')
      setAdding(false)
      setTab('messages')
      setScreen('list')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPairProgress(null)
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
    setTab('messages')
    setListQuery('')
    setTarget(t)
    setScreen('chat')
    setStream(null)
    setPlus(false)
    setChatMenuOpen(false)
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
    const state = parseProjectWorkspaceState(project.workspace_state)
    setWorkspaceDraft(state)
    setGroupRules(project.system_prompt || '')
    void phone.invoke<ProjectMember[]>(IPC.projectMembers, { projectId: project.id }).then((members) => {
      setProjectMembers(members)
      setSelectedMemberId((current) => current && members.some((member) => member.agent_id === current) ? current : members[0]?.agent_id || '')
    }).catch(() => setProjectMembers([]))
    setProjectSection('overview')
    setFilesData(null)
    void (async () => {
      try {
        let dir = project.workspace_dir.trim()
        if (!dir) {
          const dataDir = await ensureDataDir()
          if (dataDir) dir = dataDir + '/workspace'
        }
        if (!dir) return
        const result = await phone.invoke<{ exists: boolean; nodes: FileNode[] }>(IPC.fsListFiles, { dir })
        setFilesData({ root: dir.replace(/[\\/]+$/, ''), exists: result.exists, nodes: result.nodes || [] })
      } catch {
        setFilesData(null)
      }
    })()
    setReportQuery(''); setReportHits([]); setReportSelected([]); setReportResult(null); setReportMessage('')
    const firstTemplate = state.reportTemplates[0]
    setReportTemplateId(firstTemplate?.id || '')
    setReportTemplateName(firstTemplate?.name || '')
    setReportPeriodType(firstTemplate?.periodType || '季度')
    setReportSections(firstTemplate?.sections.join('\n') || '工作重点\n主要进展\n量化成果\n风险与下一步')
    setCampaignDraft({ kind: 'feature_video', title: '', feature: '', story: '', channels: state.channels, sellingPoints: [], materialsNeeded: [] })
    setEditingCampaignId('')
    setCampaignFeedback({})
    setCampaignPaths({})
    setWorkspaceSaved('')
    setNewTaskTitle(''); setNewTaskDue(''); setNewTaskCriteria(''); setNewTaskDepends([])
    void phone.invoke<TaskInfo[]>(IPC.tasksList, { projectId: target.id }).then(setProjectTasks).catch((error) => setWorkspaceSaved(`无法加载项目任务：${error instanceof Error ? error.message : String(error)}`))
    setScreen('project')
  }

  const selectedProjectMember = projectMembers.find((member) => member.agent_id === selectedMemberId)
  useEffect(() => {
    let active = true
    setProjectMemberModels([])
    if (screen === 'project' && selectedProjectMember && selectedProjectMember.execution_engine !== 'opencode') {
      void phone.invoke<{ models: Array<{ id: string; label: string }> }>(IPC.enginesModels, { engine: selectedProjectMember.execution_engine })
        .then((result) => { if (active) setProjectMemberModels(result.models) }).catch(() => {})
    }
    return () => { active = false }
  }, [screen, selectedProjectMember?.agent_id, selectedProjectMember?.execution_engine])

  async function saveProjectTask(task?: TaskInfo, status?: string) {
    if (!target || target.kind !== 'group') return
    setWorkspaceSaving(true)
    try {
      const payload = task
        ? { id: task.id, project_id: target.id, title: task.title, description: task.description, status: status ?? task.status, priority: task.priority, assignee_id: task.assignee_id, due_at: task.due_at, depends_on: task.depends_on, acceptance_criteria: task.acceptance_criteria, evidence_paths: task.evidence_paths }
        : { project_id: target.id, title: newTaskTitle.trim(), due_at: newTaskDue ? new Date(`${newTaskDue}T23:59:59`).getTime() : null, depends_on: newTaskDepends, acceptance_criteria: newTaskCriteria.trim() }
      await phone.invoke<TaskInfo>(IPC.taskSave, payload)
      setProjectTasks(await phone.invoke<TaskInfo[]>(IPC.tasksList, { projectId: target.id }))
      setNewTaskTitle(''); setNewTaskDue(''); setNewTaskCriteria(''); setNewTaskDepends([]); setWorkspaceSaved('项目任务已保存')
    } catch (error) { setWorkspaceSaved(`任务保存失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setWorkspaceSaving(false) }
  }

  async function generateProjectDocument(kind: 'charter' | 'weekly_report' | 'closeout') {
    if (!target || target.kind !== 'group') return
    setWorkspaceSaving(true)
    try {
      const result = await phone.invoke<ProjectDocumentInfo>(IPC.projectDocument, { projectId: target.id, kind, ...(kind === 'weekly_report' ? { startDate: weeklyStartDate, endDate: weeklyEndDate } : {}) })
      setWorkspaceSaved(`已生成草稿：${result.path}${result.missing.length ? `；待补：${result.missing.join('、')}` : ''}`)
    } catch (error) { setWorkspaceSaved(`生成失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setWorkspaceSaving(false) }
  }

  async function searchReportSources() {
    setReportBusy(true); setReportMessage('正在搜索思源日报…')
    try {
      const found = await phone.invoke<SiYuanSearchResult[]>(IPC.siyuanSearch, { keyword: reportQuery })
      setReportHits(found); setReportSelected([])
      setReportDates(Object.fromEntries(found.map((item) => [item.docId, `${item.docId.slice(0, 4)}-${item.docId.slice(4, 6)}-${item.docId.slice(6, 8)}`])))
      setReportMessage('请核对每篇日报日期后选择来源')
    }
    catch (error) { setReportHits([]); setReportMessage(`搜索失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setReportBusy(false) }
  }

  async function confirmReportSourcesOnPhone() {
    if (!target || target.kind !== 'group') return
    setReportBusy(true)
    try {
      const sources = reportHits.filter((item) => reportSelected.includes(item.docId)).map(({ docId, title, path }) => ({ docId, title, path, reportDate: reportDates[docId] || '' }))
      const info = await phone.invoke<ProjectInfo>(IPC.projectReport, { projectId: target.id, action: 'confirm_sources', query: reportQuery, sources })
      setWorkspaceDraft(parseProjectWorkspaceState(info.workspace_state)); setProjects((items) => items.map((item) => item.id === info.id ? info : item)); setReportSelected([]); setReportMessage(`已确认 ${sources.length} 篇来源`)
    } catch (error) { setReportMessage(`确认失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setReportBusy(false) }
  }

  async function saveReportTemplateOnPhone() {
    if (!target || target.kind !== 'group') return
    setReportBusy(true)
    try {
      const info = await phone.invoke<ProjectInfo>(IPC.projectReport, { projectId: target.id, action: 'save_template', template: { ...(reportTemplateId ? { id: reportTemplateId } : {}), name: reportTemplateName, periodType: reportPeriodType, sections: reportSections.split('\n'), outputFormat: 'markdown' } })
      const next = parseProjectWorkspaceState(info.workspace_state)
      setWorkspaceDraft(next); setProjects((items) => items.map((item) => item.id === info.id ? info : item))
      const saved = next.reportTemplates.find((item) => item.name === reportTemplateName.trim())
      if (saved) setReportTemplateId(saved.id)
      setReportMessage('报告模板已保存并同步到项目')
    } catch (error) { setReportMessage(`模板保存失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setReportBusy(false) }
  }

  async function generateProjectReportOnPhone() {
    if (!target || target.kind !== 'group') return
    setReportBusy(true); setReportResult(null); setReportMessage('正在读取日报并生成报告草稿…')
    try {
      const result = await phone.invoke<ProjectReportInfo>(IPC.projectReport, { projectId: target.id, action: 'generate', templateId: reportTemplateId, startDate: reportStartDate, endDate: reportEndDate })
      setReportResult(result); setReportMessage(`已生成报告草稿，引用 ${result.sourceDocIds.length} 篇日报`)
    } catch (error) { setReportMessage(`报告生成失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setReportBusy(false) }
  }

  async function removeReportSourceOnPhone(docId: string) {
    if (!target || target.kind !== 'group') return
    try {
      const info = await phone.invoke<ProjectInfo>(IPC.projectReport, { projectId: target.id, action: 'remove_source', docId })
      setWorkspaceDraft(parseProjectWorkspaceState(info.workspace_state)); setProjects((items) => items.map((item) => item.id === info.id ? info : item))
    } catch (error) { setReportMessage(`移除来源失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  async function persistProjectWorkspace(state: ReturnType<typeof parseProjectWorkspaceState>): Promise<boolean> {
    if (!target || target.kind !== 'group') return false
    const project = projects.find((p) => p.id === target.id)
    if (!project) return false
    setWorkspaceSaving(true)
    setWorkspaceSaved('')
    try {
      const updated = await phone.invoke<ProjectInfo>(IPC.projectSave, {
        id: project.id,
        title: project.title,
        description: project.description,
        system_prompt: groupRules,
        icon: project.icon,
        leader_agent_id: project.leader_agent_id,
        memberAgentIds: projectMembers.map((member) => member.agent_id),
        memberConfigs: projectMembers.map(({ agent_id, duties, model_override, thinking_override }) => ({ agent_id, duties, model_override, thinking_override })),
        workspace_dir: project.workspace_dir,
        workspace_state: serializeProjectWorkspaceState(state),
      })
      setProjects((items) => items.map((item) => item.id === project.id ? updated : item))
      setWorkspaceDraft(state)
      setWorkspaceSaved('已保存到项目资料')
      return true
    } catch (err) {
      setWorkspaceSaved(`保存失败：${String((err as Error).message).slice(0, 100)}`)
      return false
    } finally {
      setWorkspaceSaving(false)
    }
  }

  async function saveProjectWorkspace() { await persistProjectWorkspace(workspaceDraft) }

  async function createCampaignOnPhone() {
    try {
      if (!target || target.kind !== 'group') return
      const updated = await phone.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: target.id, action: editingCampaignId ? 'update' : 'create', ...(editingCampaignId ? { campaignId: editingCampaignId } : {}), ...campaignDraft })
      const nextState = parseProjectWorkspaceState(updated.workspace_state)
      setProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
      setWorkspaceDraft(nextState)
      setWorkspaceSaved('选题已保存，等待方向确认')
      setEditingCampaignId('')
      setCampaignDraft({ ...campaignDraft, title: '', feature: '', story: '', sellingPoints: [], materialsNeeded: [] })
    } catch (err) { setWorkspaceSaved(`无法创建选题：${String((err as Error).message)}`) }
  }

  function editCampaignOnPhone(campaign: CampaignProposal) {
    setEditingCampaignId(campaign.id)
    setCampaignDraft({
      kind: campaign.kind, title: campaign.title, feature: campaign.feature, story: campaign.story,
      channels: campaign.channels, sellingPoints: campaign.sellingPoints, materialsNeeded: campaign.materialsNeeded,
    })
  }

  async function reviewCampaignOnPhone(campaign: CampaignProposal, decision: 'approve' | 'changes_requested') {
    try {
      if (!target || target.kind !== 'group') return
      const updated = await phone.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: target.id, action: 'review_direction', campaignId: campaign.id, decision, feedback: campaignFeedback[campaign.id] || '' })
      setProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
      setWorkspaceDraft(parseProjectWorkspaceState(updated.workspace_state))
      setWorkspaceSaved('方向审核已保存')
    }
    catch (err) { setWorkspaceSaved(`无法确认选题：${String((err as Error).message)}`) }
  }

  async function makeCampaignTaskOnPhone(campaign: CampaignProposal) {
    if (!target || target.kind !== 'group') return
    const project = projects.find((item) => item.id === target.id)
    if (!project) return
    try {
      if (!canStartCampaignProduction(campaign)) throw new Error('先确认方向并补齐素材')
      const updated = await phone.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: project.id, action: 'create_task', campaignId: campaign.id })
      setProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
      setWorkspaceDraft(parseProjectWorkspaceState(updated.workspace_state))
      setWorkspaceSaved('制作任务已创建并关联选题')
    } catch (err) { setWorkspaceSaved(`无法创建制作任务：${String((err as Error).message)}`) }
  }

  async function submitCampaignOnPhone(campaign: CampaignProposal) {
    try {
      if (!target || target.kind !== 'group') return
      const updated = await phone.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: target.id, action: 'submit_delivery', campaignId: campaign.id, path: campaignPaths[campaign.id] || '' })
      setProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
      setWorkspaceDraft(parseProjectWorkspaceState(updated.workspace_state))
      setWorkspaceSaved('成品版本已提交验收')
      setCampaignPaths((current) => ({ ...current, [campaign.id]: '' }))
    } catch (err) { setWorkspaceSaved(`无法提交成品：${String((err as Error).message)}`) }
  }

  async function reviewDeliveryOnPhone(campaign: CampaignProposal, deliveryId: string, decision: 'accepted' | 'changes_requested') {
    try {
      if (!target || target.kind !== 'group') return
      const updated = await phone.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: target.id, action: 'review_delivery', campaignId: campaign.id, deliveryId, decision, feedback: campaignFeedback[deliveryId] || '' })
      setProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
      setWorkspaceDraft(parseProjectWorkspaceState(updated.workspace_state))
      setWorkspaceSaved('成品验收已保存')
    }
    catch (err) { setWorkspaceSaved(`无法验收成品：${String((err as Error).message)}`) }
  }

  async function registerAssetOnPhone() {
    try {
      if (!target || target.kind !== 'group') return
      const updated = await phone.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: target.id, action: 'register_asset', ...assetDraft })
      setProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
      setWorkspaceDraft(parseProjectWorkspaceState(updated.workspace_state))
      setAssetDraft({ title: '', path: '', feature: '', kind: 'image', source: 'user_provided', sourceNote: '', isReal: false })
      setWorkspaceSaved('素材已登记，待确认来源与可用性')
    } catch (err) { setWorkspaceSaved(`无法登记素材：${String((err as Error).message)}`) }
  }

  async function reviewAssetOnPhone(assetId: string, confirmed: boolean) {
    try {
      if (!target || target.kind !== 'group') return
      const updated = await phone.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: target.id, action: 'review_asset', assetId, confirmed })
      setProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
      setWorkspaceDraft(parseProjectWorkspaceState(updated.workspace_state))
    } catch (err) { setWorkspaceSaved(`无法确认素材：${String((err as Error).message)}`) }
  }

  async function resolveCampaignMaterialOnPhone(campaign: CampaignProposal, need: string) {
    try {
      if (!target || target.kind !== 'group') return
      const updated = await phone.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: target.id, action: 'resolve_material', campaignId: campaign.id, need, assetId: campaignAssetChoices[`${campaign.id}:${need}`] || '' })
      setProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
      setWorkspaceDraft(parseProjectWorkspaceState(updated.workspace_state))
      setWorkspaceSaved('已使用确认素材补齐选题缺口')
    } catch (err) { setWorkspaceSaved(`无法补齐素材缺口：${String((err as Error).message)}`) }
  }

  async function captureProjectScreenshotOnPhone() {
    try {
      if (!target || target.kind !== 'group') return
      setWorkspaceSaving(true)
      const updated = await phone.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: target.id, action: 'capture_browser_screenshot', ...captureDraft })
      setProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
      setWorkspaceDraft(parseProjectWorkspaceState(updated.workspace_state))
      setCaptureDraft({ title: '', feature: '', fullPage: false, redactionConfirmed: false })
      setWorkspaceSaved('截图已保存到项目素材库，待确认可用性')
    } catch (err) { setWorkspaceSaved(`无法截图：${String((err as Error).message)}`) }
    finally { setWorkspaceSaving(false) }
  }

  async function scanProjectAssetsOnPhone() {
    try {
      if (!target || target.kind !== 'group') return
      setWorkspaceSaving(true)
      const before = workspaceDraft.assets.length
      const updated = await phone.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: target.id, action: 'scan_asset_candidates', directory: assetScanDirectory })
      setProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
      const nextState = parseProjectWorkspaceState(updated.workspace_state)
      setWorkspaceDraft(nextState)
      const count = Math.max(0, nextState.assets.length - before)
      setWorkspaceSaved(`扫描完成，发现 ${count} 个新候选${count >= 200 ? '（本轮到达 200 项上限，可再次扫描下一批）' : ''}；来源和脱敏确认前不能用于制作`)
    } catch (err) { setWorkspaceSaved(`无法扫描素材：${String((err as Error).message)}`) }
    finally { setWorkspaceSaving(false) }
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
      setFileReturnScreen(screen === 'project' ? 'project' : screen === 'file' ? fileReturnScreen : 'files')
      const r = await phone.invoke<{ content: string; truncated?: boolean }>(IPC.fsReadFile, { file: path })
      setFilePreview({ name, content: r.content, truncated: r.truncated })
      setScreen('file')
    } catch (err) {
      setFilesTip(`读取失败：${(err as Error).message}`)
    }
  }

  const xiaojie = useMemo(() => agents.find((a) => a.builtin), [agents])
  const others = useMemo(() => agents.filter((a) => !a.builtin), [agents])

  const pinOrder = useMemo(() => sortedPinKeys(pins), [pins])
  const contacts = useMemo(() => {
    const entries: ConversationEntry[] = []
    if (xiaojie) {
      const key = `agent:${xiaojie.id}`
      const recent = recentMap[key]
      entries.push({
        key,
        target: { kind: 'agent', id: xiaojie.id, name: xiaojie.name, avatar: xiaojie.avatar },
        title: xiaojie.name,
        sub: recent?.text || 'Jeff 内置管家 · 问我什么都能办',
        time: recent?.time,
        avatar: xiaojie.avatar || '🤖',
        agentId: xiaojie.id,
        kind: 'agent',
        isGroup: false,
        isBuiltin: true,
        pinned: true,
        busy: stream !== null && target?.id === xiaojie.id,
        unread: unread[key] || 0,
        pinOrder: -1,
      })
    }
    for (const agent of others) {
      const key = `agent:${agent.id}`
      const recent = recentMap[key]
      const pinIndex = pinOrder.indexOf(key)
      entries.push({
        key,
        target: { kind: 'agent', id: agent.id, name: agent.name, avatar: agent.avatar },
        title: agent.name,
        sub: recent?.text || agent.description || '（无简介）',
        time: recent?.time,
        avatar: agent.avatar,
        agentId: agent.id,
        kind: 'agent',
        isGroup: false,
        isBuiltin: false,
        pinned: pinIndex >= 0,
        busy: stream !== null && target?.id === agent.id,
        unread: unread[key] || 0,
        pinOrder: pinIndex,
      })
    }
    for (const project of projects) {
      const key = `group:${project.id}`
      const recent = recentMap[key]
      const pinIndex = pinOrder.indexOf(key)
      entries.push({
        key,
        target: { kind: 'group', id: project.id, name: project.title, icon: project.icon },
        title: project.title,
        sub: recent?.text || `${project.memberCount || 0} 个成员 · 群主统筹`,
        time: recent?.time,
        avatar: project.icon,
        kind: 'group',
        isGroup: true,
        isBuiltin: false,
        pinned: pinIndex >= 0,
        busy: stream !== null && target?.id === project.id,
        unread: unread[key] || 0,
        pinOrder: pinIndex,
      })
    }
    return entries.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.pinned) return a.pinOrder - b.pinOrder
      return (b.time || 0) - (a.time || 0) || a.title.localeCompare(b.title, 'zh-CN')
    })
  }, [xiaojie, others, projects, recentMap, pinOrder, stream, target, unread])
  const conversations = useMemo(
    () => contacts.filter((entry) => entry.isBuiltin || entry.pinned || entry.time != null),
    [contacts],
  )
  const searchedConversations = useMemo(() => {
    const query = listQuery.trim().toLocaleLowerCase('zh-CN')
    const source = tab === 'messages' ? conversations : contacts
    return source.filter((entry) => {
      if (tab === 'messages' && chatFilter !== 'all' && entry.kind !== chatFilter) return false
      if (!query) return true
      return `${entry.title} ${entry.sub}`.toLocaleLowerCase('zh-CN').includes(query)
    })
  }, [conversations, contacts, listQuery, chatFilter, tab])

  const renderConversation = (entry: ConversationEntry) => (
    <WeChatItemRow
      key={entry.key}
      title={entry.title}
      sub={entry.sub.length > 64 ? entry.sub.slice(0, 64) + '…' : entry.sub}
      time={entry.time}
      avatar={entry.avatar}
      agentId={entry.agentId}
      kind={entry.kind}
      isGroup={entry.isGroup}
      isBuiltin={entry.isBuiltin}
      pinned={entry.pinned}
      busy={entry.busy}
      selected={screen === 'chat' && target?.kind === entry.target.kind && target.id === entry.target.id}
      unread={entry.unread}
      onClick={() => void openChat(entry.target)}
      onLongPress={() => setActionMenu({
        key: entry.key,
        title: entry.title,
        avatar: entry.avatar,
        agentId: entry.agentId,
        isPinned: entry.pinned,
        isBuiltin: entry.isBuiltin,
        target: entry.target,
      })}
    />
  )

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

  const recentWorkspaceFiles = useMemo(() => {
    const files: FileNode[] = []
    const visit = (nodes: FileNode[]) => {
      for (const node of nodes) {
        if (node.dir) visit(node.children || [])
        else files.push(node)
      }
    }
    visit(filesData?.nodes || [])
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, 3)
  }, [filesData])

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
    <main className={`shell${screen === 'chat' && target ? ' has-landscape-chat' : ''}${screen === 'list' && tab !== 'me' ? ' has-landscape-list' : ''}${screen === 'list' && tab === 'me' ? ' has-landscape-me' : ''}`}>
      {(screen === 'list' || (screen === 'chat' && !!target)) && tab !== 'me' && (
        <div className={screen === 'chat' ? 'landscape-list-pane' : 'mobile-list-pane'} data-testid="landscape-conversation-pane" role={screen === 'chat' ? 'complementary' : undefined} aria-label="会话列表">
          <header className="bar wechat-bar mobile-list-bar">
            <div className="bar-left">
              {tab === 'messages' ? (
                <button type="button" className="bar-title" data-testid="computer-switch" onClick={() => setTab('me')}>
                  <i className={!bound || offline ? 'dot off' : 'dot'} />
                  <span className="bar-pc-name">{peer?.name || '未绑定电脑'}</span>
                  <span className="mobile-bar-chevron">⌄</span>
                </button>
              ) : (
                <strong className="mobile-directory-title">通讯录</strong>
              )}
            </div>
            <div className="bar-right">
              <button type="button" className="bar-icon-btn" data-testid="chat-list-search-focus" title="搜索聊天" onClick={() => document.querySelector<HTMLInputElement>('[data-testid="chat-list-search"]')?.focus()}>
                <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
                </svg>
              </button>
              <button type="button" className="bar-icon-btn mobile-new-chat" data-testid="mobile-start-chat" title="发起聊天" onClick={() => { setListQuery(''); setTab('contacts') }}>
                <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              <button type="button" className="bar-icon-btn" data-testid="mobile-list-more" title="更多" aria-label="更多" aria-expanded={listMenuOpen} onClick={() => setListMenuOpen((open) => !open)}>
                <svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
              </button>
            </div>
          </header>
          {offline && bound ? (
            <button type="button" className="banner wechat-offline-banner" data-testid="reconnect" onClick={() => { haptic(12); void loadLists() }}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" /></svg>
              <span>电脑离线，当前为本地只读缓存{syncedAt ? '（同步于 ' + new Date(syncedAt).toLocaleTimeString() + '）' : ''} · 点击重新连接</span>
            </button>
          ) : null}
          <div className="mobile-list-heading">
            <div>
              <h1>{tab === 'messages' ? '聊天' : '通讯录'}</h1>
              <p>{tab === 'messages' ? '最近对话' : '选择智能体或项目群开始聊天'}</p>
            </div>
            <span>{tab === 'messages' ? conversations.length + ' 个会话' : agents.length + projects.length + ' 个联系人'}</span>
          </div>
          <div className="mobile-list-tools">
            <label className="mobile-list-search">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
              <input data-testid="chat-list-search" value={listQuery} onChange={(event) => setListQuery(event.target.value)} placeholder={tab === 'messages' ? '搜索聊天' : '搜索智能体或项目群'} />
              {listQuery ? <button type="button" aria-label="清除搜索" onClick={() => setListQuery('')}>×</button> : null}
            </label>
            {tab === 'messages' ? (
              <div className="mobile-chat-filters" role="group" aria-label="筛选聊天">
                {([
                  ['all', '全部'],
                  ['agent', '智能体'],
                  ['group', '项目群'],
                ] as const).map(([value, label]) => (
                  <button key={value} type="button" className={chatFilter === value ? 'active' : ''} aria-pressed={chatFilter === value} onClick={() => setChatFilter(value)}>{label}</button>
                ))}
              </div>
            ) : null}
          </div>
          {tab === 'messages' && !bound ? (
            <section className="pair wechat-pair-panel" data-testid="pair-panel">
              <div className="pair-hero">
                <div className="pair-logo-wrap"><Mascot size={56} mood="idle" /></div>
                <h2>绑定电脑</h2>
                <p className="hint">在电脑 Jeff 的「设置 → 远程控制」里点击绑定手机，使用下方方式一键绑定。</p>
              </div>
              {Capacitor.isNativePlatform() ? (
                <button type="button" data-testid="pair-scan" className="btn-scan" disabled={busy} onClick={() => { setError(''); void Native.scan().then((result) => acceptPair(result.text)).catch((err) => { const message = (err as Error).message || ''; if (message && !message.includes('取消')) setError(message) }) }}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 4b1 1 0 011-1h4a1 1 0 010 2H5v3a1 1 0 01-2 0V4zm16-1a1 1 0 011 1v4a1 1 0 11-2 0V5h-3a1 1 0 110-2h4zM3 19a1 1 0 001 1h4a1 1 0 100-2H5v-3a1 1 0 10-2 0v4zm17 0a1 1 0 01-1 1h-4a1 1 0 110-2h3v-3a1 1 0 112 0v4zM8 8h8v8H8V8z" /></svg>
                  扫码绑定电脑
                </button>
              ) : null}
              <div className="pair-divider"><span>或手动粘贴绑定码</span></div>
              <textarea data-testid="pair-paste" value={paste} placeholder="在此粘贴电脑端生成的绑定码或 JSON 字符串" onChange={(event) => setPaste(event.target.value)} />
              <button type="button" data-testid="pair-go" className="btn-paste-go" disabled={busy || !paste.trim()} onClick={() => void acceptPair(paste)}>{busy ? pairProgress?.stage === 'confirming' ? '等待电脑确认…' : '正在绑定…' : '使用粘贴内容绑定'}</button>
              <PairingNotice progress={pairProgress} />
              {error ? <p className="err">{error}</p> : null}
            </section>
          ) : tab === 'messages' ? (
            <ul className="msgs wechat-list mobile-conversation-list" data-testid="msg-list" onTouchStart={onPullStart} onTouchMove={onPullMove} onTouchEnd={onPullEnd} onTouchCancel={onPullEnd}>
              {pullPx > 0 ? <li className="wechat-pull-tip" style={{ opacity: Math.min(1, pullPx / 40) }}>{pullPx >= 28 ? '松开刷新' : '下拉刷新…'}</li> : null}
              {searchedConversations.filter((entry) => entry.pinned).length ? <li className="wechat-section-header"><span>置顶</span><span className="wechat-section-count">{searchedConversations.filter((entry) => entry.pinned).length}</span></li> : null}
              {searchedConversations.filter((entry) => entry.pinned).map(renderConversation)}
              {searchedConversations.filter((entry) => !entry.pinned).length ? <li className="wechat-section-header"><span>最近聊天</span><span className="wechat-section-count">{searchedConversations.filter((entry) => !entry.pinned).length}</span></li> : null}
              {searchedConversations.filter((entry) => !entry.pinned).map(renderConversation)}
              {searchedConversations.length === 0 ? <li className="mobile-empty-state">{listQuery ? '没有找到相关聊天' : '还没有会话，去通讯录选择一个智能体或项目群开始聊天'}</li> : null}
            </ul>
          ) : (
            <div className="mobile-contacts-list" data-testid="contacts-list">
              {searchedConversations.filter((entry) => entry.kind === 'group').length ? (
                <section>
                  <h2 className="mobile-contact-section-title">项目群</h2>
                  <ul>{searchedConversations.filter((entry) => entry.kind === 'group').map(renderConversation)}</ul>
                </section>
              ) : null}
              <section>
                <h2 className="mobile-contact-section-title">智能体</h2>
                {xiaojie && searchedConversations.some((entry) => entry.isBuiltin) ? <ul>{searchedConversations.filter((entry) => entry.isBuiltin).map(renderConversation)}</ul> : null}
                {groups.map(([name, list]) => {
                  const matching = list.filter((agent) => searchedConversations.some((entry) => entry.key === 'agent:' + agent.id))
                  if (!matching.length) return null
                  const isCollapsed = !!collapsed[name]
                  return (
                    <div className="wechat-group-block mobile-contact-group" key={name}>
                      <button type="button" className="wechat-group-head" data-testid={'chat-agent-group-' + name} aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => ({ ...current, [name]: !current[name] }))}>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={isCollapsed ? 'rot' : ''}><path d="M6 9l6 6 6-6" /></svg>
                        <span>{name}</span><span className="wechat-group-count">{matching.length}</span>
                      </button>
                      {!isCollapsed ? <ul>{matching.map((agent) => {
                        const entry = searchedConversations.find((candidate) => candidate.key === 'agent:' + agent.id)
                        return entry ? renderConversation(entry) : null
                      })}</ul> : null}
                    </div>
                  )
                })}
              </section>
              {searchedConversations.length === 0 ? <p className="mobile-empty-state">{listQuery ? '没有找到联系人' : '还没有可用联系人'}</p> : null}
            </div>
          )}
          {listMenuOpen ? (
            <div className="mobile-list-menu" data-testid="mobile-list-menu">
              <button type="button" onClick={() => { setListMenuOpen(false); setTab('contacts') }}>发起聊天</button>
              <button type="button" onClick={() => { setListMenuOpen(false); setTab('me') }}>电脑与设置</button>
            </div>
          ) : null}
        </div>
      )}
      {screen === 'chat' && target && tab !== 'me' ? (
        <nav className="landscape-nav-rail" aria-label="主导航" data-testid="landscape-nav-rail">
          <button type="button" className={tab === 'messages' ? 'active' : ''} aria-label="聊天" aria-pressed={tab === 'messages'} onClick={() => setTab('messages')}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-2 2v-6a7.5 7.5 0 1 1 17-3.5Z" /></svg><span>聊天</span>
          </button>
          <button type="button" className={tab === 'contacts' ? 'active' : ''} aria-label="通讯录" aria-pressed={tab === 'contacts'} onClick={() => setTab('contacts')}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.4-3.2 2.7-5 6.5-5s6.1 1.8 6.5 5M17 5.5a3.5 3.5 0 0 1 0 6.8M17.5 15c2.2.5 3.5 2 4 5" /></svg><span>通讯录</span>
          </button>
          <button type="button" aria-label="我" onClick={() => { setTab('me'); setScreen('list'); setTarget(null) }}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="7" r="4" /><path d="M4 21c0-4 3-6 8-6s8 2 8 6" /></svg><span>我</span>
          </button>
        </nav>
      ) : null}
      {memorySettingsOpen && <MemorySettings phone={phone} backAction={memoryBackAction} onClose={() => setMemorySettingsOpen(false)} />}
      {engineSelectorOpen && <EngineSelector phone={phone} agents={agents} initialId={target?.kind === 'agent' ? target.id : undefined} onSave={(saved) => { setAgents((previous) => previous.map((agent) => agent.id === saved.id ? saved : agent)); if (target) void loadHistory(target) }} onClose={() => setEngineSelectorOpen(false)} />}
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
                  {ctx.statsAvailable === false ? ENGINE_LABELS[ctx.engine || 'opencode'] : `${fmtTokensShort(ctx.usedTokens)}/${fmtTokensShort(ctx.contextLimit)}`}
                </button>
              ) : null}
            </div>
            {target.kind === 'group' ? (
              <button type="button" className="bar-icon-btn project-workspace-entry" data-testid="project-workspace" title="项目工作区" aria-label="项目工作区" onClick={openProjectWorkspace}>
                <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
              </button>
            ) : null}
            <button type="button" className="bar-icon-btn" data-testid="chat-more" title="更多聊天操作" aria-label="更多聊天操作" aria-expanded={chatMenuOpen} onClick={() => setChatMenuOpen((open) => !open)}>
              <svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
            </button>
          </header>
          {chatMenuOpen ? (
            <div className="mobile-chat-menu" data-testid="chat-menu">
              <button type="button" data-testid="chat-find" onClick={() => { setChatMenuOpen(false); haptic(10); setFindOpen(true); setFindQuery('') }}>查找聊天内容</button>
              <button type="button" data-testid="session-history" onClick={() => { setChatMenuOpen(false); void openSessionDrawer() }}>切换会话</button>
              <button type="button" data-testid="chat-new-session" onClick={() => { setChatMenuOpen(false); void newSession() }}>新建会话</button>
              {target.kind === 'group' ? <button type="button" data-testid="workspace" onClick={() => { setChatMenuOpen(false); void openWorkspaceFiles() }}>工作区文件</button> : null}
              <button type="button" data-testid="mobile-engine-settings" onClick={() => { setChatMenuOpen(false); setEngineSelectorOpen(true) }}>执行引擎与模型</button>
              <button type="button" data-testid="chat-context" onClick={() => { setChatMenuOpen(false); setCtxOpen(true) }}>上下文用量</button>
            </div>
          ) : null}
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
                  {ctx?.statsAvailable === false ? '引擎未提供上下文统计' : `上下文占用 ${fmtTokensShort(ctx?.usedTokens ?? 0)}`}
                  {ctx?.contextLimit ? ` / ${fmtTokensShort(ctx.contextLimit)}` : ' · 未配置窗口'}
                </span>
                <button type="button" className="wechat-btn-compress" data-testid="ctx-compress" disabled={ctx?.compressionAvailable === false || ctxBusy || !ctx?.sessionId} onClick={() => void compressCtx()}>
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
              </div>
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
              onClick={() => setPlus((open) => !open)}
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
            <button type="button" className="btn-nav-back" onClick={() => projectSection === 'overview' ? setScreen('chat') : setProjectSection('overview')}>
              <span className="wechat-back-chevron">‹</span>
              <span className="wechat-back-text">{projectSection === 'overview' ? '返回聊天' : '项目概览'}</span>
            </button>
            <b>{projectSection === 'overview' ? '项目工作区' : ({ profile: '项目资料与群规则', members: '群成员配置', reports: '日报与报告', tasks: '任务看板', assets: '项目素材', campaigns: '宣传选题与成品' } as Record<ProjectSection, string>)[projectSection]}</b>
            <span style={{ width: 48 }} />
          </header>
          <p className="wechat-file-hint">项目进度、待交付和最近文件集中在这里；具体资料按需打开。</p>
          {projectSection === 'overview' ? (
            <div className="project-workspace-overview" data-testid="project-workspace-overview">
              <article className="project-overview-hero">
                <span className="project-overview-eyebrow">项目工作区</span>
                <h2>{target.name}</h2>
                <p>查看团队进展，或进入一个具体事项继续处理。</p>
              </article>
              <div className="project-overview-stats">
                <button type="button" onClick={() => setProjectSection('tasks')}><strong>{projectTasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled').length}</strong><span>进行中任务</span></button>
                <button type="button" onClick={() => setProjectSection('campaigns')}><strong>{workspaceDraft.campaigns.reduce((sum, campaign) => sum + campaign.deliveries.filter((delivery) => delivery.status === 'in_review').length, 0)}</strong><span>待验收交付</span></button>
                <button type="button" onClick={() => setProjectSection('assets')}><strong>{workspaceDraft.assets.filter((asset) => !asset.confirmed).length}</strong><span>待确认素材</span></button>
              </div>
              <div className="project-overview-links">
                <button type="button" data-testid="project-section-profile" onClick={() => setProjectSection('profile')}><span>项目资料</span><small>目标、受众与项目文档</small><b>›</b></button>
                <button type="button" data-testid="project-section-members" onClick={() => setProjectSection('members')}><span>群规则与成员配置</span><small>{projectMembers.length} 位成员 · 群内职责、模型与思考程度</small><b>›</b></button>
                <button type="button" data-testid="project-section-reports" onClick={() => setProjectSection('reports')}><span>日报与报告</span><small>搜索来源、管理模板、生成草稿</small><b>›</b></button>
                <button type="button" data-testid="project-section-tasks" onClick={() => setProjectSection('tasks')}><span>任务看板</span><small>{projectTasks.length} 项任务</small><b>›</b></button>
                <button type="button" data-testid="project-section-assets" onClick={() => setProjectSection('assets')}><span>项目素材</span><small>{workspaceDraft.assets.length} 项素材</small><b>›</b></button>
                <button type="button" data-testid="project-section-campaigns" onClick={() => setProjectSection('campaigns')}><span>宣传选题与成品</span><small>{workspaceDraft.campaigns.length} 个选题</small><b>›</b></button>
              </div>
              <section className="project-overview-files">
                <div><h3>最近文件</h3><span>项目工作区</span></div>
                {recentWorkspaceFiles.length ? recentWorkspaceFiles.map((file) => <button type="button" key={file.abs} onClick={() => void openRemoteFile(file.abs, file.name)}><span>▤</span><strong>{file.name}</strong><small>{new Date(file.mtime).toLocaleDateString('zh-CN')}</small><b>›</b></button>) : <p>还没有项目文件。文件生成后会显示在这里。</p>}
              </section>
            </div>
          ) : null}
          {projectSection === 'profile' && <div className="project-workspace-form">
            <label><span>群规则（只在本群生效）</span><textarea rows={8} data-testid="mobile-group-rules" value={groupRules} onChange={(event) => setGroupRules(event.target.value)} placeholder="定义本群目标、协作流程、任务分配方式、验收口径和边界。群内身份与分工只在本群有效，不修改成员个人 Prompt。" /></label>
            <label><span>阶段目标</span><textarea rows={3} data-testid="mobile-workspace-goal" value={workspaceDraft.goal} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, goal: e.target.value }))} placeholder="这个项目当前要达成什么结果？" /></label>
            <label><span>销售对象</span><input data-testid="mobile-workspace-sales-audience" value={workspaceDraft.salesAudience} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, salesAudience: e.target.value }))} placeholder="例如：渠道商与集成商" /></label>
            <label><span>内容呈现对象</span><input data-testid="mobile-workspace-story-audience" value={workspaceDraft.storyAudience} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, storyAudience: e.target.value }))} placeholder="例如：一线医护人员" /></label>
            <label><span>传播渠道（每行一个）</span><textarea rows={2} data-testid="mobile-workspace-channels" value={workspaceDraft.channels.join('\n')} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, channels: e.target.value.split('\n') }))} placeholder="微信私聊\n渠道群转发\n现场讲解" /></label>
            <label><span>系统介绍大纲（每行一章）</span><textarea rows={7} data-testid="mobile-workspace-outline" value={workspaceDraft.systemOutline.join('\n')} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, systemOutline: e.target.value.split('\n') }))} placeholder="整体方案\n功能与医护使用场景\n对接与部署" /></label>
            <label><span>每周推进节奏</span><textarea rows={2} data-testid="mobile-workspace-cadence" value={workspaceDraft.weeklyCadence} onChange={(e) => setWorkspaceDraft((s) => ({ ...s, weeklyCadence: e.target.value }))} placeholder="每周提交一批选题与素材缺口" /></label>
            <button type="button" className="btn-primary" data-testid="mobile-workspace-save" disabled={workspaceSaving} onClick={() => void saveProjectWorkspace()}>{workspaceSaving ? '保存中…' : '保存项目资料'}</button>
            {workspaceSaved ? <p className="project-workspace-result" data-testid="mobile-workspace-result">{workspaceSaved}</p> : null}
            <h3 className="campaign-mobile-title">项目文档</h3>
            <p className="project-workspace-result">生成的均为待复核 Markdown 草稿，保存在电脑的项目工作区。</p>
            <div className="campaign-mobile-actions">
              <button type="button" disabled={workspaceSaving} data-testid="mobile-project-document-charter" onClick={() => void generateProjectDocument('charter')}>生成立项文档草稿</button>
              <button type="button" disabled={workspaceSaving} data-testid="mobile-project-document-closeout" onClick={() => void generateProjectDocument('closeout')}>生成结项核查草稿</button>
            </div>
            <div className="project-workspace-form"><label><span>周报统计开始日期</span><input data-testid="mobile-project-weekly-start" type="date" value={weeklyStartDate} onChange={(e) => setWeeklyStartDate(e.target.value)} /></label><label><span>周报统计结束日期</span><input data-testid="mobile-project-weekly-end" type="date" value={weeklyEndDate} onChange={(e) => setWeeklyEndDate(e.target.value)} /></label></div>
            <button type="button" disabled={workspaceSaving || !weeklyStartDate || !weeklyEndDate || weeklyStartDate > weeklyEndDate} data-testid="mobile-project-document-weekly" onClick={() => void generateProjectDocument('weekly_report')}>生成项目周报草稿</button>
          </div>}
          {projectSection === 'members' && <div className="project-workspace-form" data-testid="mobile-group-members">
            <p className="project-workspace-result">每个 Agent 保留个人默认模型与思考程度。这里的职责和配置只在当前群生效；留空表示继承个人默认值。</p>
            <label><span>群成员</span><select data-testid="mobile-group-member-select" value={selectedMemberId} onChange={(event) => setSelectedMemberId(event.target.value)}>{projectMembers.map((member) => <option key={member.agent_id} value={member.agent_id}>{member.name}{member.agent_id === projects.find((project) => project.id === target.id)?.leader_agent_id ? ' · 群主' : ''}</option>)}</select></label>
            {selectedProjectMember ? <>
              <p className="project-workspace-result">{selectedProjectMember.name} · {selectedProjectMember.execution_engine === 'opencode' ? 'OpenCode（Jeff）' : selectedProjectMember.execution_engine === 'opencode-system' ? 'OpenCode（系统）' : selectedProjectMember.execution_engine}</p>
              <label><span>本群职责</span><textarea rows={5} data-testid="mobile-group-member-duties" value={selectedProjectMember.duties} onChange={(event) => setProjectMembers((members) => members.map((member) => member.agent_id === selectedProjectMember.agent_id ? { ...member, duties: event.target.value } : member))} placeholder="该成员在本群负责什么；留空时按群规则分配" /></label>
              <label><span>本群模型（留空继承个人默认）</span><input data-testid="mobile-group-member-model" list="mobile-group-member-models" value={selectedProjectMember.model_override || ''} onChange={(event) => setProjectMembers((members) => members.map((member) => member.agent_id === selectedProjectMember.agent_id ? { ...member, model_override: event.target.value || null } : member))} placeholder={selectedProjectMember.execution_engine === 'opencode' ? 'provider/model，例如 openai/gpt-5' : 'CLI 模型 ID'} />
                <datalist id="mobile-group-member-models">{projectMemberModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
              </label>
              {selectedProjectMember.execution_engine !== 'cursor' && <label><span>本群思考程度</span><select data-testid="mobile-group-member-thinking" value={selectedProjectMember.thinking_override || ''} onChange={(event) => setProjectMembers((members) => members.map((member) => member.agent_id === selectedProjectMember.agent_id ? { ...member, thinking_override: event.target.value || null } : member))}><option value="">继承个人默认</option><option value="none">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="max">最大</option></select></label>}
              <button type="button" className="btn-primary" data-testid="mobile-group-member-save" disabled={workspaceSaving} onClick={() => void saveProjectWorkspace()}>{workspaceSaving ? '保存中…' : '保存群规则与成员配置'}</button>
              {workspaceSaved ? <p className="project-workspace-result" role="status">{workspaceSaved}</p> : null}
            </> : <p className="project-workspace-result">这个群还没有可编辑成员。</p>}
          </div>}
          {projectSection === 'reports' && <div className="project-workspace-form">
            <h3 className="campaign-mobile-title">思源日报与报告模板</h3>
            <p className="project-workspace-result">思源连接需先在桌面「设置 → 思源知识库」配置。请核对每篇日报日期，思源文档创建时间可能不同于日报日期。生成时正文会发送给项目群主所用模型，并在独立报告话题留痕；搜索结果只有经你确认后才会进入项目来源。</p>
            <label><span>搜索日报</span><input data-testid="mobile-report-query" value={reportQuery} onChange={(e) => setReportQuery(e.target.value)} placeholder="标题或内容关键词" /></label>
            <button type="button" data-testid="mobile-report-search" disabled={reportBusy || reportQuery.trim().length < 2} onClick={() => void searchReportSources()}>搜索思源日报</button>
            {reportHits.map((hit) => <div className="campaign-mobile-delivery" key={hit.docId}><span><strong>{hit.title}</strong><br />{hit.path}<br />{hit.snippet}<br /><label>日报日期 <input type="date" aria-label={`${hit.title} 的日报日期`} value={reportDates[hit.docId] || ''} onChange={(e) => setReportDates((dates) => ({ ...dates, [hit.docId]: e.target.value }))} /></label></span><input type="checkbox" aria-label={`选择 ${hit.title}`} checked={reportSelected.includes(hit.docId)} onChange={(e) => setReportSelected((ids) => e.target.checked ? [...ids, hit.docId] : ids.filter((id) => id !== hit.docId))} /></div>)}
            {reportHits.length > 0 ? <button type="button" data-testid="mobile-report-confirm-sources" disabled={reportBusy || reportSelected.length === 0} onClick={() => void confirmReportSourcesOnPhone()}>确认所选日报来源</button> : null}
            {workspaceDraft.reportSources.map((source) => <div className="campaign-mobile-delivery" key={source.docId}><span>{source.reportDate} · {source.title} · {source.path}</span><button type="button" onClick={() => void removeReportSourceOnPhone(source.docId)}>移除</button></div>)}
            <label><span>模板</span><select data-testid="mobile-report-template-select" value={reportTemplateId} onChange={(e) => { const item = workspaceDraft.reportTemplates.find((template) => template.id === e.target.value); setReportTemplateId(item?.id || ''); setReportTemplateName(item?.name || ''); setReportPeriodType(item?.periodType || '季度'); setReportSections(item?.sections.join('\n') || '工作重点\n主要进展\n量化成果\n风险与下一步') }}><option value="">新模板</option>{workspaceDraft.reportTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.periodType}</option>)}</select></label>
            <label><span>模板名称</span><input data-testid="mobile-report-template-name" value={reportTemplateName} onChange={(e) => setReportTemplateName(e.target.value)} placeholder="员工工作总结" /></label>
            <label><span>周期类型（可扩展）</span><input data-testid="mobile-report-period" value={reportPeriodType} onChange={(e) => setReportPeriodType(e.target.value)} placeholder="月报 / 季报 / 年报" /></label>
            <label><span>栏目（每行一个）</span><textarea data-testid="mobile-report-sections" rows={4} value={reportSections} onChange={(e) => setReportSections(e.target.value)} /></label>
            <button type="button" data-testid="mobile-report-template-save" disabled={reportBusy || !reportTemplateName.trim() || !reportPeriodType.trim() || !reportSections.trim()} onClick={() => void saveReportTemplateOnPhone()}>保存报告模板</button>
            <div className="project-workspace-form"><label><span>统计开始日期</span><input data-testid="mobile-report-start" type="date" value={reportStartDate} onChange={(e) => setReportStartDate(e.target.value)} /></label><label><span>统计结束日期</span><input data-testid="mobile-report-end" type="date" value={reportEndDate} onChange={(e) => setReportEndDate(e.target.value)} /></label></div>
            <button type="button" className="btn-primary" data-testid="mobile-report-generate" disabled={reportBusy || !reportTemplateId || workspaceDraft.reportSources.length === 0 || reportStartDate > reportEndDate} onClick={() => void generateProjectReportOnPhone()}>{reportBusy ? '生成中…' : '生成报告草稿'}</button>
            {reportMessage ? <p className="project-workspace-result" role="status" data-testid="mobile-report-message">{reportMessage}</p> : null}
            {reportResult ? <details data-testid="mobile-report-result"><summary>{reportResult.path}</summary><pre>{reportResult.content}</pre></details> : null}
          </div>}
          {projectSection === 'tasks' && <div className="project-workspace-form">
            <h3 className="campaign-mobile-title">项目管理 · 任务</h3>
            <p className="project-workspace-result">设置期限、前置任务和验收标准；依赖未完成的任务不能标记完成。</p>
            <label><span>任务标题</span><input data-testid="mobile-project-task-title" value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} placeholder="例如：完成腕表呼叫联调" /></label>
            <label><span>截止日期</span><input data-testid="mobile-project-task-due" type="date" value={newTaskDue} onChange={(e) => setNewTaskDue(e.target.value)} /></label>
            <label><span>前置任务（可多选）</span><select multiple data-testid="mobile-project-task-dependencies" value={newTaskDepends} onChange={(e) => setNewTaskDepends(Array.from(e.currentTarget.selectedOptions, (option) => option.value))}>{projectTasks.map((task) => <option key={task.id} value={task.id}>{task.key} · {task.title}</option>)}</select></label>
            <label><span>验收标准</span><textarea rows={2} data-testid="mobile-project-task-criteria" value={newTaskCriteria} onChange={(e) => setNewTaskCriteria(e.target.value)} placeholder="完成条件与可核对结果" /></label>
            <button type="button" className="btn-primary" data-testid="mobile-project-task-create" disabled={workspaceSaving || !newTaskTitle.trim()} onClick={() => void saveProjectTask()}>创建项目任务</button>
            {projectTasks.map((task) => {
              const blocked = task.depends_on.some((id) => projectTasks.find((candidate) => candidate.id === id)?.status !== 'done')
              const daysLeft = task.due_at == null ? null : Math.ceil((new Date(task.due_at).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000)
              const risk = task.status === 'done' || task.status === 'cancelled' ? '' : blocked ? '风险：等待前置任务' : daysLeft !== null && daysLeft < 0 ? `风险：已逾期 ${-daysLeft} 天` : daysLeft !== null && daysLeft <= 3 ? `风险：${daysLeft === 0 ? '今天到期' : `${daysLeft} 天内到期`}` : ''
              return <div className="campaign-mobile-delivery" key={task.id} data-testid={`mobile-project-task-${task.id}`}><span><strong>{task.key} · {task.title}</strong><br />{task.due_at ? `截止 ${new Date(task.due_at).toLocaleDateString('zh-CN')}` : '未设期限'} · {blocked ? '等待前置任务' : task.status}{risk ? <><br /><strong data-testid={`mobile-project-task-risk-${task.id}`}>{risk}</strong></> : null}{task.acceptance_criteria ? ` · 验收：${task.acceptance_criteria}` : ''}</span><select aria-label={`${task.key} 状态`} value={task.status} disabled={workspaceSaving || (blocked && task.status !== 'done')} onChange={(e) => void saveProjectTask(task, e.target.value)}><option value="todo">待办</option><option value="in_progress">进行中</option><option value="in_review">待验收</option><option value="done">已完成</option><option value="cancelled">已取消</option></select></div>
            })}
          </div>}
          {projectSection === 'assets' && <div className="project-workspace-form">
            <h4>项目素材库</h4>
            <p className="project-workspace-result">真实素材、授权截图与生成示意图分别标记；文件需先放入项目工作区，截图先脱敏。</p>
            <label><span>扫描候选目录（工作区相对路径）</span><input data-testid="mobile-asset-scan-directory" value={assetScanDirectory} onChange={(e) => setAssetScanDirectory(e.target.value)} /></label>
            <button type="button" disabled={workspaceSaving || !assetScanDirectory.trim()} data-testid="mobile-asset-scan" onClick={() => void scanProjectAssetsOnPhone()}>扫描目录中的新素材</button>
            <label><span>当前页面截图场景</span><input data-testid="mobile-asset-capture-title" value={captureDraft.title} onChange={(e) => setCaptureDraft((d) => ({ ...d, title: e.target.value }))} placeholder="护士接收腕表呼叫" /></label>
            <label><span>所属功能</span><input data-testid="mobile-asset-capture-feature" value={captureDraft.feature} onChange={(e) => setCaptureDraft((d) => ({ ...d, feature: e.target.value }))} /></label>
            <label><input type="checkbox" checked={captureDraft.fullPage} onChange={(e) => setCaptureDraft((d) => ({ ...d, fullPage: e.target.checked }))} />截取完整页面</label>
            <label><input type="checkbox" data-testid="mobile-asset-capture-consent" checked={captureDraft.redactionConfirmed} onChange={(e) => setCaptureDraft((d) => ({ ...d, redactionConfirmed: e.target.checked }))} />已获演示授权并检查/遮挡患者信息</label>
            <button type="button" disabled={workspaceSaving || !captureDraft.title.trim() || !captureDraft.redactionConfirmed} data-testid="mobile-asset-capture" onClick={() => void captureProjectScreenshotOnPhone()}>截取电脑当前内置浏览器页面</button>
            <label><span>素材名称</span><input data-testid="mobile-asset-title" value={assetDraft.title} onChange={(e) => setAssetDraft((d) => ({ ...d, title: e.target.value }))} /></label>
            <label><span>工作区相对路径</span><input data-testid="mobile-asset-path" value={assetDraft.path} onChange={(e) => setAssetDraft((d) => ({ ...d, path: e.target.value }))} placeholder="产品资料/腕表正面.png" /></label>
            <label><span>所属功能</span><input data-testid="mobile-asset-feature" value={assetDraft.feature} onChange={(e) => setAssetDraft((d) => ({ ...d, feature: e.target.value }))} /></label>
            <label><span>类型</span><select data-testid="mobile-asset-kind" value={assetDraft.kind} onChange={(e) => setAssetDraft((d) => ({ ...d, kind: e.target.value as typeof d.kind }))}><option value="image">图片</option><option value="video">视频</option><option value="document">文档</option><option value="demo_url">演示地址</option></select></label>
            <label><span>来源</span><select data-testid="mobile-asset-source" value={assetDraft.source} onChange={(e) => setAssetDraft((d) => ({ ...d, source: e.target.value as typeof d.source }))}><option value="user_provided">用户提供</option><option value="authorized_screenshot">授权系统截图</option><option value="generated_illustration">生成示意图</option><option value="demo_material">演示素材</option></select></label>
            <label><span>来源说明</span><input data-testid="mobile-asset-source-note" value={assetDraft.sourceNote} onChange={(e) => setAssetDraft((d) => ({ ...d, sourceNote: e.target.value }))} /></label>
            <label><input type="checkbox" checked={assetDraft.isReal} onChange={(e) => setAssetDraft((d) => ({ ...d, isReal: e.target.checked }))} />真实产品素材</label>
            <button type="button" disabled={workspaceSaving || !assetDraft.title.trim() || !assetDraft.path.trim()} data-testid="mobile-asset-register" onClick={() => void registerAssetOnPhone()}>登记素材</button>
            {workspaceDraft.assets.map((asset) => <div className="campaign-mobile-delivery" key={asset.id} data-testid={`mobile-asset-${asset.id}`}><span>{asset.title} · {{ image: '图片', video: '视频', document: '文档', demo_url: '演示地址' }[asset.kind]} · {asset.feature || '通用'} · {asset.source === 'unverified_candidate' ? '扫描候选·来源待核实' : asset.source === 'generated_illustration' ? '生成示意图' : asset.source === 'authorized_screenshot' ? '授权截图' : asset.isReal ? '真实素材' : '素材'} · {asset.path}{asset.sourceNote ? ` · 来源：${asset.sourceNote}` : ''} · {asset.confirmed ? '已确认' : '待确认'}</span>{!asset.confirmed ? <button type="button" onClick={() => void reviewAssetOnPhone(asset.id, true)}>确认可用</button> : <button type="button" onClick={() => void reviewAssetOnPhone(asset.id, false)}>撤销确认</button>}</div>)}
          </div>}
          {projectSection === 'campaigns' && <div className="project-workspace-form">
            <h3 className="campaign-mobile-title">宣传选题与成品</h3>
            <p className="project-workspace-result">方向确认、制作任务和成品验收分开记录。只有当前方向已确认且待补素材清零，才可创建制作任务。</p>
            <label><span>成果线</span><select data-testid="mobile-campaign-kind" value={campaignDraft.kind} onChange={(e) => setCampaignDraft((draft) => ({ ...draft, kind: e.target.value as CampaignKind }))}><option value="feature_video">单功能视频</option><option value="system_deck">完整系统介绍 PPT</option></select></label>
            <label><span>选题标题</span><input data-testid="mobile-campaign-title" value={campaignDraft.title} onChange={(e) => setCampaignDraft((draft) => ({ ...draft, title: e.target.value }))} placeholder="例如：腕表让护士不错过病房呼叫" /></label>
            {campaignDraft.kind === 'feature_video' ? <label><span>具体功能</span><input data-testid="mobile-campaign-feature" value={campaignDraft.feature} onChange={(e) => setCampaignDraft((draft) => ({ ...draft, feature: e.target.value }))} placeholder="例如：腕表病房呼叫" /></label> : null}
            <label><span>一线医护使用场景</span><textarea rows={2} data-testid="mobile-campaign-story" value={campaignDraft.story} onChange={(e) => setCampaignDraft((draft) => ({ ...draft, story: e.target.value }))} placeholder="谁在什么时刻遇到什么问题，如何使用" /></label>
            <label><span>传播渠道（每行一个）</span><textarea rows={2} data-testid="mobile-campaign-channels" value={campaignDraft.channels.join('\n')} onChange={(e) => setCampaignDraft((draft) => ({ ...draft, channels: e.target.value.split('\n') }))} placeholder="微信私聊\n渠道群转发\n现场讲解" /></label>
            <label><span>核心卖点（每行一个）</span><textarea rows={3} data-testid="mobile-campaign-points" value={campaignDraft.sellingPoints.join('\n')} onChange={(e) => setCampaignDraft((draft) => ({ ...draft, sellingPoints: e.target.value.split('\n') }))} placeholder="仅填写资料能支持的产品事实" /></label>
            <label><span>待补素材（每行一个）</span><textarea rows={2} data-testid="mobile-campaign-materials" value={campaignDraft.materialsNeeded.join('\n')} onChange={(e) => setCampaignDraft((draft) => ({ ...draft, materialsNeeded: e.target.value.split('\n') }))} placeholder="腕表实拍 / 已脱敏界面截图 / 接口说明" /></label>
            <button type="button" className="btn-primary" data-testid="mobile-campaign-create" disabled={workspaceSaving} onClick={() => void createCampaignOnPhone()}>{editingCampaignId ? '保存为新选题版本' : '创建待确认选题'}</button>
            {editingCampaignId ? <button type="button" data-testid="mobile-campaign-edit-cancel" onClick={() => setEditingCampaignId('')}>取消编辑</button> : null}
            {workspaceDraft.campaigns.map((campaign) => (
              <article className="campaign-mobile-card" key={campaign.id} data-testid={`mobile-campaign-${campaign.id}`}>
                <strong>{campaign.kind === 'system_deck' ? '完整系统 PPT' : '单功能视频'} · {campaign.title}</strong>
                <span>方向 v{campaign.revision} · {campaign.approvedRevision === campaign.revision ? '已确认' : '待确认'}</span>
                <p>功能：{campaign.feature || '完整系统'}；场景：{campaign.story || '未填写'}</p>
                <p>核心卖点：{campaign.sellingPoints.join('；')}</p>
                <p>{campaign.materialsNeeded.length ? `待补素材：${campaign.materialsNeeded.join('、')}` : '素材缺口已清零'}</p>
                {campaign.materialsNeeded.map((need) => <div className="campaign-mobile-actions" key={need} data-testid={`mobile-campaign-material-${campaign.id}`}><span>补齐：{need}</span><select aria-label={`${need} 匹配素材`} data-testid={`mobile-campaign-asset-select-${campaign.id}`} value={campaignAssetChoices[`${campaign.id}:${need}`] || ''} onChange={(e) => setCampaignAssetChoices((choices) => ({ ...choices, [`${campaign.id}:${need}`]: e.target.value }))}><option value="">选择已确认素材</option>{workspaceDraft.assets.filter((asset) => asset.confirmed && (!asset.feature || !campaign.feature || asset.feature === campaign.feature)).map((asset) => <option key={asset.id} value={asset.id}>{asset.title} · {asset.source === 'generated_illustration' ? '示意图' : asset.isReal ? '真实素材' : '素材'}</option>)}</select><button type="button" disabled={!campaignAssetChoices[`${campaign.id}:${need}`] || workspaceSaving} data-testid={`mobile-campaign-material-resolve-${campaign.id}`} onClick={() => void resolveCampaignMaterialOnPhone(campaign, need)}>使用该素材</button></div>)}
                {campaign.directionFeedback ? <p>方向意见：{campaign.directionFeedback}</p> : null}
                <button type="button" data-testid={`mobile-campaign-edit-${campaign.id}`} onClick={() => editCampaignOnPhone(campaign)}>编辑并提交新版本</button>
                {campaign.approvedRevision !== campaign.revision ? <>
                  <input aria-label={`${campaign.title} 审阅意见`} data-testid={`mobile-campaign-feedback-${campaign.id}`} value={campaignFeedback[campaign.id] || ''} onChange={(e) => setCampaignFeedback((current) => ({ ...current, [campaign.id]: e.target.value }))} placeholder="退回时填写修改意见" />
                  <div className="campaign-mobile-actions"><button type="button" data-testid={`mobile-campaign-request-changes-${campaign.id}`} onClick={() => void reviewCampaignOnPhone(campaign, 'changes_requested')}>退回修改</button><button type="button" data-testid={`mobile-campaign-approve-${campaign.id}`} onClick={() => void reviewCampaignOnPhone(campaign, 'approve')}>确认方向</button></div>
                </> : null}
                {campaign.approvedRevision === campaign.revision && !campaign.productionTaskId ? <button type="button" disabled={workspaceSaving || campaign.materialsNeeded.length > 0} data-testid={`mobile-campaign-task-${campaign.id}`} onClick={() => void makeCampaignTaskOnPhone(campaign)}>创建制作任务</button> : null}
                {campaign.productionTaskId ? <span>已关联任务 {campaign.productionTaskId}</span> : null}
                {campaign.approvedRevision === campaign.revision ? <>
                  <input aria-label={`${campaign.title} 成品路径`} data-testid={`mobile-campaign-path-${campaign.id}`} value={campaignPaths[campaign.id] || ''} onChange={(e) => setCampaignPaths((current) => ({ ...current, [campaign.id]: e.target.value }))} placeholder="工作区相对路径，如 宣传/腕表呼叫/v1.mp4" />
                  <button type="button" disabled={workspaceSaving || !canStartCampaignProduction(campaign) || !campaign.productionTaskId} data-testid={`mobile-campaign-submit-${campaign.id}`} onClick={() => void submitCampaignOnPhone(campaign)}>提交新版本验收</button>
                </> : null}
                {campaign.deliveries.map((delivery) => <div className="campaign-mobile-delivery" key={delivery.id} data-testid={`mobile-campaign-delivery-${delivery.id}`}>
                  <span>v{delivery.revision} · {delivery.path} · {delivery.status === 'in_review' ? '待验收' : delivery.status === 'accepted' ? '已验收' : '要求修改'}</span>
                  {delivery.feedback ? <p>意见：{delivery.feedback}</p> : null}
                  {delivery.status === 'in_review' ? <>
                    <input aria-label={`v${delivery.revision} 验收意见`} data-testid={`mobile-delivery-feedback-${delivery.id}`} value={campaignFeedback[delivery.id] || ''} onChange={(e) => setCampaignFeedback((current) => ({ ...current, [delivery.id]: e.target.value }))} placeholder="要求修改时填写意见" />
                    <div className="campaign-mobile-actions"><button type="button" data-testid={`mobile-delivery-request-changes-${delivery.id}`} onClick={() => void reviewDeliveryOnPhone(campaign, delivery.id, 'changes_requested')}>要求修改</button><button type="button" data-testid={`mobile-delivery-accept-${delivery.id}`} onClick={() => void reviewDeliveryOnPhone(campaign, delivery.id, 'accepted')}>验收通过</button></div>
                  </> : null}
                </div>)}
              </article>
            ))}
          </div>}
        </section>
      )}

      {screen === 'file' && filePreview && (
        <section className="fileview wechat-fileview" data-testid="file-preview">
          <header className="bar wechat-bar">
            <button type="button" className="btn-nav-back" onClick={() => setScreen(fileReturnScreen)}>
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
                    {busy ? pairProgress?.stage === 'confirming' ? '等待电脑确认…' : '正在绑定…' : '使用粘贴内容绑定这台电脑'}
                  </button>
                  <PairingNotice progress={pairProgress} />
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

          {bound && <button type="button" className="wechat-cell-btn" data-testid="mobile-memory-settings" onClick={() => setMemorySettingsOpen(true)}>记忆与公开规则</button>}
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
            <span>聊天</span>
          </button>
          <button
            type="button"
            className={tab === 'contacts' ? 'on' : ''}
            data-testid="tab-contacts"
            onClick={() => setTab('contacts')}
          >
            <div className="wechat-tab-icon">
              {tab === 'contacts' ? (
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.96 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 11a4 4 0 1 0-8 0" /><circle cx="12" cy="7" r="4" /><path d="M3 20c0-3.2 3.8-5 9-5s9 1.8 9 5" /></svg>
              )}
            </div>
            <span>通讯录</span>
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
