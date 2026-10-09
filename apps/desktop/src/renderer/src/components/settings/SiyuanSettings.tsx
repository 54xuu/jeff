import { useEffect, useMemo, useState } from 'react'
import { IPC, type SiYuanConfigInfo, type SiYuanNotebook, type SiYuanSearchResult, type SiYuanTarget } from '@jeff/core'
import { api } from '../../api'

type ConnectionState = 'loading' | 'ready' | 'error' | 'configured' | 'offline'

/** Jeff is the single SiYuan client; credentials stay in this desktop's local KV. */
export default function SiyuanSettings(): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState('http://192.168.3.249:6806')
  const [token, setToken] = useState('')
  const [tokenConfigured, setTokenConfigured] = useState(false)
  const [connection, setConnection] = useState<ConnectionState>('loading')
  const [notebooks, setNotebooks] = useState<SiYuanNotebook[]>([])
  const [target, setTarget] = useState<SiYuanTarget>({ notebookId: '', parentDocId: '' })
  const [documents, setDocuments] = useState<SiYuanSearchResult[]>([])
  const [documentQuery, setDocumentQuery] = useState('')
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<SiYuanSearchResult[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | 'target' | 'search' | null>(null)

  const loadInitial = async () => {
    const [config, savedTarget] = await Promise.all([
      api.invoke<SiYuanConfigInfo>(IPC.siyuanConfigGet),
      api.invoke<SiYuanTarget>(IPC.siyuanTargetGet),
    ])
    setBaseUrl(config.baseUrl || 'http://192.168.3.249:6806')
    setTokenConfigured(config.tokenConfigured)
    setTarget(savedTarget)
    setConnection(config.tokenConfigured ? 'loading' : 'offline')
    if (config.tokenConfigured) {
      try { await loadNotebooks() }
      catch (err) { setConnection('error'); setError(`连接失败：${String((err as Error).message)}`) }
    }
  }
  useEffect(() => { void loadInitial().catch((err) => { setConnection('error'); setError(`读取配置失败：${String((err as Error).message)}`) }) }, [])

  const loadNotebooks = async () => {
    const items = await api.invoke<SiYuanNotebook[]>(IPC.siyuanNotebooks)
    setNotebooks(items.filter((item) => !item.closed))
    setConnection('ready')
    return items
  }

  useEffect(() => {
    if (!target.notebookId || !tokenConfigured) { setDocuments([]); return }
    let active = true
    void api.invoke<SiYuanSearchResult[]>(IPC.siyuanDocuments, { notebookId: target.notebookId })
      .then((items) => { if (active) setDocuments(items) })
      .catch((err) => { if (active) setError(`读取笔记本目录失败：${String((err as Error).message)}`) })
    return () => { active = false }
  }, [target.notebookId, tokenConfigured])

  const visibleDocuments = useMemo(() => {
    const q = documentQuery.trim().toLocaleLowerCase()
    if (!q) return documents
    return documents.filter((doc) => `${doc.title} ${doc.path} ${doc.docId}`.toLocaleLowerCase().includes(q))
  }, [documents, documentQuery])

  const saveConnection = async () => {
    setBusy('save'); setError(''); setMessage('')
    try {
      const value = await api.invoke<SiYuanConfigInfo>(IPC.siyuanConfigSave, { baseUrl, ...(token.trim() ? { token: token.trim() } : {}) })
      setBaseUrl(value.baseUrl); setToken(''); setTokenConfigured(value.tokenConfigured); setConnection('configured')
      setMessage('本机连接配置已保存')
    } catch (err) { setError(`保存失败：${String((err as Error).message)}`) }
    finally { setBusy(null) }
  }

  const testConnection = async () => {
    setBusy('test'); setError(''); setMessage('正在连接思源…'); setConnection('loading')
    try {
      const items = await loadNotebooks()
      setMessage(`连接成功 · ${items.length} 个可用笔记本`)
    } catch (err) { setConnection('error'); setMessage(''); setError(`连接失败：${String((err as Error).message)}`) }
    finally { setBusy(null) }
  }

  const saveTarget = async () => {
    setBusy('target'); setError(''); setMessage('')
    try {
      const value = await api.invoke<SiYuanTarget>(IPC.siyuanTargetSave, target)
      setTarget(value); setMessage('默认归档位置已保存并加入 Jeff 同步')
    } catch (err) { setError(`归档位置保存失败：${String((err as Error).message)}`) }
    finally { setBusy(null) }
  }

  const search = async () => {
    setBusy('search'); setError(''); setMessage('正在搜索全库…')
    try {
      const items = await api.invoke<SiYuanSearchResult[]>(IPC.siyuanSearch, { keyword })
      setResults(items)
      setMessage(items.length ? `找到 ${items.length} 篇候选文档` : '没有找到匹配文档')
    } catch (err) { setResults([]); setMessage(''); setError(`搜索失败：${String((err as Error).message)}`) }
    finally { setBusy(null) }
  }

  const selectedNotebook = notebooks.find((item) => item.id === target.notebookId)
  const selectedParent = documents.find((item) => item.docId === target.parentDocId)
  const statusLabel = connection === 'loading' ? '正在连接' : connection === 'error' ? '连接异常' : connection === 'ready' ? '连接已验证' : connection === 'configured' ? '待验证' : '尚未配置'

  return <div className="settings-content siyuan-settings" data-testid="siyuan-settings">
    <header className="settings-page-head">
      <div><p className="settings-eyebrow">KNOWLEDGE BASE</p><h2 className="settings-title">思源知识库</h2></div>
      <span className={`settings-state-badge ${connection}`} role="status"><i />{statusLabel}</span>
    </header>
    <p className="settings-lead">Jeff 会在对话中查阅思源资料；写入只支持新建和追加。服务凭据只保存在这台电脑。</p>

    <section className="settings-section-card" aria-labelledby="siyuan-connection-title">
      <div className="settings-section-head"><div><h3 id="siyuan-connection-title">服务连接</h3><p>连接内网思源 Kernel，供 Jeff 桌面端与已绑定手机共同使用。</p></div></div>
      <div className="siyuan-connection-grid">
        <label className="field"><span>服务地址</span><input data-testid="siyuan-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://192.168.3.249:6806" autoComplete="url" /></label>
        <label className="field"><span>Kernel API Token <small>{tokenConfigured ? '已保存 · 留空保持不变' : '尚未配置'}</small></span><input data-testid="siyuan-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={tokenConfigured ? '输入新 Token 可替换' : '粘贴思源 API Token'} autoComplete="new-password" /></label>
      </div>
      <div className="settings-action-row">
        <button className="btn primary" data-testid="siyuan-save" disabled={busy !== null || !baseUrl.trim()} onClick={() => void saveConnection()}>{busy === 'save' ? '保存中…' : '保存连接'}</button>
        <button className="btn" data-testid="siyuan-test" disabled={busy !== null || !tokenConfigured} onClick={() => void testConnection()}>{busy === 'test' ? '检测中…' : '测试连接'}</button>
        <span className="settings-inline-note">Token 不会进入同步内容、手机请求或模型上下文。</span>
      </div>
    </section>

    <section className="settings-section-card" aria-labelledby="siyuan-target-title">
      <div className="settings-section-head"><div><h3 id="siyuan-target-title">默认归档位置</h3><p>没有项目群专属位置时使用此处。项目群可在「群资料」中单独绑定目录。</p></div></div>
      <div className="siyuan-target-grid">
        <label className="field"><span>笔记本</span><select data-testid="siyuan-target-notebook" value={target.notebookId} disabled={!tokenConfigured || busy !== null} onChange={(event) => setTarget({ notebookId: event.target.value, parentDocId: '' })}>
          <option value="">未设置</option>{notebooks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="field"><span>父文档 <small>留空表示笔记本根目录</small></span><select data-testid="siyuan-target-parent" value={target.parentDocId} disabled={!target.notebookId || busy !== null} onChange={(event) => setTarget((current) => ({ ...current, parentDocId: event.target.value }))}>
          <option value="">笔记本根目录</option>{visibleDocuments.map((doc) => <option key={doc.docId} value={doc.docId}>{doc.path || doc.title}</option>)}
        </select></label>
      </div>
      {documents.length > 6 && <label className="field siyuan-doc-filter"><span>筛选父文档</span><input value={documentQuery} onChange={(event) => setDocumentQuery(event.target.value)} placeholder="按标题、路径或 ID 筛选" /></label>}
      <div className="siyuan-target-summary" data-testid="siyuan-target-summary"><span>当前目标</span><strong>{selectedNotebook ? selectedNotebook.name : '尚未选择笔记本'}{target.notebookId ? ` / ${selectedParent?.path || selectedParent?.title || (target.parentDocId ? '父文档不可用' : '笔记本根目录')}` : ''}</strong></div>
      <div className="settings-action-row"><button className="btn primary" data-testid="siyuan-target-save" disabled={busy !== null || !tokenConfigured} onClick={() => void saveTarget()}>{busy === 'target' ? '保存中…' : '保存默认位置'}</button><span className="settings-inline-note">归档位置随 Jeff 多设备同步；API Token 仍只保存在本机。</span></div>
    </section>

    <section className="settings-section-card" aria-labelledby="siyuan-search-title">
      <div className="settings-section-head"><div><h3 id="siyuan-search-title">连接检查与搜索预览</h3><p>搜索结果可用于确认服务可用和核对目标文档；日常查阅由对话中的 Agent 工具完成。</p></div></div>
      <form className="siyuan-search-form" onSubmit={(event) => { event.preventDefault(); if (keyword.trim().length >= 2 && busy === null) void search() }}>
        <label className="field"><span>搜索全库</span><input data-testid="siyuan-search-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入笔记标题或正文关键词" /></label>
        <button className="btn primary" data-testid="siyuan-search" type="submit" disabled={busy !== null || keyword.trim().length < 2}>{busy === 'search' ? '搜索中…' : '搜索思源'}</button>
      </form>
      {(message || error) && <p className={`siyuan-feedback ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'} data-testid="siyuan-message">{error || message}</p>}
      {results.length > 0 && <div className="siyuan-results" aria-label="思源搜索结果">{results.map((item) => <article className="siyuan-result-row" key={item.docId}>
        <div className="siyuan-result-main"><strong>{item.title}</strong><span>{item.path}</span><p>{item.snippet}</p></div><code>{item.docId}</code>
      </article>)}</div>}
      {busy === 'search' && <div className="siyuan-empty-state" aria-live="polite">正在读取思源索引…</div>}
      {message === '没有找到匹配文档' && <div className="siyuan-empty-state">试试缩短关键词，或换一个正文中的词。</div>}
    </section>
  </div>
}
