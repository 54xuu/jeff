import { expect, it, vi } from 'vitest'
import { PhoneLink } from './session'
import { bytesToB64, randomX25519 } from '@jeff/core/remote'

it('绑定请求发出后立即告知电脑待确认和安全码；确认后进入安全连接', async () => {
  localStorage.clear()
  const phone = new PhoneLink()
  const progress = vi.fn()
  const link = { x25519Pub: bytesToB64(randomX25519().publicKey), setPeerKey: vi.fn(), pairRequest: vi.fn() }
  const internal = phone as any
  internal.connect = async () => { internal.link = link }
  phone.hello = async () => {}
  const qr = JSON.stringify({ token: 'test-token', desktopId: 'test-pc', desktopName: 'yh-dev16-01', desktopX25519Pub: bytesToB64(randomX25519().publicKey) })
  const pairing = (phone.pair as any)(qr, '我的手机', progress)
  try {
    await Promise.resolve(); await Promise.resolve()
    expect(link.pairRequest).toHaveBeenCalled()
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'confirming', desktopName: 'yh-dev16-01', safety: expect.stringMatching(/^\d{6}$/) }))
    internal.emit({ what: '__pair__', p: { ok: true, desktopId: 'test-pc' } })
    await pairing
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'securing' }))
  } finally { internal.emit({ what: '__pair__', p: { ok: false, error: '测试结束', desktopId: 'test-pc' } }); await pairing.catch(() => {}); localStorage.clear() }
})
