import { useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC, type SkillsBackupReport, type SkillsRestoreStage, type SkillsRestoreApply } from '@jeff/core'

interface WebdavCfg {
  url: string
  username: string
  basePath: string
  autoSync: boolean
  timeoutMs?: number
  tlsVerify?: boolean
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
  const [timeoutSec, setTimeoutSec] = useState('60')
  const [tlsVerify, setTlsVerify] = useState(true)
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
        setTimeoutSec(String(Math.round((config.timeoutMs ?? 60_000) / 1000)))
        setTlsVerify(config.tlsVerify !== false)
      }
      setReport(r)
      setLoaded(true)
    })
  }, [])

  const payload = () => {
    const sec = Number(timeoutSec)
    return {
      url,
      username,
      password,
      basePath,
      autoSync,
      timeoutMs: Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 60_000,
      tlsVerify,
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      await api.invoke(IPC.syncConfigure, payload())
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
          <span>远端基目录（必须以 / 开头，如 /jeff）</span>
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
        <label className="field">
          <span>请求超时（秒）</span>
          <input value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} placeholder="60" inputMode="numeric" />
        </label>
      </div>
      <label className="field check-field">
        <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} />
        <span>自动同步（启动时 + 变更后 30 秒防抖）</span>
      </label>
      <label className="field check-field">
        <input type="checkbox" checked={tlsVerify} onChange={(e) => setTlsVerify(e.target.checked)} />
        <span>校验证书（TLS Verify；仅自签证书时关闭）</span>
      </label>
      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" disabled={busy || !url.trim()} onClick={() => void save()}>保存并同步</button>
        <button className="btn" disabled={busy || !url.trim()} onClick={() => void syncNow()}>立即同步</button>
        {busy && <span className="settings-tip" style={{ alignSelf: 'center' }}>同步中…</span>}
      </div>
      {report && (
        <div className="sync-report" data-testid="sync-report">
          <p className="settings-tip" style={{ marginTop: 6, marginBottom: 4 }}>
            上次同步：{report.ok ? '✅' : '❌'} {new Date(report.at).toLocaleString()} · 下发 {Math.max(0, (report.uploaded ?? 0) - 4)} 项 / 拉取 {report.downloaded ?? 0} 项
            {report.conflicts?.length ? ` · 冲突 ${report.conflicts.length} 处（按更新时间取新）` : ''}
          </p>
          {report.error && (
            <pre className="settings-error sync-error-text" title="可选中复制">{report.error}</pre>
          )}
        </div>
      )}

      <SkillsBackup />
    </div>
  )
}

/** Skills 目录备份（~/.agents/skills → WebDAV）：单向备份、永不自动写回本地、恢复需两步确认 */
function SkillsBackup(): React.JSX.Element {
  const [last, setLast] = useState<(SkillsBackupReport & { fileCount?: number }) | null>(null)
  const [busy, setBusy] = useState('')
  const [staged, setStaged] = useState<SkillsRestoreStage | null>(null)

  useEffect(() => {
    void api.invoke<SkillsBackupReport & { fileCount?: number } | null>(IPC.skillsLast).then(setLast).catch(() => {})
  }, [])

  const backupNow = async () => {
    setBusy('backup')
    try {
      const r = await api.invoke<SkillsBackupReport>(IPC.skillsBackupNow)
      setLast({ ...r })
    } finally {
      setBusy('')
    }
  }

  const stage = async () => {
    setBusy('stage')
    try {
      const r = await api.invoke<SkillsRestoreStage>(IPC.skillsRestoreStage)
      setStaged(r)
    } finally {
      setBusy('')
    }
  }

  const apply = async () => {
    if (!confirm(
      '恢复将覆盖本地 ~/.agents/skills 中与备份同名的文件（不会删除本地多出的文件）。\n恢复前 Jeff 会先把本地整个 skills 目录快照到数据目录 backups/ 下，可手工回退。\n\n确认恢复？',
    )) return
    setBusy('apply')
    try {
      const r = await api.invoke<SkillsRestoreApply>(IPC.skillsRestoreApply)
      if (r.ok) {
        alert(`已恢复 ${r.restored} 个文件。\n恢复前本地快照：${r.snapshotDir}`)
        setStaged(null)
        void backupNow()
      } else {
        alert(`恢复失败：${r.error}`)
      }
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <h2 className="settings-title" style={{ marginTop: 24 }}>Skills 目录备份</h2>
      <p className="settings-tip">
        自动把 <code>~/.agents/skills</code>（所有 skill 文件）备份到 WebDAV 的 <code>skills/</code> 目录。
        <b>单向备份</b>：本地文件永不自动修改；远端只增不删；内容被覆盖前旧版本归档到远端 <code>skills-versions/</code>。多台设备同时备份不会互相破坏。
      </p>
      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" disabled={!!busy} onClick={() => void backupNow()}>{busy === 'backup' ? '备份中…' : '立即备份 skills'}</button>
        <button className="btn" disabled={!!busy} onClick={() => void stage()}>{busy === 'stage' ? '检查中…' : '从备份恢复…'}</button>
      </div>
      {last && (
        <div className="sync-report" style={{ marginTop: 6 }}>
          <p className="settings-tip" style={{ marginBottom: 4 }}>
            上次备份：{last.ok ? '✅' : '❌'} {new Date(last.at).toLocaleString()} · 共 {last.fileCount ?? '?'} 个文件 · 上传 {last.uploaded} · 旧版本归档 {last.archived} · 未变化 {last.skipped}
          </p>
          {last.error && <pre className="settings-error sync-error-text">{last.error}</pre>}
        </div>
      )}
      {staged && (
        <div className="pv-detail" style={{ marginTop: 10 }}>
          {staged.ok ? (
            <>
              <p className="settings-tip">远端备份共 <b>{staged.total}</b> 个文件，前 30 个：</p>
              <div className="mcp-tool-list">
                {staged.files.slice(0, 30).map((f) => <span key={f} className="tag">{f}</span>)}
                {staged.total > 30 && <span className="tag">…共 {staged.total} 个</span>}
              </div>
              <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
                <button className="btn danger" disabled={!!busy} onClick={() => void apply()}>{busy === 'apply' ? '恢复中…' : '确认恢复到本地'}</button>
                <button className="btn" onClick={() => setStaged(null)}>取消</button>
              </div>
            </>
          ) : (
            <p className="settings-error">⚠️ 检查备份失败：{staged.error}（远端还没有备份？先点「立即备份 skills」）</p>
          )}
        </div>
      )}
    </>
  )
}
