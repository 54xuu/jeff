import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, modelDisplayLabel, type ChatMsg, type ContextPreviewInfo } from '@jeff/core'
import Avatar from './Avatar'
import { Markdown } from './Markdown'
import { CopyButton } from './ui/CopyButton'
import { useImages, ImagePreviews, MsgImages, AssistantExtras, StreamingBubble, useComposerResize } from './ChatShared'
import ChatHistoryDrawer from './ChatHistoryDrawer'
import ContextDrawer, { ContextUsageBar, fetchContextPreview } from './ContextDrawer'
import AgentProfileDrawer from './AgentProfileDrawer'

export default function ChatWindow(props: { agentId: string }): React.JSX.Element {
  const { agents, messages, sending, streaming, loadHistory, sendAgent, newAgentSession, stopAgent, catalog, settings, appInfo } = useStore()
  const agent = agents.find((a) => a.id === props.agentId)
  const key = `agent:${props.agentId}`
  // 私聊智能体的相对路径链接以 Jeff 默认工作区为基准
  const workspaceDir = appInfo ? `${appInfo.dataDir}/workspace` : ''
  const msgs = messages[key] || []
  const sendingNow = !!sending[key]
  const stream = streaming[key]
  const [draft, setDraft] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [ctxPreview, setCtxPreview] = useState<ContextPreviewInfo | null>(null)
  const [ctxLoading, setCtxLoading] = useState(false)
  const [compressing, setCompressing] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const attachments = useImages()
  const bodyRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const composerResize = useComposerResize(composerRef)

  useEffect(() => {
    void loadHistory(key)
  }, [key])

  const currentModel =
    agent?.model_provider && agent?.model_id
      ? { providerID: agent.model_provider, modelID: agent.model_id }
      : settings?.defaultModel || null

  useEffect(() => {
    let cancelled = false
    setCtxLoading(true)
    // catch/finally 兜底：IPC 失败也不能把界面留在永久「加载中」
    fetchContextPreview({ agentId: props.agentId, model: currentModel })
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
  }, [props.agentId, currentModel?.providerID, currentModel?.modelID, msgs.length, sendingNow])

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs.length, sendingNow, stream?.text])

  if (!agent) return <div className="empty-hint">智能体不存在</div>

  const doSend = async () => {
    // 保留行首缩进（仅裁掉尾部空白/换行）；全空白且无图片时拦截
    const text = draft.trimEnd()
    if ((!text.trim() && attachments.images.length === 0) || sendingNow) return
    setDraft('')
    const images = attachments.images
    attachments.clear()
    await sendAgent(agent.id, text, images)
  }

  const doCompress = async () => {
    if (compressing || sendingNow) return
    setCompressing(true)
    try {
      const r = await api.invoke<ContextPreviewInfo>(IPC.contextCompress, {
        agentId: agent.id,
        ...(currentModel ? { model: currentModel } : {}),
      })
      setCtxPreview(r)
    } catch (err) {
      alert(`压缩失败：${String((err as Error).message).slice(0, 160)}`)
    } finally {
      setCompressing(false)
    }
  }

  return (
    <div className="chat-window" data-testid="chat-window">
      <div className="chat-header">
        <Avatar emoji={agent.avatar} size={34} />
        <div className="chat-header-title">
          <span className="chat-header-name">{agent.name}</span>
          <span className="chat-header-sub">{agent.builtin ? 'Jeff 内置管家' : agent.description || '智能体'}</span>
        </div>
        <div className="chat-header-actions">
          <ContextUsageBar preview={ctxPreview} loading={ctxLoading} onOpen={() => setContextOpen(true)} />
          <button
            className="text-btn"
            data-testid="chat-compress"
            disabled={compressing || sendingNow || !ctxPreview?.sessionId}
            onClick={() => void doCompress()}
            title="手动压缩当前会话上下文"
          >
            {compressing ? '压缩中…' : '压缩'}
          </button>
          <button
            className="text-btn"
            data-testid="chat-new-session"
            disabled={sendingNow}
            onClick={() => void newAgentSession(agent.id)}
            title={sendingNow ? '生成中不能开新会话，请先停止或等待完成' : '开启新会话（旧会话保留在聊天记录里）'}
          >
            新会话
          </button>
          <button className="icon-btn" title="聊天记录" data-testid="chat-history" onClick={() => setHistoryOpen(true)}>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3.5 2" />
            </svg>
          </button>
          <button className="text-btn" data-testid="chat-profile" onClick={() => setProfileOpen(true)} title="查看 / 编辑智能体资料">
            资料
          </button>
        </div>
      </div>

      <div className="chat-body" ref={bodyRef}>
        {msgs.length === 0 && (
          <div className="chat-welcome">
            <Avatar emoji={agent.avatar} size={64} />
            <p className="chat-welcome-name">{agent.name}</p>
            <p className="chat-welcome-desc">{agent.builtin ? '我是小杰，Jeff 的管家。你想要的都能直接跟我说：创建智能体、配置模型、答疑……' : agent.description || '开始对话吧'}</p>
          </div>
        )}
        {msgs.map((m) => (
          <MessageBubble key={m.id} msg={m} agentName={agent.name} agentAvatar={agent.avatar} workspaceDir={workspaceDir} />
        ))}
        {sendingNow && !stream && (
          <div className="msg-row left">
            <Avatar emoji={agent.avatar} size={34} />
            <div className="bubble assistant typing">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}
        {stream && <StreamingBubble avatar={agent.avatar} name={agent.name} stream={stream} workspaceDir={workspaceDir} />}
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
          <button
            type="button"
            className="chip chip-readonly"
            data-testid="chat-model-chip"
            title="模型由智能体资料决定；点击打开资料"
            onClick={() => setProfileOpen(true)}
          >
            <span className="chip-dot" />
            {currentModel ? modelDisplayLabel(currentModel, catalog) : '未配置模型 — 去资料或设置添加'}
          </button>
        </div>
        <ImagePreviews images={attachments.images} onRemove={attachments.remove} />
        <div
          className={`composer-input ${dragOver ? 'drag-over' : ''}`}
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
            value={draft}
            style={{ height: composerResize.height }}
            data-testid="chat-draft"
            placeholder={agent.builtin ? '跟小杰说点什么…（例如：帮我创建一个「架构师阿伟」）' : `发消息给 ${agent.name}…（支持粘贴/拖拽图片）`}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files || [])
              if (files.length > 0) {
                e.preventDefault()
                void attachments.addFiles(files)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void doSend()
              }
            }}
          />
          {sendingNow ? (
            <button className="send-btn stop" title="停止生成" data-testid="chat-stop" onClick={() => void stopAgent(agent.id)}>
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

      {historyOpen && <ChatHistoryDrawer agentId={agent.id} onClose={() => setHistoryOpen(false)} />}
      {profileOpen && <AgentProfileDrawer agent={agent} onClose={() => setProfileOpen(false)} />}
      {contextOpen && (
        <ContextDrawer
          agentId={agent.id}
          model={currentModel}
          onClose={() => setContextOpen(false)}
          onPreviewChange={setCtxPreview}
        />
      )}
    </div>
  )
}

