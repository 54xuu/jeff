import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, extractThinkTags, mergeReasoning, type ContextPreviewInfo, type GroupMessage } from '@jeff/core'
import Avatar from './Avatar'
import GroupInfoDrawer from './GroupInfoDrawer'
import { Markdown } from './Markdown'
import { fmtFullTime } from '../format'
import { CopyButton } from './ui/CopyButton'
import { useImages, ImagePreviews, MsgImages, AssistantExtras, StreamingBubble, useAutoScroll, useComposerResize } from './ChatShared'
import ContextDrawer, { ContextUsageBar, fetchContextPreview } from './ContextDrawer'

/** 项目群聊天窗口（= 微信群） */
export default function GroupWindow(props: { projectId: string }): React.JSX.Element {
  const { projects, agents, groupMessages, groupThreads, sending, streaming, loadGroupHistory, sendGroup, stopGroup, settings, appInfo } = useStore()
  const project = projects.find((p) => p.id === props.projectId)
  const msgs = groupMessages[props.projectId] || []
  const curThread = groupThreads[props.projectId]
  const busy = !!sending[`group:${props.projectId}`]
  const rawStream = streaming[`group:${props.projectId}`]
  // 旧会话的流式/更新事件不串进当前会话（threadId 缺失时视为旧数据，保持原行为兼容）
  const streamStale = !!rawStream?.threadId && !!curThread && rawStream.threadId !== curThread
  const stream = streamStale ? undefined : rawStream
  const [draft, setDraft] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [ctxPreview, setCtxPreview] = useState<ContextPreviewInfo | null>(null)
  const [ctxLoading, setCtxLoading] = useState(false)
  const [compressing, setCompressing] = useState(false)
  const [ctxAgentId, setCtxAgentId] = useState<string | null>(null)
  const [members, setMembers] = useState<Array<{ agentId: string; name: string }>>([])
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  /** @ 候选的键盘高亮项（↑↓ 移动，Enter/Tab 选中） */
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const attachments = useImages()
  const bodyRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const composerResize = useComposerResize(composerRef)

  useEffect(() => {
    void loadGroupHistory(props.projectId)
    void api.invoke<Array<{ agent_id: string; role: string; name: string; avatar: string }>>(IPC.projectMembers, { projectId: props.projectId }).then((list) => {
      setMembers(list.map((m) => ({ agentId: m.agent_id, name: m.name || m.agent_id })))
      setCtxAgentId((cur) => {
        if (cur && list.some((m) => m.agent_id === cur)) return cur
        const fromStream = useStore.getState().streaming[`group:${props.projectId}`]?.agentId
        if (fromStream && list.some((m) => m.agent_id === fromStream)) return fromStream
        const leader = useStore.getState().projects.find((p) => p.id === props.projectId)?.leader_agent_id
        if (leader && list.some((m) => m.agent_id === leader)) return leader
        return list[0]?.agent_id ?? null
      })
    })
  }, [props.projectId])

  useEffect(() => {
    if (stream?.agentId) setCtxAgentId(stream.agentId)
  }, [stream?.agentId])

  // 贴底时才跟随滚动；流式期间用 RAF 合并，避免每 token 强制重排
  useAutoScroll(bodyRef, `${msgs.length}:${busy}:${stream?.text.length ?? 0}:${stream?.reasoning?.length ?? 0}`)

  const ctxAgent = agents.find((a) => a.id === ctxAgentId)
  const currentModel =
    ctxAgent?.model_provider && ctxAgent?.model_id
      ? { providerID: ctxAgent.model_provider, modelID: ctxAgent.model_id }
      : settings?.defaultModel || null

  useEffect(() => {
    if (!ctxAgentId) {
      setCtxPreview(null)
      return
    }
    let cancelled = false
    setCtxLoading(true)
    // catch/finally 兜底：IPC 失败也不能把界面留在永久「加载中」
    fetchContextPreview({ agentId: ctxAgentId, projectId: props.projectId, model: currentModel })
      .then((p) => {
        if (!cancelled) setCtxPreview(p)
      })
      .catch(() => {
        if (!cancelled) setCtxPreview(null)
      })
      .finally(() => {
        if (!cancelled) setCtxLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ctxAgentId, props.projectId, currentModel?.providerID, currentModel?.modelID, msgs.length, busy])

  // @ 自动补全：光标前最近的 @xx —— 只列本项目群成员（后端只路由成员，列全局 agent 会误导派发）
  const mentionCandidates = useMemo(() => {
    if (!mention) return []
    const memberIds = new Set(members.map((m) => m.agentId))
    return useStore
      .getState()
      .agents.filter((a) => memberIds.has(a.id) && a.name.includes(mention.query))
      .slice(0, 5)
  }, [mention, members])

  // 候选集变化（继续输入/@ 被删）后高亮回到第一项，避免索引指向已消失的成员
  useEffect(() => {
    setMentionIndex(0)
  }, [mention?.query, mentionCandidates.length])

  if (!project) return <div className="empty-hint">项目群不存在</div>

  // 群消息里的相对路径链接以群工作空间为基准（未配置 = Jeff 默认工作区）
  const defaultWorkspace = appInfo ? `${appInfo.dataDir}/workspace` : ''
  const workspaceDir = (project.workspace_dir || '').trim() || defaultWorkspace

  const onDraftChange = (value: string) => {
    setDraft(value)
    const el = inputRef.current
    if (!el) return
    const upto = value.slice(0, el.selectionStart ?? value.length)
    const at = upto.lastIndexOf('@')
    if (at >= 0 && !/\s/.test(upto.slice(at + 1))) {
      setMention({ query: upto.slice(at + 1), start: at })
    } else {
      setMention(null)
    }
  }

  const pickMention = (name: string) => {
    if (!mention) return
    const before = draft.slice(0, mention.start)
    // 补全范围由 mention 自身决定：键盘导航时 textarea 光标未必还停在查询串末尾
    const end = mention.start + 1 + mention.query.length
    setDraft(`${before}@${name} ${draft.slice(end)}`)
    setMention(null)
    // 光标落到插入内容之后，接着输入不用手动挪
    const caret = before.length + name.length + 2
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  const doSend = async () => {
    // 保留行首缩进（仅裁掉尾部空白/换行）；全空白且无图片时拦截
    const text = draft.trimEnd()
    if ((!text.trim() && attachments.images.length === 0) || busy) return
    setDraft('')
    setMention(null)
    const images = attachments.images
    attachments.clear()
    await sendGroup(project.id, text, images)
  }

  const doCompress = async () => {
    if (!ctxAgentId || compressing || busy) return
    setCompressing(true)
    try {
      const r = await api.invoke<ContextPreviewInfo>(IPC.contextCompress, {
        agentId: ctxAgentId,
        projectId: project.id,
        ...(currentModel ? { model: currentModel } : {}),
      })
      setCtxPreview(r)
    } catch (err) {
      alert(`压缩失败：${String((err as Error).message).slice(0, 160)}`)
    } finally {
      setCompressing(false)
    }
  }

  const doNewThread = async () => {
    try {
      await api.invoke(IPC.groupThreadNew, { projectId: project.id })
      await loadGroupHistory(project.id)
    } catch (err) {
      alert(String((err as Error).message).slice(0, 160))
    }
  }

  return (
    <div className="chat-window group-window">
      <div className="chat-header">
        <Avatar emoji={project.icon} size={34} />
        <div className="chat-header-title">
          <span className="chat-header-name">{project.title}</span>
          <span className="chat-header-sub">{project.memberCount} 个成员 · 群主统筹</span>
        </div>
        <div className="chat-header-actions">
          <ContextUsageBar preview={ctxPreview} loading={ctxLoading} onOpen={() => setContextOpen(true)} />
          <button
            className="text-btn"
            disabled={compressing || busy || !ctxPreview?.sessionId}
            onClick={() => void doCompress()}
            title="手动压缩当前成员会话上下文"
          >
            {compressing ? '压缩中…' : '压缩'}
          </button>
          <button className="text-btn" data-testid="group-new-session" disabled={busy} onClick={() => void doNewThread()} title="开启新会话（旧记录保留在群资料 → 聊天记录）">
            新会话
          </button>
          <button className="text-btn" data-testid="group-info-btn" onClick={() => setDrawer(true)}>
            群资料
          </button>
        </div>
      </div>

      <div className="chat-body" ref={bodyRef}>
        {msgs.length === 0 && (
          <div className="chat-welcome">
            <Avatar emoji={project.icon} size={64} />
            <p className="chat-welcome-name">{project.title}</p>
            <p className="chat-welcome-desc">
              这是项目「{project.title}」的群聊。消息默认由群主（leader）统筹；工作者（worker）统一角色。用 @成员名 可直接指名对话。
            </p>
          </div>
        )}
        {msgs.map((m) => (
          <GroupBubble key={m.id} msg={m} workspaceDir={workspaceDir} />
        ))}
        {busy && !stream && (
          <div className="msg-row left">
            <Avatar emoji="⏳" size={34} />
            <div className="bubble assistant typing">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}
        {stream && (
          <StreamingBubble
            avatar={stream.senderAvatar}
            name={stream.senderName}
            stream={stream}
            workspaceDir={workspaceDir}
            time={[...msgs].reverse().find((m) => m.role === 'user')?.time}
          />
        )}
      </div>

      <div className="composer" ref={composerRef}>
        <div
          className="composer-resize-handle"
          data-testid="chat-resize-handle"
          role="separator"
          aria-label="调整输入框高度"
          aria-orientation="horizontal"
          onPointerDown={composerResize.onPointerDown}
        >
          <span />
        </div>
        <div className="composer-toolbar">
          <span className="composer-hint">默认由群主处理 · @成员名 直达 · 模型/思考用各智能体自己的设置</span>
        </div>
        <ImagePreviews images={attachments.images} onRemove={attachments.remove} />
        <div
          className={`composer-input ${dragOver ? 'drag-over' : ''}`}
          style={{ position: 'relative' }}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            void attachments.addFiles(e.dataTransfer.files)
          }}
        >
          {mentionCandidates.length > 0 && (
            <div className="mention-pop" data-testid="mention-pop">
              {mentionCandidates.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  data-testid={`mention-item-${i}`}
                  className={`mention-item ${i === mentionIndex ? 'active' : ''}`}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => pickMention(a.name)}
                >
                  {a.avatar} <b>{a.name}</b>
                  <span className="mention-desc">{a.description}</span>
                </button>
              ))}
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void attachments.addFiles(e.target.files || [])
              e.target.value = ''
            }}
          />
          <button className="attach-btn" title="添加图片（可粘贴/拖拽）" onClick={() => fileRef.current?.click()}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </button>
          <textarea
            ref={inputRef}
            value={draft}
            style={{ height: composerResize.height }}
            data-testid="chat-draft"
            placeholder={`在「${project.title}」群里说话…（@某成员 直接指名，支持图片）`}
            onChange={(e) => onDraftChange(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files || [])
              if (files.length > 0) {
                e.preventDefault()
                void attachments.addFiles(files)
              }
            }}
            onKeyDown={(e) => {
              // 输入法组字期间方向键/回车归 IME 选词，不能抢
              if (e.nativeEvent.isComposing) return
              if (mention && mentionCandidates.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionIndex((i) => (i + 1) % mentionCandidates.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pickMention((mentionCandidates[mentionIndex] ?? mentionCandidates[0]).name)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMention(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void doSend()
              }
            }}
          />
          {busy ? (
            <button className="send-btn stop" title="停止生成" data-testid="chat-stop" onClick={() => void stopGroup(project.id)}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button className="send-btn" data-testid="chat-send" onClick={() => void doSend()} disabled={!draft.trim() && attachments.images.length === 0}>
              发送
            </button>
          )}
        </div>
      </div>

      {drawer && <GroupInfoDrawer project={project} busy={busy} onClose={() => setDrawer(false)} />}
      {contextOpen && ctxAgentId && (
        <ContextDrawer
          agentId={ctxAgentId}
          projectId={project.id}
          members={members}
          model={currentModel}
          onClose={() => setContextOpen(false)}
          onPreviewChange={(p) => {
            setCtxPreview(p)
            if (p?.agentId) setCtxAgentId(p.agentId)
          }}
        />
      )}
    </div>
  )
}

