import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, type AgentInfo, type ChatMsg, type ModelOption, type ProviderCatalogItem } from '@jeff/core'
import Avatar from './Avatar'

export default function ChatWindow(props: { agentId: string }): React.JSX.Element {
  const { agents, messages, sending, loadHistory, sendAgent, newAgentSession, stopAgent, catalog, settings } = useStore()
  const agent = agents.find((a) => a.id === props.agentId)
  const key = `agent:${props.agentId}`
  const msgs = messages[key] || []
  const sendingNow = !!sending[key]
  const [draft, setDraft] = useState('')
  const [modelOverride, setModelOverride] = useState<{ providerID: string; modelID: string } | null>(null)
  const [modelOpen, setModelOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadHistory(key)
  }, [key])

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs.length, sendingNow])

  const allModels: ModelOption[] = useMemo(() => catalog.flatMap((c) => c.models), [catalog])
  const currentModel = modelOverride || (agent?.model_provider && agent?.model_id ? { providerID: agent.model_provider, modelID: agent.model_id } : settings?.defaultModel || null)

  if (!agent) return <div className="empty-hint">智能体不存在</div>

  const doSend = async () => {
    const text = draft.trim()
    if (!text || sendingNow) return
    setDraft('')
    await sendAgent(agent.id, text, modelOverride || undefined)
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
        {sendingNow && (
          <div className="msg-row left">
            <Avatar emoji={agent.avatar} size={34} />
            <div className="bubble assistant typing">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
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
                {allModels.length === 0 && <div className="model-menu-empty">暂无可用模型：请到「设置 → 模型提供商」添加并保存</div>}
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
        </div>
        <div className="composer-input">
          <textarea
            value={draft}
            placeholder={agent.builtin ? '跟小杰说点什么…（例如：帮我创建一个「架构师阿伟」）' : `发消息给 ${agent.name}…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void doSend()
              }
            }}
          />
          <button className="send-btn" onClick={() => void doSend()} disabled={!draft.trim() || sendingNow}>
            发送
          </button>
        </div>
      </div>
    </div>
  )
}

function modelLabel(m: { providerID: string; modelID: string }, catalog: ProviderCatalogItem[]): string {
  const hit = catalog.find((c) => c.id === m.providerID)
  const modelName = hit?.models.find((x) => x.modelID === m.modelID)?.label
  return modelName || `${m.providerID} / ${m.modelID}`
}

export function MessageBubble(props: { msg: ChatMsg; agentName: string; agentAvatar: string }): React.JSX.Element {
  const { msg, agentName, agentAvatar } = props
  const mine = msg.role === 'user'
  return (
    <div className={`msg-row ${mine ? 'right' : 'left'}`}>
      {!mine && <Avatar emoji={agentAvatar} size={34} />}
      <div className="msg-stack">
        {!mine && <div className="msg-sender">{agentName}</div>}
        <div className={`bubble ${mine ? 'user' : 'assistant'}`}>
          {msg.text.split('\n').map((line, i) => (
            <p key={i} className={line.startsWith('【mock') ? '' : ''}>
              {line || ' '}
            </p>
          ))}
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
