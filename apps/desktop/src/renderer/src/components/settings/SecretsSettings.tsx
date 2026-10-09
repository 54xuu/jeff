import { useCallback, useEffect, useMemo, useState } from 'react'
import { IPC, type SecretListItem, type SecretListResult } from '@jeff/core'
import { api } from '../../api'

type Draft = { originalName: string; name: string; value: string; note: string; enabled: boolean; hadValue: boolean }

const EMPTY: Draft = { originalName: '', name: '', value: '', note: '', enabled: true, hadValue: false }

function statusOf(item: SecretListItem): string {
  if (item.pending) return '待填写'
  if (item.undecryptable) return '无法解密'
  if (!item.enabled) return '已停用'
  return '已启用'
}

/** 设置 → 密码：本机密钥注入引擎环境，默认不回显明文。 */
export default function SecretsSettings(): React.JSX.Element {
  const [data, setData] = useState<SecretListResult | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState<{ name: string; value: string } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.invoke<SecretListResult>(IPC.secretsList))
      setError('')
    } catch (err) {
      setError(String((err as Error).message || err))
    }
  }, [])

  useEffect(() => {
    void load()
    return api.onPush((evt) => {
      if (evt.what === 'secrets') void load()
    })
  }, [load])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = data?.items ?? []
    if (!q) return all
    return all.filter((item) => item.name.toLowerCase().includes(q) || item.note.toLowerCase().includes(q))
  }, [data, query])

  const openNew = () => {
    setDraft({ ...EMPTY })
    setDirty(false)
    setConfirmClose(false)
    setFormError('')
  }

  const openEdit = async (item: SecretListItem) => {
    setFormError('')
    let value = ''
    if (item.hasValue) {
      try {
        value = (await api.invoke<{ value: string }>(IPC.secretsReveal, { name: item.name })).value
      } catch (err) {
        setError(String((err as Error).message || err))
        return
      }
    }
    setDraft({ originalName: item.name, name: item.name, value, note: item.note, enabled: item.enabled, hadValue: item.hasValue })
    setDirty(false)
    setConfirmClose(false)
  }

  const requestClose = () => {
    if (dirty) setConfirmClose(true)
    else setDraft(null)
  }

  const save = async () => {
    if (!draft || saving) return
    const name = draft.name.trim()
    const value = draft.value.trim()
    const trimmedHint = value !== draft.value && draft.value.length > 0
    setSaving(true)
    setFormError('')
    try {
      await api.invoke(IPC.secretsSave, {
        name,
        note: draft.note,
        enabled: draft.enabled,
        ...(draft.originalName ? { originalName: draft.originalName } : {}),
        ...(!draft.hadValue || value !== '' ? { value } : {}),
      })
      setDraft(null)
      setShown(null)
      await load()
      if (trimmedHint) setError('已去掉值的首尾空白后保存')
      else setError('')
    } catch (err) {
      setFormError(String((err as Error).message || err))
    } finally {
      setSaving(false)
    }
  }

  const reveal = async (name: string) => {
    if (shown?.name === name) {
      setShown(null)
      return
    }
    try {
      const res = await api.invoke<{ value: string }>(IPC.secretsReveal, { name })
      setShown({ name, value: res.value })
    } catch (err) {
      setError(String((err as Error).message || err))
    }
  }

  const copyValue = async (name: string) => {
    try {
      const res = await api.invoke<{ value: string }>(IPC.secretsReveal, { name })
      await navigator.clipboard.writeText(res.value)
      setError('')
    } catch (err) {
      setError(String((err as Error).message || err))
    }
  }

  const toggle = async (item: SecretListItem) => {
    try {
      await api.invoke(IPC.secretsSave, { name: item.name, originalName: item.name, note: item.note, enabled: !item.enabled })
      await load()
    } catch (err) {
      setError(String((err as Error).message || err))
    }
  }

  const remove = async (name: string) => {
    try {
      await api.invoke(IPC.secretsDelete, { name })
      setPendingDelete(null)
      setShown(null)
      await load()
    } catch (err) {
      setError(String((err as Error).message || err))
    }
  }

  const restart = async () => {
    setRestarting(true)
    setError('')
    try {
      const busy = await api.invoke<{ running: number }>(IPC.secretsBusy)
      if (busy.running > 0 && !confirmRestart) {
        setConfirmRestart(true)
        return
      }
      await api.invoke(IPC.secretsApplyRestart, { confirm: true })
      setConfirmRestart(false)
      await load()
    } catch (err) {
      setError(String((err as Error).message || err))
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div className="settings-content secrets-settings" data-testid="secrets-settings">
      <header className="settings-page-head">
        <div>
          <p className="settings-eyebrow">本机 · 不离开这台电脑</p>
          <h2 className="settings-title">密码</h2>
        </div>
        <button className="btn primary" type="button" data-testid="secrets-add" onClick={openNew}>添加</button>
      </header>
      <p className="settings-lead">这里的变量会在 Jeff 引擎启动时注入环境，供技能脚本使用（如 WEB_SEARCH_API_KEY）。</p>
      {data && (
        <p className={`secrets-status ${data.encrypted ? 'ok' : 'warn'}`} role="status" data-testid="secrets-encryption">
          {data.encrypted ? '已用系统钥匙串加密' : '系统钥匙串不可用，当前以明文保存在本机'}
        </p>
      )}
      {data?.restartNeeded && (
        <div className="secrets-banner" role="status" data-testid="secrets-restart-banner">
          <span>引擎需重启后，技能才能读到最新变量。</span>
          <button className="btn primary" type="button" data-testid="secrets-restart" disabled={restarting} onClick={() => void restart()}>
            {restarting ? '正在重启…' : '立即重启引擎'}
          </button>
        </div>
      )}
      {confirmRestart && (
        <p className="settings-error" role="alert" data-testid="secrets-restart-confirm">
          有对话或定时任务正在运行，重启会打断它们。
          <button className="btn" type="button" data-testid="secrets-restart-yes" onClick={() => void restart()}>确认重启</button>
          <button className="btn ghost" type="button" onClick={() => setConfirmRestart(false)}>取消</button>
        </p>
      )}
      <details className="secrets-limit">
        <summary>这些值会交给智能体使用</summary>
        <p>注入后模型可以通过执行命令读到环境变量，请只放愿意交给 Jeff 智能体使用的凭据。值不会同步到其他设备；其他电脑只会看到变量名，并显示「待填写」。</p>
      </details>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {(data?.items.length ?? 0) > 6 && (
        <label className="field">
          <span>搜索</span>
          <input data-testid="secrets-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="变量名或备注" />
        </label>
      )}
      {data && data.items.length === 0 && (
        <div className="empty-card" data-testid="secrets-empty">
          还没有密码。例如为联网搜索技能添加 WEB_SEARCH_API_KEY。
          <div><button className="btn" type="button" onClick={openNew}>添加</button></div>
        </div>
      )}
      <ul className="secrets-list">
        {items.map((item) => (
          <li key={item.name} className="secrets-row" data-testid={`secret-row-${item.name}`}>
            <div className="secrets-main">
              <strong>{item.name}</strong>
              <span className={`secrets-badge ${item.pending || item.undecryptable ? 'warn' : item.enabled ? 'ok' : ''}`}>{statusOf(item)}</span>
              {item.note && <em>{item.note}</em>}
              <code data-testid={`secret-mask-${item.name}`}>
                {shown?.name === item.name ? shown.value : item.hasValue ? `已设置 · ••••${item.last4}` : item.pending ? '待填写' : '无值'}
              </code>
            </div>
            <div className="secrets-actions">
              {item.hasValue && <button className="btn ghost" type="button" data-testid={`secret-show-${item.name}`} onClick={() => void reveal(item.name)}>{shown?.name === item.name ? '隐藏' : '显示'}</button>}
              {item.hasValue && <button className="btn ghost" type="button" data-testid={`secret-copy-${item.name}`} onClick={() => void copyValue(item.name)}>复制</button>}
              <button className="btn ghost" type="button" data-testid={`secret-edit-${item.name}`} onClick={() => void openEdit(item)}>编辑</button>
              <button className="btn ghost" type="button" data-testid={`secret-toggle-${item.name}`} onClick={() => void toggle(item)}>{item.enabled ? '停用' : '启用'}</button>
              <button className="btn ghost" type="button" data-testid={`secret-delete-${item.name}`} onClick={() => setPendingDelete(item.name)}>删除</button>
            </div>
            {pendingDelete === item.name && (
              <p className="settings-error" role="alert">
                删除后技能将无法读取该变量。其他设备上的同名条目也会被标记删除（值本来就不在其他设备上）。
                <button className="btn" type="button" data-testid={`secret-delete-yes-${item.name}`} onClick={() => void remove(item.name)}>确认删除</button>
                <button className="btn ghost" type="button" onClick={() => setPendingDelete(null)}>取消</button>
              </p>
            )}
          </li>
        ))}
      </ul>
      {draft && (
        <div className="modal-mask" onClick={requestClose}>
          <div className="modal form" role="dialog" aria-labelledby="secret-dialog-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title-row">
              <div className="modal-title" id="secret-dialog-title">{draft.originalName ? '编辑密码' : '添加密码'}</div>
              <button className="btn ghost" type="button" onClick={requestClose}>关闭</button>
            </div>
            <label className="field"><span>变量名</span>
              <input data-testid="secret-name" value={draft.name} onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setDirty(true) }} />
            </label>
            <label className="field"><span>值</span>
              <input data-testid="secret-value" type="password" value={draft.value} placeholder={draft.hadValue ? '留空表示不修改' : ''} onChange={(e) => { setDraft({ ...draft, value: e.target.value }); setDirty(true) }} />
            </label>
            <label className="field"><span>备注</span>
              <input data-testid="secret-note" value={draft.note} placeholder="例如：火山联网搜索 byted-web-search" onChange={(e) => { setDraft({ ...draft, note: e.target.value }); setDirty(true) }} />
            </label>
            <label className="field check-field">
              <input data-testid="secret-enabled" type="checkbox" checked={draft.enabled} onChange={(e) => { setDraft({ ...draft, enabled: e.target.checked }); setDirty(true) }} />
              <span>启用后注入引擎环境</span>
            </label>
            {formError && <p className="settings-error" role="alert" data-testid="secret-form-error">{formError}</p>}
            {confirmClose && (
              <p className="settings-error" role="alert">
                还有未保存的修改。
                <button className="btn" type="button" onClick={() => void save()}>保存并关闭</button>
                <button className="btn ghost" type="button" data-testid="secret-discard" onClick={() => setDraft(null)}>放弃</button>
                <button className="btn ghost" type="button" onClick={() => setConfirmClose(false)}>取消</button>
              </p>
            )}
            <div className="modal-actions">
              <button className="btn primary" type="button" data-testid="secret-save" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
