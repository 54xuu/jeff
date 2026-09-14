import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { slashCommandsOf, useStore, type SlashCommand } from '../store'

export interface SlashState {
  /** `/` 之后的查询串 */
  query: string
  /** `/` 在文本中的下标 */
  start: number
}

/**
 * 聊天框 `/` 指令联想（私聊与群聊共用）。
 *
 * 交互与 @ 选人一致：行首输入 `/` 触发、上下键切换、回车/Tab 选中、Esc 关闭；
 * 选中后把插件的提示词模板直接写进输入框（而不是偷偷替用户发送）——
 * 用户能先看到「将要发什么」，再自己改一改，这是可预期性最好的做法。
 */
export function useSlashMenu(opts: {
  setDraft: (v: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
}): {
  open: boolean
  candidates: SlashCommand[]
  index: number
  setIndex: (i: number) => void
  detect: (value: string) => void
  pick: (cmd: SlashCommand) => void
  /** 返回 true 表示按键已被菜单消费（调用方不要再处理回车发送） */
  handleKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  close: () => void
} {
  const plugins = useStore((s) => s.plugins)
  const [slash, setSlash] = useState<SlashState | null>(null)
  const [index, setIndex] = useState(0)
  const draftRef = useRef('')

  const commands = useMemo(() => slashCommandsOf(plugins), [plugins])
  const candidates = useMemo(() => {
    if (!slash) return []
    const q = slash.query.toLowerCase()
    return commands.filter((c) => c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q) || c.pluginName.toLowerCase().includes(q)).slice(0, 6)
  }, [slash, commands])

  useEffect(() => {
    setIndex(0)
  }, [slash?.query, candidates.length])

  const detect = (value: string) => {
    draftRef.current = value
    const el = opts.inputRef.current
    const caret = el?.selectionStart ?? value.length
    const upto = value.slice(0, caret)
    const at = upto.lastIndexOf('/')
    if (at < 0) return setSlash(null)
    // 只在「行首」触发：`a/b` 这种路径、时间戳里的斜杠不该弹出菜单
    const before = at === 0 ? '' : upto[at - 1]
    if (before && !/\s/.test(before)) return setSlash(null)
    const query = upto.slice(at + 1)
    if (/\s/.test(query)) return setSlash(null)
    if (commands.length === 0) return setSlash(null)
    setSlash({ query, start: at })
  }

  const pick = (cmd: SlashCommand) => {
    if (!slash) return
    const draft = draftRef.current
    const before = draft.slice(0, slash.start)
    const end = slash.start + 1 + slash.query.length
    const next = `${before}${cmd.prompt}${draft.slice(end)}`
    opts.setDraft(next)
    setSlash(null)
    const caret = before.length + cmd.prompt.length
    requestAnimationFrame(() => {
      const el = opts.inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
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
      setSlash(null)
      return true
    }
    return false
  }

  return { open: !!slash && candidates.length > 0, candidates, index, setIndex, detect, pick, handleKey, close: () => setSlash(null) }
}
