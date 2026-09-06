import { useStore } from '../../store'
import ProviderSettings from './ProviderSettings'
import McpSettings from './McpSettings'
import MemorySettings from './MemorySettings'
import EngineSettings from './EngineSettings'
import SyncSettings from './SyncSettings'
import AppearanceSettings from './AppearanceSettings'
import AboutSettings from './AboutSettings'

/** 设置页右侧内容区：按左侧导航选中的分组渲染 */
export default function SettingsContent(): React.JSX.Element {
  const settingsSection = useStore((s) => s.settingsSection)
  return (
    <div className="settings-pane" key={settingsSection}>
      {settingsSection === 'providers' && <ProviderSettings />}
      {settingsSection === 'mcp' && <McpSettings />}
      {settingsSection === 'memory' && <MemorySettings />}
      {settingsSection === 'engine' && <EngineSettings />}
      {settingsSection === 'sync' && <SyncSettings />}
      {settingsSection === 'appearance' && <AppearanceSettings />}
      {settingsSection === 'about' && <AboutSettings />}
    </div>
  )
}
