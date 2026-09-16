import type { RefObject } from 'react'
import { PluginChip } from './PluginChip'
import type { ComposerState } from './composerState'

/** 输入框：无筹码时是普通 textarea；有筹码时前段 + 筹码 + 后段，退格可整块删筹码 */
export function ComposerDraft(props: {
  composer: ComposerState
  setComposer: (s: ComposerState) => void
  afterRef: RefObject<HTMLTextAreaElement | null>
  beforeRef: RefObject<HTMLTextAreaElement | null>
  placeholder: string
  height: number
  onDetect: (value: string, field: 'before' | 'after') => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, field: 'before' | 'after') => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
}): React.JSX.Element {
  const { composer, setComposer } = props
  const chip = composer.chip

  const removeChip = (caret: number) => {
    const merged = `${composer.before}${composer.after}`
    setComposer({ before: '', chip: null, after: merged })
    requestAnimationFrame(() => {
      const el = props.afterRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  const onAfterKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (chip && e.key === 'Backspace' && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      e.preventDefault()
      removeChip(composer.before.length)
      return
    }
    props.onKeyDown(e, 'after')
  }

  const onBeforeKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (chip && e.key === 'Delete') {
      const el = e.currentTarget
      if (el.selectionStart === el.value.length && el.selectionEnd === el.value.length) {
        e.preventDefault()
        removeChip(composer.before.length)
        return
      }
    }
    props.onKeyDown(e, 'before')
  }

  return (
    <div className={`chip-draft ${chip ? 'has-chip' : ''}`}>
      {chip ? (
        <>
          <textarea
            ref={props.beforeRef}
            className="chip-draft-before"
            value={composer.before}
            rows={1}
            aria-label="插件前的文字"
            style={{ width: composer.before.length === 0 ? 8 : undefined, flex: composer.before.length === 0 ? '0 0 8px' : undefined }}
            onChange={(e) => {
              setComposer({ ...composer, before: e.target.value })
              props.onDetect(e.target.value, 'before')
            }}
            onKeyDown={onBeforeKeyDown}
            onPaste={props.onPaste}
          />
          <PluginChip pluginId={chip.pluginId} name={chip.pluginName} icon={chip.icon} iconSvg={chip.iconSvg} testId="composer-plugin-chip" />
          <textarea
            ref={props.afterRef}
            className="chip-draft-after"
            value={composer.after}
            data-testid="chat-draft"
            placeholder={composer.before ? '' : props.placeholder}
            style={{ height: props.height }}
            onChange={(e) => {
              setComposer({ ...composer, after: e.target.value })
              props.onDetect(e.target.value, 'after')
            }}
            onKeyDown={onAfterKeyDown}
            onPaste={props.onPaste}
          />
        </>
      ) : (
        <textarea
          ref={props.afterRef}
          value={composer.after}
          style={{ height: props.height }}
          data-testid="chat-draft"
          placeholder={props.placeholder}
          onChange={(e) => {
            setComposer({ before: '', chip: null, after: e.target.value })
            props.onDetect(e.target.value, 'after')
          }}
          onKeyDown={(e) => props.onKeyDown(e, 'after')}
          onPaste={props.onPaste}
        />
      )}
    </div>
  )
}
