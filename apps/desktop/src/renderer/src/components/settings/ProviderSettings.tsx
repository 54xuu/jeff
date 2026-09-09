import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'
import { IPC, API_FORMATS, THINKING_TIERS, type ProviderSetting, type ProviderModelCfg, type ProviderProbeResult, type ThinkingTier } from '@jeff/core'
import { useDirtyClose } from '../ui/useDirtyClose'

/** 设置 → 模型供应商：横向 tabs + 每个提供商独立详情（无内置，专注自定义供应商） */
export default function ProviderSettings(): React.JSX.Element {
  const { refreshCatalog, refreshSettings, appInfo } = useStore()
  const [providers, setProviders] = useState<ProviderSetting[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)

  const load = async () => {
    const data = await api.invoke<{ providers: ProviderSetting[] }>(IPC.providersList)
    setProviders(data.providers)
    setDirty(false)
    setActiveId((cur) => (cur && data.providers.some((p) => p.id === cur) ? cur : data.providers[0]?.id ?? null))
    await refreshCatalog()
    await refreshSettings()
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await api.invoke(IPC.providersSave, { providers })
      await load()
      setSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }

  const active = providers.find((p) => p.id === activeId) ?? null
  const update = (fn: (arr: ProviderSetting[]) => ProviderSetting[]) => {
    setProviders((arr) => fn(arr))
    setDirty(true)
  }

  return (
    <div className="settings-content">
      <h2 className="settings-title">模型供应商</h2>
      <p className="settings-tip">配置自定义模型提供商（Chat / Responses / Anthropic 格式）。保存后自动重启后台引擎生效；每次新会话默认使用第一个启用提供商的第一个模型。</p>

      {/* 横向 tabs：提供商列表 + 永远在最后的【+】 */}
      <div className="pv-tabs">
        {providers.map((p) => (
          <button key={p.id} className={`pv-tab ${p.id === activeId ? 'on' : ''}`} onClick={() => setActiveId(p.id)}>
            <span className={`pv-dot ${p.enabled ? 'on' : ''}`} />
            {p.name || p.id}
          </button>
        ))}
        <button className="pv-tab pv-add" title="添加自定义提供商" onClick={() => setAdding(true)}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {providers.length === 0 && <div className="empty-card">还没有模型供应商：点上方【+】添加一个（如硅基流动、DeepSeek、OpenRouter 中转等）。</div>}

      {active && (
        <ProviderDetail
          key={active.id}
          provider={active}
          canDelete={providers.length > 0}
          onChange={(next) => update((arr) => arr.map((p) => (p.id === next.id ? next : p)))}
          onDelete={() => {
            const rest = providers.filter((p) => p.id !== active.id)
            setProviders(rest)
            setActiveId(rest[0]?.id ?? null)
            setDirty(true)
          }}
        />
      )}

      <div className="settings-actions">
        <button className="btn primary" data-testid="providers-save" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? '保存中…（引擎重启）' : `保存${dirty ? '（未保存更改）' : ''}`}
        </button>
        {savedAt && !dirty && <span className="settings-tip" style={{ alignSelf: 'center' }}>✅ 已保存（{new Date(savedAt).toLocaleTimeString()}）</span>}
        {appInfo && <span className="settings-tip" style={{ marginLeft: 'auto', alignSelf: 'center' }}>引擎状态：{appInfo.sidecarStatus}</span>}
      </div>

      {adding && (
        <AddProvider
          existingIds={providers.map((p) => p.id)}
          onClose={() => setAdding(false)}
          onAdd={(p) => {
            update((arr) => [...arr.filter((x) => x.id !== p.id), p])
            setActiveId(p.id)
            setAdding(false)
          }}
        />
      )}
    </div>
  )
}

