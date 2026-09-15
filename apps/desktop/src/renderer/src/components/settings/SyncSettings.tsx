import { useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC, type PluginInfo, type SkillsBackupReport, type SkillsRestoreStage, type SkillsRestoreApply } from '@jeff/core'
import { Toast } from '../ui/Toast'

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
        同步智能体、项目群、任务、定时任务、设置（含 MCP）、记忆与 AGENTS.md 到你的 WebDAV 服务器；不含会话聊天数据。同步成功后会刷新通讯录与项目群。实体级双向合并，多台机器交替使用不丢数据。定时任务只同步定义（运行历史留本机）；Skills 目录与插件目录属于整目录文件，仍需在下方手动备份/恢复。
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
      <PluginsBackup />
    </div>
  )
}

/**
 * 插件目录备份（~/.jeff/plugins → WebDAV）。
 * 入口统一放设置页：功能页只做功能本身，备份/恢复一律在「设置 → 同步」（见 AGENTS.md）。
 */
function PluginsBackup(): React.JSX.Element {
  const [last, setLast] = useState<(SkillsBackupReport & { fileCount?: number }) | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    void api.invoke<SkillsBackupReport | null>(IPC.pluginBackupLast).then((r) => setLast(r ?? null)).catch(() => {})
    void api.invoke<PluginInfo[]>(IPC.pluginsList).then((list) => setCount(list.length)).catch(() => {})
  }, [])

  const backupNow = async () => {
    setBusy('backup')
    try {
      const r = await api.invoke<SkillsBackupReport>(IPC.pluginBackupNow)
      setLast({ ...r })
      setToast(
        r.ok
          ? { kind: 'success', text: `插件备份完成：共 ${r.fileCount ?? '?'} 个文件 · 上传 ${r.uploaded} · 远端删除 ${r.deleted} · 未变化 ${r.skipped}${r.elapsedMs != null ? ` · 耗时 ${(r.elapsedMs / 1000).toFixed(1)}s` : ''}` }
          : { kind: 'error', text: `插件备份失败：${r.error ?? '未知错误'}` },
      )
    } finally {
      setBusy('')
    }
  }

  const restore = async () => {
    if (
      !confirm(
        '恢复会把本地 ~/.jeff/plugins 整个目录替换为备份内容（插件定义与其中的静态文件；启用状态与密钥留在本机不动）。\n恢复前 Jeff 会先把本地插件目录快照到数据目录 backups/plugins-<时间戳>，可手工回退。\n\n确认恢复？',
      )
    )
      return
    setBusy('restore')
    try {
      const r = await api.invoke<SkillsRestoreApply>(IPC.pluginRestore)
      if (r.ok) {
        setToast({ kind: 'success', text: `已恢复 ${r.restored} 个插件文件，移除本地多出 ${r.removed} 个${r.snapshotDir ? `；恢复前快照：${r.snapshotDir}` : ''}` })
        void api.invoke<PluginInfo[]>(IPC.pluginsList).then((list) => setCount(list.length)).catch(() => {})
      } else {
        setToast({ kind: 'error', text: `还原失败：${r.error}` })
      }
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <h2 className="settings-title" style={{ marginTop: 24 }}>
        插件目录备份
      </h2>
      <p className="settings-tip">
        把 <code>~/.jeff/plugins</code>（所有插件定义与静态文件）整目录镜像到 WebDAV 的 <code>plugins/</code> 目录，本地删除会同步删除（带熔断）。当前本机装了 <b>{count ?? '?'}</b> 个插件。
        插件的<b>启用状态与密钥不进备份</b>（跟机器走、避免敏感值跨设备），恢复后需在本机重新启用与填密钥。
      </p>
      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" disabled={!!busy} data-testid="plugin-backup" onClick={() => void backupNow()}>
          {busy === 'backup' ? '备份中…' : '立即备份插件'}
        </button>
        <button className="btn" disabled={!!busy} data-testid="plugin-restore" onClick={() => void restore()}>
          {busy === 'restore' ? '恢复中…' : '从备份恢复…'}
        </button>
      </div>
      {last && (
        <div className="sync-report" style={{ marginTop: 6 }}>
          <p className="settings-tip" style={{ marginBottom: 4 }}>
            上次备份：{last.ok ? '✅' : '❌'} {new Date(last.at).toLocaleString()} · 共 {last.fileCount ?? '?'} 个文件 · 上传 {last.uploaded} · 远端删除 {last.deleted} · 未变化 {last.skipped}
            {last.elapsedMs != null && ` · 耗时 ${(last.elapsedMs / 1000).toFixed(1)}s`}
          </p>
          {last.error && <pre className="settings-error sync-error-text">{last.error}</pre>}
        </div>
      )}
      {toast && <Toast kind={toast.kind} message={toast.text} onClose={() => setToast(null)} />}
    </>
  )
}

