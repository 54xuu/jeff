import { useStore } from '../../store'
import Mascot from '../Mascot'

/** 设置 → 关于：面向用户的版本信息，诊断路径按需展开。 */
export default function AboutSettings(): React.JSX.Element {
  const { appInfo } = useStore()
  return (
    <div className="settings-content about-settings" data-testid="about-settings">
      <header className="settings-page-head"><div><p className="settings-eyebrow">JEFF DESKTOP</p><h2 className="settings-title">关于 Jeff</h2></div></header>
      <p className="settings-lead">Jeff 把智能体、项目群与本地工具放在一个工作台中。</p>
      <section className="settings-section-card about-product-card">
        <div className="about-card">
          <div className="about-logo"><Mascot size={52} mood="idle" /></div>
          <div className="about-product-copy">
            <p className="about-name">Jeff · 个人智能体与项目工作台</p>
            <p className="about-line">版本 v{appInfo?.version || '—'}</p>
            <p className="about-line">桌面引擎状态：{appInfo?.sidecarStatus || '—'}</p>
          </div>
        </div>
      </section>
      <details className="settings-section-card about-diagnostics">
        <summary>运行环境与诊断信息</summary>
        <div className="about-detail-grid">
          <div><span>渲染界面</span><strong>Electron · React</strong></div>
          <div><span>执行引擎</span><strong>OpenCode（Jeff）{appInfo?.opencodeVersion ? ` · ${appInfo.opencodeVersion}` : ''}</strong></div>
          <div className="about-path-row"><span>数据目录</span><code title={appInfo?.dataDir || ''}>{appInfo?.dataDir || '—'}</code></div>
          {appInfo?.opencodeBinary && <div className="about-path-row"><span>引擎程序</span><code title={appInfo.opencodeBinary}>{appInfo.opencodeBinary}</code></div>}
          {appInfo?.sidecarPort ? <div><span>本机服务端口</span><strong>{appInfo.sidecarPort}</strong></div> : null}
        </div>
        {appInfo?.sidecarError && <p className="settings-error" role="alert">{appInfo.sidecarError}</p>}
      </details>
    </div>
  )
}
