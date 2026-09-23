import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, agentDraftKey, extractThinkTags, mergeReasoning, modelDisplayLabel, type ChatMsg, type ContextPreviewInfo } from '@jeff/core'
import Avatar from './Avatar'
import { Markdown } from './Markdown'
import { fmtFullTime } from '../format'
import { CopyButton } from './ui/CopyButton'
import { useImages, ImagePreviews, MsgImages, AssistantExtras, StreamingBubble, useAutoScroll, useComposerResize } from './ChatShared'
import ContextDrawer, { ContextUsageBar, fetchContextPreview } from './ContextDrawer'
import AgentProfileDrawer from './AgentProfileDrawer'
import { IconCompress, IconNewSession, IconProfile } from './ui/Icons'
import { useSlashMenu } from './useSlash'
import { SlashMenu } from './SlashMenu'
import { ComposerDraft } from './ComposerDraft'
import { UserTextWithChip } from './PluginChip'
import { composerPlugin, canSendComposer, emptyComposer, outgoingText, type ComposerState } from './composerState'
import { useComposerMemory } from './useComposerMemory'
import { BackToBottom, FindBar, QuotePills, SuggestionChips, addQuote, useConversationFind, useTextQuote } from './ChatChrome'
import MessageRail, { toNavPreview, useMessageAnchors, type NavItem } from './MessageRail'

