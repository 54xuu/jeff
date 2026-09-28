import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { IPC, type RemoteStatus } from '@jeff/core'
import { api } from '../../api'

const EMPTY: RemoteStatus = {
  connected: false,
  desktopId: '',
  desktopName: '',
  bound: null,
  openAtLogin: false,
  preventSleep: true,
  pairing: null,
}

/** 设置 → 远程控制：绑定手机、开机自启、防止睡眠。 */
export default function RemoteSettings(): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatus>(EMPTY)
  const [name, setName] = useState('')
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reload = async () => {
    const next = await api.invoke<RemoteStatus>(IPC.remoteStatus)
    setStatus(next)
    setName(next.desktopName)
  }

  useEffect(() => {
    void reload().catch((err) => setError((err as Error).message))
    const off = api.onPush((e) => {
      if (e.what === 'remote-status') setStatus((e.payload || EMPTY) as RemoteStatus)
    })
    return off
  }, [])

  useEffect(() => {
    const payload = status.pairing?.payload
    if (!payload) {
      setQr('')
      return
    }
    void QRCode.toDataURL(payload, { margin: 1, width: 220 }).then(setQr)
  }, [status.pairing?.payload])

  const saveName = async () => {
    setBusy(true)
    setError('')
    try {
      const next = await api.invoke<RemoteStatus>(IPC.remoteSettings, { desktopName: name.trim() })
      setStatus(next)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (key: 'openAtLogin' | 'preventSleep', value: boolean) => {
    setBusy(true)
    setError('')
    try {
      const next = await api.invoke<RemoteStatus>(IPC.remoteSettings, { [key]: value })
      setStatus(next)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pair = async () => {
    setBusy(true)
    setError('')
    try {
      await api.invoke(IPC.remotePairStart)
      await reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const unbind = async () => {
    setBusy(true)
    setError('')
    try {
      await api.invoke(IPC.remoteUnbind)
      await reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-content" data-testid="remote-settings">
      <h2 className="settings-title">远程控制</h2>
      <p className="settings-tip">手机通过中转站连上这台电脑。消息是端到端加密的，中转站只负责转发。电脑睡着或 Jeff 没开，手机就操作不了。</p>
      <div className="pv-detail">
        <p data-testid="remote-connection">{status.connected ? '中转站已连接' : '正在连接中转站'}</p>
        {status.lastError ? <p className="settings-tip">{status.lastError}</p> : null}
        <label className="field">
          <span>这台电脑的名字</span>
          <input data-testid="remote-name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="button" className="btn" disabled={busy} onClick={() => void saveName()}>
          保存名字
        </button>
        {status.bound ? (
          <p data-testid="remote-bound">
            已绑定手机：{status.bound.appName || status.bound.appId}
            <button type="button" className="btn" data-testid="remote-unbind" disabled={busy} onClick={() => void unbind()}>
              解除绑定
            </button>
          </p>
        ) : (
          <p data-testid="remote-bound">还没有绑定手机</p>
        )}
        <button type="button" className="btn primary" data-testid="remote-pair" disabled={busy || !status.connected} onClick={() => void pair()}>
          绑定手机
        </button>
        {status.pairing && qr ? (
          <div data-testid="remote-qr">
            <img src={qr} alt="配对二维码" width={220} height={220} />
            <pre data-testid="remote-qr-payload">{status.pairing.payload}</pre>
            <p className="settings-tip">五分钟内用 Jeff App 扫这个码。手机上会显示一串安全码，和电脑上的对上再点确认。</p>
          </div>
        ) : null}
        <label className="field check-field">
          <input
            type="checkbox"
            data-testid="remote-login"
            checked={status.openAtLogin}
            disabled={busy}
            onChange={(e) => void toggle('openAtLogin', e.target.checked)}
          />
          <span>开机自动启动 Jeff</span>
        </label>
        <label className="field check-field">
          <input
            type="checkbox"
            data-testid="remote-sleep"
            checked={status.preventSleep}
            disabled={busy}
            onChange={(e) => void toggle('preventSleep', e.target.checked)}
          />
          <span>已绑定手机时防止系统睡眠</span>
        </label>
      </div>
      {error ? <p className="settings-tip">{error}</p> : null}
    </div>
  )
}
