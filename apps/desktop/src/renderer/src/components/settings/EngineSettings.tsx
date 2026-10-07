import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'
import { IPC, type EngineStatus, type EngineId } from '@jeff/core'

const STATUS_LABELS: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中…',
  running: '运行中',
  crashed: '异常（自动重启中）',
}

/** 设置 → 引擎服务：opencode sidecar 状态 / 版本 / 重启 / 日志 / TLS 与调试开关 */
export default function EngineSettings(): React.JSX.Element {
  const { appInfo, refreshAppInfo } = useStore()
  const [engines, setEngines] = useState<EngineStatus[]>([])
  const [paths, setPaths] = useState<Partial<Record<EngineId, string>>>({})
  const [engineError, setEngineError] = useState('')
  const [engineBusy, setEngineBusy] = useState<EngineId | null>(null)
  const refreshEngines = async () => {
    const detected = await api.invoke<EngineStatus[]>(IPC.enginesList)
    setEngines(detected)
    setPaths((previous) => Object.fromEntries(detected.map((engine) => [engine.id, previous[engine.id] ?? engine.configuredPath ?? ''])))
  }
  useEffect(() => { void refreshEngines().catch((err) => setEngineError(String(err.message))) }, [])
  const configureEngine = async (engine: EngineId) => {
    setEngineBusy(engine); setEngineError('')
    try { await api.invoke(IPC.enginesPathSave, { engine, path: paths[engine] || '' }); await refreshEngines() }
    catch (err) { setEngineError(String((err as Error).message)) } finally { setEngineBusy(null) }
  }
  const [logs, setLogs] = useState<string[]>([])
  const [restarting, setRestarting] = useState(false)
  const [skipTls, setSkipTls] = useState(false)
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [toggling, setToggling] = useState<'tls' | 'debug' | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  useEffect(() => {
    void api.invoke<{ lines: string[] }>(IPC.sidecarLogs).then((r) => setLogs(r.lines))
    void api.invoke<{ skipVerify: boolean }>(IPC.llmTlsGet).then((r) => setSkipTls(r.skipVerify))
    void api.invoke<{ enabled: boolean }>(IPC.debugLogGet).then((r) => setDebugEnabled(r.enabled))
  }, [])

  // 乐观更新 + 失败回滚：保存会触发 sidecar 重启，失败时不能假装已生效
  const toggleSkipTls = async (v: boolean) => {
    if (toggling) return
    const prev = skipTls
    setToggling('tls')
    setToggleError(null)
    setSkipTls(v)
    try {
      await api.invoke(IPC.llmTlsSet, { skip: v })
      await refreshAppInfo()
    } catch (err) {
      setSkipTls(prev)
      setToggleError(`证书校验开关保存失败：${String((err as Error).message).slice(0, 160)}`)
    } finally {
      setToggling(null)
    }
  }

  const toggleDebug = async (v: boolean) => {
    if (toggling) return
    const prev = debugEnabled
    setToggling('debug')
    setToggleError(null)
    setDebugEnabled(v)
    try {
      await api.invoke(IPC.debugLogSet, { enabled: v })
    } catch (err) {
      setDebugEnabled(prev)
      setToggleError(`调试模式保存失败：${String((err as Error).message).slice(0, 160)}`)
    } finally {
      setToggling(null)
    }
  }

  const openLogDir = async () => {
    setToggleError(null)
    try {
      await api.invoke(IPC.debugLogOpenDir)
    } catch (err) {
      setToggleError(`打开日志目录失败：${String((err as Error).message).slice(0, 160)}`)
    }
  }

  const restart = async () => {    setRestarting(true)
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
    <div className="settings-content" data-testid="engine-settings">
      <h2 className="settings-title">引擎服务</h2>
      <p className="settings-tip">
        OpenCode 是默认执行引擎（安装包内自带）。智能体资料中可选择本机已安装并登录的 Codex CLI、Cursor CLI 或 Claude Code。修改供应商 / MCP 配置后会自动重启引擎；如遇异常也可手动重启。
      </p>
      {engineError && <p role="alert">{engineError}</p>}
      {engines.filter((engine) => engine.id !== 'opencode').map((engine) => (
        <div className="pv-detail" key={engine.id} data-testid={`engine-${engine.id}`}>
          <h3>{engine.label} · {engine.available ? '已检测到' : '未就绪'}</h3>
          <p className="settings-tip">{engine.version || ''} {engine.error || ''}</p>
          <input aria-label={`${engine.label} 路径`} placeholder={engine.path || '可执行文件绝对路径（留空自动检测）'} value={paths[engine.id] ?? ''} onChange={(event) => setPaths((previous) => ({ ...previous, [engine.id]: event.target.value }))} />
          <button type="button" disabled={engineBusy !== null} onClick={() => void configureEngine(engine.id)}>{engineBusy === engine.id ? '检测中…' : '保存并检测'}</button>
          <p className="settings-tip">安装与登录在电脑上完成；检测只核对路径、版本和协议。实际登录与模型可用性请在聊天中发送消息验证。留空保存恢复自动检测。</p>
        </div>
      ))}
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
            {appInfo?.sidecarError && <div className="provider-sub" style={{ color: 'var(--danger)' }}>⚠️ {appInfo.sidecarError}</div>}
            <div className="provider-sub">数据目录：{appInfo?.dataDir}</div>
          </div>
          <button className="text-btn" disabled={restarting} onClick={() => void restart()}>{restarting ? '重启中…' : '重启服务'}</button>
        </div>
      </div>
      <div className="pv-detail" style={{ marginTop: 8 }}>
        <label className="field check-field">
          <input type="checkbox" disabled={toggling !== null} checked={skipTls} onChange={(e) => void toggleSkipTls(e.target.checked)} />
          <span>跳过 LLM 证书校验（企业代理 / 安全软件拦截导致「certificate verification error」时开启；保存后自动重启引擎）</span>
        </label>
        <label className="field check-field">
          <input type="checkbox" disabled={toggling !== null} checked={debugEnabled} onChange={(e) => void toggleDebug(e.target.checked)} />
          <span>调试模式（记录引擎输出、工具调用与消息处理日志，可能包含聊天内容；默认开启）</span>
        </label>
        <div className="field" style={{ gap: 8, alignItems: 'center' }}>
          <button className="text-btn" onClick={() => void openLogDir()} data-testid="open-log-dir">打开日志目录</button>
          <span className="settings-tip" style={{ margin: 0 }}>反馈问题请附上该目录下最新的 debug-日期.log</span>
        </div>
        {toggleError && <p className="settings-error">⚠️ {toggleError}</p>}
      </div>
      <details className="mcp-tools" open={!!appInfo?.sidecarError}>
        <summary>最近日志（{logs.length} 行）</summary>
        <pre className="engine-logs">{logs.length ? logs.join('\n') : '暂无日志'}</pre>
      </details>
    </div>
  )
}
