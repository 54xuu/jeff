import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, type AgentInfo, type ModelOption } from '@jeff/core'
import Avatar from './Avatar'
import AgentEditor, { type AgentEditorSave } from './AgentEditor'

/** 通讯录 · 智能体：左右布局（左列表 / 右编辑表单），每个智能体可设指令、模型、思考程度 */
export default function AgentsPage(): React.JSX.Element {
  const { agents, catalog, refreshAgents } = useStore()
  const [selId, setSelId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!selId && agents.length > 0) setSelId(agents[0].id)
  }, [agents, selId])

  const sel = agents.find((a) => a.id === selId) ?? null
  const models: ModelOption[] = catalog.flatMap((c) => c.models)

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

  const list = agents
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
        {list.map((a) => (
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

      <div className="agents-right">
        {creating ? (
          <AgentEditor key="new" initial={{ isNew: true }} models={models} onCancel={() => setCreating(false)} onSave={save} />
        ) : sel ? (
          <AgentEditor
            key={sel.id}
            initial={sel}
            models={models}
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
