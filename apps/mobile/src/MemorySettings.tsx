import { useEffect, useState, type MutableRefObject } from 'react'
import { IPC, type MemoryScopeInfo, type AgentsMdInfo } from '@jeff/core'
import type { PhoneLink } from './session'

type Entry = MemoryScopeInfo | AgentsMdInfo
export default function MemorySettings({ phone, onClose, backAction }: { phone: PhoneLink; onClose: () => void; backAction?: MutableRefObject<(() => void) | null> }) {
  const [mode, setMode] = useState<'memory' | 'rules'>('memory')
  const [items, setItems] = useState<Entry[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Entry | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setSelected(null); setItems([]); setError('')
    void phone.invoke<Entry[]>(mode === 'memory' ? IPC.memoryScopes : IPC.agentsMdList).then((data) => { if (active) setItems(data) }).catch((err) => { if (active) setError(err.message) })
    return () => { active = false }
  }, [phone, mode])
  const discard = () => !dirty || window.confirm('有未保存的修改，是否放弃？')
  useEffect(() => {
    if (!backAction) return
    backAction.current = () => { if (!busy && discard()) onClose() }
    return () => { backAction.current = null }
  }, [backAction, busy, dirty, onClose])
  const pick = async (item: Entry) => {
    if (busy || !discard()) return
    setBusy(true); setError('')
    try {
      const result = await phone.invoke<{ content: string }>(mode === 'memory' ? IPC.memoryGet : IPC.agentsMdGet, { kind: item.kind, id: item.id })
      setSelected(item); setContent(result.content); setDirty(false)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  const save = async () => {
    if (!selected) return
    setBusy(true); setError('')
    try {
      await phone.invoke(mode === 'memory' ? IPC.memorySave : IPC.agentsMdSave, { kind: selected.kind, id: selected.id, content })
      setDirty(false)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return <div className="engine-selector-backdrop" role="dialog" aria-modal="true" aria-label="记忆与规则">
    <section className="engine-selector-dialog mobile-memory-settings">
      <h3>记忆与规则</h3>
      <p>Jeff 自动分流：密钥和保密内容存电脑本机私有记忆；公开内容写全局或项目 AGENTS.md。</p>
      <select aria-label="内容类型" value={mode} disabled={busy} onChange={(event) => { if (discard()) { setDirty(false); setMode(event.target.value as typeof mode) } }}><option value="memory">记忆</option><option value="rules">公开规则 AGENTS.md</option></select>
      <input aria-label="搜索记忆范围" placeholder="搜索智能体或项目群…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="mobile-memory-scopes">{items.filter((item) => item.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((item) => <button type="button" key={`${item.kind}:${item.id}`} aria-pressed={selected?.kind === item.kind && selected.id === item.id} disabled={busy} onClick={() => void pick(item)}>{item.label}</button>)}</div>
      {selected && <><strong>{selected.label}</strong><textarea aria-label="记忆内容" value={content} disabled={busy} onChange={(event) => { setContent(event.target.value); setDirty(true) }} rows={8} /><p>{mode === 'memory' ? '条目用 § 分隔；[私有] 条目及识别到的凭据不参与同步。' : '全局规则对所有对话生效，项目规则仅对该项目群生效。'}</p><button type="button" data-testid="mobile-memory-save" disabled={!dirty || busy} onClick={() => void save()}>{busy ? '保存中…' : dirty ? '保存修改' : '已保存'}</button></>}
      {error && <p role="alert">{error}</p>}
      <button type="button" data-testid="mobile-memory-close" disabled={busy} onClick={() => { if (discard()) onClose() }}>关闭</button>
    </section>
  </div>
}
