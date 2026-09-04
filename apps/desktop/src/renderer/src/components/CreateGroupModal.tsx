import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, XIAOJIE_ID } from '@jeff/core'

/** 发起群聊 = 创建项目群：群名/图标/群主/成员 */
export default function CreateGroupModal(props: { onClose: () => void }): React.JSX.Element {
  const agents = useStore((s) => s.agents)
  const [title, setTitle] = useState('')
  const [icon, setIcon] = useState('👥')
  const [description, setDescription] = useState('')
  const [leaderId, setLeaderId] = useState('')
  const [memberIds, setMemberIds] = useState<string[]>([])

  const toggleMember = (id: string) => {
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const save = async () => {
    if (!title.trim() || !leaderId) return
    const members = [leaderId, ...memberIds.filter((m) => m !== leaderId)]
    await api.invoke(IPC.projectSave, { title: title.trim(), icon: icon.trim() || '👥', description: description.trim(), leader_agent_id: leaderId, memberAgentIds: members })
    await useStore.getState().refreshProjects()
    props.onClose()
  }

  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">发起群聊（创建项目）</div>
        <label className="field">
          <span>群名 *</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：Jeff 官网开发" />
        </label>
        <div style={{ display: 'flex', gap: 12 }}>
          <label className="field" style={{ width: 90 }}>
            <span>图标</span>
            <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={4} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>群简介</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="这个项目是干嘛的" />
          </label>
        </div>
        <label className="field">
          <span>群主（leader，统筹一切）*</span>
          <select value={leaderId} onChange={(e) => setLeaderId(e.target.value)}>
            <option value="">选择智能体…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.avatar} {a.name}
                {a.builtin ? '（内置）' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>群成员（可多选，群主自动入群）</span>
          <div className="member-picker">
            {agents
              .filter((a) => a.id !== leaderId)
              .map((a) => (
                <button
                  key={a.id}
                  className={`member-chip ${memberIds.includes(a.id) ? 'on' : ''}`}
                  onClick={() => toggleMember(a.id)}
                  type="button"
                >
                  {a.avatar} {a.name}
                </button>
              ))}
            {agents.length === 0 && <span className="settings-tip">还没有智能体：先到「智能体」页或找小杰创建</span>}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn primary" disabled={!title.trim() || !leaderId} onClick={() => void save()}>
            建群
          </button>
        </div>
        <p className="settings-tip" style={{ marginTop: 8 }}>
          提示：也可以直接跟小杰说「帮我建一个项目群」，让它代劳。
        </p>
      </div>
    </div>
  )
}
