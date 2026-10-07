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
  const [copied, setCopied] = useState(false)

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
    void QRCode.toDataURL(payload, { margin: 2, width: 480, errorCorrectionLevel: 'H' }).then(setQr)
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

  const reconnect = async () => {
    setBusy(true)
    setError('')
    try {
      await api.invoke(IPC.remoteReconnect)
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

      {/* 中转站连接状态卡片 */}
      <div className="remote-status-card" data-testid="remote-status-card">
        <div className="remote-status-header">
          <div className="remote-status-indicator-group">
            <span className={`status-dot ${status.connected ? 'online' : status.state === 'error' ? 'error' : 'connecting'}`} />
            <span className="remote-status-text" data-testid="remote-connection">
              {status.connected ? '中转站已连接' : status.state === 'error' ? '中转站连接失败' : '正在连接中转站'}
            </span>
          </div>
          <button
            type="button"
            className="btn small"
            data-testid="remote-reconnect"
            disabled={busy}
            onClick={() => void reconnect()}
          >
            重新连接
          </button>
        </div>
        <div className="remote-status-details">
          <div className="remote-status-item">
            <span className="remote-status-label">中转站地址</span>
            <span className="remote-status-val">{status.relayUrl || '默认中转服务'}</span>
          </div>
          {status.connected ? (
            <>
              <div className="remote-status-item">
                <span className="remote-status-label">心跳延迟</span>
                <span className="remote-status-val">{status.rttMs != null ? `${status.rttMs} ms` : '检测中…'}</span>
              </div>
              <div className="remote-status-item">
                <span className="remote-status-label">已连通自</span>
                <span className="remote-status-val">
                  {status.lastConnectedAt ? new Date(status.lastConnectedAt).toLocaleTimeString() : '刚刚'}
                </span>
              </div>
            </>
          ) : null}
        </div>
        {status.lastError ? <p className="settings-error remote-status-error">{status.lastError}</p> : null}
      </div>

      <div className="pv-detail">
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
          <div className="remote-pair-card" data-testid="remote-qr">
            <div className="remote-pair-header">
              <span className="remote-pair-badge">等待扫码</span>
              <span className="settings-tip">5 分钟内有效</span>
            </div>
            <div className="remote-pair-body">
              <div className="remote-qr-box">
                <img src={qr} alt="配对二维码" width={280} height={280} />
              </div>
              <div className="remote-pair-info">
                <h4>使用 Jeff 手机端扫码绑定</h4>
                <ol className="remote-pair-steps">
                  <li>打开手机上的 Jeff App</li>
                  <li>在「消息」或「我」页面点击<strong>「扫码绑定」</strong></li>
                  <li>扫码或粘贴绑定码后，核对两端的 6 位数字安全码</li><li>在这台电脑的 Jeff 弹窗中点击<strong>「确认绑定」</strong>，手机才会完成绑定</li>
                </ol>
                <div className="remote-pair-manual">
                  <span className="settings-tip">若摄像头不便扫描，可点击下方复制绑定码后在手机上手动粘贴：</span>
                  <div className="remote-copy-row">
                    <button
                      type="button"
                      className="btn"
                      data-testid="remote-copy"
                      onClick={() => {
                        const text = status.pairing?.payload || ''
                        const done = () => {
                          setCopied(true)
                          window.setTimeout(() => setCopied(false), 2000)
                        }
                        void navigator.clipboard.writeText(text).then(done).catch(() => {
                          const el = document.createElement('textarea')
                          el.value = text
                          document.body.appendChild(el)
                          el.select()
                          document.execCommand('copy')
                          el.remove()
                          done()
                        })
                      }}
                    >
                      {copied ? '已复制' : '复制绑定码'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            {/* 隐藏保留原始 payload 元素供 E2E 自动化测试读取 */}
            <pre data-testid="remote-qr-payload" style={{ display: 'none' }}>{status.pairing.payload}</pre>
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
