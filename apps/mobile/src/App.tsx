import { Capacitor } from '@capacitor/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IPC, extractThinkTags, mergeReasoning } from '@jeff/core'
import type { AgentInfo, ChatMsg, FsDirEntry, GroupMessage, ProjectInfo } from '@jeff/core'
import type { RemoteStreamFrame } from '@jeff/core/remote'
import { consumeBack } from './backstack'
import { Markdown } from './Markdown'
import { Native, PhoneLink, mergeStream, shrinkImage } from './session'

type Tab = 'messages' | 'me'
type Screen = 'list' | 'chat' | 'dirs'
type ChatTarget = { kind: 'agent'; id: string; name: string } | { kind: 'group'; id: string; name: string }

const phone = new PhoneLink()
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

function formatWeChatTime(ts?: number): string {
  if (!ts) return ''
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

function WeChatAvatar({ kind, name, size = 48 }: { kind: 'user' | 'agent' | 'group'; name: string; size?: number }) {
  const initial = (name || '').trim().slice(0, 1).toUpperCase() || 'J'
  const isGroup = kind === 'group'
  const isUser = kind === 'user'

  return (
    <div
      className={`wechat-avatar ${isUser ? 'user' : isGroup ? 'group' : 'agent'}`}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
    >
      {isUser ? (
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
    </div>
  )
}

function ReasoningView({ reasoning, live }: { reasoning?: string | string[]; live?: boolean }) {
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
        {!open && preview ? <span className="wechat-reasoning-preview">{preview}</span> : null}
        <span className={`wechat-arrow ${open ? 'down' : ''}`}>›</span>
      </button>
      {open ? (
        <div className="wechat-reasoning-content">
          <pre>{text}</pre>
        </div>
      ) : null}
    </div>
  )
}

type ToolItem = { tool: string; status?: string; output?: string; error?: string }

function AssistantText(props: { text: string; reasoning?: string | string[]; tools?: ToolItem[]; live?: boolean }): React.JSX.Element {
  const parsed = useMemo(() => extractThinkTags(props.text), [props.text])
  const reasoning = useMemo(() => mergeReasoning(props.reasoning, parsed.reasoning), [props.reasoning, parsed])
  return (
    <>
      {reasoning ? <ReasoningView reasoning={reasoning} live={props.live} /> : null}
      {props.tools && props.tools.length > 0 ? <ToolsView tools={props.tools} /> : null}
      {parsed.text ? <Markdown text={parsed.text} live={props.live} /> : props.live && !reasoning ? <p>…</p> : null}
    </>
  )
}

function ToolsView({ tools }: { tools?: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  if (!tools || tools.length === 0) return null

  const running = tools.find((t) => t.status === 'running')
  const failed = tools.find((t) => t.status === 'error' || t.error)
  const statusLabel = running ? '运行中…' : failed ? '执行失败' : '完成'
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
        <div className="wechat-tools-body">
          {tools.map((t, idx) => (
            <div key={idx} className="wechat-tool-row">
              <div className="wechat-tool-head">
                <span className="wechat-tool-name">{t.tool}</span>
                <span className={`wechat-tool-tag ${t.status || ''}`}>
                  {t.status === 'running' ? '运行中' : t.status === 'error' ? '失败' : '完成'}
                </span>
              </div>
              {t.error ? <pre className="wechat-tool-err">{t.error}</pre> : null}
              {t.output ? <pre className="wechat-tool-out">{t.output.length > 240 ? t.output.slice(0, 240) + '…' : t.output}</pre> : null}
            </div>
          ))}
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
  const [stream, setStream] = useState<{ text: string; reasoning: string; tools?: Array<{ tool: string; status?: string }> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const offlineRef = useRef(false)
  const markOffline = (v: boolean) => {
    offlineRef.current = v
    setOffline(v)
  }
  const [syncedAt, setSyncedAt] = useState(0)
  const [plus, setPlus] = useState(false)
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([])
  const [dirs, setDirs] = useState<{ dir: string; parent?: string; entries: FsDirEntry[] } | null>(null)
  const [computers, setComputers] = useState(phone.desktops)
  const [activeId, setActiveId] = useState('')
  const [, bump] = useState(0)
  const [recentMap, setRecentMap] = useState<Record<string, { text: string; time: number }>>({})
  const bubblesEndRef = useRef<HTMLDivElement>(null)

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
    if (plusRef.current) {
      setPlus(false)
      return
    }
    if (screenRef.current === 'dirs') {
      setScreen('chat')
      return
    }
    if (screenRef.current === 'chat') {
      setScreen('list')
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
          void loadHistory(current)
          return
        }
        setStream((prev) => {
          const merged = mergeStream(prev || { text: '', reasoning: '' }, frame)
          return { text: merged.text, reasoning: merged.reasoning, tools: frame.tools }
        })
      }
      if (ev.what === 'chat-updated' || ev.what === 'group-updated') {
        const current = targetRef.current
        if (current) void loadHistory(current)
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
      void openChat({ kind, id: note.id, name: note.title || '会话' })
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
    if (screen === 'chat') {
      bubblesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
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
    if (cachedA) {
      try { setAgents(JSON.parse(cachedA) as AgentInfo[]) } catch {}
    }
    if (cachedP) {
      try { setProjects(JSON.parse(cachedP) as ProjectInfo[]) } catch {}
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

  async function loadHistory(t: ChatTarget) {
    const id = phone.activeId
    const key = `history:${t.kind}:${t.id}`
    try {
      if (t.kind === 'agent') {
        const rows = await phone.invoke<ChatMsg[]>(IPC.chatHistory, { agentId: t.id })
        setMessages(rows)
        await cachePut(id, key, JSON.stringify(rows))
        const last = rows[rows.length - 1]
        if (last) setRecentMap((prev) => ({ ...prev, [`agent:${t.id}`]: { text: last.text, time: last.time } }))
      } else {
        const r = await phone.invoke<{ threadId: string; messages: GroupMessage[] } | GroupMessage[]>(IPC.groupHistory, { projectId: t.id })
        const rows = Array.isArray(r) ? r : r?.messages || []
        setMessages(rows)
        await cachePut(id, key, JSON.stringify(rows))
        const last = rows[rows.length - 1]
        if (last) setRecentMap((prev) => ({ ...prev, [`group:${t.id}`]: { text: last.text, time: last.time } }))
      }
      markOffline(false)
      setSyncedAt(Date.now())
    } catch {
      markOffline(true)
      const cached = await cacheGet(id, key)
      if (cached) {
        const raw = JSON.parse(cached) as ChatMsg[] | { messages?: ChatMsg[] }
        const rows = Array.isArray(raw) ? raw : raw?.messages || []
        setMessages(rows)
        const last = rows[rows.length - 1]
        if (last) setRecentMap((prev) => ({ ...prev, [`${t.kind}:${t.id}`]: { text: last.text, time: last.time } }))
      }
    }
  }

  async function openChat(t: ChatTarget) {
    setTarget(t)
    setScreen('chat')
    setStream(null)
    setMessages([])
    await loadHistory(t)
    try {
      if (t.kind === 'agent') {
        const r = await phone.invoke<{ sessions: Array<{ id: string; active?: boolean }> }>(IPC.sessionsList, { agentId: t.id })
        const current = r.sessions?.find((s) => s.active) || r.sessions?.[0]
        if (current) await phone.invoke(IPC.sessionActivate, { scope: 'private', agentId: t.id, sessionId: current.id })
      } else {
        const r = await phone.invoke<{ threads: Array<{ id: string; active?: boolean }> }>(IPC.groupThreadsList, { projectId: t.id })
        const current = r.threads?.find((s) => s.active) || r.threads?.[0]
        if (current) await phone.invoke(IPC.groupThreadActivate, { projectId: t.id, threadId: current.id })
      }
    } catch {
      // 历史已在页面上展示
    }
  }

  async function send() {
    if (!target || !draft.trim()) return
    const text = draft.trim()
    setDraft('')
    setBusy(true)
    setPlus(false)
    try {
      if (target.kind === 'agent') await phone.invoke(IPC.chatSend, { agentId: target.id, text })
      else await phone.invoke(IPC.groupSend, { projectId: target.id, text })
      await loadHistory(target)
    } catch (err) {
      setError((err as Error).message)
      setDraft(text)
    } finally {
      setBusy(false)
    }
  }

  async function sendImage(dataUrl: string) {
    if (!target) return
    setBusy(true)
    try {
      const image = await shrinkImage(dataUrl)
      const images = [image]
      if (target.kind === 'agent') await phone.invoke(IPC.chatSend, { agentId: target.id, text: draft.trim() || '（图片）', images })
      else await phone.invoke(IPC.groupSend, { projectId: target.id, text: draft.trim() || '（图片）', images })
      setDraft('')
      await loadHistory(target)
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
      const r = await phone.invoke<{ sessions: Array<{ id: string; title: string }> }>(IPC.sessionsList, { agentId: target.id })
      setSessions(r.sessions || [])
    } else {
      const r = await phone.invoke<{ threads: Array<{ id: string; title: string }> }>(IPC.groupThreadsList, { projectId: target.id })
      setSessions((r.threads || []).map((t) => ({ id: t.id, title: t.title })))
    }
    setPlus(true)
  }

  async function activateSession(sessionId: string) {
    if (!target) return
    if (target.kind === 'agent') await phone.invoke(IPC.sessionActivate, { scope: 'private', agentId: target.id, sessionId })
    else await phone.invoke(IPC.groupThreadActivate, { projectId: target.id, threadId: sessionId })
    setPlus(false)
    await loadHistory(target)
  }

  async function newSession() {
    if (!target) return
    if (target.kind === 'agent') await phone.invoke(IPC.chatNew, { agentId: target.id })
    else await phone.invoke(IPC.groupThreadNew, { projectId: target.id })
    setPlus(false)
    await loadHistory(target)
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
    setScreen('chat')
  }

  const rows = useMemo(() => {
    const items: Array<{ key: string; title: string; sub: string; time?: number; target: ChatTarget }> = []
    for (const a of agents) {
      const rec = recentMap[`agent:${a.id}`]
      items.push({
        key: `a:${a.id}`,
        title: a.name,
        sub: rec?.text ? (rec.text.length > 40 ? rec.text.slice(0, 40) + '…' : rec.text) : (a.description || '私聊会话'),
        time: rec?.time,
        target: { kind: 'agent', id: a.id, name: a.name },
      })
    }
    for (const p of projects) {
      const rec = recentMap[`group:${p.id}`]
      items.push({
        key: `g:${p.id}`,
        title: p.title,
        sub: rec?.text ? (rec.text.length > 40 ? rec.text.slice(0, 40) + '…' : rec.text) : (p.description || '项目群协作'),
        time: rec?.time,
        target: { kind: 'group', id: p.id, name: p.title },
      })
    }
    return items
  }, [agents, projects, recentMap])

  const peer = computers.get(activeId)
  const bound = computers.size > 0

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
            <svg viewBox="0 0 24 24" width="48" height="48" fill="#07c160">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
            </svg>
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
            <div className="banner wechat-offline-banner">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
              </svg>
              <span>电脑离线，当前为本地只读缓存{syncedAt ? ` (同步于 ${new Date(syncedAt).toLocaleTimeString()})` : ''}</span>
            </div>
          ) : null}
          {!bound ? (
            <section className="pair wechat-pair-panel" data-testid="pair-panel">
              <div className="pair-hero">
                <div className="pair-logo-wrap">
                  <svg viewBox="0 0 24 24" width="48" height="48" fill="#07c160">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                  </svg>
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
            <ul className="msgs wechat-list" data-testid="msg-list">
              {rows.map((row) => (
                <li key={row.key} className="wechat-item">
                  <button type="button" className="wechat-item-btn" onClick={() => void openChat(row.target)}>
                    <WeChatAvatar kind={row.target.kind} name={row.title} size={48} />
                    <div className="wechat-item-main">
                      <div className="wechat-item-top">
                        <b className="wechat-item-title">{row.title}</b>
                        {row.time ? <span className="wechat-time">{formatWeChatTime(row.time)}</span> : null}
                      </div>
                      <div className="wechat-item-bot">
                        <span className="wechat-item-sub">{row.sub}</span>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
              {rows.length === 0 ? <li className="empty">这台电脑上还没有会话</li> : null}
            </ul>
          )}
        </>
      )}

      {screen === 'chat' && target && (
        <section className="chat wechat-chat" data-testid="chat">
          <header className="bar wechat-bar wechat-chat-bar">
            <button type="button" className="btn-nav-back" data-testid="chat-back" onClick={() => setScreen('list')}>
              <span className="wechat-back-chevron">‹</span>
              <span className="wechat-back-text">返回</span>
            </button>
            <div className="wechat-chat-title">
              <b>{target.name}</b>
              {target.kind === 'group' ? <span className="wechat-group-tag">群聊</span> : null}
            </div>
            {target.kind === 'group' ? (
              <button type="button" className="btn-nav-action" data-testid="workspace" onClick={() => void openDirs()}>
                工作空间
              </button>
            ) : (
              <button type="button" className="btn-nav-action" onClick={() => (plus ? setPlus(false) : void loadSessions())}>
                会话
              </button>
            )}
          </header>
          <div className="bubbles wechat-bubbles" data-testid="bubbles">
            {messages.map((m) => {
              const isMe = m.role === 'user'
              return (
                <div key={m.id} className={`wechat-msg-row ${isMe ? 'me' : 'other'}`}>
                  {!isMe && (
                    <div className="wechat-msg-avatar">
                      <WeChatAvatar
                        kind={target.kind === 'group' ? 'group' : 'agent'}
                        name={'sender_name' in m && m.sender_name ? m.sender_name : target.name}
                        size={40}
                      />
                    </div>
                  )}
                  <div className="wechat-msg-content">
                    {!isMe && 'sender_name' in m && m.sender_name ? (
                      <span className="wechat-sender-name">{m.sender_name}</span>
                    ) : null}
                    <div className={isMe ? 'bubble me' : 'bubble'}>
                      {m.role === 'assistant' ? (
                        <AssistantText text={m.text} reasoning={m.reasoning} tools={m.tools} />
                      ) : (
                        <>
                          {!isMe && m.reasoning && m.reasoning.length > 0 ? <ReasoningView reasoning={m.reasoning} /> : null}
                          {!isMe && m.tools && m.tools.length > 0 ? <ToolsView tools={m.tools} /> : null}
                          {m.text ? <p>{m.text}</p> : null}
                        </>
                      )}
                      {m.images?.map((img, i) => (
                        <img key={i} src={img.dataUrl} alt="" />
                      ))}
                      {m.role !== 'assistant' && m.tools?.length ? (
                        <small className="tools">{m.tools.map((t) => t.tool).join(' · ')}</small>
                      ) : null}
                    </div>
                  </div>
                  {isMe && (
                    <div className="wechat-msg-avatar">
                      <WeChatAvatar kind="user" name="我" size={40} />
                    </div>
                  )}
                </div>
              )
            })}
            {stream ? (
              <div className="wechat-msg-row other" data-testid="stream">
                <div className="wechat-msg-avatar">
                  <WeChatAvatar kind={target.kind === 'group' ? 'group' : 'agent'} name={target.name} size={40} />
                </div>
                <div className="wechat-msg-content">
                  <div className="bubble">
                    <AssistantText text={stream.text} reasoning={stream.reasoning} tools={stream.tools} live />
                  </div>
                </div>
              </div>
            ) : null}
            <div ref={bubblesEndRef} />
          </div>
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
          <form
            className="composer wechat-composer"
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
          >
            <button
              type="button"
              className="wechat-composer-plus"
              data-testid="plus"
              onClick={() => (plus ? setPlus(false) : void loadSessions())}
            >
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
              </svg>
            </button>
            <input
              data-testid="chat-input"
              value={draft}
              placeholder={offline ? '电脑离线，不能发送' : '发消息'}
              disabled={offline}
              onChange={(e) => setDraft(e.target.value)}
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
            <button type="button" className="btn-nav-back" onClick={() => setScreen('chat')}>
              <span className="wechat-back-chevron">‹</span>
              <span className="wechat-back-text">返回</span>
            </button>
            <b>选择电脑上的目录</b>
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

      {tab === 'me' && screen === 'list' && (
        <section className="me wechat-me" data-testid="me">
          <header className="bar wechat-bar">
            <b>我与设备</b>
            <span style={{ width: 48 }} />
          </header>

          <div className="wechat-me-profile">
            <WeChatAvatar kind="user" name="我" size={56} />
            <div className="wechat-me-info">
              <h3>我的手机</h3>
              <p>ID: {phone.me.id.slice(0, 10)}…</p>
            </div>
          </div>

          <div className="wechat-section-title">已绑定电脑</div>
          <ul className="wechat-me-computers">
            {[...computers.values()].map((c) => {
              const isCurrent = c.id === activeId
              return (
                <li key={c.id} className={`wechat-comp-item ${isCurrent ? 'active' : ''}`}>
                  <button
                    type="button"
                    onClick={() => {
                      phone.select(c.id)
                      refreshPeers()
                      void loadLists()
                      setTab('messages')
                    }}
                  >
                    <div className="wechat-comp-main">
                      <i className={c.online ? 'dot' : 'dot off'} />
                      <div className="wechat-comp-names">
                        <b>{c.name}</b>
                        <small>{c.online ? '在线（点击切换为主控）' : '离线'}</small>
                      </div>
                    </div>
                    {isCurrent ? <span className="wechat-comp-badge">当前使用</span> : <span className="wechat-comp-switch">切换 ›</span>}
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="wechat-section-title">连接操作</div>
          <div className="wechat-card-group">
            {bound ? (
              <button type="button" className="wechat-cell-btn" data-testid="pair-another" onClick={() => setAdding((v) => !v)}>
                <span>➕ 绑定另一台电脑</span>
                <span>›</span>
              </button>
            ) : null}
            {adding || !bound ? (
              <div className="wechat-me-pair-box">
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
                    📷 扫码绑定电脑
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
                  {busy ? '正在绑定…' : '使用粘贴内容绑定这台电脑'}
                </button>
              </div>
            ) : null}

            {bound ? (
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
                <span>解除当前电脑绑定</span>
                <span>›</span>
              </button>
            ) : null}
          </div>

          <div className="wechat-section-title">后台保活与安全</div>
          <div className="wechat-card-group">
            {Capacitor.isNativePlatform() ? (
              <button type="button" className="wechat-cell-btn" onClick={() => void Native.openBattery()}>
                <span>🔋 忽略电池优化（防被杀后台）</span>
                <span>设置 ›</span>
              </button>
            ) : null}
            <button type="button" className="wechat-cell-btn" onClick={() => setLocked(true)}>
              <span>🔒 立即锁屏保护</span>
              <span>锁定 ›</span>
            </button>
          </div>
          <p className="hint wechat-hint">
            华为/荣耀等机型请在「系统设置 → 应用启动管理」中，将 Jeff 设为「手动管理」并允许「允许后台活动」，以防熄屏后连接被系统阻断。
          </p>

          <button type="button" className="btn-back-msgs" onClick={() => setTab('messages')}>
            返回会话列表
          </button>
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
    </main>
  )
}
