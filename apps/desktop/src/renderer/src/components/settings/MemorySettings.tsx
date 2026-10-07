import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { IPC, type MemoryScopeInfo, type AgentsMdInfo } from '@jeff/core'
import { Dialog, Toast } from '../ui'

/** 记忆字符预算（与 memory/store.ts 保持一致） */
const BUDGET = { user: 1375, agent: 2200, project: 2200 } as const

interface MemoryData {
  content: string
  label: string
  budget?: number
}

/** 设置 → 记忆：分层 scope + 条目级管理（§ 分隔）+ 字符预算占用 + AGENTS.md（用户级/项目级） */
export default function MemorySettings(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [scopeKind, setScopeKind] = useState<'all' | 'user' | 'agent' | 'project'>('all')
  const [mdQuery, setMdQuery] = useState('')
  const [scopes, setScopes] = useState<MemoryScopeInfo[]>([])
  const [sel, setSel] = useState<MemoryScopeInfo | null>(null)
  const [content, setContent] = useState('')
  const [budget, setBudget] = useState<number>(BUDGET.agent)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [agentsMds, setAgentsMds] = useState<AgentsMdInfo[]>([])
  const [mdSel, setMdSel] = useState<AgentsMdInfo | null>(null)
  const [mdContent, setMdContent] = useState('')
  const [mdDirty, setMdDirty] = useState(false)
  const [mdSaving, setMdSaving] = useState(false)
  const [mdError, setMdError] = useState<string | null>(null)
  const [mdConfirmDiscard, setMdConfirmDiscard] = useState(false)

  const refresh = async (keepId?: string) => {
    const list = await api.invoke<MemoryScopeInfo[]>(IPC.memoryScopes)
    setScopes(list)
    setLoaded(true)
    if (keepId) {
      const again = list.find((m) => `${m.kind}:${m.id}` === keepId)
      if (again) return pick(again, false)
    }
    if (list[0]) await pick(list[0], false)
  }

  const refreshMd = async () => {
    const list = await api.invoke<AgentsMdInfo[]>(IPC.agentsMdList)
    setAgentsMds(list)
  }

  useEffect(() => {
    void refresh()
    void refreshMd()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 编辑器 Esc 关闭（脏内容先确认丢弃，不悄然丢失）
  useEffect(() => {
    if (!mdSel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || mdConfirmDiscard || mdSaving) return
      requestDiscard()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mdSel, mdDirty, mdConfirmDiscard, mdSaving])

  const pick = async (m: MemoryScopeInfo, resetDirty = true) => {
    if (resetDirty && dirty && !window.confirm('当前记忆有未保存的修改，切换后将丢失。是否继续？')) return
    const data = await api.invoke<MemoryData>(IPC.memoryGet, { kind: m.kind, id: m.id })
    setSel(m)
    setContent(data.content)
    setBudget(data.budget ?? (m.kind === 'user' ? BUDGET.user : m.kind === 'agent' ? BUDGET.agent : BUDGET.project))
    if (resetDirty) setDirty(false)
  }

  /** 记忆文件按 § 分条（与 store 的存储语义一致） */
  const entries = useMemo(() => content.split(/\n?§\n?/).map((s) => s.trim()).filter(Boolean), [content])
  const usage = Math.min(100, Math.round((content.length / Math.max(1, budget)) * 100))

  const groups = useMemo(() => {
    const visible = scopes.filter((s) => (scopeKind === 'all' || s.kind === scopeKind) && s.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    const user = visible.filter((s) => s.kind === 'user')
    const agents = visible.filter((s) => s.kind === 'agent')
    const projects = visible.filter((s) => s.kind === 'project')
    return [
      { title: '全局', hint: '用户画像，由小杰在对话中维护', items: user },
      { title: '智能体记忆', hint: '每个智能体各自的长期记忆', items: agents },
      { title: '项目群记忆', hint: '群聊中自动沉淀的项目共享记忆', items: projects },
    ]
  }, [scopes, query, scopeKind])

  return (
    <div className="settings-content" data-testid="memory-settings">
      <h2 className="settings-title">记忆</h2>
      <p className="settings-tip">
        说「记住…」时 Jeff 自动分流：密钥、密码及保密内容存入私有记忆；公开偏好和规则写入全局或项目 AGENTS.md。标记为私有的条目仅保存在这台电脑，不参与同步。旧记忆保留，可在这里查看和整理。
      </p>

      {error && <Toast kind="error" message={error} onClose={() => setError('')} />}
      {!loaded && <p className="settings-tip">加载中…</p>}
      {loaded && (
        <div className="settings-card">
          <div className="memory-layout">
          <div className="memory-scopes">
            <input className="memory-search" aria-label="搜索记忆范围" placeholder="搜索智能体或项目群…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="memory-filter" aria-label="记忆范围类型" value={scopeKind} onChange={(e) => setScopeKind(e.target.value as typeof scopeKind)}>
              <option value="all">全部范围（{scopes.length}）</option><option value="user">全局</option><option value="agent">智能体</option><option value="project">项目群</option>
            </select>
            <div className="memory-scope-results">
            {groups.filter((g) => g.items.length > 0).map((g) => (
              <div key={g.title} className="memory-group">
                <div className="memory-group-title">
                  {g.title} · {g.items.length}
                  {g.items.length === 0 && <span className="settings-tip">（暂无）</span>}
                </div>
                {g.items.map((m) => (
                  <button
                    key={`${m.kind}:${m.id}`}
                    className={`memory-chip ${sel && sel.kind === m.kind && sel.id === m.id ? 'on' : ''}`}
                    onClick={() => void pick(m)}
                    title={m.file}
                  >
                    {m.label}
                  </button>
                ))}
                {g.items.length === 0 && <div className="memory-empty-hint">{g.hint}</div>}
              </div>
            ))}
            {groups.every((g) => g.items.length === 0) && <div className="memory-empty-hint">没有匹配的范围</div>}
            </div>
            <div className="memory-empty-hint" style={{ marginTop: 8 }}>
              对话里对 agent 说「记住 / 忘记 / 整理记忆」即可增删改；超过预算会自动要求模型合并旧条目。
            </div>
          </div>
          <div className="memory-editor">
            {sel ? (
              <>
                <div className="memory-editor-head">
                  <span>{sel.label} 的记忆 · {entries.length} 条</span>
                  <span className="settings-tip">{sel.file}</span>
                </div>
                <div className="memory-budget">
                  <div className="memory-budget-bar">
                    <div className={`memory-budget-fill ${usage > 90 ? 'danger' : usage > 70 ? 'warn' : ''}`} style={{ width: `${usage}%` }} />
                  </div>
                  <span className="settings-tip">{content.length} / {budget} 字符（{usage}%）</span>
                </div>
                <div className="memory-entries">
                  {entries.map((e, i) => (
                    <div key={i} className="memory-entry">
                      <span className="memory-entry-text">{e.length > 160 ? `${e.slice(0, 160)}…` : e}</span>
                      <button
                        className="text-btn danger"
                        title="删除该条"
                        onClick={() => {
                          const next = entries.filter((_, j) => j !== i).join('\n§\n')
                          setContent(next)
                          setDirty(true)
                        }}
                      >
                        忘记
                      </button>
                    </div>
                  ))}
                  {entries.length === 0 && <div className="memory-empty-hint">暂无记忆条目。</div>}
                </div>
                <details className="mcp-tools" style={{ marginTop: 8 }}>
                  <summary>整段编辑（高级）</summary>
                  <textarea
                    rows={10}
                    value={content}
                    onChange={(e) => {
                      setContent(e.target.value)
                      setDirty(true)
                    }}
                    placeholder="每行一条；条目以 § 分隔。"
                    style={{ fontFamily: 'inherit', fontSize: 12, width: '100%', marginTop: 6 }}
                  />
                  <div className="settings-actions">
                    <button
                      className="btn primary"
                      data-testid="memory-save"
                      disabled={!dirty || saving}
                      onClick={async () => {
                        if (!sel) return
                        setSaving(true)
                        setError('')
                        try {
                          await api.invoke(IPC.memorySave, { kind: sel.kind, id: sel.id, content })
                          setDirty(false)
                          await refresh(`${sel.kind}:${sel.id}`)
                        } catch (err) {
                          setError(`保存失败：${(err as Error).message}`)
                        } finally {
                          setSaving(false)
                        }
                      }}
                    >
                      {saving ? '保存中…' : `保存${dirty ? '（未保存）' : ''}`}
                    </button>
                  </div>
                </details>
              </>
            ) : (
              <div className="empty-card">选择左侧任意记忆范围查看内容</div>
            )}
          </div>
          </div>
        </div>
      )}

      <h2 className="settings-title">AGENTS.md（规则文件）</h2>
      <p className="settings-tip">
        用户级 AGENTS.md 对所有对话生效；项目级按项目保存在 Jeff 数据目录（agents-md/）下，仅该群的会话生效（每轮自动注入上下文），并随 WebDAV 同步。
        旧版放在工作空间目录下的 AGENTS.md 仅在项目规则尚未创建时作为迁移来源：首次编辑保存后会写入数据目录，此后以数据目录为准。
      </p>
      <input className="memory-search memory-rule-search" aria-label="搜索规则文件" placeholder="搜索全局规则或项目群…" value={mdQuery} onChange={(e) => setMdQuery(e.target.value)} />
      <div className="pv-detail memory-rules-list">
        {agentsMds.length === 0 && <div className="empty-card">加载中…</div>}
        {agentsMds.filter((m) => m.label.toLocaleLowerCase().includes(mdQuery.trim().toLocaleLowerCase())).map((m) => (
          <div key={`${m.kind}:${m.id}`} className="provider-row">
            <div className="provider-main">
              <div className="provider-name">
                {m.label}
                <span className={`tag ${m.exists ? 'tag-green' : ''}`}>{m.exists ? '已存在' : '未创建'}</span>
              </div>
              <div className="provider-sub">{m.file}</div>
            </div>
            <button
              className="text-btn"
              data-testid={`agentsmd-edit-${m.kind}`}
              onClick={async () => {
                try {
                  const data = await api.invoke<{ content: string; file: string }>(IPC.agentsMdGet, { kind: m.kind, id: m.id })
                  setMdSel(m)
                  setMdContent(data.content)
                  setMdDirty(false)
                  setMdError(null)
                } catch (err) {
                  alert(`读取失败：${String((err as Error).message).slice(0, 160)}`)
                }
              }}
            >
              编辑
            </button>
          </div>
        ))}
      </div>

      {mdSel && (
        <div className="agentsmd-mask" data-testid="agentsmd-editor" onMouseDown={(e) => { if (e.target === e.currentTarget) requestDiscard() }}>
          <div className="agentsmd-panel" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <div className="agentsmd-head">
              <div className="agentsmd-head-title">
                <span className="agentsmd-title">编辑 AGENTS.md</span>
                <span className={`tag ${mdSel.kind === 'user' ? 'tag-green' : ''}`}>{mdSel.kind === 'user' ? '用户级 · 全局生效' : '项目级 · 仅该群生效'}</span>
                <span className="tag">{mdSel.exists ? '已存在' : '未创建'}</span>
              </div>
              <div className="agentsmd-head-file" title={mdSel.file}>{mdSel.file}</div>
            </div>
            <textarea
              className="agentsmd-textarea"
              data-testid="agentsmd-textarea"
              value={mdContent}
              onChange={(e) => { setMdContent(e.target.value); setMdDirty(true) }}
              placeholder={'# 我的全局规则\n- 回复用简体中文\n- 代码先解释再写…'}
              spellCheck={false}
            />
            <div className="agentsmd-foot">
              <span className="agentsmd-meta" data-testid="agentsmd-status">
                {mdContent.length} 字符
                {mdDirty ? ' · 有未保存修改' : ' · 已与文件一致'}
              </span>
              {mdError && <Toast kind="error" message={mdError} onClose={() => setMdError(null)} />}
              <div className="agentsmd-foot-actions">
                <button className="btn" data-testid="agentsmd-cancel" disabled={mdSaving} onClick={() => requestDiscard()}>
                  取消
                </button>
                <button className="btn primary" data-testid="agentsmd-save" disabled={!mdDirty || mdSaving} onClick={() => void saveMd()}>
                  {mdSaving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {mdConfirmDiscard && (
        <Dialog
          title="放弃未保存的修改？"
          onClose={() => setMdConfirmDiscard(false)}
          onConfirm={() => {
            setMdConfirmDiscard(false)
            setMdSel(null)
            setMdDirty(false)
            setMdError(null)
          }}
          confirmLabel="放弃修改"
          cancelLabel="继续编辑"
        >
          <p className="settings-tip">AGENTS.md 有未保存的修改，关闭后将丢失这些内容。</p>
        </Dialog>
      )}
    </div>
  )

  function requestDiscard() {
    if (!mdSel) return
    if (mdDirty && !mdSaving) setMdConfirmDiscard(true)
    else closeMd()
  }

  function closeMd() {
    setMdSel(null)
    setMdDirty(false)
    setMdError(null)
  }

  async function saveMd() {
    if (!mdSel) return
    setMdSaving(true)
    setMdError(null)
    try {
      await api.invoke(IPC.agentsMdSave, { kind: mdSel.kind, id: mdSel.id, content: mdContent })
      closeMd()
      void refreshMd()
    } catch (err) {
      // 保存失败：保留编辑内容，错误可见可重试
      setMdError(`保存失败：${String((err as Error).message).slice(0, 160)}`)
    } finally {
      setMdSaving(false)
    }
  }
}
