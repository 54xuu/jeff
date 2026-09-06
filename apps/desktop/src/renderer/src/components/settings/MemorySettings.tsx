import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { IPC, type MemoryScopeInfo, type AgentsMdInfo } from '@jeff/core'

/** 记忆字符预算（与 memory/store.ts 保持一致） */
const BUDGET = { user: 1375, agent: 2200, project: 2200 } as const

interface MemoryData {
  content: string
  label: string
  budget?: number
}

/** 设置 → 记忆：分层 scope + 条目级管理（§ 分隔）+ 字符预算占用 + AGENTS.md（用户级/项目级） */
export default function MemorySettings(): React.JSX.Element {
  const [scopes, setScopes] = useState<MemoryScopeInfo[]>([])
  const [sel, setSel] = useState<MemoryScopeInfo | null>(null)
  const [content, setContent] = useState('')
  const [budget, setBudget] = useState<number>(BUDGET.agent)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [agentsMds, setAgentsMds] = useState<AgentsMdInfo[]>([])
  const [mdSel, setMdSel] = useState<AgentsMdInfo | null>(null)
  const [mdContent, setMdContent] = useState('')
  const [mdDirty, setMdDirty] = useState(false)

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

  const pick = async (m: MemoryScopeInfo, resetDirty = true) => {
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
    const user = scopes.filter((s) => s.kind === 'user')
    const agents = scopes.filter((s) => s.kind === 'agent')
    const projects = scopes.filter((s) => s.kind === 'project')
    return [
      { title: '全局', hint: '用户画像，由小杰在对话中维护', items: user },
      { title: '智能体记忆', hint: '每个智能体各自的长期记忆', items: agents },
      { title: '项目群记忆', hint: '群聊中自动沉淀的项目共享记忆', items: projects },
    ]
  }, [scopes])

  return (
    <div className="settings-content" data-testid="memory-settings">
      <h2 className="settings-title">记忆</h2>
      <p className="settings-tip">
        长期记忆按范围分层（全局 / 智能体 / 项目群），由 agent 在对话中自主读写（说「记住…」「忘记…」即可）；这里可人工查看、编辑、删除单条。为控制 token 消耗，每个范围有字符预算，超出时 agent 会自动整合。
      </p>

      {!loaded && <p className="settings-tip">加载中…</p>}
      {loaded && (
        <div className="memory-layout">
          <div className="memory-scopes">
            {groups.map((g) => (
              <div key={g.title} className="memory-group">
                <div className="memory-group-title">
                  {g.title}
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
                  <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
                    <button
                      className="btn primary"
                      data-testid="memory-save"
                      disabled={!dirty || saving}
                      onClick={async () => {
                        if (!sel) return
                        setSaving(true)
                        try {
                          await api.invoke(IPC.memorySave, { kind: sel.kind, id: sel.id, content })
                          setDirty(false)
                          await refresh(`${sel.kind}:${sel.id}`)
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
      )}

      <h2 className="settings-title" style={{ marginTop: 24 }}>AGENTS.md（规则文件）</h2>
      <p className="settings-tip">
        用户级 AGENTS.md 对所有对话生效；项目级放在各群工作空间目录下，仅该群的会话生效（每轮自动注入上下文）。
      </p>
      <div className="pv-detail">
        {agentsMds.length === 0 && <div className="empty-card">加载中…</div>}
        {agentsMds.map((m) => (
          <div key={`${m.kind}:${m.id}`} className="provider-row">
            <div className="provider-main">
              <div className="provider-name">
                {m.label}
                <span className={`tag ${m.exists ? 'tag-green' : ''}`}>{m.exists ? '已存在' : '未创建'}</span>
              </div>
              <div className="provider-sub">{m.file}</div>
            </div>
            <button className="text-btn" onClick={async () => {
              const data = await api.invoke<{ content: string; file: string }>(IPC.agentsMdGet, { kind: m.kind, id: m.id })
              setMdSel(m)
              setMdContent(data.content)
              setMdDirty(false)
            }}>
              编辑
            </button>
          </div>
        ))}
      </div>

      {mdSel && (
        <div className="modal-mask" onClick={() => setMdSel(null)}>
          <div className="modal form" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">编辑 AGENTS.md</div>
            <p className="settings-tip">{mdSel.file}</p>
            <textarea
              rows={16}
              value={mdContent}
              onChange={(e) => { setMdContent(e.target.value); setMdDirty(true) }}
              placeholder={'# 我的全局规则\n- 回复用简体中文\n- 代码先解释再写…'}
              spellCheck={false}
              style={{ fontFamily: 'inherit', fontSize: 12 }}
            />
            <div className="modal-actions">
              <button className="btn" onClick={() => setMdSel(null)}>取消</button>
              <button className="btn primary" disabled={!mdDirty} onClick={async () => {
                if (!mdSel) return
                await api.invoke(IPC.agentsMdSave, { kind: mdSel.kind, id: mdSel.id, content: mdContent })
                setMdSel(null)
                void refreshMd()
              }}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