/** 单个提供商详情（右侧内容） */
function ProviderDetail(props: {
  provider: ProviderSetting
  canDelete: boolean
  onChange: (p: ProviderSetting) => void
  onDelete: () => void
}): React.JSX.Element {
  const p = props.provider
  const [addingModel, setAddingModel] = useState(false)
  const [editModel, setEditModel] = useState<string | null>(null)
  const [probingId, setProbingId] = useState<string | null>(null)
  const [probeResults, setProbeResults] = useState<Record<string, ProviderProbeResult>>({})

  const set = (patch: Partial<ProviderSetting>) => {
    // 配置一变，旧探测结果即失效
    setProbeResults({})
    props.onChange({ ...p, ...patch })
  }

  const probeModel = async (modelId: string) => {
    setProbingId(modelId)
    try {
      const r = await api.invoke<ProviderProbeResult>(IPC.providersProbe, { provider: p, modelId })
      setProbeResults((prev) => ({ ...prev, [modelId]: r }))
    } catch (err) {
      setProbeResults((prev) => ({ ...prev, [modelId]: { ok: false, error: String((err as Error).message).slice(0, 200), elapsedMs: 0 } }))
    } finally {
      setProbingId(null)
    }
  }

  const formatHint = useMemo(() => API_FORMATS.find((f) => f.id === p.apiFormat)?.hint ?? '', [p.apiFormat])

  return (
    <div className="pv-detail">
      <div className="pv-grid">
        <label className="field">
          <span>名称</span>
          <input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="如 我的中转" />
        </label>
        <label className="field">
          <span>id（唯一标识）</span>
          <input value={p.id} disabled title="id 创建后不可修改" />
        </label>
        <label className="field">
          <span>API 格式</span>
          <select value={p.apiFormat} onChange={(e) => set({ apiFormat: e.target.value as ProviderSetting['apiFormat'] })}>
            {API_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>API Key</span>
          <input type="password" value={p.apiKey || ''} onChange={(e) => set({ apiKey: e.target.value || undefined })} placeholder="sk-…" />
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span>baseURL{p.apiFormat === 'anthropic' ? '（Anthropic 官方为 https://api.anthropic.com）' : ''}</span>
          <input value={p.baseURL || ''} onChange={(e) => set({ baseURL: e.target.value || undefined })} placeholder={p.apiFormat === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.example.com/v1'} />
        </label>
      </div>
      <p className="settings-tip">{formatHint}</p>

      <div className="pv-models-head">
        <span className="pv-models-title">模型（{p.models.length}）</span>
        <div className="settings-actions" style={{ margin: 0 }}>
          <button className={`toggle ${p.enabled ? 'on' : ''}`} onClick={() => set({ enabled: !p.enabled })}>
            {p.enabled ? '已启用' : '已禁用'}
          </button>
          <button className="btn" onClick={() => setAddingModel(true)}>+ 添加模型</button>
          <button className="btn danger" onClick={() => { if (confirm(`删除提供商「${p.name || p.id}」及其模型配置？`)) props.onDelete() }}>删除提供商</button>
        </div>
      </div>

      {p.models.length === 0 && <div className="empty-card">还没有模型。点「+ 添加模型」录入模型 ID 等参数。</div>}
      {p.models.map((m) => {
        const probe = probeResults[m.id]
        return (
          <div key={m.id} className="provider-row">
            <div className="provider-main">
              <div className="provider-name">
                {m.name || m.id}
                <span className="tag">id: {m.id}</span>
                {m.attachment && <span className="tag tag-green">图片输入</span>}
                {(m.thinkingTiers?.length ?? 0) > 0 && <span className="tag">思考: {m.thinkingTiers!.join('/')}</span>}
              </div>
              <div className="provider-sub">
                {m.contextLimit ? `上下文 ${m.contextLimit}` : '⚠️ 未配置上下文'}
                {m.outputLimit ? ` · 最大输出 ${m.outputLimit}` : ' · 输出默认'}
                {' · 输出: 文本'}
              </div>
              {probe && !probe.ok && probe.error && <div className="provider-sub" style={{ color: '#dc2626' }}>⚠️ {probe.error}</div>}
            </div>
            {probe?.ok && <span className="tag tag-green">已连接 · {probe.elapsedMs}ms</span>}
            {probe && !probe.ok && <span className="tag" style={{ color: '#dc2626' }}>失败</span>}
            <button
              className="text-btn"
              data-testid={`provider-probe-${m.id}`}
              disabled={probingId === m.id}
              title="直连 baseURL 发一次最小请求，验证该模型是否可连通（未保存的配置也可测）"
              onClick={() => void probeModel(m.id)}
            >
              {probingId === m.id ? '测试中…' : '测试'}
            </button>
            <button className="text-btn" onClick={() => setEditModel(m.id)}>编辑</button>
            <button className="text-btn danger" onClick={() => set({ models: p.models.filter((x) => x.id !== m.id) })}>移除</button>
          </div>
        )
      })}

      {addingModel && (
        <ModelForm
          existingIds={p.models.map((m) => m.id)}
          onClose={() => setAddingModel(false)}
          onSave={(m) => {
            set({ models: [...p.models, m] })
            setAddingModel(false)
          }}
        />
      )}
      {editModel && (
        <ModelForm
          initial={p.models.find((m) => m.id === editModel)}
          existingIds={p.models.filter((m) => m.id !== editModel).map((m) => m.id)}
          onClose={() => setEditModel(null)}
          onSave={(m) => {
            set({ models: p.models.map((x) => (x.id === editModel ? m : x)) })
            setEditModel(null)
          }}
        />
      )}
    </div>
  )
}

const TIER_LABELS: Record<ThinkingTier, string> = { none: '无思考', low: '低', high: '高', max: '最大' }

/** 模型表单：模型ID / 上下文窗口 / 最大输出 / 输入类型 / 输出类型(固定文本) / 思考模式(多选) */
function ModelForm(props: {
  initial?: ProviderModelCfg
  existingIds: string[]
  onClose: () => void
  onSave: (m: ProviderModelCfg) => void
}): React.JSX.Element {
  const isEdit = !!props.initial
  const [id, setId] = useState(props.initial?.id || '')
  const [name, setName] = useState(props.initial?.name || '')
  const [ctx, setCtx] = useState(props.initial?.contextLimit ? String(props.initial.contextLimit) : '')
  const [out, setOut] = useState(props.initial?.outputLimit ? String(props.initial.outputLimit) : '')
  const [attachment, setAttachment] = useState(!!props.initial?.attachment)
  const [tiers, setTiers] = useState<ThinkingTier[]>(props.initial?.thinkingTiers ?? [])
  const [error, setError] = useState('')

  const dirty =
    id !== (props.initial?.id || '') ||
    name !== (props.initial?.name || '') ||
    ctx !== (props.initial?.contextLimit ? String(props.initial.contextLimit) : '') ||
    out !== (props.initial?.outputLimit ? String(props.initial.outputLimit) : '') ||
    attachment !== !!props.initial?.attachment ||
    tiers.join(',') !== (props.initial?.thinkingTiers ?? []).join(',')
  const { requestClose, guard } = useDirtyClose({ dirty, onClose: props.onClose })

  const submit = () => {
    const mid = id.trim()
    if (!mid) return setError('模型 ID 必填')
    if (props.existingIds.includes(mid)) return setError(`模型 ID「${mid}」已存在`)
    const num = (s: string) => (s.trim() && /^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined)
    const contextLimit = num(ctx)
    if (!contextLimit || contextLimit <= 0) return setError('上下文窗口必填（正整数 tokens，用于自动压缩）')
    props.onSave({
      id: mid,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(attachment ? { attachment: true } : {}),
      contextLimit,
      ...(num(out) ? { outputLimit: num(out) } : {}),
      ...(tiers.length ? { thinkingTiers: tiers } : {}),
    })
  }

  return (
    <div className="modal-mask" onClick={requestClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title-row">
          <div className="modal-title">{isEdit ? `编辑模型「${props.initial?.id}」` : '添加模型'}</div>
          <button className="icon-btn" aria-label="关闭" onClick={requestClose}>
            ×
          </button>
        </div>
        <label className="field">
          <span>模型 ID *</span>
          <input value={id} onChange={(e) => setId(e.target.value)} disabled={isEdit} placeholder="如 deepseek-chat / claude-sonnet-4-5" />
        </label>
        <label className="field">
          <span>显示名（可选）</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 DeepSeek Chat" />
        </label>
        <div style={{ display: 'flex', gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            <span>上下文窗口（tokens）*</span>
            <input value={ctx} onChange={(e) => setCtx(e.target.value.replace(/[^\d]/g, ''))} placeholder="如 128000" />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>最大输出 Token（可选）</span>
            <input value={out} onChange={(e) => setOut(e.target.value.replace(/[^\d]/g, ''))} placeholder="如 8192" />
          </label>
        </div>
        <label className="field check-field">
          <input type="checkbox" checked={attachment} onChange={(e) => setAttachment(e.target.checked)} />
          <span>输入类型：支持图片（勾选后聊天里可发图；不勾 = 纯文本输入）</span>
        </label>
        <div className="field">
          <span>输出类型：文本（当前固定）</span>
        </div>
        <div className="field">
          <span>思考模式（多选；会话里可切换，OpenAI 系 max=high，Anthropic 按预算映射）</span>
          <div className="member-picker">
            {THINKING_TIERS.map((t) => (
              <button
                key={t}
                type="button"
                className={`member-chip ${tiers.includes(t) ? 'on' : ''}`}
                onClick={() => setTiers((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))}
              >
                {TIER_LABELS[t]}（{t}）
              </button>
            ))}
          </div>
        </div>
        {error && <p className="settings-error">⚠️ {error}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={requestClose}>取消</button>
          <button className="btn primary" onClick={submit}>{isEdit ? '保存' : '添加'}</button>
        </div>
      </div>
      {guard}
    </div>
  )
}

/** 添加提供商（名称/id/baseURL/格式/Key，模型后补） */
function AddProvider(props: { existingIds: string[]; onClose: () => void; onAdd: (p: ProviderSetting) => void }): React.JSX.Element {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [apiFormat, setApiFormat] = useState<ProviderSetting['apiFormat']>('chat')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')

  const dirty = id !== '' || name !== '' || baseURL !== '' || apiKey !== '' || apiFormat !== 'chat'
  const { requestClose, guard } = useDirtyClose({ dirty, onClose: props.onClose })

  const submit = () => {
    const pid = id.trim().replace(/\s+/g, '-').toLowerCase()
    if (!pid) return setError('id 必填（如 my-proxy）')
    if (props.existingIds.includes(pid)) return setError(`id「${pid}」已存在`)
    if (apiFormat !== 'anthropic' && !baseURL.trim()) return setError('baseURL 必填（Anthropic 官方可留空）')
    props.onAdd({
      id: pid,
      name: name.trim() || pid,
      apiFormat,
      ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      enabled: true,
      models: [],
    })
  }

  return (
    <div className="modal-mask" onClick={requestClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title-row">
          <div className="modal-title">添加模型提供商</div>
          <button className="icon-btn" aria-label="关闭" onClick={requestClose}>
            ×
          </button>
        </div>
        <label className="field">
          <span>id *（唯一标识，如 my-proxy）</span>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="my-proxy" />
        </label>
        <label className="field">
          <span>名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 我的中转" />
        </label>
        <label className="field">
          <span>API 格式</span>
          <select value={apiFormat} onChange={(e) => setApiFormat(e.target.value as ProviderSetting['apiFormat'])}>
            {API_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>baseURL{apiFormat === 'anthropic' ? '（官方 https://api.anthropic.com 可留空）' : ' *'}</span>
          <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder={apiFormat === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.example.com/v1'} />
        </label>
        <label className="field">
          <span>API Key</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
        </label>
        <p className="settings-tip">创建后到提供商详情里「+ 添加模型」录入模型 ID 与参数。</p>
        {error && <p className="settings-error">⚠️ {error}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={requestClose}>取消</button>
          <button className="btn primary" onClick={submit}>添加</button>
        </div>
      </div>
      {guard}
    </div>
  )
}
