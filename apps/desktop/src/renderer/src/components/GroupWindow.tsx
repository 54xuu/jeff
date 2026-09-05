import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { IPC, type GroupMessage, type ModelOption, type ProviderCatalogItem } from '@jeff/core'
import Avatar from './Avatar'
import GroupInfoDrawer from './GroupInfoDrawer'
import { Markdown } from './Markdown'
import { useImages, ImagePreviews, MsgImages } from './ChatShared'

/** 项目群聊天窗口（= 微信群） */
export default function GroupWindow(props: { projectId: string }): React.JSX.Element {
  const { projects, groupMessages, tasks, sending, streaming, loadGroupHistory, loadTasks, sendGroup, catalog, settings, agents } = useStore()
  const project = projects.find((p) => p.id === props.projectId)
  const msgs = groupMessages[props.projectId] || []
  const projectTasks = tasks[props.projectId] || []
  const busy = !!sending[`group:${props.projectId}`]
  const stream = streaming[`group:${props.projectId}`]
  const [draft, setDraft] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [modelOverride, setModelOverride] = useState<{ providerID: string; modelID: string } | null>(null)
  const [modelOpen, setModelOpen] = useState(false)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const attachments = useImages()
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void loadGroupHistory(props.projectId)
    void loadTasks(props.projectId)
  }, [props.projectId])

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs.length, busy, stream?.text])

  const allModels: ModelOption[] = useMemo(() => catalog.flatMap((c) => c.models), [catalog])
  const currentModel = modelOverride || settings?.defaultModel || null

  // @ 自动补全：光标前最近的 @xx
  const mentionCandidates = useMemo(() => {
    if (!mention) return []
    return useStore
      .getState()
      .agents.filter((a) => a.name.includes(mention.query))
      .slice(0, 5)
  }, [mention])

  if (!project) return <div className="empty-hint">项目群不存在</div>

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
    const after = draft.slice((inputRef.current?.selectionStart ?? draft.length))
    setDraft(`${before}@${name} ${after}`)
    setMention(null)
    inputRef.current?.focus()
  }

  const doSend = async () => {
    const text = draft.trim()
    if ((!text && attachments.images.length === 0) || busy) return
    setDraft('')
    setMention(null)
    const images = attachments.images
    attachments.clear()
    await sendGroup(project.id, text, modelOverride || undefined, images)
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
          <button className="text-btn" onClick={() => setDrawer(true)}>
            群资料与任务
          </button>
        </div>
      </div>

      <div className="chat-body" ref={bodyRef}>
        {msgs.length === 0 && (
          <div className="chat-welcome">
            <Avatar emoji={project.icon} size={64} />
            <p className="chat-welcome-name">{project.title}</p>
            <p className="chat-welcome-desc">
              这是项目「{project.title}」的群聊。所有消息默认由群主（leader）统筹处理；用 @成员名 可以直接指名对话。
            </p>
          </div>
        )}
        {msgs.map((m) => (
          <GroupBubble key={m.id} msg={m} />
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
        {busy && stream && (
          <div className="msg-row left">
            <Avatar emoji={stream.senderAvatar} size={34} />
            <div className="msg-stack">
              <div className="msg-sender">{stream.senderName}</div>
              <div className="bubble assistant">
                <Markdown text={stream.text || '…'} />
                <span className="stream-caret" />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-toolbar">
          <div className="model-select">
            <button className="chip" onClick={() => setModelOpen((v) => !v)}>
              <span className="chip-dot" />
              {currentModel ? modelLabel(currentModel, catalog) : '未配置模型 — 去设置添加 provider'}
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {modelOpen && (
              <div className="model-menu">
                {allModels.length === 0 && <div className="model-menu-empty">暂无可用模型：请到「设置 → 模型供应商」添加并保存</div>}
                {allModels.map((m) => (
                  <button
                    key={`${m.providerID}/${m.modelID}`}
                    className={`model-menu-item ${currentModel?.providerID === m.providerID && currentModel?.modelID === m.modelID ? 'on' : ''}`}
                    onClick={() => {
                      setModelOverride({ providerID: m.providerID, modelID: m.modelID })
                      setModelOpen(false)
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="composer-hint">默认由群主处理 · @成员名 直达</span>
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
            <div className="mention-pop">
              {mentionCandidates.map((a) => (
                <button key={a.id} className="mention-item" onClick={() => pickMention(a.name)}>
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
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void doSend()
              }
            }}
          />
          <button className="send-btn" onClick={() => void doSend()} disabled={(!draft.trim() && attachments.images.length === 0) || busy}>
            发送
          </button>
        </div>
      </div>

      {drawer && <GroupInfoDrawer project={project} tasks={projectTasks} onClose={() => setDrawer(false)} />}
      {void agents}
    </div>
  )
}

export function modelLabel(m: { providerID: string; modelID: string }, catalog: ProviderCatalogItem[]): string {
  const hit = catalog.find((c) => c.id === m.providerID)
  const modelName = hit?.models.find((x) => x.modelID === m.modelID)?.label
  return modelName || `${m.providerID} / ${m.modelID}`
}

function GroupBubble(props: { msg: GroupMessage }): React.JSX.Element {
  const { msg } = props
  const meta = (msg.meta || {}) as { type?: string; taskId?: string }
  if (msg.role === 'system' && meta.type === 'task') {
    return <TaskCardInline msg={msg} />
  }
  if (msg.role === 'system') {
    return (
      <div className="msg-system">
        <span>{msg.text}</span>
      </div>
    )
  }
  const mine = msg.role === 'user'
  return (
    <div className={`msg-row ${mine ? 'right' : 'left'}`}>
      {!mine && <Avatar emoji={msg.sender_avatar || '🤖'} size={34} />}
      <div className="msg-stack">
        {!mine && <div className="msg-sender">{msg.sender_name}</div>}
        <div className={`bubble ${mine ? 'user' : 'assistant'}`}>
          <MsgImages images={msg.images || []} />
          {msg.role === 'assistant' ? (
            <Markdown text={msg.text} />
          ) : (
            msg.text.split('\n').map((line, i) => (
              <p key={i}>{line || ' '}</p>
            ))
          )}
        </div>
      </div>
      {mine && <div className="self-avatar">🧑</div>}
    </div>
  )
}

/** 聊天里的任务卡片（点击打开看板由上层处理；这里展示状态） */
function TaskCardInline(props: { msg: GroupMessage }): React.JSX.Element {
  const { msg } = props
  const meta = (msg.meta || {}) as { type?: string; taskId?: string }
  const taskId = meta.taskId
  const active = useStore((s) => s.active)
  const openKanban = () => {
    // 触发群资料抽屉：通过自定义事件让 GroupWindow 打开
    window.dispatchEvent(new CustomEvent('jeff:open-kanban', { detail: { projectId: active?.kind === 'group' ? active.id : undefined } }))
  }
  return (
    <div className="msg-system">
      <button className="task-card" onClick={openKanban}>
        <span className="task-card-icon">📋</span>
        <span className="task-card-text">{msg.text.replace(/^📋 任务 /, '')}</span>
        {taskId && <span className="tag">看板</span>}
      </button>
    </div>
  )
}
