import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'
import { IPC } from '@jeff/core'

const STATUS_LABELS: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中…',
  running: '运行中',
  crashed: '异常（自动重启中）',
}

/** 设置 → 引擎服务：opencode sidecar 状态 / 版本 / 重启 / 日志 */
export default function EngineSettings(): React.JSX.Element {
  const { appInfo, refreshAppInfo } = useStore()
  const [logs, setLogs] = useState<string[]>([])
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    void api.invoke<{ lines: string[] }>(IPC.sidecarLogs).then((r) => setLogs(r.lines))
  }, [])

  const restart = async () => {
    setRestarting(true)
    try {
      await api.invoke(IPC.sidecarRestart)
      await refreshAppInfo()
      const r = await api.invoke<{ lines: string[] }>(IPC.sidecarLogs)
      setLogs(r.lines)
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div className="settings-content">
      <h2 className="settings-title">引擎服务</h2>
      <p className="settings-tip">
        Jeff 基于 opencode 引擎运行（安装包内自带，无需单独安装）。修改供应商 / MCP 配置后会自动重启引擎；如遇异常也可手动重启。
      </p>
      <div className="pv-detail">
        <div className="provider-row">
          <div className="provider-main">
            <div className="provider-name">
              状态
              <span className={`tag ${appInfo?.sidecarStatus === 'running' ? 'tag-green' : ''}`}>{STATUS_LABELS[appInfo?.sidecarStatus || 'stopped'] || appInfo?.sidecarStatus}</span>
              {appInfo?.sidecarPort ? <span className="tag">端口 {appInfo.sidecarPort}</span> : null}
              {appInfo?.opencodeVersion ? <span className="tag">opencode {appInfo.opencodeVersion}</span> : null}
            </div>
            <div className="provider-sub">二进制：{appInfo?.opencodeBinary || '未找到'}</div>
            {appInfo?.sidecarError && <div className="provider-sub" style={{ color: '#dc2626' }}>⚠️ {appInfo.sidecarError}</div>}
            <div className="provider-sub">数据目录：{appInfo?.dataDir}</div>
          </div>
          <button className="text-btn" disabled={restarting} onClick={() => void restart()}>{restarting ? '重启中…' : '重启服务'}</button>
        </div>
      </div>
      <details className="mcp-tools" open={!!appInfo?.sidecarError}>
        <summary>最近日志（{logs.length} 行）</summary>
        <pre className="engine-logs">{logs.length ? logs.join('\n') : '暂无日志'}</pre>
      </details>
    </div>
  )
}
