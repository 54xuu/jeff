import { useEffect, useState } from 'react'
import { useStore, applyTheme } from '../store'
import { api } from '../api'
import { IPC, BUILTIN_PROVIDER_PRESETS, type ProviderSetting, type MemoryScopeInfo, type McpServerCfg } from '@jeff/core'

export default function SettingsPage(): React.JSX.Element {
  const { settings, refreshSettings, refreshCatalog, appInfo } = useStore()
  const [providers, setProviders] = useState<ProviderSetting[]>([])
  const [defaultModel, setDefaultModel] = useState<{ providerID: string; modelID: string } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [adding, setAdding] = useState(false)

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
    await api.invoke(IPC.providersSave, { providers, defaultModel })
    await load()
  }

  const setTheme = async (theme: 'system' | 'light' | 'dark') => {
    await api.invoke(IPC.settingsSet, { theme })
    applyTheme(theme)
    void refreshSettings()
  }

  const removeProvider = (id: string) => {
    setProviders((p) => p.filter((x) => x.id !== id))
    setDirty(true)
  }

  return (
    <div className="settings-page">
      <div className="list-header">
        <span>设置</span>
      </div>
      <div className="settings-scroll">
        <div className="settings-sec">模型提供商</div>
        <p className="settings-tip">添加后点击「保存」生效（会重启后台引擎）。内置预设只需填 API Key；自定义 OpenAI 兼容端点需填 baseURL 和模型 id。</p>
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
            <button className="text-btn danger" onClick={() => removeProvider(p.id)}>移除</button>
          </div>
        ))}
        <button className="btn" onClick={() => setAdding(true)}>+ 添加提供商</button>

        <div className="settings-sec">默认模型（小杰与未指定模型的智能体使用）</div>
        <ModelPicker value={defaultModel} onChange={(m) => { setDefaultModel(m); setDirty(true) }} />

        <div className="settings-actions">
          <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
            保存{dirty ? '（未保存更改）' : ''}
          </button>
        </div>

        <div className="settings-sec">MCP 连接器</div>
        <McpManager />

        <div className="settings-sec">WebDAV 同步（智能体/项目/任务/设置/记忆；不含会话数据）</div>
        <SyncManager />

        <div className="settings-sec">记忆（长期记忆 · 条目以 § 分隔，每行一条）</div>
        <MemoryManager />

        <div className="settings-sec">外观</div>
        <div className="seg">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} className={`seg-item ${settings?.theme === t ? 'on' : ''}`} onClick={() => void setTheme(t)}>
              {t === 'system' ? '跟随系统' : t === 'light' ? '亮色' : '深夜'}
            </button>
          ))}
        </div>

        <div className="settings-sec">关于</div>
        <div className="about">
          <p>Jeff — 个人「开发 + 项目管理」agent 桌面应用</p>
          <p>版本：{appInfo?.version || '-'} · 引擎：opencode（{appInfo?.sidecarStatus || '-'}）</p>
          <p>数据目录：{appInfo?.dataDir || '-'}</p>
        </div>
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

  const submit = () => {
    if (kind === 'preset') {
      props.onAdd({ id: presetId, kind: 'builtin', name: BUILTIN_PROVIDER_PRESETS.find((x) => x.id === presetId)?.name || presetId, apiKey: apiKey.trim() || undefined })
    } else {
      const models = modelsText.split('\n').map((s) => s.trim()).filter(Boolean).map((mid) => ({ id: mid }))
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
          <label className="field">
            <span>提供商</span>
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {BUILTIN_PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
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


function MemoryManager(): React.JSX.Element {
  const [scopes, setScopes] = useState<MemoryScopeInfo[]>([])
  const [sel, setSel] = useState<MemoryScopeInfo | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    void api.invoke<MemoryScopeInfo[]>(IPC.memoryScopes).then((list) => {
      setScopes(list)
      if (!sel && list[0]) void pick(list[0])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = async (m: MemoryScopeInfo) => {
    const data = await api.invoke<{ content: string; label: string }>(IPC.memoryGet, { kind: m.kind, id: m.id })
    setSel(m)
    setContent(data.content)
    setDirty(false)
  }

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ width: 170, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {scopes.map((m) => (
          <button key={`${m.kind}:${m.id}`} className={`member-chip ${sel?.id === m.id ? 'on' : ''}`} onClick={() => void pick(m)}>
            {m.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1 }}>
        <textarea
          rows={8}
          value={content}
          onChange={(e) => {
            setContent(e.target.value)
            setDirty(true)
          }}
          placeholder="空 = 暂无记忆。每行一条；也可整段编辑，保存时按 § 分隔解析。"
          style={{ width: '100%', fontFamily: 'inherit', fontSize: 12 }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button className="btn primary" disabled={!sel || !dirty} onClick={async () => {
            if (!sel) return
            await api.invoke(IPC.memorySave, { kind: sel.kind, id: sel.id, content })
            setDirty(false)
          }}>
            保存{dirty ? '（未保存）' : ''}
          </button>
          {sel && <span className="settings-tip" style={{ alignSelf: 'center' }}>{sel.file}</span>}
        </div>
      </div>
    </div>
  )
}


interface WebdavCfg {
  url: string
  username: string
  basePath: string
  autoSync: boolean
}

interface SyncReportInfo {
  ok: boolean
  at: number
  uploaded: number
  downloaded: number
  conflicts: string[]
  error?: string
}

function SyncManager(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [basePath, setBasePath] = useState('/jeff')
  const [autoSync, setAutoSync] = useState(true)
  const [report, setReport] = useState<SyncReportInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void api.invoke<{ config: WebdavCfg | null; report: SyncReportInfo | null }>(IPC.syncStatus).then(({ config, report: r }) => {
      if (config) {
        setUrl(config.url)
        setUsername(config.username)
        setBasePath(config.basePath)
        setAutoSync(config.autoSync)
      }
      setReport(r)
      setLoaded(true)
    })
  }, [])

  const save = async () => {
    setBusy(true)
    try {
      await api.invoke(IPC.syncConfigure, { url, username, password, basePath, autoSync })
      const r = await api.invoke<SyncReportInfo>(IPC.syncNow)
      setReport(r)
    } catch (err) {
      setReport({ ok: false, at: Date.now(), uploaded: 0, downloaded: 0, conflicts: [], error: String((err as Error).message).slice(0, 200) })
    } finally {
      setBusy(false)
    }
  }

  const syncNow = async () => {
    setBusy(true)
    try {
      const r = await api.invoke<SyncReportInfo>(IPC.syncNow)
      setReport(r)
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return <div className="settings-tip">加载中…</div>
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label className="field">
          <span>服务器 URL（如 https://dav.example.com/dav）</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </label>
        <label className="field">
          <span>远端基目录</span>
          <input value={basePath} onChange={(e) => setBasePath(e.target.value)} placeholder="/jeff" />
        </label>
        <label className="field">
          <span>用户名</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span>密码 / 应用密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="留空 = 不修改已存密码" />
        </label>
      </div>
      <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} style={{ width: 16 }} />
        <span style={{ color: 'var(--text)' }}>自动同步（启动时 + 变更后 30 秒防抖）</span>
      </label>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="btn primary" disabled={busy || !url.trim()} onClick={() => void save()}>保存并同步</button>
        <button className="btn" disabled={busy || !url.trim()} onClick={() => void syncNow()}>立即同步</button>
        {busy && <span className="settings-tip">同步中…</span>}
      </div>
      {report && (
        <p className="settings-tip" style={{ marginTop: 6 }}>
          上次同步：{report.ok ? '✅' : '❌'} {new Date(report.at).toLocaleString()} · 下发 {Math.max(0, (report.uploaded ?? 0) - 4)} 项 / 拉取 {report.downloaded ?? 0} 项
          {report.conflicts?.length ? ` · 冲突 ${report.conflicts.length} 处（按更新时间取新）` : ''}
          {report.error ? ` · ${report.error}` : ''}
        </p>
      )}
    </div>
  )
}


function McpManager(): React.JSX.Element {
  const [servers, setServers] = useState<Record<string, McpServerCfg>>({})
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    void api.invoke<Record<string, McpServerCfg>>(IPC.mcpList).then(setServers)
  }, [])

  const save = async (next: Record<string, McpServerCfg>) => {
    setServers(next)
    setDirty(true)
  }

  return (
    <div>
      <p className="settings-tip">local = 本机命令行 MCP 服务；remote = HTTP/SSE 端点（支持 headers）。保存后重启引擎生效。</p>
      {Object.entries(servers).map(([name, cfg]) => (
        <div key={name} className="provider-row">
          <div className="provider-main">
            <div className="provider-name">
              {name} <span className="tag">{cfg.type === 'local' ? 'local' : 'remote'}</span>
              {!cfg.enabled && <span className="tag">已停用</span>}
            </div>
            <div className="provider-sub">{cfg.type === 'local' ? (cfg.command || []).join(' ') : cfg.url}</div>
          </div>
          <button className="text-btn" onClick={() => void save({ ...servers, [name]: { ...cfg, enabled: !cfg.enabled } })}>
            {cfg.enabled ? '停用' : '启用'}
          </button>
          <button className="text-btn danger" onClick={() => {
            const next = { ...servers }
            delete next[name]
            void save(next)
          }}>
            移除
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn" onClick={() => setAdding(true)}>+ 添加 MCP</button>
        <button className="btn primary" disabled={!dirty || busy} onClick={async () => {
          setBusy(true)
          try {
            await api.invoke(IPC.mcpSave, { servers })
            setDirty(false)
            await useStore.getState().refreshCatalog()
          } finally {
            setBusy(false)
          }
        }}>保存{dirty ? '（重启引擎生效）' : ''}</button>
      </div>
      {adding && (
        <AddMcp onClose={() => setAdding(false)} onAdd={(name, cfg) => {
          void save({ ...servers, [name]: cfg })
          setAdding(false)
        }} />
      )}
    </div>
  )
}

function AddMcp(props: { onClose: () => void; onAdd: (name: string, cfg: McpServerCfg) => void }): React.JSX.Element {
  const [type, setType] = useState<'local' | 'remote'>('local')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('npx -y @modelcontextprotocol/server-xxx')
  const [url, setUrl] = useState('https://')
  const [headerText, setHeaderText] = useState('')

  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">添加 MCP 连接器</div>
        <div className="seg">
          <button className={`seg-item ${type === 'local' ? 'on' : ''}`} onClick={() => setType('local')}>local（本机命令）</button>
          <button className={`seg-item ${type === 'remote' ? 'on' : ''}`} onClick={() => setType('remote')}>remote（HTTP）</button>
        </div>
        <label className="field">
          <span>名称 *</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 context7" />
        </label>
        {type === 'local' ? (
          <label className="field">
            <span>启动命令（空格分隔）</span>
            <input value={command} onChange={(e) => setCommand(e.target.value)} />
          </label>
        ) : (
          <>
            <label className="field">
              <span>URL *</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label className="field">
              <span>Headers（每行 key: value，可选）</span>
              <textarea rows={2} value={headerText} onChange={(e) => setHeaderText(e.target.value)} placeholder="Authorization: Bearer sk-…" />
            </label>
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() => {
              const headers: Record<string, string> = {}
              for (const line of headerText.split('\n')) {
                const idx = line.indexOf(':')
                if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
              }
              props.onAdd(name.trim(), {
                type,
                enabled: true,
                ...(type === 'local' ? { command: command.trim().split(/\s+/) } : { url: url.trim(), headers }),
              })
            }}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  )
}
