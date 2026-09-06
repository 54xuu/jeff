import { useEffect } from 'react'
import { useStore, applyTheme } from './store'
import { api } from './api'
import NavRail from './components/NavRail'
import ChatList from './components/ChatList'
import ChatWindow from './components/ChatWindow'
import GroupWindow from './components/GroupWindow'
import AgentsPage from './components/AgentsPage'
import SettingsNav from './components/settings/SettingsNav'
import SettingsContent from './components/settings/SettingsContent'
import type { SettingsSection } from './store'

export default function App(): React.JSX.Element {
  const { tab, active, agents, projects, refreshAgents, refreshProjects, refreshAppInfo, refreshSettings, refreshCatalog, handlePush } = useStore()

  useEffect(() => {
    void refreshAgents()
    void refreshProjects()
    void refreshAppInfo()
    void refreshSettings()
    void refreshCatalog()
    const off = api.onPush((e) => handlePush(e.what, e.payload))
    // 冒烟钩子（多视图）：JEFF_SMOKE_VIEWS=chat,group,settings:memory,… 逐视图截图
    const smokeViews = (window as { jeff?: { env?: { smokeViews?: string; smokeTheme?: string; smokeViewDelay?: string } } }).jeff?.env?.smokeViews
    if (smokeViews) {
      console.log(`[jeff-smoke] 多视图驱动启动: ${smokeViews}`)
      const smokeTheme = (window as { jeff?: { env?: { smokeTheme?: string } } }).jeff?.env?.smokeTheme
      const viewDelay = Number((window as { jeff?: { env?: { smokeViewDelay?: string } } }).jeff?.env?.smokeViewDelay || 900)
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      setTimeout(() => {
        void (async () => {
          if (smokeTheme === 'dark' || smokeTheme === 'light') applyTheme(smokeTheme)
          for (const raw of smokeViews.split(',')) {
            const view = raw.trim()
            if (!view) continue
            if (view.startsWith('settings:')) {
              useStore.getState().setTab('settings')
              useStore.getState().setSettingsSection(view.slice(9) as SettingsSection)
            } else if (view === 'contacts') {
              useStore.getState().setTab('contacts')
            } else if (view === 'group') {
              useStore.getState().setTab('chats')
              const ps = useStore.getState().projects
              useStore.getState().setActive(ps[0] ? { kind: 'group', id: ps[0].id } : null)
            } else {
              useStore.getState().setTab('chats')
              const as = useStore.getState().agents
              useStore.getState().setActive(as[0] ? { kind: 'agent', id: as[0].id } : null)
            }
            await sleep(viewDelay)
            console.log(`[jeff-smoke] 截图 ${view}`)
            await api.invoke('smoke:shot', { name: view.replace(/[^a-z0-9]+/gi, '_') })
          }
          await api.invoke('smoke:done')
        })()
      }, 1500)
    } else {
      // 单视图冒烟（CI 兼容）：自动选中第一个会话后由主进程截图
      const smokeSelect = (window as { jeff?: { env?: { smokeSelect?: string } } }).jeff?.env?.smokeSelect
      if (smokeSelect) {
        setTimeout(async () => {
          await useStore.getState().refreshProjects()
          const ps = useStore.getState().projects
          if (smokeSelect === 'group' && ps[0]) useStore.getState().setActive({ kind: 'group', id: ps[0].id })
          else if (smokeSelect === 'settings') useStore.getState().setTab('settings')
          else if (ps.length === 0) {
            const as = useStore.getState().agents
            if (as[0]) useStore.getState().setActive({ kind: 'agent', id: as[0].id })
          }
        }, 300)
      }
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
        {tab === 'settings' && <SettingsNav />}
      </div>
      <div className="main-pane">
        {tab === 'chats' && active?.kind === 'agent' && <ChatWindow key={active.id} agentId={active.id} />}
        {tab === 'chats' && active?.kind === 'group' && <GroupWindow key={active.id} projectId={active.id} />}
        {tab === 'chats' && !active && <EmptyHint hasAgents={agents.length > 0} hasProjects={projects.length > 0} />}
        {tab === 'contacts' && <AgentsPage />}
        {tab === 'settings' && <SettingsContent />}
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
