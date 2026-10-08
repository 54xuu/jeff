import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { IPC, type ChatMsg, type ContextPromptDetails, type ContextPreviewInfo } from '@jeff/core'
import { Markdown } from './Markdown'
import { IconClose, IconCompress } from './ui/Icons'

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

function promptStatus(status: string): string {
  switch (status) {
    case 'loaded': return '已读取'
    case 'empty': return '未填写'
    case 'missing': return '不存在'
    case 'error': return '读取失败'
    default: return 'Jeff 生成'
  }
}

/** 标题栏占用条：点击打开上下文抽屉 */
export function ContextUsageBar(props: {
  preview: ContextPreviewInfo | null
  loading?: boolean
  onOpen: () => void
}): React.JSX.Element {
  const p = props.preview
  if (!p) {
    return (
      <button type="button" className="ctx-usage" onClick={props.onOpen} title="查看上下文" data-testid="context-usage">
        {props.loading ? '上下文…' : '上下文'}
      </button>
    )
  }
  if (p.statsAvailable === false) {
    return <button type="button" className="ctx-usage" onClick={props.onOpen} title="执行引擎未提供上下文统计" data-testid="context-usage">上下文统计不可用</button>
  }
  if (!p.contextLimit) {
    return (
      <button type="button" className="ctx-usage warn" onClick={props.onOpen} title="未配置上下文窗口" data-testid="context-usage">
        未配置窗口
      </button>
    )
  }
  const pct = Math.min(100, Math.round((p.usedTokens / p.contextLimit) * 100))
  const near = p.threshold != null && p.usedTokens >= p.threshold * 0.85
  const over = p.threshold != null && p.usedTokens >= p.threshold
  return (
    <button
      type="button"
      className={`ctx-usage ${over ? 'danger' : near ? 'warn' : ''}`}
      onClick={props.onOpen}
      title={`上下文 ${fmtTokens(p.usedTokens)} / ${fmtTokens(p.contextLimit)}${p.threshold != null ? ` · 自动压缩线 ${fmtTokens(p.threshold)}` : ''}`}
      data-testid="context-usage"
    >
      <span className="ctx-usage-track">
        <span className="ctx-usage-fill" style={{ width: `${pct}%` }} />
        {p.threshold != null && (
          <span className="ctx-usage-mark" style={{ left: `${Math.min(100, (p.threshold / p.contextLimit) * 100)}%` }} />
        )}
      </span>
      <span className="ctx-usage-label">
        {fmtTokens(p.usedTokens)}/{fmtTokens(p.contextLimit)}
      </span>
    </button>
  )
}

/**
 * 上下文抽屉：system / compact 摘要 / 仍发给模型的活跃消息
 */
