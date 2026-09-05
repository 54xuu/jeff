import { useStore, applyTheme, effectiveTheme } from '../../store'
import { api } from '../../api'
import { IPC } from '@jeff/core'

const OPTIONS: Array<{ id: 'system' | 'light' | 'dark'; label: string; desc: string }> = [
  { id: 'light', label: '亮色', desc: '日间模式' },
  { id: 'dark', label: '深夜', desc: '夜间模式' },
  { id: 'system', label: '跟随系统', desc: '自动切换' },
]

/** 设置 → 外观：主题选择 + 左栏快捷切换说明 */
export default function AppearanceSettings(): React.JSX.Element {
  const { settings, refreshSettings } = useStore()
  const current = settings?.theme ?? 'system'
  const eff = effectiveTheme(current)

  const setTheme = async (theme: 'system' | 'light' | 'dark') => {
    await api.invoke(IPC.settingsSet, { theme })
    applyTheme(theme)
    void refreshSettings()
  }

  return (
    <div className="settings-content">
      <h2 className="settings-title">外观</h2>
      <p className="settings-tip">当前生效：{eff === 'dark' ? '深夜模式' : '亮色模式'}。左侧导航栏底部也有快捷切换按钮。</p>
      <div className="appearance-cards">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            className={`appearance-card ${current === o.id ? 'on' : ''}`}
            onClick={() => void setTheme(o.id)}
          >
            <span className="appearance-preview" data-preview={o.id}>
              <span className="appearance-preview-dot" />
              <span className="appearance-preview-lines">
                <i /><i /><i />
              </span>
            </span>
            <span className="appearance-card-label">{o.label}</span>
            <span className="appearance-card-desc">{o.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
