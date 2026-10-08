import { useEffect, useState } from 'react'
import { IPC, ENGINE_LABELS, type EngineId, type EngineStatus, type AgentInfo, type ProviderCatalogItem } from '@jeff/core'
import type { PhoneLink } from './session'

export default function EngineSelector(props: { phone: PhoneLink; agents: AgentInfo[]; initialId?: string; onSave: (agent: AgentInfo) => void; onClose: () => void }) {
  const [agentId, setAgentId] = useState(props.initialId || props.agents[0]?.id || '')
  const agent = props.agents.find((item) => item.id === agentId)
  const [engine, setEngine] = useState<EngineId>(agent?.execution_engine || 'opencode')
  const [model, setModel] = useState(agent?.engine_model || '')
  const [modelKey, setModelKey] = useState(agent?.model_provider && agent.model_id ? `${agent.model_provider}/${agent.model_id}` : '')
  const [thinking, setThinking] = useState(agent?.thinking || '')
  const [statuses, setStatuses] = useState<EngineStatus[]>([])
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [jeffModels, setJeffModels] = useState<Array<{ id: string; label: string }>>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { let active = true; void props.phone.invoke<EngineStatus[]>(IPC.enginesList).then((value) => { if (active) setStatuses(value) }).catch((err) => { if (active) setError(String(err.message)) }); return () => { active = false } }, [props.phone])
  useEffect(() => { setEngine(agent?.execution_engine || 'opencode'); setModel(agent?.engine_model || ''); setModelKey(agent?.model_provider && agent.model_id ? `${agent.model_provider}/${agent.model_id}` : ''); setThinking(agent?.thinking || '') }, [agentId])
  useEffect(() => {
    let active = true
    if (engine === 'opencode') void props.phone.invoke<{ catalog: ProviderCatalogItem[] }>(IPC.providersCatalog).then((result) => {
      if (active) setJeffModels(result.catalog.flatMap((provider) => provider.models.map((item) => ({ id: `${item.providerID}/${item.modelID}`, label: item.label }))))
    }).catch(() => setJeffModels([]))
    return () => { active = false }
  }, [props.phone, engine])
  useEffect(() => {
    let active = true; setModels([])
    if (engine !== 'opencode') void props.phone.invoke<{ models: Array<{ id: string; label: string }> }>(IPC.enginesModels, { engine }).then((value) => { if (active) setModels(value.models) }).catch(() => {})
    return () => { active = false }
  }, [props.phone, engine])
  const save = async () => {
    if (!agent) return
    setBusy(true); setError('')
    try {
      const [model_provider, ...model_parts] = modelKey.split('/')
      const saved = await props.phone.invoke<AgentInfo>(IPC.agentsUpsert, {
        ...agent, execution_engine: engine, engine_model: model.trim(),
        model_provider: engine === 'opencode' && model_provider && model_parts.length ? model_provider : agent.model_provider || '',
        model_id: engine === 'opencode' && model_provider && model_parts.length ? model_parts.join('/') : agent.model_id || '',
        thinking: engine === 'cursor' ? '' : thinking,
      })
      props.onSave(saved); props.onClose()
    } catch (err) { setError(String((err as Error).message)) } finally { setBusy(false) }
  }
  const visibleEngines = statuses.filter((status) => status.id === 'opencode' || status.available || status.id === engine)
  return <div className="engine-selector-backdrop" role="dialog" aria-modal="true" aria-label="执行引擎" data-testid="mobile-engine-selector">
    <section className="engine-selector-dialog">
      <h3>执行引擎</h3>
      <label>智能体<select aria-label="智能体" value={agentId} onChange={(event) => setAgentId(event.target.value)}>{props.agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>执行引擎<select aria-label="执行引擎" data-testid="mobile-agent-engine" value={engine} onChange={(event) => { setEngine(event.target.value as EngineId); setModel(''); setThinking('') }}>{visibleEngines.map((item) => <option key={item.id} value={item.id}>{ENGINE_LABELS[item.id]}{item.available ? '' : '（未就绪）'}</option>)}</select></label>
      {engine === 'opencode' && <label>OpenCode（Jeff）模型<select data-testid="mobile-jeff-model" value={modelKey} onChange={(event) => setModelKey(event.target.value)}><option value="">跟随 OpenCode（Jeff）默认</option>{jeffModels.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
      {engine !== 'opencode' && <label>CLI 模型（留空沿用默认）<input data-testid="mobile-engine-model" list="mobile-engine-models" value={model} onChange={(event) => setModel(event.target.value)} /><datalist id="mobile-engine-models">{models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</datalist></label>}
      {engine !== 'cursor' && <label>思考档位<select aria-label="思考档位" value={thinking} onChange={(event) => setThinking(event.target.value)}><option value="">跟随引擎</option><option value="low">低</option><option value="high">高</option><option value="max">最高</option></select></label>}
      <p>{statuses.find((item) => item.id === engine)?.error || statuses.find((item) => item.id === engine)?.version || ''}</p>
      <p>CLI 在电脑上执行。安装和登录请在电脑上完成。切换引擎会新建会话，原记录保留。</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" data-testid="mobile-engine-save" disabled={busy || !agent} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
      <button type="button" disabled={busy} onClick={props.onClose}>取消</button>
    </section>
  </div>
}
