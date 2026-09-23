import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { slashDismissKey } from '@jeff/core'
import { slashCommandsOf, useStore, type SlashCommand } from '../store'
import { chipFromCommand, type ComposerState } from './composerState'

export interface SlashState {
  /** `/` 之后的查询串 */
  query: string
  /** `/` 在当前字段中的下标 */
  start: number
  /** 查询发生在筹码前段还是后段（无筹码时只有 after） */
  field: 'before' | 'after'
}

/**
 * 聊天框 `/` 指令联想（私聊与群聊共用）。
 *
 * 行首或空白后输入 `/` 触发；上下键切换、回车/Tab 选中、Esc 关闭。
 * 选中后把 `/指令` 换成插件筹码，不把 prompt 写进输入框。
 */
export function useSlashMenu(opts: {
  composer: ComposerState
  setComposer: (next: ComposerState | ((prev: ComposerState) => ComposerState)) => void
  afterRef: RefObject<HTMLTextAreaElement | null>
  beforeRef: RefObject<HTMLTextAreaElement | null>
}): {
  open: boolean
  candidates: SlashCommand[]
  index: number
  setIndex: (i: number) => void
  detect: (value: string, field?: 'before' | 'after') => void
  pick: (cmd: SlashCommand) => void
  /** 返回 true 表示按键已被菜单消费（调用方不要再处理回车发送） */
  handleKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  close: () => void
  /** 用方向键回填历史时跳过下一次 detect，避免正文里的 `/` 把菜单重新打开 */
  suppressDetect: () => void
} {
  const plugins = useStore((s) => s.plugins)
  const [slash, setSlash] = useState<SlashState | null>(null)
  const [index, setIndex] = useState(0)
  const composerRef = useRef(opts.composer)
  composerRef.current = opts.composer
  /** Esc 关掉后面板时记下的签名；查询没变就不再打开 */
  const dismissed = useRef<string | null>(null)
  const ignoreDetect = useRef(false)

  const commands = useMemo(() => slashCommandsOf(plugins), [plugins])
  const candidates = useMemo(() => {
    if (!slash) return []
    const q = slash.query.toLowerCase()
    return commands.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q) || c.pluginName.toLowerCase().includes(q),
    )
  }, [slash, commands])

  useEffect(() => {
    setIndex(0)
  }, [slash?.query, candidates.length])

  const detect = (value: string, field: 'before' | 'after' = 'after') => {
    if (ignoreDetect.current) {
      ignoreDetect.current = false
      return
    }
    const el = field === 'before' ? opts.beforeRef.current : opts.afterRef.current
    const caret = el?.selectionStart ?? value.length
    const upto = value.slice(0, caret)
    const at = upto.lastIndexOf('/')
    if (at < 0) {
      dismissed.current = null
      return setSlash(null)
    }
    const before = at === 0 ? '' : upto[at - 1]
    if (before && !/\s/.test(before)) {
      dismissed.current = null
      return setSlash(null)
    }
    const query = upto.slice(at + 1)
    if (/\s/.test(query)) {
      dismissed.current = null
      return setSlash(null)
    }
    if (commands.length === 0) return setSlash(null)
    const sig = slashDismissKey(field, at, query)
    if (dismissed.current === sig) return
    dismissed.current = null
    setSlash({ query, start: at, field })
  }

  const pick = (cmd: SlashCommand) => {
    if (!slash) return
    const cur = composerRef.current
    const chip = chipFromCommand(cmd)
    const eat = slash.start + 1 + slash.query.length
    let next: ComposerState
    const quotes = cur.quotes || []
    if (!cur.chip) {
      next = {
        before: cur.after.slice(0, slash.start),
        chip,
        after: cur.after.slice(eat),
        quotes,
      }
    } else if (slash.field === 'after') {
      next = {
        before: cur.before + cur.after.slice(0, slash.start),
        chip,
        after: cur.after.slice(eat),
        quotes,
      }
    } else {
      next = {
        before: cur.before.slice(0, slash.start),
        chip,
        after: cur.before.slice(eat) + cur.after,
        quotes,
      }
    }
    dismissed.current = null
    opts.setComposer(next)
    setSlash(null)
    requestAnimationFrame(() => {
      const el = opts.afterRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(0, 0)
    })
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!slash || candidates.length === 0) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (i + 1) % candidates.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (i - 1 + candidates.length) % candidates.length)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pick(candidates[index] ?? candidates[0])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      dismissed.current = slashDismissKey(slash.field, slash.start, slash.query)
      setSlash(null)
      return true
    }
    return false
  }

  return {
    open: !!slash && candidates.length > 0,
    candidates,
    index,
    setIndex,
    detect,
    pick,
    handleKey,
    close: () => setSlash(null),
    suppressDetect: () => {
      ignoreDetect.current = true
    },
  }
}
