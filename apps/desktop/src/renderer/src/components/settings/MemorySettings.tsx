import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { IPC, type MemoryScopeInfo } from '@jeff/core'

/** 设置 → 记忆：全局用户画像 / 各智能体 / 各项目群，分层展示（空记忆有占位说明） */
export default function MemorySettings(): React.JSX.Element {
  const [scopes, setScopes] = useState<MemoryScopeInfo[]>([])
  const [sel, setSel] = useState<MemoryScopeInfo | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

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

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = async (m: MemoryScopeInfo, resetDirty = true) => {
    const data = await api.invoke<{ content: string; label: string }>(IPC.memoryGet, { kind: m.kind, id: m.id })
    setSel(m)
    setContent(data.content)
    if (resetDirty) setDirty(false)
  }

  const groups = useMemo(() => {
    const user = scopes.filter((s) => s.kind === 'user')
    const agents = scopes.filter((s) => s.kind === 'agent')
    const projects = scopes.filter((s) => s.kind === 'project')
    return [
      { title: '全局', hint: '用户画像，由小杰在对话中维护', items: user },
      { title: '智能体记忆', hint: '每个智能体各自的长期记忆', items: agents },
      { title: '项目群记忆', hint: '群聊中自动沉淀的项目共享记忆，群内成员共同读写', items: projects },
    ]
  }, [scopes])

  return (
    <div className="settings-content">
      <h2 className="settings-title">记忆</h2>
      <p className="settings-tip">
        长期记忆按范围分层：全局用户画像（1 份）、每个智能体一份、每个项目群一份。对话中由 agent 用 jeff_memory 工具自动读写；这里可以人工查看和编辑。条目以 § 分隔。
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
              项目群记忆在群聊对话中自动沉淀；新建项目群后会出现在这里。
            </div>
          </div>
          <div className="memory-editor">
            {sel ? (
              <>
                <div className="memory-editor-head">
                  <span>{sel.label} 的记忆</span>
                  <span className="settings-tip">{sel.file}</span>
                </div>
                <textarea
                  rows={14}
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value)
                    setDirty(true)
                  }}
                  placeholder="暂无记忆。每行一条；也可整段编辑，保存时按 § 分隔解析。"
                  style={{ fontFamily: 'inherit', fontSize: 12 }}
                />
                <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
                  <button
                    className="btn primary"
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
              </>
            ) : (
              <div className="empty-card">选择左侧任意记忆范围查看内容</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
