import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, XIAOJIE_ID, type AgentInfo, type ModelOption } from '@jeff/core'
import Avatar from './Avatar'

type Editing = Partial<AgentInfo> & { isNew?: boolean }

export default function AgentsPage(): React.JSX.Element {
  const { agents, catalog } = useStore()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [detail, setDetail] = useState<AgentInfo | null>(null)

  const xiaojie = agents.find((a) => a.builtin)
  const others = agents.filter((a) => !a.builtin)

  return (
    <div className="agents-page">
      <div className="list-header">
        <span>通讯录 · 智能体</span>
        <button className="icon-btn" title="新建智能体" onClick={() => setEditing({ isNew: true, avatar: '🤖' })}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {xiaojie && (
        <div className="contact-card" onClick={() => setDetail(xiaojie)}>
          <Avatar emoji={xiaojie.avatar} />
          <div className="contact-body">
            <div className="contact-name">
              {xiaojie.name} <span className="tag tag-green">内置</span>
            </div>
            <div className="contact-desc">{xiaojie.description}</div>
          </div>
        </div>
      )}
      <div className="list-section">我的智能体（{others.length}）</div>
      {others.map((a) => (
        <div key={a.id} className="contact-card" onClick={() => setDetail(a)}>
          <Avatar emoji={a.avatar} />
          <div className="contact-body">
            <div className="contact-name">{a.name}</div>
            <div className="contact-desc">{a.description || '（无简介）'}</div>
          </div>
        </div>
      ))}

      {detail && <AgentDetail agent={detail} onClose={() => setDetail(null)} onEdit={() => { setEditing({ ...detail }); setDetail(null) }} onDelete={async () => {
        if (!confirm(`确定删除「${detail.name}」？该操作可由历史记录恢复（软删除）。`)) return
        await api.invoke(IPC.agentsDelete, { id: detail.id })
        setDetail(null)
        void useStore.getState().refreshAgents()
      }} />}

      {editing && (
        <AgentEditor
          initial={editing}
          models={catalog.flatMap((c) => c.models)}
          onClose={() => setEditing(null)}
          onSave={async (d) => {
            await api.invoke(IPC.agentsUpsert, d)
            setEditing(null)
            void useStore.getState().refreshAgents()
          }}
        />
      )}
    </div>
  )
}

function AgentDetail(props: { agent: AgentInfo; onClose: () => void; onEdit: () => void; onDelete: () => void }): React.JSX.Element {
  const a = props.agent
  const locked = a.builtin
  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Avatar emoji={a.avatar} size={52} />
          <div>
            <div className="contact-name big">
              {a.name} {locked && <span className="tag tag-green">内置</span>}
            </div>
            <div className="contact-desc">{a.description || '（无简介）'}</div>
          </div>
        </div>
        <div className="modal-sec">身份指令</div>
        <pre className="modal-pre">{a.instructions || '（无）'}</pre>
        <div className="modal-sec">默认模型</div>
        <div className="modal-line">{a.model_provider && a.model_id ? `${a.model_provider} / ${a.model_id}` : '跟随全局默认'}</div>
        <div className="modal-actions">
          {!locked && (
            <>
              <button className="btn" onClick={props.onEdit}>编辑</button>
              <button className="btn danger" onClick={() => void props.onDelete()}>删除</button>
            </>
          )}
          <button className="btn primary" onClick={() => { useStore.getState().setActive({ kind: 'agent', id: a.id }); useStore.getState().setTab('chats'); props.onClose() }}>发消息</button>
        </div>
      </div>
    </div>
  )
}

function AgentEditor(props: {
  initial: Editing
  models: ModelOption[]
  onClose: () => void
  onSave: (d: { id?: string; name: string; avatar: string; description: string; instructions: string; model_provider: string; model_id: string }) => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(props.initial.name || '')
  const [avatar, setAvatar] = useState(props.initial.avatar || '🤖')
  const [description, setDescription] = useState(props.initial.description || '')
  const [instructions, setInstructions] = useState(props.initial.instructions || '')
  const [modelKey, setModelKey] = useState(
    props.initial.model_provider && props.initial.model_id ? `${props.initial.model_provider}/${props.initial.model_id}` : '',
  )

  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{props.initial.isNew ? '新建智能体' : `编辑「${props.initial.name}」`}</div>
        <label className="field">
          <span>名字 *</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：架构师阿伟" />
        </label>
        <label className="field">
          <span>头像 emoji</span>
          <input value={avatar} onChange={(e) => setAvatar(e.target.value)} maxLength={4} />
        </label>
        <label className="field">
          <span>简介</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明它是干嘛的" />
        </label>
        <label className="field">
          <span>身份指令（system prompt）</span>
          <textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="它擅长什么、行为规矩、输出格式…" />
        </label>
        <label className="field">
          <span>默认模型</span>
          <select value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
            <option value="">跟随全局默认</option>
            {props.models.map((m) => (
              <option key={`${m.providerID}/${m.modelID}`} value={`${m.providerID}/${m.modelID}`}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() =>
              void props.onSave({
                ...(props.initial.id ? { id: props.initial.id } : {}),
                name: name.trim(),
                avatar: avatar.trim() || '🤖',
                description: description.trim(),
                instructions,
                model_provider: modelKey ? modelKey.split('/')[0] : '',
                model_id: modelKey ? modelKey.split('/')[1] : '',
              })
            }
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
