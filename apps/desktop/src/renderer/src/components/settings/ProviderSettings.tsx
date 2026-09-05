import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'
import { IPC, BUILTIN_PROVIDER_PRESETS, type ProviderSetting } from '@jeff/core'

/** 设置 → 模型供应商：provider 管理 + 默认模型 */
export default function ProviderSettings(): React.JSX.Element {
  const { refreshCatalog, appInfo } = useStore()
  const [providers, setProviders] = useState<ProviderSetting[]>([])
  const [defaultModel, setDefaultModel] = useState<{ providerID: string; modelID: string } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [adding, setAdding] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const load = async () => {
    const data = await api.invoke<{ providers: ProviderSetting[]; defaultModel: { providerID: string; modelID: string } | null }>(IPC.providersList)
    setProviders(data.providers)
    setDefaultModel(data.defaultModel)
    setDirty(false)
    await refreshCatalog()
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await api.invoke(IPC.providersSave, { providers, defaultModel })
      await load()
      setSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-content">
      <h2 className="settings-title">模型供应商</h2>
      <p className="settings-tip">
        内置预设只需填 API Key；自定义 OpenAI 兼容端点需填 baseURL 和模型 id。保存后会重启后台引擎使其生效。
      </p>

      {providers.length === 0 && (
        <div className="empty-card">
          还没有配置任何模型供应商。点击下方「添加提供商」，选一个预设（如硅基流动、DeepSeek）填入 API Key 即可开始对话。
        </div>
      )}
      <div className="provider-list">
        {providers.map((p) => (
          <div key={p.id} className="provider-row">
            <div className="provider-main">
              <div className="provider-name">
                {p.name || p.id} <span className="tag">{p.kind === 'custom' ? '自定义' : '预设'}</span>
                <span className="tag">id: {p.id}</span>
              </div>
              <div className="provider-sub">
                {p.kind === 'custom' ? `baseURL: ${p.baseURL || '未填'}` : '密钥已配置'}
                {p.apiKey ? ` · Key: ${p.apiKey.slice(0, 4)}…` : ' · 未配置 Key'}
              </div>
            </div>
            <button className="text-btn danger" onClick={() => { setProviders((arr) => arr.filter((x) => x.id !== p.id)); setDirty(true) }}>移除</button>
          </div>
        ))}
      </div>
      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn" onClick={() => setAdding(true)}>+ 添加提供商</button>
      </div>

      <h2 className="settings-title">默认模型</h2>
      <p className="settings-tip">小杰与未指定模型的智能体使用该模型；每条会话也可在输入框上方临时切换。</p>
      <ModelPicker value={defaultModel} onChange={(m) => { setDefaultModel(m); setDirty(true) }} />

      <div className="settings-actions">
        <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? '保存中…' : `保存${dirty ? '（未保存更改）' : ''}`}
        </button>
        {savedAt && !dirty && <span className="settings-tip" style={{ alignSelf: 'center' }}>✅ 已保存（{new Date(savedAt).toLocaleTimeString()}）</span>}
        {appInfo && <span className="settings-tip" style={{ marginLeft: 'auto', alignSelf: 'center' }}>引擎状态：{appInfo.sidecarStatus}</span>}
      </div>

      {adding && (
        <AddProvider
          onClose={() => setAdding(false)}
          onAdd={(p) => {
            setProviders((prev) => [...prev.filter((x) => x.id !== p.id), p])
            setDirty(true)
            setAdding(false)
          }}
        />
      )}
    </div>
  )
}

function ModelPicker(props: { value: { providerID: string; modelID: string } | null; onChange: (m: { providerID: string; modelID: string } | null) => void }): React.JSX.Element {
  const catalog = useStore((s) => s.catalog)
  const models = catalog.flatMap((c) => c.models)
  const key = props.value ? `${props.value.providerID}/${props.value.modelID}` : ''
  return (
    <select className="model-picker" value={key} onChange={(e) => {
      const v = e.target.value
      props.onChange(v ? { providerID: v.split('/')[0], modelID: v.split('/')[1] } : null)
    }}>
      <option value="">（未设置）</option>
      {models.map((m) => (
        <option key={`${m.providerID}/${m.modelID}`} value={`${m.providerID}/${m.modelID}`}>{m.label}</option>
      ))}
    </select>
  )
}

function AddProvider(props: { onClose: () => void; onAdd: (p: ProviderSetting) => void }): React.JSX.Element {
  const [kind, setKind] = useState<'preset' | 'custom'>('preset')
  const [presetId, setPresetId] = useState(BUILTIN_PROVIDER_PRESETS[0].id)
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelsText, setModelsText] = useState('')
  const [attachment, setAttachment] = useState(false)

  const submit = () => {
    if (kind === 'preset') {
      props.onAdd({ id: presetId, kind: 'builtin', name: BUILTIN_PROVIDER_PRESETS.find((x) => x.id === presetId)?.name || presetId, apiKey: apiKey.trim() || undefined })
    } else {
      const models = modelsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((mid) => ({ id: mid, ...(attachment ? { attachment: true } : {}) }))
      props.onAdd({ id: id.trim(), kind: 'custom', name: name.trim() || id.trim(), baseURL: baseURL.trim(), apiKey: apiKey.trim() || undefined, models })
    }
  }

  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">添加模型提供商</div>
        <div className="seg">
          <button className={`seg-item ${kind === 'preset' ? 'on' : ''}`} onClick={() => setKind('preset')}>内置预设</button>
          <button className={`seg-item ${kind === 'custom' ? 'on' : ''}`} onClick={() => setKind('custom')}>OpenAI 兼容</button>
        </div>
        {kind === 'preset' ? (
          <>
            <label className="field">
              <span>提供商</span>
              <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                {BUILTIN_PROVIDER_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <p className="settings-tip">保存后，该提供商的可用模型会出现在默认模型下拉与聊天输入框的模型切换里。</p>
          </>
        ) : (
          <>
            <label className="field">
              <span>id *</span>
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="如 my-proxy" />
            </label>
            <label className="field">
              <span>名称</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 我的中转" />
            </label>
            <label className="field">
              <span>baseURL *</span>
              <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://api.example.com/v1" />
            </label>
            <label className="field">
              <span>模型 id（每行一个）</span>
              <textarea rows={3} value={modelsText} onChange={(e) => setModelsText(e.target.value)} placeholder={'gpt-4o\ndeepseek-chat'} />
            </label>
            <label className="field check-field">
              <input type="checkbox" checked={attachment} onChange={(e) => setAttachment(e.target.checked)} />
              <span>这些模型支持图片输入（多模态，如 Qwen-VL、GPT-4o）；勾选后聊天里可发送图片</span>
            </label>
          </>
        )}
        <label className="field">
          <span>API Key</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>取消</button>
          <button
            className="btn primary"
            disabled={kind === 'preset' ? false : !id.trim() || !baseURL.trim()}
            onClick={submit}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  )
}
