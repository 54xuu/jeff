import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'
import { IPC, type EngineStatus, type EngineId } from '@jeff/core'
import ProviderSettings from './ProviderSettings'

const STATUS_LABELS: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中…',
  running: '运行中',
  crashed: '异常（自动重启中）',
}

type PendingEngine = { next: EngineId } | null

/** 设置 → 执行引擎：CLI 选择、运行状态与本机诊断 */
export default function EngineSettings(): React.JSX.Element {
  const { appInfo, refreshAppInfo } = useStore()
  const [engines, setEngines] = useState<EngineStatus[]>([])
  const [selectedEngine, setSelectedEngine] = useState<EngineId>('opencode')
  const [paths, setPaths] = useState<Partial<Record<EngineId, string>>>({})
  const [engineError, setEngineError] = useState('')
  const [engineBusy, setEngineBusy] = useState<EngineId | null>(null)
  const [providerDirty, setProviderDirty] = useState(false)
  const [pendingEngine, setPendingEngine] = useState<PendingEngine>(null)
  const [providerSwitchBusy, setProviderSwitchBusy] = useState(false)
  const providerSave = useRef<() => Promise<boolean>>(async () => false)
  const engineRequest = useRef(0)
  const editedPaths = useRef(new Set<EngineId>())
  const refreshEngines = async () => {
    const request = ++engineRequest.current
    try {
      const detected = await api.invoke<EngineStatus[]>(IPC.enginesList)
      if (request !== engineRequest.current) return
      setEngines(detected)
      setPaths((previous) => Object.fromEntries(detected.map((engine) => [
        engine.id,
        editedPaths.current.has(engine.id) ? previous[engine.id] ?? '' : engine.configuredPath ?? '',
      ])))
      setEngineError('')
    } catch (err) {
      if (request === engineRequest.current) setEngineError(String((err as Error).message))
      throw err
    }
  }
  useEffect(() => {
    let active = true
    const unsubscribe = api.onPush(({ what, payload }) => {
      if (!active || what !== 'sidecar-status' || (payload as { status?: string } | undefined)?.status !== 'running') return
      // A slow first launch can render Settings before EngineClient exists. Retry once the
      // sidecar-ready event has rebound the client so the selector never stays empty.
      void refreshEngines().catch(() => {})
    })
    void refreshEngines().catch(() => {})
    return () => { active = false; unsubscribe() }
  }, [])
  const selected = engines.find((engine) => engine.id === selectedEngine)
  const requestEngineSwitch = (next: EngineId) => {
    if (next === selectedEngine) return
    if (selectedEngine === 'opencode' && providerDirty) setPendingEngine({ next })
    else setSelectedEngine(next)
  }
  const finishEngineSwitch = (next: EngineId) => {
    setSelectedEngine(next)
    setProviderDirty(false)
    setPendingEngine(null)
  }
  const saveAndSwitchEngine = async () => {
    if (!pendingEngine) return
    setProviderSwitchBusy(true)
    const saved = await providerSave.current()
    setProviderSwitchBusy(false)
    if (saved) finishEngineSwitch(pendingEngine.next)
  }
  const configureEngine = async (engine: EngineId) => {
    setEngineBusy(engine); setEngineError('')
    try {
      const updated = await api.invoke<EngineStatus>(IPC.enginesPathSave, { engine, path: paths[engine] || '' })
      editedPaths.current.delete(engine)
      setPaths((previous) => ({ ...previous, [engine]: updated.configuredPath ?? '' }))
      await refreshEngines()
    }
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
      <h2 className="settings-title">执行引擎</h2>
      <p className="settings-tip">每个 Agent 可独立选择本机可用的 CLI。选择一个引擎查看状态与配置；只有 OpenCode（Jeff）在此管理模型提供商。</p>
      {engineError && <p role="alert" data-testid="engine-error">{engineError}</p>}
      <label className="field" style={{ maxWidth: 620 }}>
        <span>默认查看的引擎</span>
        <select data-testid="engine-service-select" value={selectedEngine} onChange={(event) => requestEngineSwitch(event.target.value as EngineId)}>
          {engines.filter((engine) => engine.id === 'opencode' || engine.available || !!engine.configuredPath || engine.id === selectedEngine).map((engine) => (
            <option key={engine.id} value={engine.id}>{engine.label}{engine.available ? ' · 可用' : ' · 未就绪'}</option>
          ))}
        </select>
        <small className="settings-tip">列表只显示已检测到或已配置路径的 CLI；要使用新 CLI，请先在本机安装并登录。</small>
      </label>
      {selectedEngine === 'opencode' && <ProviderSettings embedded onDirtyChange={setProviderDirty} onRegisterSave={(save) => { providerSave.current = save }} />}
      {selectedEngine === 'opencode-system' && selected && (
        <div className="pv-detail" data-testid="engine-opencode-system">
          <h3>{selected.label} · {selected.available ? '已检测到' : '未就绪'}</h3>
          <p className="settings-tip">这是本机单独安装的 OpenCode。Jeff 为它建立隔离会话目录，并使用该系统账号已配置的模型凭据；群聊与私聊记录仍保存在 Jeff。</p>
          {selected.error && <p className="settings-error">{selected.error}</p>}
          <p className="settings-tip">登录、模型和思考选项来自系统 OpenCode；模型提供商编辑只出现在 OpenCode（Jeff）中。</p>
          <details className="settings-diagnostic-path">
            <summary>查看程序路径与版本</summary>
            <div className="engine-diagnostic-values">
              <p>CLI：<code>{selected.path || '未找到'}</code></p>
              {selected.sourcePath && <p>系统配置来源：<code>{selected.sourcePath}</code></p>}
              {selected.version && <p>版本：<code>{selected.version}</code></p>}
            </div>
          </details>
        </div>
      )}
      {selected && selectedEngine !== 'opencode' && selectedEngine !== 'opencode-system' && (
        <div className="pv-detail" key={selected.id} data-testid={`engine-${selected.id}`}>
          <h3>{selected.label} · {selected.available ? '已检测到' : '未就绪'}</h3>
          <p className="settings-tip">安装与登录在电脑上完成；检测只核对路径、版本和 CLI 协议。登录与模型可用性请在聊天中实际验证。</p>
          {selected.error && <p className="settings-error">{selected.error}</p>}
          {selected.version && <details className="settings-diagnostic-path"><summary>查看 CLI 版本</summary><code>{selected.version}</code></details>}
        </div>
      )}
      <details className="pv-detail" data-testid="engine-path-manager">
        <summary>管理 CLI 检测路径</summary>
        <p className="settings-tip">通常无需手动指定。仅当 CLI 已安装但自动检测不到时使用；留空保存会恢复自动检测。</p>
        <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {engines.filter((engine) => engine.id !== 'opencode').map((engine) => (
            <div className="group-settings" key={engine.id} data-testid={`engine-path-row-${engine.id}`}>
              <label className="field"><span>{engine.label} 路径 · {engine.available ? '已检测到' : '未就绪'}</span><input aria-label={`${engine.label} 路径`} data-testid={`engine-path-${engine.id}`} placeholder={engine.path || '可执行文件绝对路径'} value={paths[engine.id] ?? ''} onChange={(event) => { editedPaths.current.add(engine.id); setPaths((previous) => ({ ...previous, [engine.id]: event.target.value })) }} /></label>
              {engine.error && <p className="settings-error">{engine.error}</p>}
              <button type="button" className="btn" data-testid={`engine-path-save-${engine.id}`} disabled={engineBusy !== null} onClick={() => void configureEngine(engine.id)}>{engineBusy === engine.id ? '检测中…' : '保存并检测'}</button>
            </div>
          ))}
        </div>
      </details>
      {selectedEngine === 'opencode' && <div className="pv-detail">
        <div className="provider-row">
          <div className="provider-main">
            <div className="provider-name">
              桌面引擎
              <span className={`tag ${appInfo?.sidecarStatus === 'running' ? 'tag-green' : ''}`}>{STATUS_LABELS[appInfo?.sidecarStatus || 'stopped'] || appInfo?.sidecarStatus}</span>
            </div>
            {appInfo?.sidecarError && <div className="settings-error" role="alert">{appInfo.sidecarError}</div>}
          </div>
          <button className="text-btn" disabled={restarting} onClick={() => void restart()}>{restarting ? '重启中…' : '重启服务'}</button>
        </div>
        <details className="settings-diagnostic-path engine-runtime-diagnostics" data-testid="engine-runtime-diagnostics" open={!!appInfo?.sidecarError}>
          <summary>查看运行环境与路径</summary>
          <div className="engine-diagnostic-grid">
            {appInfo?.sidecarPort ? <p>本机服务端口：<code>{appInfo.sidecarPort}</code></p> : null}
            {appInfo?.opencodeVersion ? <p>OpenCode 版本：<code>{appInfo.opencodeVersion}</code></p> : null}
            <p>引擎程序：<code>{appInfo?.opencodeBinary || '未找到'}</code></p>
            <p>数据目录：<code>{appInfo?.dataDir || '—'}</code></p>
          </div>
        </details>
      </div>}
      {selectedEngine === 'opencode' && <details className="pv-detail" style={{ marginTop: 8 }}>
        <summary>服务诊断与高级选项</summary>
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
      </details>}
      {selectedEngine === 'opencode' && <details className="mcp-tools" open={!!appInfo?.sidecarError}>
        <summary>最近日志（{logs.length} 行）</summary>
        <pre className="engine-logs">{logs.length ? logs.join('\n') : '暂无日志'}</pre>
      </details>}
      {pendingEngine && <div className="modal-mask" data-testid="engine-switch-confirm">
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="engine-switch-title">
          <h3 id="engine-switch-title">模型提供商还有未保存更改</h3>
          <p>切换引擎前请选择如何处理当前更改。</p>
          <div className="settings-actions">
            <button className="btn primary" data-testid="engine-switch-save" disabled={providerSwitchBusy} onClick={() => void saveAndSwitchEngine()}>{providerSwitchBusy ? '保存中…' : '保存并继续'}</button>
            <button className="btn" data-testid="engine-switch-discard" disabled={providerSwitchBusy} onClick={() => finishEngineSwitch(pendingEngine.next)}>放弃更改</button>
            <button className="btn" data-testid="engine-switch-cancel" disabled={providerSwitchBusy} onClick={() => setPendingEngine(null)}>取消</button>
          </div>
        </section>
      </div>}
    </div>
  )
}
