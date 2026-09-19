import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../api'
import { IPC, type AppSettings } from '@jeff/core'
import { playNotifySound, showDesktopNotify } from '../../notify'

type ToggleKey = 'notifyDesktop' | 'notifySound' | 'notifyOnlyBackground'
type Form = Pick<AppSettings, ToggleKey>

function readForm(s: AppSettings | null): Form {
  return {
    notifyDesktop: s?.notifyDesktop !== false,
    notifySound: s?.notifySound !== false,
    notifyOnlyBackground: s?.notifyOnlyBackground !== false,
  }
}

/** 设置 → 通知与提醒：桌面文本通知 + 消息提示音（Windows / Linux 通用） */
export default function NotificationSettings(): React.JSX.Element {
  const { settings, refreshSettings } = useStore()
  const [form, setForm] = useState<Form>(() => readForm(settings))
  const [saving, setSaving] = useState<ToggleKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 服务端为准：保存后 / 多端同步回来时把勾选状态拉回真实值
  useEffect(() => setForm(readForm(settings)), [settings])

  // 乐观更新 + 失败回滚：勾了但没存上，比勾不上更糟
  const toggle = async (k: ToggleKey, v: boolean) => {
    if (saving) return
    const prev = form[k]
    setSaving(k)
    setError(null)
    setForm((f) => ({ ...f, [k]: v }))
    try {
      await api.invoke(IPC.settingsSet, { [k]: v })
      await refreshSettings()
    } catch (err) {
      setForm((f) => ({ ...f, [k]: prev }))
      setError(`保存失败：${String((err as Error).message).slice(0, 160)}`)
    } finally {
      setSaving(null)
    }
  }

  const busy = saving !== null

  return (
    <div className="settings-content" data-testid="notification-settings">
      <h2 className="settings-title">通知与提醒</h2>
      <p className="settings-tip">
        AI 回复完成时提醒你。私聊与项目群都适用；群聊一轮可能串行跑多个成员，整条协作流水线结束才提醒一次。你正看着那个会话时不会被弹窗打断。
      </p>

      <div className="pv-detail">
        <label className="field check-field">
          <input
            type="checkbox"
            data-testid="notify-desktop"
            disabled={busy}
            checked={form.notifyDesktop}
            onChange={(e) => void toggle('notifyDesktop', e.target.checked)}
          />
          <span>桌面文本通知（回复完成时弹提醒；Linux 走系统通知，Windows 在屏幕右下角弹出气泡）</span>
        </label>

        <label className="field check-field">
          <input
            type="checkbox"
            data-testid="notify-sound"
            disabled={busy}
            checked={form.notifySound}
            onChange={(e) => void toggle('notifySound', e.target.checked)}
          />
          <span>消息提示音（清脆双音铃；不依赖系统提示音，Linux 与 Windows 表现一致）</span>
        </label>

        <label className="field check-field">
          <input
            type="checkbox"
            data-testid="notify-only-background"
            disabled={busy}
            checked={form.notifyOnlyBackground}
            onChange={(e) => void toggle('notifyOnlyBackground', e.target.checked)}
          />
          <span>仅当 Jeff 不在前台时弹桌面通知（Linux 生效；Windows 右下角气泡在看别的会话时也会弹）</span>
        </label>

        <div className="field" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <button className="text-btn" data-testid="notify-try-sound" onClick={() => playNotifySound()}>
            试听提示音
          </button>
          <button
            className="text-btn"
            data-testid="notify-try-desktop"
            onClick={() =>
              showDesktopNotify({ title: 'Jeff 通知测试', body: '看到这条系统通知，说明桌面提醒已经生效。' })
            }
          >
            发送测试通知
          </button>
        </div>

        {error && <p className="settings-error">⚠️ {error}</p>}
      </div>

      <h3 className="settings-subtitle">提醒规则</h3>
      <p className="settings-tip" style={{ margin: 0 }}>
        正在看着这个会话（窗口在前台且选中它）→ 不提醒；切到别的会话或离开 Jeff → 响提示音并弹视觉提醒。Linux 默认可勾「仅后台」避免前台横幅；Windows 用屏幕右下角气泡，不依赖系统操作中心。点击提醒会唤起 Jeff 并跳到对应会话。
      </p>
    </div>
  )
}
