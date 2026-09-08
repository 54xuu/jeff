import { useRef, useState } from 'react'
import Picker, { type Theme } from 'emoji-picker-react'
import { useDismissable } from '../../hooks/useDismissable'
import { effectiveTheme } from '../../store'

function SmileIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5s1.2 1.8 3.5 1.8 3.5-1.8 3.5-1.8" />
      <line x1="9" y1="9.5" x2="9.01" y2="9.5" strokeWidth="2.4" />
      <line x1="15" y1="9.5" x2="15.01" y2="9.5" strokeWidth="2.4" />
    </svg>
  )
}

/**
 * emoji 选择器：输入框右侧的正方形按钮，点击弹出完整 emoji 面板（可搜索/分类浏览）。
 * 选中回写输入框并关闭；Esc / 点空白关闭。数据内置离线可用（emoji-picker-react）。
 */
export function EmojiPickerButton(props: {
  /** 当前输入值（用作按钮展示；空则显示笑脸图标） */
  value?: string
  onPick: (emoji: string) => void
  testId?: string
  title?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useDismissable(open, () => setOpen(false), rootRef)
  // 打开那一刻读取当前主题（应用内切换主题会重渲染祖先；面板按需挂载，无需订阅）
  const theme = (open && effectiveTheme(document.documentElement.dataset.theme as 'light' | 'dark' | undefined) === 'dark' ? 'dark' : 'light') as Theme
  return (
    <div className="emoji-pick" ref={rootRef}>
      <button
        type="button"
        className="emoji-pick-btn"
        data-testid={props.testId}
        title={props.title || '选择 emoji'}
        aria-label={props.title || '选择 emoji'}
        onClick={() => setOpen((v) => !v)}
      >
        {props.value ? <span className="emoji-pick-cur">{props.value}</span> : <SmileIcon />}
      </button>
      {open && (
        <div className="emoji-pick-pop" data-testid={props.testId ? `${props.testId}-pop` : undefined}>
          <Picker
            onEmojiClick={(d) => {
              props.onPick(d.emoji)
              setOpen(false)
            }}
            theme={theme}
            emojiStyle="native"
            searchPlaceholder="搜索 emoji…"
            lazyLoadEmojis
            previewConfig={{ showPreview: false }}
            skinTonesDisabled
            width={332}
            height={360}
          />
        </div>
      )}
    </div>
  )
}
