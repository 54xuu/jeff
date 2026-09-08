import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, XIAOJIE_ID } from '@jeff/core'
import { EmojiPickerButton } from './ui/EmojiPicker'

/** 发起群聊 = 创建项目群：群名/图标/群主/成员/工作空间目录 */
export default function CreateGroupModal(props: { onClose: () => void }): React.JSX.Element {
  const { agents } = useStore()
  const [title, setTitle] = useState('')
  const [icon, setIcon] = useState('👥')
  const [description, setDescription] = useState('')
  const [leaderId, setLeaderId] = useState('')
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [error, setError] = useState<string | null>(null)

  const toggleMember = (id: string) => {
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const pickDir = async () => {
    const dir = await api.invoke<string | null>(IPC.dialogPickDir, { title: '选择工作空间目录', defaultPath: workspaceDir || undefined })
    if (dir) setWorkspaceDir(dir)
  }

  const save = async () => {
    if (!title.trim() || !leaderId) return
    const members = [leaderId, ...memberIds.filter((m) => m !== leaderId)]
    try {
      await api.invoke(IPC.projectSave, {
        title: title.trim(),
        icon: icon.trim() || '👥',
        description: description.trim(),
        leader_agent_id: leaderId,
        memberAgentIds: members,
        workspace_dir: workspaceDir.trim(),
      })
      await useStore.getState().refreshProjects()
      props.onClose()
    } catch (err) {
      setError(String((err as Error).message).slice(0, 160))
    }
  }

  return (
    <div className="modal-mask" data-testid="create-group-modal" onClick={props.onClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">发起群聊（创建项目）</div>
        <label className="field">
          <span>群名 *</span>
          <input value={title} data-testid="group-title" onChange={(e) => setTitle(e.target.value)} placeholder="如：Jeff 官网开发" />
        </label>
        <div style={{ display: 'flex', gap: 12 }}>
          <label className="field" style={{ width: 110 }}>
            <span>图标</span>
            <div className="emoji-input-row">
              <input value={icon} onChange={(e) => setIcon(e.target.value)} />
              <EmojiPickerButton value={icon} onPick={setIcon} testId="group-icon-create-picker" />
            </div>
          </label>
        </div>
        <label className="field">
          <span>群简介（项目背景，会注入群聊 system）</span>
          <textarea rows={4} value={description} data-testid="group-desc" onChange={(e) => setDescription(e.target.value)} placeholder="这个项目是干嘛的、背景约束、验收口径…" />
        </label>
        <label className="field">
          <span>工作空间目录（不选 = Jeff 默认工作区）</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={workspaceDir} onChange={(e) => setWorkspaceDir(e.target.value)} placeholder="留空 = Jeff 默认工作区；群内产出的文件都保存在这里" style={{ flex: 1 }} />
            <button className="btn" type="button" onClick={() => void pickDir()}>浏览…</button>
          </div>
        </label>
        <label className="field">
          <span>群主（leader，统筹一切）*</span>
          <select value={leaderId} data-testid="group-leader" onChange={(e) => setLeaderId(e.target.value)}>
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
          <span>工作者（worker，可多选；群主自动入群，角色统一为 worker）</span>
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
          {error && <span className="settings-error" style={{ marginRight: 'auto', alignSelf: 'center' }}>⚠️ {error}</span>}
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn primary" data-testid="group-create-confirm" disabled={!title.trim() || !leaderId} onClick={() => void save()}>
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