/** Skills 目录备份（~/.agents/skills → WebDAV）：整目录镜像、恢复整目录替换、两步确认 */
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
      if (r.ok) {
        alert(
          `skills 备份完成：共 ${r.fileCount ?? '?'} 个文件 · 上传 ${r.uploaded} · 远端删除 ${r.deleted} · 归档旧版 ${r.archived} · 未变化 ${r.skipped}` +
            (r.elapsedMs != null ? ` · 耗时 ${(r.elapsedMs / 1000).toFixed(1)}s` : ''),
        )
      } else {
        alert(`skills 备份失败：${r.error ?? '未知错误'}`)
      }
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
      '恢复将把本地 ~/.agents/skills 整个目录替换为备份内容：备份里没有的本地文件会被删除（跨平台删除同步生效）。\n恢复前 Jeff 会先把本地整个 skills 目录快照到数据目录 backups/ 下，可手工回退。\n\n确认恢复？',
    )) return
    setBusy('apply')
    try {
      const r = await api.invoke<SkillsRestoreApply>(IPC.skillsRestoreApply)
      if (r.ok) {
        alert(`已恢复 ${r.restored} 个文件，移除本地多出 ${r.removed} 个文件。\n恢复前本地快照：${r.snapshotDir}`)
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
        把 <code>~/.agents/skills</code>（所有 skill 文件）整目录镜像备份到 WebDAV 的 <code>skills/</code> 目录：本地新增/修改会上传，<b>本地删除的文件远端也同步删除</b>（删除/覆盖前旧版本先归档到远端 <code>skills-versions/</code>，可找回）。
        在任一台设备上维护 skills 后备份，其他设备「从备份恢复」即得到完全一致的目录；相对路径跨 Windows / Linux 通用。
      </p>
      <div className="settings-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" disabled={!!busy} onClick={() => void backupNow()}>{busy === 'backup' ? '备份中…' : '立即备份 skills'}</button>
        <button className="btn" disabled={!!busy} onClick={() => void stage()}>{busy === 'stage' ? '检查中…' : '从备份恢复…'}</button>
      </div>
      {last && (
        <div className="sync-report" style={{ marginTop: 6 }}>
          <p className="settings-tip" style={{ marginBottom: 4 }}>
            上次备份：{last.ok ? '✅' : '❌'} {new Date(last.at).toLocaleString()} · 共 {last.fileCount ?? '?'} 个文件 · 上传 {last.uploaded} · 远端删除 {last.deleted} · 旧版本归档 {last.archived} · 未变化 {last.skipped}{last.elapsedMs != null && ` · 耗时 ${(last.elapsedMs / 1000).toFixed(1)}s`}
          </p>
          {last.error && <pre className="settings-error sync-error-text">{last.error}</pre>}
        </div>
      )}
      {staged && (
        <div className="pv-detail" style={{ marginTop: 10 }}>
          {staged.ok ? (
            <>
              <p className="settings-tip">远端备份共 <b>{staged.total}</b> 个文件，前 30 个：</p>
              {staged.warnings?.map((w) => <p key={w} className="settings-tip" style={{ color: '#d97706' }}>⚠️ {w}</p>)}
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
            <p className="settings-error">
              ⚠️ 检查备份失败：{staged.error}
              {staged.error?.includes('下载失败')
                ? '（远端备份不完整：可能上次备份被中断或正在被其他设备操作，请在有完整 skills 的设备上重新点「立即备份 skills」后再试）'
                : '（远端还没有备份？先点「立即备份 skills」）'}
            </p>
          )}
        </div>
      )}
    </>
  )
}