export default function ChatWindow(props: { agentId: string }): React.JSX.Element {
  const { agents, messages, sending, streaming, loadHistory, sendAgent, newAgentSession, stopAgent, catalog, settings, appInfo } = useStore()
  const agent = agents.find((a) => a.id === props.agentId)
  const key = `agent:${props.agentId}`
  // 私聊智能体的相对路径链接以 Jeff 默认工作区为基准
  const workspaceDir = appInfo ? `${appInfo.dataDir}/workspace` : ''
  const msgs = messages[key] || []
  const sendingNow = !!sending[key]
  const stream = streaming[key]
  const [draftComposer, setDraftComposer] = useState<ComposerState>(emptyComposer())
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
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const draftBeforeRef = useRef<HTMLTextAreaElement>(null)
  const slash = useSlashMenu({ composer: draftComposer, setComposer: setDraftComposer, afterRef: draftRef, beforeRef: draftBeforeRef })
  const memoryKey = ctxPreview?.sessionId ? agentDraftKey(ctxPreview.sessionId) : null
  const memory = useComposerMemory({
    storageKey: memoryKey,
    composer: draftComposer,
    setComposer: setDraftComposer,
    target: { kind: 'agent', id: props.agentId },
    suppressDetect: slash.suppressDetect,
  })
  const composerResize = useComposerResize(composerRef)
  const { anchors, bindAnchor } = useMessageAnchors()
  const navItems = useMemo<NavItem[]>(
    () =>
      msgs.map((m) => ({
        id: m.id,
        role: m.role,
        preview: toNavPreview(m),
        time: m.time,
        sender: m.role === 'user' ? '我' : m.role === 'system' ? '系统' : agent?.name || '智能体',
      })),
    [msgs, agent?.name],
  )

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

  // 贴底时才跟随滚动；上次离开时不在底部则恢复位置
  const scroll = useAutoScroll(bodyRef, `${msgs.length}:${sendingNow}:${stream?.text.length ?? 0}:${stream?.reasoning?.length ?? 0}`, memoryKey)
  const find = useConversationFind(msgs.map((m) => ({ id: m.id, text: m.text })))
  const quotePop = useTextQuote(bodyRef, (text) => addQuote(setDraftComposer, 'chat', text))

  if (!agent) return <div className="empty-hint">智能体不存在</div>

  const doSend = async () => {
    const snap = draftComposer
    const text = outgoingText(snap)
    const plugin = composerPlugin(snap)
    if (!canSendComposer(snap, attachments.images.length) || sendingNow) return
    setDraftComposer(emptyComposer())
    slash.close()
    const images = attachments.images
    attachments.clear()
    const ok = await sendAgent(agent.id, text, images, plugin)
    if (ok) memory.noteSent(snap)
    else setDraftComposer(snap)
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
        <Avatar emoji={agent.avatar} size={34} busy={sendingNow || !!stream} />
        <div className="chat-header-title">
          <span className="chat-header-name">{agent.name}</span>
          <span className="chat-header-sub">{agent.builtin ? 'Jeff 内置管家' : agent.description || '智能体'}</span>
        </div>
        <div className="chat-header-actions">
          <ContextUsageBar preview={ctxPreview} loading={ctxLoading} onOpen={() => setContextOpen(true)} />
          <button
            className={`icon-btn ${compressing ? 'is-busy' : ''}`}
            data-testid="chat-compress"
            disabled={compressing || sendingNow || !ctxPreview?.sessionId}
            onClick={() => void doCompress()}
            title={compressing ? '压缩中…' : '手动压缩当前会话上下文'}
          >
            <IconCompress />
          </button>
          <button
            className="icon-btn"
            data-testid="chat-new-session"
            disabled={sendingNow}
            onClick={() => {
              void (async () => {
                await newAgentSession(agent.id)
                try {
                  const p = await fetchContextPreview({ agentId: agent.id, ...(currentModel ? { model: currentModel } : {}) })
                  setCtxPreview(p)
                } catch {
                  setCtxPreview(null)
                }
              })()
            }}
            title={sendingNow ? '生成中不能开新会话，请先停止或等待完成' : '开启新会话（旧会话保留在「资料 → 聊天记录」里）'}
          >
            <IconNewSession />
          </button>
          <button className="icon-btn" data-testid="chat-profile" onClick={() => setProfileOpen(true)} title="资料 / 聊天记录">
            <IconProfile />
          </button>
        </div>
      </div>

      <div className="chat-body-area">
        {find.open && (
          <FindBar
            query={find.query}
            count={find.count}
            index={find.index}
            onQuery={find.setQuery}
            onNext={find.next}
            onPrev={find.prev}
            onClose={find.close}
          />
        )}
        <div className="chat-body" ref={bodyRef}>
          {msgs.length === 0 && (
            <div className="chat-welcome">
              <Avatar emoji={agent.avatar} size={64} />
              <p className="chat-welcome-name">{agent.name}</p>
              <p className="chat-welcome-desc">{agent.builtin ? '我是小杰，Jeff 的管家。你想要的都能直接跟我说：创建智能体、配置模型、答疑……' : agent.description || '开始对话吧'}</p>
            </div>
          )}
          {msgs.map((m) => (
            <MessageBubble
              key={m.id}
              msg={m}
              agentName={agent.name}
              agentAvatar={agent.avatar}
              workspaceDir={workspaceDir}
              anchorRef={bindAnchor(m.id)}
              findHit={find.hitId === m.id}
            />
          ))}
          {sendingNow && !stream && (
            <div className="msg-row left">
              <Avatar emoji={agent.avatar} size={34} busy />
              <div className="bubble assistant typing">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            </div>
          )}
          {stream && (
            <StreamingBubble
              avatar={agent.avatar}
              name={agent.name}
              stream={stream}
              workspaceDir={workspaceDir}
              time={[...msgs].reverse().find((m) => m.role === 'user')?.time}
              busy
            />
          )}
        </div>
        {quotePop}
        {scroll.away && <BackToBottom onClick={scroll.jumpToBottom} />}
        <MessageRail items={navItems} bodyRef={bodyRef} anchors={anchors} />
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
        <QuotePills quotes={draftComposer.quotes || []} onRemove={(id) => setDraftComposer((c) => ({ ...c, quotes: (c.quotes || []).filter((q) => q.id !== id) }))} />
        {agent.builtin && msgs.length === 0 && !sendingNow && !stream && <SuggestionChips onPick={memory.fillIfEmpty} />}
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
          {slash.open && (
            <SlashMenu candidates={slash.candidates} index={slash.index} setIndex={slash.setIndex} onPick={slash.pick} />
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
          <ComposerDraft
            composer={draftComposer}
            setComposer={setDraftComposer}
            afterRef={draftRef}
            beforeRef={draftBeforeRef}
            placeholder={agent.builtin ? '跟小杰说点什么…（例如：帮我创建一个「架构师阿伟」；输入 / 调用插件指令）' : `发消息给 ${agent.name}…（支持粘贴/拖拽图片；输入 / 调用插件指令）`}
            height={composerResize.height}
            onDetect={(value, field) => slash.detect(value, field)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files || [])
              if (files.length > 0) {
                e.preventDefault()
                void attachments.addFiles(files)
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (slash.handleKey(e)) return
              if (memory.tryHistory(e, e.currentTarget.value, slash.open)) return
              if (e.key === 'Enter' && !e.shiftKey) {
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
            <button className="send-btn" data-testid="chat-send" onClick={() => void doSend()} disabled={!canSendComposer(draftComposer, attachments.images.length)}>
              发送
            </button>
          )}
        </div>
      </div>

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

export function MessageBubble(props: {
  msg: ChatMsg
  agentName: string
  agentAvatar: string
  workspaceDir?: string
  anchorRef?: (el: HTMLElement | null) => void
  findHit?: boolean
}): React.JSX.Element {
  const { msg, agentName, agentAvatar, workspaceDir, anchorRef, findHit } = props
  const mine = msg.role === 'user'
  const isMarkdown = !mine && msg.role === 'assistant'
  // 历史消息里同样剥掉 <think>：与流式气泡保持一致的清爽版面
  const parsed = useMemo(() => (isMarkdown ? extractThinkTags(msg.text) : null), [isMarkdown, msg.text])
  const reasoning = useMemo(() => (parsed ? mergeReasoning(msg.reasoning, parsed.reasoning) : undefined), [msg.reasoning, parsed])
  const body = parsed ? parsed.text : msg.text
  // 系统提示（已停止 / 发送失败）不是智能体说的话：用居中提示条，避免挂在智能体名下造成误读
  if (msg.role === 'system') {
    return (
      <div className="msg-system" ref={anchorRef} data-msg-id={msg.id} data-find-hit={findHit ? '1' : undefined}>
        <span>{msg.text}</span>
        <span className="msg-time">{fmtFullTime(msg.time)}</span>
        <CopyButton className="msg-copy msg-copy-system" text={msg.text} label="复制消息" testId="msg-copy-system" />
      </div>
    )
  }
  return (
    <div className={`msg-row ${mine ? 'right' : 'left'}${findHit ? ' find-hit' : ''}`} ref={anchorRef} data-msg-id={msg.id}>
      {!mine && <Avatar emoji={agentAvatar} size={34} />}
      <div className="msg-stack">
        {!mine && (
          <div className="msg-sender">
            {agentName}
            <span className="msg-time">{fmtFullTime(msg.time)}</span>
          </div>
        )}
        {mine && <div className="msg-meta-user"><span className="msg-time">{fmtFullTime(msg.time)}</span></div>}
        <div className="msg-bubble-wrap">
          <div className={`bubble ${mine ? 'user' : 'assistant'}`}>
            {isMarkdown && <AssistantExtras reasoning={reasoning} tools={msg.tools} workspaceDir={workspaceDir} />}
            <MsgImages images={msg.images || []} />
            {isMarkdown ? (
              <Markdown text={body} workspaceDir={workspaceDir} />
            ) : (
              <UserTextWithChip text={msg.text} plugin={msg.plugin} />
            )}
          </div>
          <CopyButton className="msg-copy" text={body} label="复制消息" testId="msg-copy" />
        </div>
      </div>
      {mine && <div className="self-avatar">🧑</div>}
    </div>
  )
}
