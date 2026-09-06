import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, type AgentInfo, type ModelOption } from '@jeff/core'
import Avatar from './Avatar'

type ThinkingTierOpt = '' | 'none' | 'low' | 'high' | 'max'

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

  const save = async (d: { id?: string; name: string; avatar: string; description: string; instructions: string; model_provider: string; model_id: string; thinking: string }) => {
    await api.invoke(IPC.agentsUpsert, d)
    await refreshAgents()
    if (d.id) setSelId(d.id)
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
    <div className="agents-page">
      <div className="agents-left">
        <div className="list-header">
          <span>通讯录 · 智能体</span>
          <button className="icon-btn" title="新建智能体" onClick={() => setCreating(true)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        {list.map((a) => (
          <div key={a.id} className={`contact-card ${selId === a.id ? 'selected' : ''}`} onClick={() => { setSelId(a.id); setCreating(false) }}>
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
          <AgentEditor key="new" initial={{ isNew: true }} models={models} onCancel={() => setCreating(false)} onSave={(d) => void save(d)} />
        ) : sel ? (
          <AgentEditor
            key={sel.id}
            initial={sel}
            models={models}
            onDelete={sel.builtin ? undefined : () => void remove(sel)}
            onCancel={() => setSelId(sel.id)}
            onSave={(d) => void save(d)}
            onChat={() => {
              useStore.getState().setActive({ kind: 'agent', id: sel.id })
              useStore.getState().setTab('chats')
            }}
          />
        ) : (
          <div className="empty-hint"><p>选择左侧智能体查看 / 编辑，或点右上角「+」新建</p></div>
        )}
      </div>
    </div>
  )
}

/** 右侧编辑表单（小杰：名称/头像/指令锁定，仅模型与思考程度可改） */
function AgentEditor(props: {
  initial: Partial<AgentInfo> & { isNew?: boolean }
  models: ModelOption[]
  onCancel: () => void
  onSave: (d: { id?: string; name: string; avatar: string; description: string; instructions: string; model_provider: string; model_id: string; thinking: string }) => void
  onDelete?: () => void
  onChat?: () => void
}): React.JSX.Element {
  const a = props.initial
  const locked = !!a.builtin && !a.isNew
  const [name, setName] = useState(a.name || '')
  const [avatar, setAvatar] = useState(a.avatar || '🤖')
  const [description, setDescription] = useState(a.description || '')
  const [instructions, setInstructions] = useState(a.instructions || '')
  const [modelKey, setModelKey] = useState(a.model_provider && a.model_id ? `${a.model_provider}/${a.model_id}` : '')
  const [thinking, setThinking] = useState<ThinkingTierOpt>((a.thinking as ThinkingTierOpt) || '')
  const [saving, setSaving] = useState(false)

  const submit = () => {
    if (!locked && !name.trim()) return
    setSaving(true)
    props.onSave({
      ...(a.id ? { id: a.id } : {}),
      name: locked ? a.name || '小杰' : name.trim(),
      avatar: locked ? a.avatar || '🧑‍💻' : avatar.trim() || '🤖',
      description: locked ? a.description || '' : description.trim(),
      instructions: locked ? a.instructions || '' : instructions,
      model_provider: modelKey ? modelKey.split('/')[0] : '',
      model_id: modelKey ? modelKey.split('/')[1] : '',
      thinking,
    })
  }

  return (
    <div className="agents-editor">
      <div className="agents-editor-head">
        <Avatar emoji={locked ? a.avatar || '🧑‍💻' : avatar} size={44} />
        <div>
          <div className="contact-name big">{a.isNew ? '新建智能体' : `${a.name} ${locked ? '（内置 · 名称与指令锁定）' : ''}`}</div>
          <div className="contact-desc">{a.isNew ? '创建后可在聊天列表直接对话' : a.description || '（无简介）'}</div>
        </div>
        <div className="settings-actions" style={{ marginLeft: 'auto', margin: 0 }}>
          {props.onChat && !a.isNew && <button className="btn" onClick={props.onChat}>发消息</button>}
          {props.onDelete && <button className="btn danger" onClick={props.onDelete}>删除</button>}
        </div>
      </div>

      <div className="pv-grid">
        {!locked && (
          <>
            <label className="field">
              <span>名字 *</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：架构师阿伟" />
            </label>
            <label className="field">
              <span>头像 emoji</span>
              <input value={avatar} onChange={(e) => setAvatar(e.target.value)} maxLength={4} />
            </label>
          </>
        )}
        {!locked && (
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>简介</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明它是干嘛的" />
          </label>
        )}
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span>模型（留空 = 默认用第一个启用提供商的第一个模型）</span>
          <select value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
            <option value="">跟随默认</option>
            {props.models.map((m) => (
              <option key={`${m.providerID}/${m.modelID}`} value={`${m.providerID}/${m.modelID}`}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>思考程度（默认 = 跟随模型配置）</span>
          <select value={thinking} onChange={(e) => setThinking(e.target.value as ThinkingTierOpt)}>
            <option value="">默认</option>
            <option value="none">无思考（none）</option>
            <option value="low">低（low）</option>
            <option value="high">高（high）</option>
            <option value="max">最大（max）</option>
          </select>
        </label>
        {!locked && (
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>身份指令（system prompt）</span>
            <textarea rows={7} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="它擅长什么、行为规矩、输出格式…" />
          </label>
        )}
      </div>

      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" disabled={saving || (!locked && !name.trim())} onClick={submit}>{saving ? '保存中…' : '保存'}</button>
        <button className="btn" onClick={props.onCancel}>取消</button>
      </div>
    </div>
  )
}
