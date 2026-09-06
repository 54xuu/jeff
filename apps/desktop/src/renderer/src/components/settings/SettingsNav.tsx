import { useStore, type SettingsSection } from '../../store'

const SECTIONS: Array<{ id: SettingsSection; label: string; desc: string; icon: React.JSX.Element }> = [
  {
    id: 'providers',
    label: '模型供应商',
    desc: '添加模型与密钥',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M9 4v16M4 9h16" />
      </svg>
    ),
  },
  {
    id: 'mcp',
    label: 'MCP 连接器',
    desc: '扩展工具能力',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3v5M15 3v5M6 8h12l-1 5a5 5 0 0 1-10 0L6 8zM12 18v3" />
      </svg>
    ),
  },
  {
    id: 'memory',
    label: '记忆',
    desc: '全局 / 智能体 / 项目群',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 12 3zM10 20h4" />
      </svg>
    ),
  },
  {
    id: 'engine',
    label: '引擎服务',
    desc: 'opencode 状态与重启',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12a7 7 0 0 1 12-4.9M19 12a7 7 0 0 1-12 4.9" />
        <path d="M17 3v4h-4M7 21v-4h4" />
      </svg>
    ),
  },
  {
    id: 'sync',
    label: 'WebDAV 同步',
    desc: '多设备数据同步',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6" />
      </svg>
    ),
  },
  {
    id: 'appearance',
    label: '外观',
    desc: '亮色 / 深夜 / 跟随系统',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    ),
  },
  {
    id: 'about',
    label: '关于',
    desc: '版本与数据目录',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8h.01M11 12h1v5h1" />
      </svg>
    ),
  },
]

/** 设置页左侧分组导航（settings tab 下占据原会话列表位置） */
export default function SettingsNav(): React.JSX.Element {
  const { settingsSection, setSettingsSection } = useStore()
  return (
    <div className="settings-nav">
      <div className="list-header">
        <span>设置</span>
      </div>
      <div className="settings-nav-list">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`settings-nav-item ${settingsSection === s.id ? 'on' : ''}`}
            data-testid={`settings-nav-${s.id}`}
            onClick={() => setSettingsSection(s.id)}
          >
            <span className="settings-nav-icon">{s.icon}</span>
            <span className="settings-nav-text">
              <span className="settings-nav-label">{s.label}</span>
              <span className="settings-nav-desc">{s.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
