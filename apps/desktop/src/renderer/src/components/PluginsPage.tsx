import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, type PluginInfo } from '@jeff/core'
import { openInBrowser } from '../browserHost'
import { Button } from './ui/Button'
import { Toast } from './ui/Toast'
import { Dialog } from './ui/Dialog'
import { Field } from './ui/Field'

/**
 * 插件视图：装了什么、提供哪些能力和快捷指令、启停与密钥、以及插件的 WebDAV 备份/恢复。
 * 插件启用后它的 MCP 会被自动注入引擎（免去手工配 MCP），因此这里同时是「MCP 包装」的入口。
 */
export default function PluginsPage(): React.JSX.Element {
  const { plugins, refreshPlugins } = useStore()
  const [busy, setBusy] = useState<string | null>(null)
  const [detail, setDetail] = useState<PluginInfo | null>(null)
  const [secretFor, setSecretFor] = useState<PluginInfo | null>(null)
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    void refreshPlugins()
  }, [refreshPlugins])

  const call = async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    try {
      const r = await fn()
      await refreshPlugins()
      if (okMsg) setToast({ kind: 'success', message: okMsg })
      return r
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      setToast({ kind: 'error', message: msg === '已取消' ? '已取消导入' : msg })
      return undefined
    }
  }

  const setEnabled = (p: PluginInfo, enabled: boolean) =>
    call(() => api.invoke(IPC.pluginSetEnabled, { id: p.id, enabled }), enabled ? `已启用「${p.name}」，其 MCP 工具将在引擎重启后可用` : `已停用「${p.name}」`)

  const importPlugin = () => call(() => api.invoke<PluginInfo>(IPC.pluginImport, {}), '插件已导入')

  const removePlugin = async (p: PluginInfo) => {
    if (!confirm(`卸载插件「${p.name}」？其目录与密钥将被删除（可从 WebDAV 备份恢复）。`)) return
    await call(() => api.invoke(IPC.pluginDelete, { id: p.id }), '插件已卸载')
    setDetail(null)
  }

  const openHome = (p: PluginInfo) => {
    if (!p.homepage) return
    // 走 browserHost：面板未打开会自动打开并等就绪，人看到的页面与 agent 操作的是同一个
    void openInBrowser(p.homepage).catch((e: unknown) => setToast({ kind: 'error', message: String((e as Error)?.message || e) }))
  }

  const enabledCount = plugins.filter((p) => p.enabled).length

  return (
    <div className="page-pane" data-testid="plugins-page">
      <div className="page-head">
        <div>
          <h2>插件</h2>
          <p className="settings-tip">
            把专门能力（如「智慧病房」）打包成插件：启用后自动接入其 MCP 工具，免去手工配置 MCP；提供首页的插件可用内置浏览器打开。插件的备份与恢复在「设置 → 同步」里（插件目录备份）。
          </p>
        </div>
        <div className="page-head-actions">
          <Button onClick={() => void importPlugin()} data-testid="plugin-import">
            导入插件
          </Button>
          <Button
            data-testid="plugin-goto-backup"
            onClick={() => {
              useStore.getState().setTab('settings')
              useStore.getState().setSettingsSection('sync')
            }}
          >
            备份与恢复
          </Button>
        </div>
      </div>

      <div className="plugins-summary">
        <span className="cron-badge">已启用 {enabledCount}</span>
        <span className="cron-badge">共 {plugins.length} 个</span>
        <span className="cron-dim">插件目录：{plugins[0]?.dir ? plugins[0].dir.replace(/\/[^/]+$/, '') : '~/.jeff/plugins'}</span>
      </div>

      {plugins.length === 0 && (
        <div className="empty-hint" style={{ padding: '40px 0' }}>
          <p>还没有安装插件</p>
          <p className="sub">把含 plugin.json 的目录放到 ~/.jeff/plugins/ 后点「导入插件」，或让小杰帮你接入</p>
        </div>
      )}

      <div className="plugin-grid">
        {plugins.map((p) => (
          <div key={p.id} className={`plugin-card ${p.enabled ? 'on' : ''}`} data-testid={`plugin-card-${p.id}`}>
            <div className="plugin-icon">{p.icon}</div>
            <div className="plugin-body">
              <div className="plugin-name">
                {p.name}
                {p.version && <span className="plugin-version">v{p.version}</span>}
                {p.enabled && <span className="tag tag-green">已启用</span>}
                {p.error && <span className="tag tag-red">配置有误</span>}
              </div>
              <div className="plugin-desc">{p.error || p.description || '（无简介）'}</div>
              <div className="plugin-meta">
                {p.mcp && <span className="cron-badge">MCP {p.mcp.tools?.length ? `${p.mcp.tools.length} 工具` : '已声明'}</span>}
                {p.commands.length > 0 && <span className="cron-badge">{p.commands.length} 条指令</span>}
                {p.homepage && <span className="cron-badge">有首页</span>}
                {p.hasSecret && <span className="cron-badge">已存密钥</span>}
              </div>
            </div>
            <div className="plugin-actions">
              <button className="icon-btn" title="查看能力与指令" onClick={() => setDetail(p)} data-testid={`plugin-detail-${p.id}`}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 16v-4M12 8h.01" />
                </svg>
              </button>
              {p.mcp && (
                <button className="icon-btn" title="配置密钥 / 认证" onClick={() => setSecretFor(p)}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 7a4 4 0 1 1-3.5 5.9L5 19H2v-3l6.1-6.5A4 4 0 0 1 15 7z" />
                  </svg>
                </button>
              )}
              {p.homepage && (
                <button className="icon-btn" title="用内置浏览器打开首页" onClick={() => openHome(p)} data-testid={`plugin-home-${p.id}`}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
                  </svg>
                </button>
              )}
              <button
                className={`switch ${p.enabled ? 'on' : ''}`}
                title={p.enabled ? '停用' : '启用'}
                disabled={busy === p.id || (!!p.error && !p.enabled)}
                data-testid={`plugin-toggle-${p.id}`}
                onClick={() => {
                  setBusy(p.id)
                  void setEnabled(p, !p.enabled).finally(() => setBusy(null))
                }}
              >
                <span />
              </button>
            </div>
          </div>
        ))}
      </div>

      {detail && (
        <Dialog title={`${detail.icon} ${detail.name}`} onClose={() => setDetail(null)}>
          <div className="plugin-detail">
            <p className="settings-tip">{detail.description || '（无简介）'}</p>
            {detail.error && <p className="cron-run-error">配置问题：{detail.error}</p>}
            {detail.homepage && (
              <p>
                首页：<button className="link-btn" onClick={() => openHome(detail)}>{detail.homepage}</button>
              </p>
            )}
            <h4>快捷指令（聊天框输入 / 呼出）</h4>
            {detail.commands.length === 0 ? (
              <p className="cron-dim">该插件未提供快捷指令</p>
            ) : (
              <ul className="plugin-cmd-list">
                {detail.commands.map((c) => (
                  <li key={c.name}>
                    <code>{c.name}</code> <span>{c.description || ''}</span>
                    <div className="cron-dim">{c.prompt}</div>
                  </li>
                ))}
              </ul>
            )}
            <h4>MCP 接入</h4>
            {detail.mcp ? (
              <ul className="plugin-cmd-list">
                <li>
                  <code>{detail.mcp.url ? 'remote' : 'local'}</code> <span>{detail.mcp.url || (detail.mcp.command || []).join(' ')}</span>
                </li>
                {(detail.mcp.tools || []).length > 0 && (
                  <li>
                    <code>tools</code> <span>{(detail.mcp.tools || []).join('、')}</span>
                    <div className="cron-dim">实际可用工具以服务端 tools/list 为准</div>
                  </li>
                )}
              </ul>
            ) : (
              <p className="cron-dim">该插件不提供 MCP 工具</p>
            )}
            <p className="settings-tip">插件目录：{detail.dir}</p>
          </div>
          <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
            <Button variant="danger" onClick={() => void removePlugin(detail)}>
              卸载插件
            </Button>
            <Button onClick={() => setDetail(null)}>关闭</Button>
          </div>
        </Dialog>
      )}

      {secretFor && (
        <SecretDialog
          plugin={secretFor}
          onClose={() => setSecretFor(null)}
          onSaved={async () => {
            setSecretFor(null)
            await refreshPlugins()
            setToast({ kind: 'success', message: '密钥已保存（仅本机，不参与 WebDAV 同步）' })
          }}
        />
      )}

      {toast && <Toast kind={toast.kind} message={toast.message} onClose={() => setToast(null)} />}
    </div>
  )
}

