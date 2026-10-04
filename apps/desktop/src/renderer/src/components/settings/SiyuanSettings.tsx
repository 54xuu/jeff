import { useEffect, useState } from 'react'
import { IPC, type SiYuanConfigInfo, type SiYuanSearchResult } from '@jeff/core'
import { api } from '../../api'

/** SiYuan API settings are local-only; the token never enters settings sync or phone payloads. */
export default function SiyuanSettings(): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [configured, setConfigured] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<SiYuanSearchResult[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = async () => {
    const value = await api.invoke<SiYuanConfigInfo>(IPC.siyuanConfigGet)
    setBaseUrl(value.baseUrl)
    setConfigured(value.tokenConfigured)
  }
  useEffect(() => { void reload().catch((error) => setMessage(String((error as Error).message))) }, [])

  const save = async () => {
    setBusy(true); setMessage('')
    try {
      const value = await api.invoke<SiYuanConfigInfo>(IPC.siyuanConfigSave, { baseUrl, ...(token.trim() ? { token } : {}) })
      setBaseUrl(value.baseUrl); setConfigured(value.tokenConfigured); setToken(''); setMessage('配置已保存在本机')
    } catch (error) { setMessage(`保存失败：${String((error as Error).message)}`) }
    finally { setBusy(false) }
  }

  const search = async () => {
    setBusy(true); setMessage('正在连接思源并搜索…')
    try {
      const items = await api.invoke<SiYuanSearchResult[]>(IPC.siyuanSearch, { keyword })
      setResults(items); setMessage(`连接成功，找到 ${items.length} 篇候选文档`)
    } catch (error) { setResults([]); setMessage(`搜索失败：${String((error as Error).message)}`) }
    finally { setBusy(false) }
  }

  return <div className="settings-content" data-testid="siyuan-settings">
    <h2 className="settings-title">思源知识库</h2>
    <p className="settings-tip">连接思源 Kernel API，用于搜索日报和读取已确认的报告来源。API Token 只保存在本机，不进入 WebDAV 同步，也不会发给手机。</p>
    <div className="settings-card">
      <label className="field"><span>服务地址</span><input data-testid="siyuan-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:6806" /></label>
      <label className="field"><span>Kernel API Token {configured ? '（已保存；留空保持不变）' : ''}</span><input data-testid="siyuan-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={configured ? '已配置' : '粘贴思源 API Token'} autoComplete="new-password" /></label>
      <div className="settings-actions"><button className="btn primary" data-testid="siyuan-save" disabled={busy || !baseUrl.trim()} onClick={() => void save()}>{busy ? '处理中…' : '保存本机配置'}</button><span className="settings-tip">{configured ? '已配置' : '尚未配置'}</span></div>
    </div>
    <div className="settings-card">
      <h3>连接测试与候选搜索</h3>
      <div className="settings-actions"><input data-testid="siyuan-search-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入日报标题或内容关键词" /><button className="btn" data-testid="siyuan-search" disabled={busy || keyword.trim().length < 2} onClick={() => void search()}>搜索思源</button></div>
      {message && <p className="settings-tip" role="status" data-testid="siyuan-message">{message}</p>}
      {results.map((item) => <div className="campaign-asset-row" key={item.docId}><span><strong>{item.title}</strong><br />{item.path}<br />{item.snippet}</span><code>{item.docId}</code></div>)}
    </div>
  </div>
}
