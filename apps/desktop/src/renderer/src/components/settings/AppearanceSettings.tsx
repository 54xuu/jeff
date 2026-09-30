import { useStore, applyTheme, applyThemePack, effectiveTheme } from '../../store'
import { api } from '../../api'
import { IPC } from '@jeff/core'

const MODE_OPTIONS: Array<{ id: 'system' | 'light' | 'dark'; label: string; desc: string }> = [
  { id: 'light', label: '亮色', desc: '日间模式' },
  { id: 'dark', label: '深夜', desc: '夜间模式' },
  { id: 'system', label: '跟随系统', desc: '自动切换' },
]

const PACK_OPTIONS: Array<{ id: 'cue' | 'weui' | 'catppuccin'; label: string; desc: string }> = [
  { id: 'cue', label: '翡翠小杰（推荐）', desc: 'Logo 同源翡翠绿 · 呆萌清爽工作台' },
  { id: 'weui', label: '经典微信绿', desc: '经典微信绿强调 · 护眼温润工作台' },
  { id: 'catppuccin', label: 'Catppuccin 粉彩', desc: '低饱和粉彩 · 柔和极简' },
]

/** 设置 → 外观：主题包 + 亮/暗/跟随系统 */
export default function AppearanceSettings(): React.JSX.Element {
  const { settings, refreshSettings } = useStore()
  const current = settings?.theme ?? 'system'
  const pack = settings?.themePack ?? 'cue'
  const eff = effectiveTheme(current)

  const setTheme = async (theme: 'system' | 'light' | 'dark') => {
    await api.invoke(IPC.settingsSet, { theme })
    applyTheme(theme)
    void refreshSettings()
  }

  const setPack = async (themePack: 'cue' | 'weui' | 'catppuccin') => {
    await api.invoke(IPC.settingsSet, { themePack })
    applyThemePack(themePack)
    void refreshSettings()
  }

  return (
    <div className="settings-content" data-testid="appearance-settings">
      <h2 className="settings-title">外观</h2>
      <p className="settings-tip">
        主题包控制视觉语言；颜色模式控制亮/暗。当前生效：{eff === 'dark' ? '深夜' : '亮色'} · {PACK_OPTIONS.find((p) => p.id === pack)?.label || pack}。左侧导航栏底部可快捷切换亮暗。
      </p>

      <h3 className="settings-subtitle">主题</h3>
      <div className="appearance-cards">
        {PACK_OPTIONS.map((o) => (
          <button
            key={o.id}
            className={`appearance-card ${pack === o.id ? 'on' : ''}`}
            data-testid={`theme-pack-${o.id}`}
            onClick={() => void setPack(o.id)}
          >
            <span className="appearance-preview" data-preview={o.id}>
              <span className="appearance-preview-dot" />
              <span className="appearance-preview-lines">
                <i />
                <i />
                <i />
              </span>
            </span>
            <span className="appearance-card-label">{o.label}</span>
            <span className="appearance-card-desc">{o.desc}</span>
          </button>
        ))}
      </div>

      <h3 className="settings-subtitle">颜色模式</h3>
      <div className="appearance-cards">
        {MODE_OPTIONS.map((o) => (
          <button
            key={o.id}
            className={`appearance-card ${current === o.id ? 'on' : ''}`}
            data-testid={`theme-mode-${o.id}`}
            onClick={() => void setTheme(o.id)}
          >
            <span className="appearance-preview" data-preview={o.id}>
              <span className="appearance-preview-dot" />
              <span className="appearance-preview-lines">
                <i />
                <i />
                <i />
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
