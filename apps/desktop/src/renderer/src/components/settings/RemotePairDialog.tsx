import { useEffect, useState } from 'react'
import { IPC, type RemotePairAsk } from '@jeff/core'
import { api } from '../../api'

/** 手机扫码后，无论当前在哪个页面都弹出确认。 */
export default function RemotePairDialog(): React.JSX.Element | null {
  const [ask, setAsk] = useState<RemotePairAsk | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    return api.onPush((e) => {
      if (e.what !== 'remote-pair-ask') return
      setAsk((e.payload as RemotePairAsk | null) || null)
    })
  }, [])

  if (!ask) return null

  const answer = async (accept: boolean, replace = false) => {
    setBusy(true)
    try {
      await api.invoke(IPC.remotePairConfirm, { token: ask.token, accept, replace })
      setAsk(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" data-testid="remote-pair-dialog">
      <div className="modal">
        <div className="modal-title">手机「{ask.appName || '未命名'}」请求绑定</div>
        <p className="settings-tip">请核对手机上的安全码。对上了再确认。二维码被人偷拍时，先扫到的人过不了这一步。</p>
        <p data-testid="remote-safety" style={{ fontSize: 28, letterSpacing: 6, fontWeight: 700 }}>
          {ask.safety}
        </p>
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
