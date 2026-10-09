import { useEffect, useState } from 'react'
import { useStore, type SettingsSection } from '../../store'
import McpSettings from './McpSettings'
import MemorySettings from './MemorySettings'
import EngineSettings from './EngineSettings'
import SyncSettings from './SyncSettings'
import NotificationSettings from './NotificationSettings'
import AppearanceSettings from './AppearanceSettings'
import AboutSettings from './AboutSettings'
import RemoteSettings from './RemoteSettings'
import SiyuanSettings from './SiyuanSettings'

/** 设置页右侧内容区：按左侧导航选中的分组渲染 */
export default function SettingsContent(): React.JSX.Element {
  const settingsSection = useStore((s) => s.settingsSection)
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set([settingsSection]))
  useEffect(() => setVisited((current) => new Set([...current, settingsSection])), [settingsSection])
  const sections: Array<{ id: SettingsSection; content: React.JSX.Element }> = [
    { id: 'mcp', content: <McpSettings /> },
    { id: 'memory', content: <MemorySettings /> },
    { id: 'engine', content: <EngineSettings /> },
    { id: 'sync', content: <SyncSettings /> },
    { id: 'siyuan', content: <SiyuanSettings /> },
    { id: 'notification', content: <NotificationSettings /> },
    { id: 'appearance', content: <AppearanceSettings /> },
    { id: 'remote', content: <RemoteSettings /> },
    { id: 'about', content: <AboutSettings /> },
  ]
  return (
    <div className="settings-pane" data-testid="settings-pane">
      {sections.map(({ id, content }) => visited.has(id) && <div className="settings-section-panel" key={id} hidden={settingsSection !== id} aria-hidden={settingsSection !== id}>{content}</div>)}
    </div>
  )
}
