import { useStore } from '../../store'

/** 设置 → 关于 */
export default function AboutSettings(): React.JSX.Element {
  const { appInfo } = useStore()
  return (
    <div className="settings-content">
      <h2 className="settings-title">关于 Jeff</h2>
      <div className="about-card">
        <div className="about-logo">J</div>
        <div>
          <p className="about-name">Jeff — 个人「开发 + 项目管理」agent 桌面应用</p>
          <p className="about-line">版本：v{appInfo?.version || '-'} · 渲染：Electron + React</p>
          <p className="about-line">引擎：opencode sidecar（状态：{appInfo?.sidecarStatus || '-'}）</p>
          <p className="about-line">数据目录：{appInfo?.dataDir || '-'}</p>
          {appInfo?.opencodeBinary && <p className="about-line about-mono">二进制：{appInfo.opencodeBinary}</p>}
        </div>
      </div>
      <p className="settings-tip">提示：Windows / Linux 安装包可在 GitHub Releases 下载；本地构建产物在仓库 apps/desktop/release/ 目录。</p>
    </div>
  )
}
