import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { PluginChip } from './PluginChip'
import type { ComposerState } from './composerState'

/** 筹码与其后文字的间距，计入 text-indent */
const CHIP_GAP_PX = 6

/** 输入框：无筹码时是普通 textarea；有筹码时筹码叠在首行，正文用 text-indent 让位，换行从左边起排 */
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
  const prefixRef = useRef<HTMLSpanElement>(null)
  const [indent, setIndent] = useState(0)

  useLayoutEffect(() => {
    if (!chip) {
      setIndent(0)
      return
    }
    const el = prefixRef.current
    if (!el) return
    const measure = () => {
      setIndent(Math.ceil(el.getBoundingClientRect().width) + CHIP_GAP_PX)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [chip?.pluginId, chip?.pluginName, chip?.icon, chip?.iconSvg, composer.before])

  const removeChip = (caret: number) => {
    const merged = `${composer.before}${composer.after}`
    setComposer({ ...composer, before: '', chip: null, after: merged })
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

  return (
    <div className={`chip-draft ${chip ? 'has-chip' : ''}`}>
      {chip ? (
        <>
          <span className="chip-draft-prefix" ref={prefixRef} aria-hidden>
            {composer.before ? <span className="chip-draft-lead">{composer.before}</span> : null}
            <PluginChip pluginId={chip.pluginId} name={chip.pluginName} icon={chip.icon} iconSvg={chip.iconSvg} testId="composer-plugin-chip" />
          </span>
          <textarea
            ref={props.afterRef}
            className="chip-draft-after"
            value={composer.after}
            data-testid="chat-draft"
            placeholder={composer.before ? '' : props.placeholder}
            style={{ height: props.height, textIndent: indent }}
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
            setComposer({ ...composer, before: '', chip: null, after: e.target.value })
            props.onDetect(e.target.value, 'after')
          }}
          onKeyDown={(e) => props.onKeyDown(e, 'after')}
          onPaste={props.onPaste}
        />
      )}
    </div>
  )
}
