import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { IPC, type ChatMsg, type ContextPreviewInfo } from '@jeff/core'
import { Markdown } from './Markdown'

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
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
      const r = await api.invoke<ContextPreviewInfo>(IPC.contextPreview, {
        agentId: id,
        ...(props.projectId ? { projectId: props.projectId } : {}),
        ...(props.model ? { model: props.model } : {}),
      })
      setPreview(r)
      props.onPreviewChange?.(r)
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

  const goProviders = () => {
    useStore.getState().setTab('settings')
    useStore.getState().setSettingsSection('providers')
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
      setPreview(r)
      props.onPreviewChange?.(r)
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
            <button className="text-btn" disabled={compressing || loading || !preview?.sessionId} onClick={() => void compress()} data-testid="context-compress">
              {compressing ? '压缩中…' : '压缩'}
            </button>
            <button className="text-btn" onClick={props.onClose}>关闭</button>
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
                  占用 <b>{fmtTokens(preview.usedTokens)}</b> / {fmtTokens(preview.contextLimit)}
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
              <h3 className="ctx-section-title">本轮 System</h3>
              {preview.system ? (
                <pre className="ctx-pre">{preview.system}</pre>
              ) : (
                <div className="empty-card">无记忆 / AGENTS.md 注入</div>
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