function SecretDialog(props: { plugin: PluginInfo; onClose: () => void; onSaved: () => Promise<void> }): React.JSX.Element {
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const headerKeys = Object.keys(props.plugin.mcp?.headers || {})
  return (
    <Dialog title={`${props.plugin.name} · 密钥`} onClose={props.onClose}>
      <div className="pv-grid">
        <Field label="密钥 / 令牌" span hint={headerKeys.length ? `将替换请求头里的 ${headerKeys.map((h) => `\${SECRET}`).join('、')} 占位（${headerKeys.join('、')}）` : '该插件未声明需要请求头的占位'}>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="粘贴令牌（留空 = 清除）" data-testid="plugin-secret" />
        </Field>
      </div>
      <p className="settings-tip">密钥只存在本机（kv），不参与 WebDAV 同步；插件配置里的 ${'{SECRET}'} 会在注入引擎时被替换。</p>
      {error && <Toast kind="error" message={error} onClose={() => setError(null)} />}
      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <Button
          variant="primary"
          disabled={saving}
          data-testid="plugin-secret-save"
          onClick={() => {
            setSaving(true)
            setError(null)
            void api
              .invoke(IPC.pluginSaveSecret, { id: props.plugin.id, secret })
              .then(() => props.onSaved())
              .catch((e) => setError(String((e as Error)?.message || e)))
              .finally(() => setSaving(false))
          }}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
        <Button onClick={props.onClose}>取消</Button>
      </div>
    </Dialog>
  )
}