export function MessageBubble(props: { msg: ChatMsg; agentName: string; agentAvatar: string; workspaceDir?: string }): React.JSX.Element {
  const { msg, agentName, agentAvatar, workspaceDir } = props
  const mine = msg.role === 'user'
  const isMarkdown = !mine && msg.role === 'assistant'
  return (
    <div className={`msg-row ${mine ? 'right' : 'left'}`}>
      {!mine && <Avatar emoji={agentAvatar} size={34} />}
      <div className="msg-stack">
        {!mine && <div className="msg-sender">{agentName}</div>}
        <div className="msg-bubble-wrap">
          <div className={`bubble ${mine ? 'user' : 'assistant'}`}>
            {isMarkdown && <AssistantExtras reasoning={msg.reasoning} tools={msg.tools} workspaceDir={workspaceDir} />}
            <MsgImages images={msg.images || []} />
            {isMarkdown ? (
              <Markdown text={msg.text} workspaceDir={workspaceDir} />
            ) : (
              msg.text.split('\n').map((line, i) => (
                <p key={i}>{line || ' '}</p>
              ))
            )}
          </div>
          <CopyButton className="msg-copy" text={msg.text} label="复制消息" testId="msg-copy" />
        </div>
      </div>
      {mine && <div className="self-avatar">🧑</div>}
    </div>
  )
}
