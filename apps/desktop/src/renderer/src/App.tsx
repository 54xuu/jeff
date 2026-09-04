import { useEffect } from 'react'
import { useStore } from './store'
import { api } from './api'
import NavRail from './components/NavRail'
import ChatList from './components/ChatList'
import ChatWindow from './components/ChatWindow'
import GroupWindow from './components/GroupWindow'
import AgentsPage from './components/AgentsPage'
import SettingsPage from './components/SettingsPage'

export default function App(): React.JSX.Element {
  const { tab, active, agents, projects, refreshAgents, refreshProjects, refreshAppInfo, refreshSettings, refreshCatalog, handlePush } = useStore()

  useEffect(() => {
    void refreshAgents()
    void refreshProjects()
    void refreshAppInfo()
    void refreshSettings()
    void refreshCatalog()
    const off = api.onPush((e) => handlePush(e.what, e.payload))
    // 冒烟钩子：自动选中第一个会话（打包验证 UI 用）
    const smokeSelect = (window as { jeff?: { env?: { smokeSelect?: string } } }).jeff?.env?.smokeSelect
    if (smokeSelect) {
      setTimeout(async () => {
        await useStore.getState().refreshProjects()
        const ps = useStore.getState().projects
        if (smokeSelect === 'group' && ps[0]) useStore.getState().setActive({ kind: 'group', id: ps[0].id })
        else if (ps.length === 0) {
          const as = useStore.getState().agents
          if (as[0]) useStore.getState().setActive({ kind: 'agent', id: as[0].id })
        }
      }, 300)
    }
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
        {tab === 'chats' && active?.kind === 'group' && <GroupWindow key={active.id} projectId={active.id} />}
        {tab === 'chats' && !active && <EmptyHint hasAgents={agents.length > 0} hasProjects={projects.length > 0} />}
        {tab === 'contacts' && <ContactHint hasAgents={agents.length > 0} />}
        {tab === 'settings' && <SettingsHint />}
      </div>
    </div>
  )
}

function EmptyHint(props: { hasAgents: boolean; hasProjects: boolean }): React.JSX.Element {
  return (
    <div className="empty-hint">
      <div className="empty-logo">J</div>
      <p>选择一个会话开始聊天</p>
      <p className="sub">
        {!props.hasAgents && !props.hasProjects
          ? '和小杰聊聊，让它帮你把一切都配置好'
          : props.hasProjects
            ? '点开项目群，所有工作由群主统筹'
            : '让小杰帮你创建智能体和项目群'}
      </p>
    </div>
  )
}

function ContactHint(props: { hasAgents: boolean }): React.JSX.Element {
  return (
    <div className="empty-hint">
      <p>{props.hasAgents ? '点击左侧智能体查看详情、编辑或开始聊天' : '还没有智能体，点左侧「新建智能体」创建一个吧'}</p>
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
