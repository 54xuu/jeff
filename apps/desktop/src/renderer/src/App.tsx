import { useEffect } from 'react'
import { useStore } from './store'
import { api } from './api'
import NavRail from './components/NavRail'
import ChatList from './components/ChatList'
import ChatWindow from './components/ChatWindow'
import AgentsPage from './components/AgentsPage'
import SettingsPage from './components/SettingsPage'

export default function App(): React.JSX.Element {
  const { tab, active, agents, refreshAgents, refreshAppInfo, refreshSettings, refreshCatalog, handlePush } = useStore()

  useEffect(() => {
    void refreshAgents()
    void refreshAppInfo()
    void refreshSettings()
    void refreshCatalog()
    const off = api.onPush((e) => handlePush(e.what, e.payload))
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onMedia = () => {
      const theme = useStore.getState().settings?.theme || 'system'
      if (theme === 'system') document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'
    }
    media.addEventListener('change', onMedia)
    return () => {
      off()
      media.removeEventListener('change', onMedia)
    }
  }, [])

  return (
    <div className="app">
      <NavRail />
      <div className="list-pane">
        {tab === 'chats' && <ChatList />}
        {tab === 'contacts' && <AgentsPage />}
        {tab === 'settings' && <SettingsPage />}
      </div>
      <div className="main-pane">
        {tab === 'chats' && active?.kind === 'agent' && <ChatWindow key={active.id} agentId={active.id} />}
        {tab === 'chats' && (!active || active.kind !== 'agent') && <EmptyHint />}
        {tab === 'contacts' && <ContactHint />}
        {tab === 'settings' && <SettingsHint />}
      </div>
    </div>
  )
}

function EmptyHint(): React.JSX.Element {
  return (
    <div className="empty-hint">
      <div className="empty-logo">J</div>
      <p>选择一个会话开始聊天</p>
      <p className="sub">和小杰聊聊，让它帮你把一切都配置好</p>
    </div>
  )
}

function ContactHint(): React.JSX.Element {
  const agents = useStore((s) => s.agents)
  const hasSelection = agents.length > 0
  return (
    <div className="empty-hint">
      <p>{hasSelection ? '点击左侧智能体查看详情、编辑或开始聊天' : '还没有智能体，点左侧「新建智能体」创建一个吧'}</p>
    </div>
  )
}

function SettingsHint(): React.JSX.Element {
  return (
    <div className="empty-hint">
      <p>设置项目在左侧：提供商、外观、关于</p>
    </div>
  )
}
