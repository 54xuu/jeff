import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, type AgentInfo, type ModelOption } from '@jeff/core'
import Avatar from './Avatar'
import AgentEditor, { type AgentEditorSave } from './AgentEditor'

const DEFAULT_GROUP = '默认'

/**
 * 通讯录 · 智能体：左侧按「分类」折叠的分组列表，右侧编辑表单。
 * 智能体多了以后一长条列表很难找，分组是主要导航手段；分类直接在编辑表单里新建（不单独建表）。
 */
export default function AgentsPage(): React.JSX.Element {
  const { agents, catalog, refreshAgents } = useStore()
  const [selId, setSelId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!selId && agents.length > 0) setSelId(agents[0].id)
  }, [agents, selId])

  const sel = agents.find((a) => a.id === selId) ?? null
  const models: ModelOption[] = catalog.flatMap((c) => c.models)

  /** 分类分组：默认组永远排最后；组内保持后端顺序（内置优先、再按名字） */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = q ? agents.filter((a) => a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q) || (a.category || '').toLowerCase().includes(q)) : agents
    const map = new Map<string, AgentInfo[]>()
    for (const a of hit) {
      const key = (a.category || '').trim() || DEFAULT_GROUP
      const arr = map.get(key)
      if (arr) arr.push(a)
      else map.set(key, [a])
    }
    return Array.from(map.entries()).sort(([x], [y]) => {
      if (x === DEFAULT_GROUP) return 1
      if (y === DEFAULT_GROUP) return -1
      return x.localeCompare(y, 'zh-CN')
    })
  }, [agents, query])

  const save = async (d: AgentEditorSave) => {
    const res = await api.invoke<AgentInfo>(IPC.agentsUpsert, d)
    await refreshAgents()
    if (res?.id) setSelId(res.id)
    else if (d.id) setSelId(d.id)
    setCreating(false)
  }

  const remove = async (a: AgentInfo) => {
    if (!confirm(`确定删除「${a.name}」？该操作可由历史记录恢复（软删除）。`)) return
    await api.invoke(IPC.agentsDelete, { id: a.id })
    await refreshAgents()
    setSelId(null)
  }

  const allCategories = useMemo(() => {
    const set = new Set<string>()
    for (const a of agents) {
      const c = (a.category || '').trim()
      if (c) set.add(c)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [agents])

  return (
    <div className="agents-page" data-testid="agents-page">
      <div className="agents-left">
        <div className="list-header">
          <span>通讯录 · 智能体</span>
          <button className="icon-btn" title="新建智能体" data-testid="agent-create" onClick={() => setCreating(true)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <div className="agents-search">
          <div className="search-field">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.6-3.6" />
            </svg>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名字 / 简介 / 分类" data-testid="agent-search" spellCheck={false} />
          </div>
        </div>
        {groups.map(([name, list]) => {
          const isCollapsed = !!collapsed[name]
          return (
            <div className="agent-group" key={name} data-testid={`agent-group-${name}`}>
              <button
                className="agent-group-head"
                data-testid={`agent-group-toggle-${name}`}
                onClick={() => setCollapsed((c) => ({ ...c, [name]: !c[name] }))}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={isCollapsed ? 'rot' : ''}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
                <span className="agent-group-name">{name}</span>
                <span className="agent-group-count">{list.length}</span>
              </button>
              {!isCollapsed &&
                list.map((a) => (
                  <div
                    key={a.id}
                    className={`contact-card ${selId === a.id ? 'selected' : ''}`}
                    data-testid={`agent-card-${a.id}`}
                    onClick={() => {
                      setSelId(a.id)
                      setCreating(false)
                    }}
                  >
                    <Avatar emoji={a.avatar} />
                    <div className="contact-body">
                      <div className="contact-name">
                        {a.name} {a.builtin && <span className="tag tag-green">内置</span>}
                      </div>
                      <div className="contact-desc">{a.description || '（无简介）'}</div>
                    </div>
                  </div>
                ))}
            </div>
          )
        })}
        {groups.length === 0 && <p className="side-empty">没有匹配的智能体</p>}
      </div>

      <div className="agents-right">
        {creating ? (
          <AgentEditor key="new" initial={{ isNew: true }} models={models} categories={allCategories} onCancel={() => setCreating(false)} onSave={save} />
        ) : sel ? (
          <AgentEditor
            key={sel.id}
            initial={sel}
            models={models}
            categories={allCategories}
            onDelete={sel.builtin ? undefined : () => void remove(sel)}
            onCancel={() => setSelId(sel.id)}
            onSave={save}
            onChat={() => {
              useStore.getState().setActive({ kind: 'agent', id: sel.id })
              useStore.getState().setTab('chats')
            }}
          />
        ) : (
          <div className="empty-hint">
            <p>选择左侧智能体查看 / 编辑，或点右上角「+」新建</p>
          </div>
        )}
      </div>
    </div>
  )
}