function GroupBubble(props: { msg: GroupMessage; workspaceDir?: string }): React.JSX.Element {
  const { msg, workspaceDir } = props
  const isAssistant = msg.role === 'assistant'
  // 历史消息里同样剥掉 <think>：与流式气泡保持一致的清爽版面
  const parsed = useMemo(() => (isAssistant ? extractThinkTags(msg.text) : null), [isAssistant, msg.text])
  const reasoning = useMemo(() => (parsed ? mergeReasoning(msg.reasoning, parsed.reasoning) : undefined), [msg.reasoning, parsed])
  const body = parsed ? parsed.text : msg.text
  if (msg.role === 'system') {
    return (
      <div className="msg-system">
        <span>{msg.text}</span>
        <span className="msg-time">{fmtFullTime(msg.time)}</span>
        <CopyButton className="msg-copy msg-copy-system" text={msg.text} label="复制消息" testId="msg-copy-system" />
      </div>
    )
  }
  const mine = msg.role === 'user'
  return (
    <div className={`msg-row ${mine ? 'right' : 'left'}`}>
      {!mine && <Avatar emoji={msg.sender_avatar || '🤖'} size={34} />}
      <div className="msg-stack">
        {!mine && (
          <div className="msg-sender">
            {msg.sender_name}
            <span className="msg-time">{fmtFullTime(msg.time)}</span>
          </div>
        )}
        {mine && <div className="msg-meta-user"><span className="msg-time">{fmtFullTime(msg.time)}</span></div>}
        <div className="msg-bubble-wrap">
          <div className={`bubble ${mine ? 'user' : 'assistant'}`}>
            {isAssistant && <AssistantExtras reasoning={reasoning} tools={msg.tools} workspaceDir={workspaceDir} />}
            <MsgImages images={msg.images || []} />
            {isAssistant ? (
              <Markdown text={body} workspaceDir={workspaceDir} />
            ) : (
              msg.text.split('\n').map((line, i) => (
                <p key={i}>{line || ' '}</p>
              ))
            )}
          </div>
          <CopyButton className="msg-copy" text={body} label="复制消息" testId="msg-copy" />
        </div>
      </div>
      {mine && <div className="self-avatar">🧑</div>}
    </div>
  )
}
