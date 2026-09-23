import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import {
  arrowShouldRecallHistory,
  pushHistory,
  readDraft,
  readHistory,
  stepHistory,
  writeDraft,
  writeHistory,
  type DraftSnapshot,
} from '@jeff/core'
import { useStore } from '../store'
import { applyComposerSeed, composerFromSnapshot, emptyComposer, snapshotOf, type ComposerState } from './composerState'

/**
 * 按会话记住草稿和发送历史，并消费一次性的预填（插件「试一下」、浏览器引用）。
 * session 键还没到时不写盘，避免用空草稿盖掉上次留下的内容。
 */
export function useComposerMemory(opts: {
  storageKey: string | null
  composer: ComposerState
  setComposer: Dispatch<SetStateAction<ComposerState>>
  target: { kind: 'agent' | 'group'; id: string }
  suppressDetect: () => void
}): {
  noteSent: (sent: ComposerState) => void
  tryHistory: (e: React.KeyboardEvent, fieldText: string, slashOpen: boolean) => boolean
  fillIfEmpty: (text: string) => void
} {
  const { storageKey, composer, setComposer, suppressDetect } = opts
  const composerRef = useRef(composer)
  composerRef.current = composer
  const hydrated = useRef<string | null>(null)
  const holdWrite = useRef(false)
  const [history, setHistory] = useState<DraftSnapshot[]>([])
  const historyIndex = useRef(-1)
  const stash = useRef<ComposerState | null>(null)
  const seed = useStore((s) => s.composerSeed)

  useEffect(() => {
    historyIndex.current = -1
    stash.current = null
    if (!storageKey) {
      hydrated.current = null
      setHistory([])
      return
    }
    if (hydrated.current === storageKey) return
    hydrated.current = storageKey
    setHistory(readHistory(localStorage, storageKey))
    const saved = readDraft(localStorage, storageKey)
    holdWrite.current = true
    if (saved) {
      setComposer((prev) => {
        const textBlank = !prev.before.trim() && !prev.after.trim() && (prev.quotes || []).length === 0
        if (!textBlank) return prev
        const loaded = composerFromSnapshot(saved)
        return {
          ...loaded,
          chip: prev.chip || loaded.chip,
          quotes: (prev.quotes || []).length ? prev.quotes : loaded.quotes,
        }
      })
    }
    queueMicrotask(() => {
      holdWrite.current = false
    })
  }, [storageKey, setComposer])

  useEffect(() => {
    if (!storageKey || hydrated.current !== storageKey || holdWrite.current) return
    const key = storageKey
    const handle = window.setTimeout(() => {
      writeDraft(localStorage, key, snapshotOf(composerRef.current))
    }, 250)
    return () => {
      window.clearTimeout(handle)
      // 切走会话时防抖可能还没到点，离开前立刻落盘
      if (!holdWrite.current && hydrated.current === key) {
        writeDraft(localStorage, key, snapshotOf(composerRef.current))
      }
    }
  }, [storageKey, composer])

  useEffect(() => {
    return () => {
      const key = hydrated.current
      if (!key || holdWrite.current) return
      writeDraft(localStorage, key, snapshotOf(composerRef.current))
    }
  }, [])

  useEffect(() => {
    if (!seed) return
    if (seed.target.kind !== opts.target.kind || seed.target.id !== opts.target.id) return
    setComposer((prev) => applyComposerSeed(prev, seed))
    useStore.getState().clearComposerSeed(seed.nonce)
  }, [seed, opts.target.kind, opts.target.id, setComposer])

  const noteSent = (sent: ComposerState) => {
    if (!storageKey) return
    const next = pushHistory(history, snapshotOf(sent))
    setHistory(next)
    writeHistory(localStorage, storageKey, next)
    writeDraft(localStorage, storageKey, snapshotOf(emptyComposer()))
    historyIndex.current = -1
    stash.current = null
  }

  const tryHistory = (e: React.KeyboardEvent, fieldText: string, slashOpen: boolean): boolean => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false
    const caret = (e.currentTarget as HTMLTextAreaElement).selectionStart ?? fieldText.length
    const browsing = historyIndex.current >= 0
    if (!arrowShouldRecallHistory({ text: fieldText, caret, browsing, slashOpen })) return false
    if (history.length === 0 && historyIndex.current < 0) return false
    e.preventDefault()
    const dir = e.key === 'ArrowUp' ? 'older' : 'newer'
    if (historyIndex.current < 0) stash.current = composerRef.current
    const next = stepHistory(history.length, historyIndex.current, dir)
    historyIndex.current = next
    suppressDetect()
    if (next < 0) {
      const back = stash.current
      stash.current = null
      if (back) setComposer(back)
      return true
    }
    const item = history[next]
    if (!item) return true
    setComposer((prev) => ({ ...composerFromSnapshot(item), quotes: prev.quotes || [] }))
    return true
  }

  const fillIfEmpty = (text: string) => {
    setComposer((prev) => {
      if (prev.after.trim() || prev.before.trim() || prev.chip) return prev
      return { ...prev, after: text }
    })
  }

  return { noteSent, tryHistory, fillIfEmpty }
}
