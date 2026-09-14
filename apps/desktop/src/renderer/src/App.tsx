import { useEffect } from 'react'
import { useStore, applyTheme } from './store'
import { api } from './api'
import { IPC, type BrowserConsoleEntry, type BrowserRequest } from '@jeff/core'
import NavRail from './components/NavRail'
import ChatList from './components/ChatList'
import ChatWindow from './components/ChatWindow'
import GroupWindow from './components/GroupWindow'
import AgentsPage from './components/AgentsPage'
import SchedulesPage from './components/SchedulesPage'
import PluginsPage from './components/PluginsPage'
import BrowserPanel from './components/BrowserPanel'
import PaneResizer, { PaneExpandStrip } from './components/layout/PaneResizer'
import { clampListWidth, LIST_DEFAULT_WIDTH } from './layout/panes'
import { useViewportWidth } from './layout/useViewportWidth'
import { emitConsoleEntry, registerBrowserOpener, runBrowserAction } from './browserHost'
import SettingsNav from './components/settings/SettingsNav'
import SettingsContent from './components/settings/SettingsContent'
import MarkdownPreviewModal, { PreviewNotice } from './components/preview/MarkdownPreviewModal'
import type { SettingsSection } from './store'

export default function App(): React.JSX.Element {
  const { tab, active, agents, projects, refreshAgents, refreshProjects, refreshAppInfo, refreshSettings, refreshCatalog, refreshCron, refreshPlugins, handlePush, layout, setLayout, persistLayout } = useStore()
  const winWidth = useViewportWidth()
  // 布局里存的是「偏好宽度」，渲染时按当前窗口夹一次：窗口临时变小只是把栏挤窄，偏好值不会被改掉
  const listWidth = clampListWidth(layout.listWidth, winWidth)
  /** 这几个页签的左栏有内容，才需要分隔条与开合按钮（智能体/插件页的左栏本来就是空的，靠 CSS 的 :empty 隐藏） */
  const listHasContent = tab === 'chats' || tab === 'schedules' || tab === 'settings'

  useEffect(() => {
    void refreshAgents()
    void refreshProjects()
    void refreshAppInfo()
    void refreshSettings()
    void refreshCatalog()
    void refreshCron()
    void refreshPlugins()
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
            } else if (view === 'schedules') {
              useStore.getState().setTab('schedules')
              await useStore.getState().refreshCron()
            } else if (view === 'plugins') {
              useStore.getState().setTab('plugins')
              await useStore.getState().refreshPlugins()
            } else if (view === 'browser') {
              useStore.getState().setTab('chats')
              useStore.getState().setBrowser({ visible: true, address: process.env.JEFF_SMOKE_URL || '' })
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

  /**
   * 主进程下发的浏览器动作（agent 调 jeff_browser_* 工具）→ 交给 BrowserPanel 执行后回传。
   * 必须挂在 App 层而不是面板内：面板未打开时也要先被唤起（runBrowserAction 负责自动打开并等就绪）。
   */
  useEffect(() => {
    registerBrowserOpener(() => useStore.getState().setBrowser({ visible: true }))
    const off = api.onPush((e) => {
      // 主进程补采的记录（图片/脚本/接口 404 等，webview 的 console-message 看不到）
      if (e.what === 'browser-console') {
        emitConsoleEntry((e.payload || {}) as Omit<BrowserConsoleEntry, 'at'>)
        return
      }
      if (e.what !== 'browser-request') return
      const req = (e.payload || {}) as BrowserRequest
      const reply = (r: { ok: boolean; data?: unknown; error?: string }) => {
        void api.invoke(IPC.browserResult, { id: req.id, ...r }).catch(() => {})
      }
      void runBrowserAction(req.action, req.args || {})
        .then((data) => reply({ ok: true, data }))
        .catch((err) => reply({ ok: false, error: String((err as Error)?.message || err).slice(0, 500) }))
    })
    return off
  }, [])

  return (
    <div className="app">
      <NavRail />
      {listHasContent && layout.listVisible && (
        <PaneResizer
          side="left"
          width={listWidth}
          clamp={(w) => clampListWidth(w, winWidth)}
          onResize={(w) => setLayout({ listWidth: w }, { persist: false })}
          onCommit={persistLayout}
          onReset={() => setLayout({ listWidth: LIST_DEFAULT_WIDTH })}
          onCollapse={() => setLayout({ listVisible: false })}
          collapseTitle="收起会话列表"
          testId="list-resizer"
        />
      )}
      {/* 收起时用 display:none 而不是不渲染：列表内部的展开状态（分类折叠、滚动位置）得以保留 */}
      <div className={`list-pane ${layout.listVisible ? '' : 'is-hidden'}`} style={{ width: listWidth }} data-testid="list-pane">
        {tab === 'chats' && <ChatList />}
        {tab === 'schedules' && <SchedulesListPane />}
        {tab === 'settings' && <SettingsNav />}
      </div>
      {listHasContent && !layout.listVisible && (
        <PaneExpandStrip title="展开会话列表" testId="list-expand" onExpand={() => setLayout({ listVisible: true })} />
      )}
      <div className="main-pane">
        {tab === 'chats' && active?.kind === 'agent' && <ChatWindow key={active.id} agentId={active.id} />}
        {tab === 'chats' && active?.kind === 'group' && <GroupWindow key={active.id} projectId={active.id} />}
        {tab === 'chats' && !active && <EmptyHint hasAgents={agents.length > 0} hasProjects={projects.length > 0} />}
        {tab === 'contacts' && <AgentsPage />}
        {tab === 'schedules' && <SchedulesPage />}
        {tab === 'plugins' && <PluginsPage />}
        {tab === 'settings' && <SettingsContent />}
      </div>
      {/* 内置浏览器（右侧独立面板，可拖拽宽度；关闭即销毁 webview） */}
      <BrowserPanel />
      {/* 全局公共 Markdown 预览器（任意处调用）+ 轻提示 */}
      <MarkdownPreviewModal />
      <PreviewNotice />
    </div>
  )
}

/** 定时任务视图的左侧栏：任务列表（点主区域管理） */
function SchedulesListPane(): React.JSX.Element {
  const { cronTasks } = useStore()
  return (
    <div className="side-list" data-testid="schedules-list">
      <div className="list-header">
        <span>定时任务</span>
        <span className="side-count" data-testid="schedules-count">
          {cronTasks.filter((t) => t.enabled).length}/{cronTasks.length}
        </span>
      </div>
      {cronTasks.length === 0 && <p className="side-empty">还没有定时任务</p>}
      {cronTasks.map((t) => (
        <div key={t.id} className={`side-item ${t.enabled ? '' : 'muted'}`}>
          <span className={`side-dot ${t.last_status === 'failed' ? 'bad' : t.enabled ? 'ok' : ''}`} />
          <div className="side-item-body">
            <div className="side-item-name">{t.name}</div>
            <div className="side-item-sub">
              {t.cron_human} · {t.target_label}
            </div>
          </div>
        </div>
      ))}
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
