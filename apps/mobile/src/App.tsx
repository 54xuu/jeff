import { Capacitor } from '@capacitor/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IPC } from '@jeff/core'
import type { AgentInfo, ChatMsg, FsDirEntry, GroupMessage, ProjectInfo } from '@jeff/core'
import type { RemoteStreamFrame } from '@jeff/core/remote'
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
    if (Capacitor.isNativePlatform()) {
      void Native.addListener('resume', () => {
        void openFromNote()
      }).then((handle) => {
        resumeHandle = handle
      })
    }
    return () => {
      off()
      document.removeEventListener('visibilitychange', onVis)
      void resumeHandle?.remove()
    }
    // boot once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function boot() {
    if (Capacitor.isNativePlatform()) {
      try {
        const unlocked = await Native.unlock()
        if (unlocked.ok || unlocked.skipped) setLocked(false)
      } catch (err) {
        setUnlockError((err as Error).message || '解锁未通过，请点击下方按钮重试')
      }
      const dbg = await Native.readDebugPair().catch(() => ({ text: '' }))
      if (dbg.text) await acceptPair(dbg.text)
    } else {
      setLocked(false)
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
    let failed = false
    try {
      const [a, p] = await Promise.all([phone.invoke<AgentInfo[]>(IPC.agentsList), phone.invoke<ProjectInfo[]>(IPC.projectsList)])
      setAgents(a)
      setProjects(p)
      markOffline(false)
      setSyncedAt(Date.now())
      await cachePut(id, 'agents', JSON.stringify(a))
      await cachePut(id, 'projects', JSON.stringify(p))
    } catch {
      failed = true
      const a = await cacheGet(id, 'agents')
      const p = await cacheGet(id, 'projects')
      if (a) setAgents(JSON.parse(a) as AgentInfo[])
      if (p) setProjects(JSON.parse(p) as ProjectInfo[])
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
      } else {
        const rows = await phone.invoke<GroupMessage[]>(IPC.groupHistory, { projectId: t.id })
        setMessages(rows)
        await cachePut(id, key, JSON.stringify(rows))
      }
      markOffline(false)
      setSyncedAt(Date.now())
    } catch {
      markOffline(true)
      const cached = await cacheGet(id, key)
      if (cached) setMessages(JSON.parse(cached) as ChatMsg[])
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
      // 历史已经在页面上；桌面没切过去不挡住这次打开
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
    const items: Array<{ key: string; title: string; sub: string; target: ChatTarget }> = []
    for (const a of agents) items.push({ key: `a:${a.id}`, title: a.name, sub: a.description || '私聊', target: { kind: 'agent', id: a.id, name: a.name } })
    for (const p of projects) items.push({ key: `g:${p.id}`, title: p.title, sub: '项目群', target: { kind: 'group', id: p.id, name: p.title } })
    return items
  }, [agents, projects])

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
        <h1>Jeff</h1>
        <p>解锁后才能看会话</p>
        <button
          type="button"
          data-testid="unlock"
          disabled={authenticating}
          onClick={() => void requestUnlock()}
        >
          {authenticating ? '正在调起解锁…' : '指纹或锁屏密码解锁'}
        </button>
        {unlockError ? <p className="err">{unlockError}</p> : null}
      </main>
    )
  }

  return (
    <main className="shell">
      {screen === 'list' && tab === 'messages' && (
        <>
          <header className="bar">
            <button type="button" className="bar-title" data-testid="computer-switch" onClick={() => setTab('me')}>
              <i className={!bound || offline ? 'dot off' : 'dot'} />
              {peer?.name || '未绑定电脑'}
            </button>
          </header>
          {offline ? <p className="banner">电脑离线，以下是只读缓存{syncedAt ? `，最后同步于 ${new Date(syncedAt).toLocaleString()}` : ''}</p> : null}
          {!bound ? (
            <section className="pair" data-testid="pair-panel">
              <h1>绑定电脑</h1>
              <p className="hint">在电脑 Jeff 的「设置 → 远程控制」里点绑定手机，然后用下方按钮扫码。</p>
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
                  📷 扫码绑定
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
            <ul className="msgs" data-testid="msg-list">
              {rows.map((row) => (
                <li key={row.key}>
                  <button type="button" onClick={() => void openChat(row.target)}>
                    <b>{row.title}</b>
                    <span>{row.sub}</span>
                  </button>
                </li>
              ))}
              {rows.length === 0 ? <li className="empty">这台电脑上还没有会话</li> : null}
            </ul>
          )}
        </>
      )}

      {screen === 'chat' && target && (
        <section className="chat" data-testid="chat">
          <header className="bar">
            <button type="button" data-testid="chat-back" onClick={() => setScreen('list')}>
              返回
            </button>
            <b>{target.name}</b>
            {target.kind === 'group' ? (
              <button type="button" data-testid="workspace" onClick={() => void openDirs()}>
                工作空间
              </button>
            ) : (
              <span />
            )}
          </header>
          <div className="bubbles" data-testid="bubbles">
            {messages.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'bubble me' : 'bubble'}>
                {'sender_name' in m && m.sender_name ? <small>{m.sender_name}</small> : null}
                <p>{m.text}</p>
                {m.images?.map((img, i) => (
                  <img key={i} src={img.dataUrl} alt="" />
                ))}
                {m.tools?.length ? <small className="tools">{m.tools.map((t) => t.tool).join(' · ')}</small> : null}
              </div>
            ))}
            {stream ? (
              <div className="bubble" data-testid="stream">
                {stream.tools?.length ? <small className="tools">{stream.tools.map((t) => `${t.tool}${t.status ? `(${t.status})` : ''}`).join(' · ')}</small> : null}
                <p>{stream.text || '…'}</p>
              </div>
            ) : null}
          </div>
          {error ? <p className="err">{error}</p> : null}
          {plus ? (
            <div className="plus" data-testid="plus-panel">
              <button type="button" data-testid="new-session" onClick={() => void newSession()}>
                新建会话
              </button>
              {Capacitor.isNativePlatform() ? (
                <button
                  type="button"
                  data-testid="pick-image"
                  onClick={() => {
                    void Native.pickImage().then((r) => sendImage(r.dataUrl))
                  }}
                >
                  相册
                </button>
              ) : (
                <label className="file">
                  相册
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
              <ul>
                {sessions.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => void activateSession(s.id)}>
                      {s.title || s.id}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
          >
            <button type="button" data-testid="plus" onClick={() => (plus ? setPlus(false) : void loadSessions())}>
              +
            </button>
            <input data-testid="chat-input" value={draft} placeholder={offline ? '电脑离线，不能发送' : '发消息'} disabled={offline} onChange={(e) => setDraft(e.target.value)} />
            {stream || busy ? (
              <button type="button" data-testid="chat-stop" onClick={() => void stop()}>
                停止
              </button>
            ) : (
              <button type="submit" data-testid="chat-send" disabled={offline || !draft.trim()}>
                发送
              </button>
            )}
          </form>
        </section>
      )}

      {screen === 'dirs' && dirs && (
        <section className="dirs" data-testid="dir-picker">
          <header className="bar">
            <button type="button" onClick={() => setScreen('chat')}>
              返回
            </button>
            <b>选择电脑上的目录</b>
          </header>
          <p className="path">{dirs.dir || '从这里开始'}</p>
          <ul>
            {dirs.parent ? (
              <li>
                <button type="button" onClick={() => void openDirs(dirs.parent)}>
                  上级目录
                </button>
              </li>
            ) : null}
            {dirs.entries.map((e) => (
              <li key={e.path}>
                <button type="button" onClick={() => void openDirs(e.path)}>
                  {e.name}
                </button>
                <button type="button" data-testid={`use-${e.name}`} onClick={() => void chooseDir(e.path)}>
                  用这个
                </button>
              </li>
            ))}
          </ul>
          <form
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
        <section className="me" data-testid="me">
          <header className="bar">
            <b>我</b>
          </header>
          <ul className="msgs">
            {[...computers.values()].map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    phone.select(c.id)
                    refreshPeers()
                    void loadLists()
                    setTab('messages')
                  }}
                >
                  <b>{c.name}</b>
                  <span>{c.online ? '在线' : '离线'}</span>
                </button>
              </li>
            ))}
          </ul>
          {bound ? (
            <button type="button" data-testid="pair-another" onClick={() => setAdding((v) => !v)}>
              再绑定一台电脑
            </button>
          ) : null}
          {adding ? (
            <>
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
                  📷 扫码绑定这台电脑
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
            </>
          ) : null}
          {bound ? (
            <button
              type="button"
              data-testid="unbind"
              onClick={() => {
                phone.unbind()
                refreshPeers()
                setAgents([])
                setProjects([])
              }}
            >
              解除当前电脑的绑定
            </button>
          ) : null}
          <p className="hint">华为手机请到「设置 → 应用启动管理」，把 Jeff 改成手动管理，并允许后台活动。否则熄屏大约二十分钟后，系统会停掉前台服务。</p>
          {Capacitor.isNativePlatform() ? (
            <button type="button" onClick={() => void Native.openBattery()}>
              打开电池优化设置
            </button>
          ) : null}
          <button type="button" onClick={() => setTab('messages')}>
            返回消息
          </button>
        </section>
      )}

      {screen === 'list' && (
        <nav className="tabs">
          <button type="button" className={tab === 'messages' ? 'on' : ''} data-testid="tab-messages" onClick={() => setTab('messages')}>
            消息
          </button>
          <button type="button" className={tab === 'me' ? 'on' : ''} data-testid="tab-me" onClick={() => setTab('me')}>
            我
          </button>
        </nav>
      )}
    </main>
  )
}
