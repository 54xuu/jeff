import { useState } from 'react'
import { formatModelKey, parseModelKey, type AgentInfo, type ModelOption } from '@jeff/core'
import Avatar from './Avatar'
import ModelPickerCombo from './ModelPickerCombo'
import { Button } from './ui/Button'
import { Field } from './ui/Field'
import { Toast } from './ui/Toast'

export type ThinkingTierOpt = '' | 'none' | 'low' | 'high' | 'max'

export type AgentEditorSave = {
  id?: string
  name: string
  avatar: string
  description: string
  instructions: string
  model_provider: string
  model_id: string
  thinking: string
}

/** 智能体编辑表单（通讯录 / 私聊资料抽屉共用；小杰：名称/头像/指令锁定，仅模型与思考程度可改） */
export default function AgentEditor(props: {
  initial: Partial<AgentInfo> & { isNew?: boolean }
  models: ModelOption[]
  onCancel: () => void
  onSave: (d: AgentEditorSave) => Promise<void>
  onDelete?: () => void
  onChat?: () => void
  /** 抽屉场景隐藏「发消息」等导航动作 */
  compact?: boolean
}): React.JSX.Element {
  const a = props.initial
  const locked = !!a.builtin && !a.isNew
  const [name, setName] = useState(a.name || '')
  const [avatar, setAvatar] = useState(a.avatar || '🤖')
  const [description, setDescription] = useState(a.description || '')
  const [instructions, setInstructions] = useState(a.instructions || '')
  const [modelKey, setModelKey] = useState(a.model_provider && a.model_id ? formatModelKey(a.model_provider, a.model_id) : '')
  const [thinking, setThinking] = useState<ThinkingTierOpt>((a.thinking as ThinkingTierOpt) || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!locked && !name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const parsed = parseModelKey(modelKey)
      await props.onSave({
        ...(a.id ? { id: a.id } : {}),
        name: locked ? a.name || '小杰' : name.trim(),
        avatar: locked ? a.avatar || '🧑‍💻' : avatar.trim() || '🤖',
        description: locked ? a.description || '' : description.trim(),
        instructions: locked ? a.instructions || '' : instructions,
        model_provider: parsed?.providerID || '',
        model_id: parsed?.modelID || '',
        thinking,
      })
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="agents-editor" data-testid="agent-editor">
      <div className="agents-editor-head">
        <Avatar emoji={locked ? a.avatar || '🧑‍💻' : avatar} size={44} />
        <div>
          <div className="contact-name big">{a.isNew ? '新建智能体' : `${a.name} ${locked ? '（内置 · 名称与指令锁定）' : ''}`}</div>
          <div className="contact-desc">{a.isNew ? '创建后可在聊天列表直接对话' : a.description || '（无简介）'}</div>
        </div>
        <div className="settings-actions" style={{ marginLeft: 'auto', margin: 0 }}>
          {props.onChat && !a.isNew && !props.compact && (
            <Button data-testid="agent-chat" onClick={props.onChat}>
              发消息
            </Button>
          )}
          {props.onDelete && (
            <Button variant="danger" onClick={props.onDelete}>
              删除
            </Button>
          )}
        </div>
      </div>

      <div className="pv-grid">
        {!locked && (
          <>
            <Field label="名字 *">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：架构师阿伟" data-testid="agent-name" />
            </Field>
            <Field label="头像 emoji">
              <input value={avatar} onChange={(e) => setAvatar(e.target.value)} maxLength={4} />
            </Field>
          </>
        )}
        {!locked && (
          <Field label="简介" span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明它是干嘛的" />
          </Field>
        )}
        <Field label="模型（留空 = 默认用第一个启用提供商的第一个模型）" span>
          <ModelPickerCombo value={modelKey} onChange={setModelKey} placeholderEmpty="跟随默认" />
        </Field>
        <Field label="思考程度（默认 = 跟随模型配置）">
          <select value={thinking} onChange={(e) => setThinking(e.target.value as ThinkingTierOpt)} data-testid="agent-thinking">
            <option value="">默认</option>
            <option value="none">无思考（none）</option>
            <option value="low">低（low）</option>
            <option value="high">高（high）</option>
            <option value="max">最大（max）</option>
          </select>
        </Field>
        {!locked && (
          <Field label="身份指令（system prompt）" span>
            <textarea rows={7} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="它擅长什么、行为规矩、输出格式…" data-testid="agent-instructions" />
          </Field>
        )}
      </div>

      {error && <Toast kind="error" message={error} onClose={() => setError(null)} />}

      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <Button variant="primary" disabled={saving || (!locked && !name.trim())} data-testid="agent-save" onClick={() => void submit()}>
          {saving ? '保存中…' : '保存'}
        </Button>
        <Button onClick={props.onCancel}>取消</Button>
      </div>
    </div>
  )
}
