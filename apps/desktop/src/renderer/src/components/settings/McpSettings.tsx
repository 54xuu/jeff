import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'
import { IPC, parseMcpServerJson, type McpServerCfg } from '@jeff/core'

/** 设置 → MCP 连接器：表单添加 + 每项 JSON 编辑 */
export default function McpSettings(): React.JSX.Element {
  const [servers, setServers] = useState<Record<string, McpServerCfg>>({})
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void api.invoke<Record<string, McpServerCfg>>(IPC.mcpList).then((s) => {
      setServers(s)
      setLoaded(true)
    })
  }, [])

  const update = (next: Record<string, McpServerCfg>) => {
    setServers(next)
    setDirty(true)
  }

  const save = async () => {
    setBusy(true)
    try {
      await api.invoke(IPC.mcpSave, { servers })
      setDirty(false)
      await useStore.getState().refreshCatalog()
    } finally {
      setBusy(false)
    }
  }

  const names = Object.keys(servers)
  return (
    <div className="settings-content">
      <h2 className="settings-title">MCP 连接器</h2>
      <p className="settings-tip">
        local = 本机命令行 MCP 服务；remote = HTTP/SSE 端点（支持 headers）。可逐个编辑 JSON（opencode 原生格式），保存后重启引擎生效。
      </p>

      {!loaded && <p className="settings-tip">加载中…</p>}
      {loaded && names.length === 0 && (
        <div className="empty-card">还没有配置 MCP 连接器。点击「添加 MCP」用表单创建，或用小杰帮你配置。</div>
      )}
      {names.map((name) => {
        const cfg = servers[name]
        return (
          <div key={name} className="provider-row">
            <div className="provider-main">
              <div className="provider-name">
                {name} <span className="tag">{cfg.type === 'local' ? 'local' : 'remote'}</span>
                {!cfg.enabled && <span className="tag">已停用</span>}
              </div>
              <div className="provider-sub">{cfg.type === 'local' ? (cfg.command || []).join(' ') : cfg.url}</div>
            </div>
            <button className="text-btn" onClick={() => setEditing(name)}>编辑 JSON</button>
            <button className="text-btn" onClick={() => update({ ...servers, [name]: { ...cfg, enabled: !cfg.enabled } })}>
              {cfg.enabled ? '停用' : '启用'}
            </button>
            <button className="text-btn danger" onClick={() => {
              const next = { ...servers }
              delete next[name]
              update(next)
            }}>
              移除
            </button>
          </div>
        )
      })}
      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn" onClick={() => setAdding(true)}>+ 添加 MCP</button>
        <button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? '保存中…' : `保存${dirty ? '（重启引擎生效）' : ''}`}
        </button>
      </div>

      {adding && (
        <AddMcp onClose={() => setAdding(false)} onAdd={(name, cfg) => {
          update({ ...servers, [name]: cfg })
          setAdding(false)
        }} />
      )}
      {editing && (
        <EditMcpJson
          name={editing}
          cfg={servers[editing]}
          onClose={() => setEditing(null)}
          onSave={(name, cfg) => {
            const next = { ...servers }
            if (name !== editing) delete next[editing]
            next[name] = cfg
            update(next)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

/** 编辑单个 MCP server 的 JSON（opencode 原生格式，带结构校验） */
function EditMcpJson(props: { name: string; cfg: McpServerCfg; onClose: () => void; onSave: (name: string, cfg: McpServerCfg) => void }): React.JSX.Element {
  const [name, setName] = useState(props.name)
  const [text, setText] = useState(() => JSON.stringify(props.cfg, null, 2))
  const [error, setError] = useState('')

  const submit = () => {
    const r = parseMcpServerJson(text)
    if (!r.ok) {
      setError(r.error)
      return
    }
    if (!name.trim()) {
      setError('名称不能为空')
      return
    }
    props.onSave(name.trim(), r.cfg)
  }

  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">编辑 MCP 连接器 JSON</div>
        <label className="field">
          <span>名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>配置（opencode mcp 格式）</span>
          <textarea
            rows={10}
            value={text}
            onChange={(e) => { setText(e.target.value); setError('') }}
            spellCheck={false}
            style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 }}
          />
        </label>
        <p className="settings-tip">
          示例 — local：{'{"type":"local","command":["npx","-y","@modelcontextprotocol/server-xxx"],"enabled":true}'}；
          remote：{'{"type":"remote","url":"https://…","headers":{"Authorization":"Bearer …"}}'}
        </p>
        {error && <p className="settings-error">⚠️ {error}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn primary" onClick={submit}>保存</button>
        </div>
      </div>
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
