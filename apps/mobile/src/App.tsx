import { useEffect, useState } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { verifyInPage } from './selftest'

interface SpikePlugin {
  cryptoSelfTest(): Promise<{ ok: boolean; detail: string }>
  startForeground(): Promise<void>
}

const Spike = registerPlugin<SpikePlugin>('JeffSpike')

export function App() {
  const [jsOk, setJsOk] = useState('检查中')
  const [nativeOk, setNativeOk] = useState(Capacitor.isNativePlatform() ? '检查中' : '浏览器里没有原生层')

  useEffect(() => {
    try {
      verifyInPage()
      setJsOk('通过')
    } catch (err) {
      setJsOk((err as Error).message)
    }
    if (!Capacitor.isNativePlatform()) return
    Spike.cryptoSelfTest()
      .then((r) => setNativeOk(r.ok ? '通过' : r.detail))
      .catch((err) => setNativeOk((err as Error).message || '原生自检失败'))
    Spike.startForeground().catch(() => {
      /* 前台服务由 Activity 也会拉起，这里失败不挡住页面 */
    })
  }, [])

  return (
    <main>
      <header>Jeff</header>
      <section>
        <h1>远程控制</h1>
        <p>〇期在验证加密和后台连接，还不能操作电脑。</p>
        <ul>
          <li>
            <span>页面加密</span>
            <b data-ok={jsOk === '通过'}>{jsOk}</b>
          </li>
          <li>
            <span>原生加密</span>
            <b data-ok={nativeOk === '通过'}>{nativeOk}</b>
          </li>
        </ul>
      </section>
    </main>
  )
}
