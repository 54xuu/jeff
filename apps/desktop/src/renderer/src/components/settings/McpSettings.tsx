import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { IPC, parseMcpServersJson, type McpServerCfg, type McpProbeResult } from '@jeff/core'
import { useDirtyClose } from '../ui/useDirtyClose'

const EXAMPLE_JSON = `{
  "mcpServers": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" },
    "fetch": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-fetch"] }
  }
}`

/** 设置 → MCP 连接器：JSON 粘贴导入 + 服务列表（状态 / 工具清单 / 编辑 / 启用禁用删除） */
export default function McpSettings(): React.JSX.Element {
  const [servers, setServers] = useState<Record<string, McpServerCfg>>({})
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({})
  const [probing, setProbing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  const refresh = async () => {
    const s = await api.invoke<Record<string, McpServerCfg>>(IPC.mcpList)
    setServers(s)
    setLoaded(true)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const probe = async () => {
    setProbing(true)
    try {
      const r = await api.invoke<Record<string, McpProbeResult>>(IPC.mcpProbe)
      setProbes(r)
    } finally {
      setProbing(false)
    }
  }

  useEffect(() => {
    // 有服务且尚无探测结果时自动探测一次
    if (loaded && Object.keys(servers).length > 0 && Object.keys(probes).length === 0) void probe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, servers])

  const save = async (next: Record<string, McpServerCfg>) => {
    setServers(next)
    await api.invoke(IPC.mcpSave, { servers: next })
    await useStore.getState().refreshCatalog()
    setProbes({})
  }

  const restartEngine = async () => {
    setRestarting(true)
    try {
      await api.invoke(IPC.sidecarRestart)
    } finally {
      setRestarting(false)
    }
  }

  const names = Object.keys(servers)
  return (
    <div className="settings-content" data-testid="mcp-settings">
      <h2 className="settings-title">MCP 连接器</h2>
      <p className="settings-tip">
        直接粘贴 MCP JSON 导入：支持 <code>{'{"mcpServers":{…}}'}</code>（Claude Desktop / Cursor 格式）或 opencode 原生 map 格式。local = 本机命令；remote = HTTP/SSE。保存后重启引擎生效。
      </p>

      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" data-testid="mcp-import" onClick={() => setImportOpen(true)}>导入 JSON…</button>
        <button className="btn" data-testid="mcp-probe" disabled={probing || names.length === 0} onClick={() => void probe()}>{probing ? '探测中…' : '重新检测状态'}</button>
        <button className="btn" data-testid="mcp-restart" disabled={restarting} onClick={() => void restartEngine()}>{restarting ? '重启中…' : '重启引擎'}</button>
      </div>

      {!loaded && <p className="settings-tip">加载中…</p>}
      {loaded && names.length === 0 && <div className="empty-card">还没有 MCP 连接器。点「导入 JSON…」粘贴 Claude Desktop / Cursor / opencode 格式配置。</div>}

      {names.map((name) => {
        const cfg = servers[name]
        const probe = probes[name]
        return (
          <div key={name} className="provider-row">
            <div className="provider-main">
              <div className="provider-name">
                <span className={`pv-dot ${cfg.enabled ? 'on' : ''}`} />
                {name}
                <span className="tag">{cfg.type === 'local' ? 'local' : 'remote'}</span>
                {!cfg.enabled && <span className="tag">已停用</span>}
                {probe && cfg.enabled && probe.status === 'ok' && <span className="tag tag-green">已连接 · {probe.toolCount} 个工具</span>}
                {probe && cfg.enabled && probe.status === 'error' && <span className="tag" style={{ color: '#dc2626' }}>连接失败</span>}
              </div>
              <div className="provider-sub">{cfg.type === 'local' ? (cfg.command || []).join(' ') : cfg.url}</div>
              {probe && cfg.enabled && probe.status === 'error' && <div className="provider-sub" style={{ color: '#dc2626' }}>⚠️ {probe.error}</div>}
              {probe && probe.status === 'ok' && probe.tools.length > 0 && (
                <details className="mcp-tools">
                  <summary>工具清单（{probe.toolCount}）</summary>
                  <div className="mcp-tool-list">
                    {probe.tools.map((t) => (
                      <span key={t} className="tag">{t}</span>
                    ))}
                  </div>
                </details>
              )}
            </div>
            <button className="text-btn" data-testid={`mcp-edit-${name}`} onClick={() => setEditingName(name)}>编辑</button>
            <button className="text-btn" onClick={() => void save({ ...servers, [name]: { ...cfg, enabled: !cfg.enabled } })}>
              {cfg.enabled ? '禁用' : '启用'}
            </button>
            <button className="text-btn danger" onClick={() => {
              if (!confirm(`删除 MCP「${name}」？`)) return
              const next = { ...servers }
              delete next[name]
              void save(next)
            }}>
              删除
            </button>
          </div>
        )
      })}

      {importOpen && (
        <ServerJsonDialog
          title="导入 MCP JSON"
          existing={servers}
          onClose={() => setImportOpen(false)}
          onConfirm={async (parsed) => {
            await save({ ...servers, ...parsed })
            setImportOpen(false)
          }}
        />
      )}
      {editingName && servers[editingName] && (
        <ServerJsonDialog
          title={`编辑 MCP「${editingName}」`}
          existing={servers}
          editing={{ name: editingName, cfg: servers[editingName] }}
          onClose={() => setEditingName(null)}
          onConfirm={async (parsed) => {
            const next: Record<string, McpServerCfg> = { ...servers }
            // 支持改名：新名写入，旧名移除（同名则直接覆盖）
            const newNames = Object.keys(parsed)
            if (!newNames.includes(editingName)) delete next[editingName]
            await save({ ...next, ...parsed })
            setEditingName(null)
          }}
        />
      )}
    </div>
  )
}

/** JSON 弹窗：导入（空表单）与编辑（预填单个服务）共用。粘贴 → 解析校验 → 预览 → 确认。 */
function ServerJsonDialog(props: {
  title: string
  existing: Record<string, McpServerCfg>
  editing?: { name: string; cfg: McpServerCfg }
  onClose: () => void
  onConfirm: (parsed: Record<string, McpServerCfg>) => void | Promise<void>
}): React.JSX.Element {
  const initial = props.editing
    ? JSON.stringify({ mcpServers: { [props.editing.name]: props.editing.cfg } }, null, 2)
    : ''
  const [text, setText] = useState(initial)
  const [error, setError] = useState('')
  const [parsed, setParsed] = useState<Record<string, McpServerCfg> | null>(null)
  const [saving, setSaving] = useState(false)

  const { requestClose, guard } = useDirtyClose({ dirty: text.trim() !== initial.trim(), onClose: props.onClose })

  const doParse = () => {
    setParsed(null)
    setError('')
    const r = parseMcpServersJson(text)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setParsed(r.servers)
  }

  // 展示「会覆盖哪些已有服务」；编辑改名时旧名会被移除，不算冲突
  const others = props.editing
    ? Object.keys(props.existing).filter((k) => k !== props.editing!.name)
    : Object.keys(props.existing)
  const conflicts = parsed ? Object.keys(parsed).filter((k) => k in props.existing && others.includes(k)) : []

  const confirm = async () => {
    if (!parsed) return
    setSaving(true)
    try {
      await props.onConfirm(parsed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-mask" onClick={requestClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title-row">
          <div className="modal-title">{props.title}</div>
          <button className="icon-btn" aria-label="关闭" onClick={requestClose}>
            ×
          </button>
        </div>
        <label className="field">
          <span>粘贴 MCP 配置 JSON（mcpServers 包裹或 opencode map 均可）</span>
          <textarea
            rows={10}
            value={text}
            data-testid="mcp-import-json"
            onChange={(e) => { setText(e.target.value); setError(''); setParsed(null) }}
            placeholder={EXAMPLE_JSON}
            spellCheck={false}
            style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 }}
          />
        </label>
        {error && <p className="settings-error">⚠️ {error}</p>}
        {parsed && (
          <div className="mcp-preview">
            <p className="settings-tip">
              解析成功，将{props.editing && !Object.keys(parsed).includes(props.editing.name) ? `改名（${props.editing.name} → ${Object.keys(parsed).join('、')}）并` : ''}
              {conflicts.length ? `覆盖 ${conflicts.join('、')}` : '新增'} {Object.keys(parsed).length} 个服务：
            </p>
            {Object.entries(parsed).map(([name, cfg]) => (
              <div key={name} className="provider-sub">
                • <b>{name}</b>（{cfg.type}）：{cfg.type === 'local' ? (cfg.command || []).join(' ') : cfg.url}
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={requestClose}>取消</button>
          <button className="btn" data-testid="mcp-parse" disabled={!text.trim()} onClick={doParse}>解析校验</button>
          <button className="btn primary" data-testid="mcp-import-confirm" disabled={!parsed || saving} onClick={() => void confirm()}>
            {saving ? '保存中…' : conflicts.length ? '覆盖并保存' : props.editing ? '保存修改' : '添加'}
          </button>
        </div>
      </div>
      {guard}
    </div>
  )
}
