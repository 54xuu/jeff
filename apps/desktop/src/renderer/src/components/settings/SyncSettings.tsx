import { useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC } from '@jeff/core'

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

/** 设置 → WebDAV 同步 */
export default function SyncSettings(): React.JSX.Element {
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

  if (!loaded) return <div className="settings-content"><p className="settings-tip">加载中…</p></div>
  return (
    <div className="settings-content">
      <h2 className="settings-title">WebDAV 同步</h2>
      <p className="settings-tip">
        同步智能体、项目群、任务、设置与记忆到你的 WebDAV 服务器（坚果云、Alist 等）；不含会话聊天数据。实体级双向合并，多台机器交替使用不丢数据。
      </p>
      <div className="sync-grid">
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
      <label className="field check-field">
        <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} />
        <span>自动同步（启动时 + 变更后 30 秒防抖）</span>
      </label>
      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" disabled={busy || !url.trim()} onClick={() => void save()}>保存并同步</button>
        <button className="btn" disabled={busy || !url.trim()} onClick={() => void syncNow()}>立即同步</button>
        {busy && <span className="settings-tip" style={{ alignSelf: 'center' }}>同步中…</span>}
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
