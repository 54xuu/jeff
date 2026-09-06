import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, type ChatMsg, type ModelOption, type ProviderCatalogItem } from '@jeff/core'
import Avatar from './Avatar'
import { Markdown } from './Markdown'
import { useImages, ImagePreviews, MsgImages } from './ChatShared'

export default function ChatWindow(props: { agentId: string }): React.JSX.Element {
  const { agents, messages, sending, streaming, loadHistory, sendAgent, newAgentSession, stopAgent, catalog, settings } = useStore()
  const agent = agents.find((a) => a.id === props.agentId)
  const key = `agent:${props.agentId}`
  const msgs = messages[key] || []
  const sendingNow = !!sending[key]
  const stream = streaming[key]
  const [draft, setDraft] = useState('')
  const [modelOverride, setModelOverride] = useState<{ providerID: string; modelID: string } | null>(null)
  const [variant, setVariant] = useState<string>('')
  const [modelOpen, setModelOpen] = useState(false)
  const [variantOpen, setVariantOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const attachments = useImages()
  const bodyRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void loadHistory(key)
  }, [key])

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs.length, sendingNow, stream?.text])

  const allModels: ModelOption[] = useMemo(() => catalog.flatMap((c) => c.models), [catalog])
  const currentModel = modelOverride || (agent?.model_provider && agent?.model_id ? { providerID: agent.model_provider, modelID: agent.model_id } : settings?.defaultModel || null)
  // 当前模型的思考档位（来自供应商配置）；切模型时档位复位
  const tiers = useMemo(() => {
    if (!currentModel) return []
    return allModels.find((m) => m.providerID === currentModel.providerID && m.modelID === currentModel.modelID)?.thinkingTiers ?? []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentModel?.providerID, currentModel?.modelID, allModels])
  useEffect(() => setVariant(''), [currentModel?.providerID, currentModel?.modelID])

  if (!agent) return <div className="empty-hint">智能体不存在</div>

  const doSend = async () => {
    const text = draft.trim()
    if ((!text && attachments.images.length === 0) || sendingNow) return
    setDraft('')
    const images = attachments.images
    attachments.clear()
    await sendAgent(agent.id, text, modelOverride || undefined, images, variant || undefined)
  }

  return (
    <div className="chat-window">
      <div className="chat-header">
        <Avatar emoji={agent.avatar} size={34} />
        <div className="chat-header-title">
          <span className="chat-header-name">{agent.name}</span>
          <span className="chat-header-sub">{agent.builtin ? 'Jeff 内置管家' : agent.description || '智能体'}</span>
        </div>
        <div className="chat-header-actions">
          <button className="text-btn" onClick={() => void newAgentSession(agent.id)} title="开启新会话（旧会话保留）">
            新会话
          </button>
          {sendingNow && (
            <button className="text-btn danger" onClick={() => void stopAgent(agent.id)}>
              停止
            </button>
          )}
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
          <MessageBubble key={m.id} msg={m} agentName={agent.name} agentAvatar={agent.avatar} />
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
        {sendingNow && stream && (
          <div className="msg-row left">
            <Avatar emoji={agent.avatar} size={34} />
            <div className="msg-stack">
              <div className="msg-sender">{agent.name}</div>
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
          {tiers.length > 0 && (
            <div className="model-select">
              <button className="chip chip-variant" onClick={() => setVariantOpen((v) => !v)} title="思考程度">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
                </svg>
                {variant ? TIER_LABEL[variant] || variant : '思考: 默认'}
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {variantOpen && (
                <div className="model-menu">
                  <button className={`model-menu-item ${variant === '' ? 'on' : ''}`} onClick={() => { setVariant(''); setVariantOpen(false) }}>默认（跟随模型配置）</button>
                  {tiers.map((t) => (
                    <button key={t} className={`model-menu-item ${variant === t ? 'on' : ''}`} onClick={() => { setVariant(t); setVariantOpen(false) }}>
                      {TIER_LABEL[t] || t}（{t}）
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
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
          <button className="send-btn" onClick={() => void doSend()} disabled={(!draft.trim() && attachments.images.length === 0) || sendingNow}>
            发送
          </button>
        </div>
      </div>
    </div>
  )
}

function modelLabel(m: { providerID: string; modelID: string }, catalog: ProviderCatalogItem[]): string {
  // 规格：按「提供商名称 / 模型ID」展示
  const hit = catalog.find((c) => c.id === m.providerID)
  return `${hit?.name || m.providerID} / ${m.modelID}`
}

const TIER_LABEL: Record<string, string> = { none: '无思考', low: '低', high: '高', max: '最大' }

export function MessageBubble(props: { msg: ChatMsg; agentName: string; agentAvatar: string }): React.JSX.Element {
  const { msg, agentName, agentAvatar } = props
  const mine = msg.role === 'user'
  const isMarkdown = !mine && msg.role === 'assistant'
  return (
    <div className={`msg-row ${mine ? 'right' : 'left'}`}>
      {!mine && <Avatar emoji={agentAvatar} size={34} />}
      <div className="msg-stack">
        {!mine && <div className="msg-sender">{agentName}</div>}
        <div className={`bubble ${mine ? 'user' : 'assistant'}`}>
          <MsgImages images={msg.images || []} />
          {isMarkdown ? (
            <Markdown text={msg.text} />
          ) : (
            msg.text.split('\n').map((line, i) => (
              <p key={i}>{line || ' '}</p>
            ))
          )}
          {msg.tools?.map((t, i) => (
            <details key={i} className="tool-block">
              <summary>
                <span className="tool-tag">工具</span>
                {t.tool} {t.status ? `· ${t.status}` : ''}
              </summary>
              <pre>{t.error ? `错误: ${t.error}` : t.output || '(无输出)'}</pre>
            </details>
          ))}
        </div>
      </div>
      {mine && <div className="self-avatar">🧑</div>}
    </div>
  )
}
