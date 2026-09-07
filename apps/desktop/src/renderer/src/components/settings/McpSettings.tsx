import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { IPC, parseMcpServersJson, type McpServerCfg, type McpProbeResult } from '@jeff/core'

const EXAMPLE_JSON = `{
  "mcpServers": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" },
    "fetch": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-fetch"] }
  }
}`

/** 设置 → MCP 连接器：JSON 粘贴导入 + 服务列表（状态 / 工具清单 / 启用禁用删除） */
export default function McpSettings(): React.JSX.Element {
  const [servers, setServers] = useState<Record<string, McpServerCfg>>({})
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({})
  const [probing, setProbing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

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
        <ImportJson
          existing={servers}
          onClose={() => setImportOpen(false)}
          onImport={async (merged) => {
            await save(merged)
            setImportOpen(false)
          }}
        />
      )}
    </div>
  )
}

/** JSON 导入弹窗：粘贴 → 解析校验 → 预览 → 确认合并 */
function ImportJson(props: { existing: Record<string, McpServerCfg>; onClose: () => void; onImport: (merged: Record<string, McpServerCfg>) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [parsed, setParsed] = useState<Record<string, McpServerCfg> | null>(null)

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

  const conflicts = parsed ? Object.keys(parsed).filter((k) => k in props.existing) : []

  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">导入 MCP JSON</div>
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
            <p className="settings-tip">解析成功，将{conflicts.length ? `覆盖 ${conflicts.join('、')}` : '新增'} {Object.keys(parsed).length} 个服务：</p>
            {Object.entries(parsed).map(([name, cfg]) => (
              <div key={name} className="provider-sub">
                • <b>{name}</b>（{cfg.type}）：{cfg.type === 'local' ? (cfg.command || []).join(' ') : cfg.url}
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn" data-testid="mcp-parse" disabled={!text.trim()} onClick={doParse}>解析校验</button>
          <button className="btn primary" data-testid="mcp-import-confirm" disabled={!parsed} onClick={() => parsed && props.onImport({ ...props.existing, ...parsed })}>
            {conflicts.length ? '覆盖并保存' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}
