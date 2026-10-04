import { useEffect, useState } from 'react'
import { IPC, parseProjectWorkspaceState, type ProjectInfo, type ProjectReportInfo, type ProjectWorkspaceState, type SiYuanSearchResult } from '@jeff/core'
import { api } from '../api'

export default function ProjectReportsPanel({ project, state, onState }: { project: ProjectInfo; state: ProjectWorkspaceState; onState: (state: ProjectWorkspaceState) => void }): React.JSX.Element {
  const today = new Date().toISOString().slice(0, 10)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SiYuanSearchResult[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [reportDates, setReportDates] = useState<Record<string, string>>({})
  const [templateId, setTemplateId] = useState('')
  const [name, setName] = useState('')
  const [periodType, setPeriodType] = useState('季度')
  const [sections, setSections] = useState('工作重点\n主要进展\n量化成果\n风险与下一步')
  const [startDate, setStartDate] = useState(`${today.slice(0, 4)}-${today.slice(5, 7)}-01`)
  const [endDate, setEndDate] = useState(today)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<ProjectReportInfo | null>(null)

  useEffect(() => { setHits([]); setSelected([]); setResult(null); setMessage('') }, [project.id])
  const update = (info: ProjectInfo) => onState(parseProjectWorkspaceState(info.workspace_state))

  const search = async () => {
    setBusy(true); setMessage('正在搜索思源日报…')
    try {
      const found = await api.invoke<SiYuanSearchResult[]>(IPC.siyuanSearch, { keyword: query })
      setHits(found); setSelected([])
      setReportDates(Object.fromEntries(found.map((item) => [item.docId, `${item.docId.slice(0, 4)}-${item.docId.slice(4, 6)}-${item.docId.slice(6, 8)}`])))
      setMessage('请核对每篇日报日期后选择来源')
    }
    catch (error) { setHits([]); setMessage(`搜索失败：${String((error as Error).message)}`) }
    finally { setBusy(false) }
  }
  const confirmSources = async () => {
    setBusy(true)
    try {
      const sources = hits.filter((item) => selected.includes(item.docId)).map(({ docId, title, path }) => ({ docId, title, path, reportDate: reportDates[docId] || '' }))
      const projectInfo = await api.invoke<ProjectInfo>(IPC.projectReport, { projectId: project.id, action: 'confirm_sources', query, sources })
      update(projectInfo); setMessage(`已确认 ${sources.length} 篇报告来源`); setSelected([])
    } catch (error) { setMessage(`确认失败：${String((error as Error).message)}`) }
    finally { setBusy(false) }
  }
  const removeSource = async (docId: string) => {
    try { update(await api.invoke<ProjectInfo>(IPC.projectReport, { projectId: project.id, action: 'remove_source', docId })) }
    catch (error) { setMessage(`移除来源失败：${String((error as Error).message)}`) }
  }
  const selectTemplate = (id: string) => {
    const value = state.reportTemplates.find((item) => item.id === id)
    setTemplateId(id); setName(value?.name || ''); setPeriodType(value?.periodType || '季度'); setSections(value?.sections.join('\n') || '')
  }
  const saveTemplate = async () => {
    setBusy(true)
    try {
      const info = await api.invoke<ProjectInfo>(IPC.projectReport, { projectId: project.id, action: 'save_template', template: { ...(templateId ? { id: templateId } : {}), name, periodType, sections: sections.split('\n'), outputFormat: 'markdown' } })
      update(info)
      const updated = parseProjectWorkspaceState(info.workspace_state).reportTemplates.find((item) => item.name === name.trim())
      if (updated) setTemplateId(updated.id)
      setMessage('报告模板已保存并同步到项目')
    } catch (error) { setMessage(`模板保存失败：${String((error as Error).message)}`) }
    finally { setBusy(false) }
  }
  const deleteTemplate = async () => {
    if (!templateId || !confirm(`删除报告模板「${name}」？`)) return
    setBusy(true)
    try { update(await api.invoke<ProjectInfo>(IPC.projectReport, { projectId: project.id, action: 'delete_template', templateId })); setTemplateId(''); setName(''); setSections(''); setMessage('模板已删除') }
    catch (error) { setMessage(`模板删除失败：${String((error as Error).message)}`) }
    finally { setBusy(false) }
  }
  const generate = async () => {
    setBusy(true); setResult(null); setMessage('正在读取确认过的日报并请项目群生成草稿…')
    try {
      const output = await api.invoke<ProjectReportInfo>(IPC.projectReport, { projectId: project.id, action: 'generate', templateId, startDate, endDate })
      setResult(output); setMessage(`报告草稿已生成，引用 ${output.sourceDocIds.length} 篇日报`)
    } catch (error) { setMessage(`生成失败：${String((error as Error).message)}`) }
    finally { setBusy(false) }
  }

  return <section className="campaign-assets" data-testid="project-reports-panel">
    <h3>思源日报与报告模板</h3>
    <p className="settings-tip">先搜索并确认来源，再按模板和日期范围生成 Markdown 草稿。生成时，已确认日报正文会发送给本项目群主智能体所用模型，并在独立报告话题中留痕；请先核对日期，避免思源文档创建时间与日报日期不一致。API Token 只存在桌面本机；App 通过加密链路请求搜索和读取，来源确认记录随项目同步。</p>
    <label className="field"><span>搜索日报标题或正文</span><input data-testid="report-source-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：腕表呼叫 / 2026-10" /></label>
    <button className="btn" data-testid="report-source-search" disabled={busy || query.trim().length < 2} onClick={() => void search()}>搜索思源日报</button>
    {hits.map((item) => <div className="campaign-asset-row" key={item.docId}><span><strong>{item.title}</strong> · {item.path}<br />{item.snippet}<br /><label>日报日期 <input type="date" aria-label={`${item.title} 的日报日期`} value={reportDates[item.docId] || ''} onChange={(event) => setReportDates((dates) => ({ ...dates, [item.docId]: event.target.value }))} /></label></span><input type="checkbox" aria-label={`选择 ${item.title}`} checked={selected.includes(item.docId)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, item.docId] : ids.filter((id) => id !== item.docId))} /></div>)}
    {hits.length > 0 && <button className="btn primary" data-testid="report-source-confirm" disabled={busy || selected.length === 0} onClick={() => void confirmSources()}>确认所选来源</button>}
    {state.reportSources.length > 0 && <div data-testid="confirmed-report-sources"><strong>已确认的报告来源（{state.reportSources.length}）</strong>{state.reportSources.map((item) => <div className="campaign-asset-row" key={item.docId}><span>{item.reportDate} · {item.title} · {item.path}</span><button className="btn" onClick={() => void removeSource(item.docId)}>移除</button></div>)}</div>}
    <hr />
    <label className="field"><span>选择或新建报告模板</span><select data-testid="report-template-select" value={templateId} onChange={(event) => selectTemplate(event.target.value)}><option value="">新模板</option>{state.reportTemplates.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.periodType}</option>)}</select></label>
    <label className="field"><span>模板名称</span><input data-testid="report-template-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="技术部工作总结" /></label>
    <label className="field"><span>报告周期类型（可扩展）</span><input data-testid="report-template-period" list="report-period-presets" value={periodType} onChange={(event) => setPeriodType(event.target.value)} /><datalist id="report-period-presets"><option value="月报" /><option value="季报" /><option value="年报" /><option value="自定义" /></datalist></label>
    <label className="field"><span>栏目顺序（每行一个）</span><textarea data-testid="report-template-sections" rows={5} value={sections} onChange={(event) => setSections(event.target.value)} /></label>
    <div className="settings-actions"><button className="btn primary" data-testid="report-template-save" disabled={busy || !name.trim() || !periodType.trim() || !sections.trim()} onClick={() => void saveTemplate()}>保存模板</button>{templateId && <button className="btn" disabled={busy} onClick={() => void deleteTemplate()}>删除模板</button>}</div>
    <label className="field"><span>报告日期范围</span><div className="settings-actions"><input data-testid="report-start-date" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /><input data-testid="report-end-date" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></div></label>
    <button className="btn primary" data-testid="report-generate" disabled={busy || !templateId || !state.reportSources.length || startDate > endDate} onClick={() => void generate()}>{busy ? '处理中…' : '生成报告草稿'}</button>
    {message && <p className="settings-tip" role="status" data-testid="report-message">{message}</p>}
    {result && <details open data-testid="report-result"><summary>{result.path}</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 480, overflow: 'auto' }}>{result.content}</pre></details>}
  </section>
}
