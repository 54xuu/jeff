import { useEffect, useState } from 'react'
import { IPC, type RemotePairAsk } from '@jeff/core'
import { playNotifySound } from '../../notify'
import { useStore } from '../../store'
import { api } from '../../api'

/** 手机扫码后，无论当前在哪个页面都弹出确认。 */
export default function RemotePairDialog(): React.JSX.Element | null {
  const [ask, setAsk] = useState<RemotePairAsk | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    return api.onPush((e) => {
      if (e.what !== 'remote-pair-ask') return
      const request = (e.payload as RemotePairAsk | null) || null
      setAsk(request); setError('')
      if (request && useStore.getState().settings?.notifySound !== false) playNotifySound()
    })
  }, [])

  if (!ask) return null

  const answer = async (accept: boolean, replace = false) => {
    setBusy(true)
    try {
      await api.invoke(IPC.remotePairConfirm, { token: ask.token, accept, replace })
      setAsk(null)
    } catch (err) { setError(String((err as Error).message)) } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" data-testid="remote-pair-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remote-pair-title">
      <div className="modal">
        <div className="modal-title" id="remote-pair-title">手机「{ask.appName || '未命名'}」请求绑定</div>
        <p className="settings-tip"><strong>手机正在等待你确认。</strong>请核对手机上的安全码。对上了再确认。二维码被人偷拍时，先扫到的人过不了这一步。</p>
        <p data-testid="remote-safety" style={{ fontSize: 28, letterSpacing: 6, fontWeight: 700 }}>
          {ask.safety}
        </p>
        {error && <p role="alert">{error}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          {ask.replace ? (
            <button type="button" className="btn primary" data-testid="remote-pair-replace" disabled={busy} onClick={() => void answer(true, true)}>
              替换原有手机
            </button>
          ) : (
            <button type="button" className="btn primary" data-testid="remote-pair-accept" disabled={busy} onClick={() => void answer(true, false)}>
              确认绑定
            </button>
          )}
          <button type="button" className="btn" data-testid="remote-pair-reject" disabled={busy} onClick={() => void answer(false)}>
            拒绝
          </button>
        </div>
      </div>
    </div>
  )
}