export default function ContextDrawer(props: {
  agentId: string
  projectId?: string
  /** 群聊成员列表（可切换查看哪个 agent 的 session） */
  members?: Array<{ agentId: string; name: string }>
  model?: { providerID: string; modelID: string } | null
  onClose: () => void
  onPreviewChange?: (p: ContextPreviewInfo | null) => void
}): React.JSX.Element {
  const [agentId, setAgentId] = useState(props.agentId)
  const [preview, setPreview] = useState<ContextPreviewInfo | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [compressing, setCompressing] = useState(false)

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setError('')
    try {
      const args = { agentId: id, ...(props.projectId ? { projectId: props.projectId } : {}) }
      const [r, details] = await Promise.all([
        api.invoke<ContextPreviewInfo>(IPC.contextPreview, { ...args, ...(props.model ? { model: props.model } : {}) }),
        api.invoke<ContextPromptDetails>(IPC.contextPromptDetails, args),
      ])
      const merged = { ...r, ...details }
      setPreview(merged)
      props.onPreviewChange?.(merged)
    } catch (err) {
      setError(String((err as Error).message).slice(0, 200))
      setPreview(null)
      props.onPreviewChange?.(null)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId, props.model?.providerID, props.model?.modelID])

  useEffect(() => {
    setAgentId(props.agentId)
  }, [props.agentId])

  useEffect(() => {
    void load(agentId)
  }, [agentId, load])

  // Esc 关抽屉（无表单，直接关）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props.onClose])

  const goProviders = () => {
    useStore.getState().setTab('settings')
    useStore.getState().setSettingsSection('engine')
    props.onClose()
  }

  const compress = async () => {
    if (compressing) return
    setCompressing(true)
    setError('')
    try {
      const r = await api.invoke<ContextPreviewInfo>(IPC.contextCompress, {
        agentId,
        ...(props.projectId ? { projectId: props.projectId } : {}),
        ...(props.model ? { model: props.model } : {}),
      })
      const details = await api.invoke<ContextPromptDetails>(IPC.contextPromptDetails, {
        agentId,
        ...(props.projectId ? { projectId: props.projectId } : {}),
      })
      const merged = { ...r, ...details }
      setPreview(merged)
      props.onPreviewChange?.(merged)
    } catch (err) {
      setError(String((err as Error).message).slice(0, 200))
    } finally {
      setCompressing(false)
    }
  }

  return (
    <div className="drawer-mask" onClick={props.onClose}>
      <div className="history-drawer context-drawer" onClick={(e) => e.stopPropagation()} data-testid="context-drawer">
        <div className="history-head">
          <span>上下文</span>
          <div className="history-head-actions">
            <button
              className={`icon-btn ${compressing ? 'is-busy' : ''}`}
              disabled={preview?.compressionAvailable === false || compressing || loading || !preview?.sessionId}
              onClick={() => void compress()}
              data-testid="context-compress"
              title={compressing ? '压缩中…' : '手动压缩当前会话上下文'}
            >
              <IconCompress />
            </button>
            <button className="icon-btn" title="关闭" onClick={props.onClose}>
              <IconClose />
            </button>
          </div>
        </div>

        {props.members && props.members.length > 1 && (
          <div className="ctx-member-bar">
            {props.members.map((m) => (
              <button key={m.agentId} type="button" className={`tag ${m.agentId === agentId ? 'tag-green' : ''}`} onClick={() => setAgentId(m.agentId)}>
                {m.name}
              </button>
            ))}
          </div>
        )}

        {error && <p className="settings-error history-tip">⚠️ {error}</p>}
        {loading && <p className="settings-tip history-tip">加载中…</p>}

        {!loading && preview && (
          <div className="ctx-body">
            <div className="ctx-stats">
              {preview.contextLimit ? (
                <p className="settings-tip">
                  {preview.statsAvailable === false ? '引擎未提供上下文统计' : <>占用 <b>{fmtTokens(preview.usedTokens)}</b> / {fmtTokens(preview.contextLimit)}</>}
                  {preview.threshold != null ? ` · 自动压缩阈值 ${fmtTokens(preview.threshold)}` : ''}
                  {preview.autoEnabled ? '' : ' · 自动压缩未启用'}
                  {preview.compactedCount > 0 ? ` · 已压缩隐藏 ${preview.compactedCount} 条` : ''}
                </p>
              ) : (
                <p className="settings-error history-tip">
                  未配置上下文窗口，自动压缩未启用。
                  <button type="button" className="text-btn" onClick={goProviders}>去配置模型</button>
                </p>
              )}
            </div>

            <section className="ctx-section">
              <h3 className="ctx-section-title">下一轮拟发送的 Jeff 上下文</h3>
              <p className="settings-tip">个人指令通过 Agent 定义注入；这里展示 Jeff 提供的规则、资料、记忆和任务内容。</p>
              {preview.promptContext?.blocks.length ? (
                <div className="ctx-prompt-blocks">
                  {preview.promptContext.blocks.map((block) => (
                    <article key={`${block.id}:${block.source}`} className={`ctx-prompt-block ${block.included ? 'is-included' : 'is-omitted'}`}>
                      <div className="ctx-prompt-block-head">
                        <b>{block.id === 'agent-instructions' ? 'Agent 个人指令' : block.id}</b>
                        <span>{promptStatus(block.readStatus)} · {block.scope}{block.delivery === 'agent-definition' ? ' · Agent 定义' : ''}</span>
                      </div>
                      <small>{block.source}{block.contentHash ? ` · SHA-256 ${block.contentHash.slice(0, 12)}` : ''}</small>
                      {block.content ? <pre className="ctx-pre">{block.content}</pre> : <p className="ctx-prompt-empty">此来源当前没有可注入内容。</p>}
                    </article>
                  ))}
                </div>
              ) : preview.system ? (
                <pre className="ctx-pre">{preview.system}</pre>
              ) : (
                <div className="empty-card">当前没有额外 Jeff 上下文。</div>
              )}
            </section>

            <section className="ctx-section">
              <h3 className="ctx-section-title">最近一轮实际发送</h3>
              {preview.lastPromptSnapshot ? (
                <>
                  <p className="settings-tip">{new Date(preview.lastPromptSnapshot.sentAt).toLocaleString()} · {preview.lastPromptSnapshot.engine} · 上下文 SHA-256 {preview.lastPromptSnapshot.context.contextHash.slice(0, 16)}。不包含 CLI、模型服务商内部提示词。</p>
                  <details className="ctx-actual-prompt" open>
                    <summary>Jeff 实际提交的 system 内容</summary>
                    <pre className="ctx-pre">{preview.lastPromptSnapshot.system || '（空）'}</pre>
                  </details>
                  {preview.lastPromptSnapshot.adapterPrompt && (
                    <details className="ctx-actual-prompt">
                      <summary>Agent / 引擎适配器收到的 Jeff 指令</summary>
                      <pre className="ctx-pre">{preview.lastPromptSnapshot.adapterPrompt}</pre>
                    </details>
                  )}
                </>
              ) : (
                <div className="empty-card">当前会话还没有可查看的发送快照。</div>
              )}
            </section>

            <section className="ctx-section">
              <h3 className="ctx-section-title">Compact 摘要</h3>
              {preview.summary ? (
                <div className="ctx-summary"><Markdown text={preview.summary} /></div>
              ) : (
                <div className="empty-card">尚未压缩过；历史仍全部进入模型上下文</div>
              )}
            </section>

            <section className="ctx-section ctx-active">
              <h3 className="ctx-section-title">活跃消息（仍会发给模型）· {preview.activeMessages.length}</h3>
              <div className="ctx-msgs">
                {preview.activeMessages.length === 0 && <div className="empty-card">暂无活跃消息</div>}
                {preview.activeMessages.map((m) => (
                  <ActiveMsg key={m.id} msg={m} />
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

function ActiveMsg(props: { msg: ChatMsg }): React.JSX.Element {
  const m = props.msg
  return (
    <div className={`history-msg ${m.role}`}>
      <div className="history-msg-meta">{m.role === 'user' ? '我' : m.role === 'system' ? '系统' : '对方'}</div>
      {m.role === 'assistant' ? <Markdown text={m.text || '（无文本）'} /> : <pre className="history-msg-text">{m.text}</pre>}
    </div>
  )
}

/** 拉取轻量占用信息（标题栏用，不打开抽屉） */
export async function fetchContextPreview(input: {
  agentId: string
  projectId?: string
  model?: { providerID: string; modelID: string } | null
}): Promise<ContextPreviewInfo | null> {
  try {
    return await api.invoke<ContextPreviewInfo>(IPC.contextPreview, {
      agentId: input.agentId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.model ? { model: input.model } : {}),
    })
  } catch {
    return null
  }
}
