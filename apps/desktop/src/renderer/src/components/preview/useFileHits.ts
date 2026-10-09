/**
 * 消息渲染完成后批量向主进程确认路径是否存在。
 * 流式过程中不调用（enabled=false），避免半截路径被当成文件。
 */
import { useEffect, useRef, useState } from 'react'
import { createContext } from 'react'
import { IPC, extractFileCandidates } from '@jeff/core'
import { api } from '../../api'

export const FileBaseContext = createContext<string[]>([])

const memory = new Map<string, string | null>()

export function useFileHits(text: string, bases: string[], enabled: boolean): Record<string, string> {
  const [hits, setHits] = useState<Record<string, string>>({})
  const baseKey = bases.join('\0')
  const basesRef = useRef(bases)
  basesRef.current = bases
  useEffect(() => {
    if (!enabled) {
      setHits({})
      return
    }
    const inputs = [...new Set(extractFileCandidates(text).map((c) => c.raw))]
    if (inputs.length === 0) {
      setHits({})
      return
    }
    let cancel = false
    void resolveCached(inputs, basesRef.current, baseKey)
      .then((next) => {
        if (!cancel) setHits(next)
      })
      .catch(() => {
        if (!cancel) setHits({})
      })
    return () => {
      cancel = true
    }
  }, [text, baseKey, enabled])
  return hits
}

async function resolveCached(inputs: string[], bases: string[], baseKey: string): Promise<Record<string, string>> {
  const missing = inputs.filter((input) => !memory.has(`${baseKey}\0${input}`))
  if (missing.length > 0) {
    const result = await api.invoke<{ hits: Array<{ input: string; abs: string }> }>(IPC.fsResolvePaths, { inputs: missing, bases })
    const found = new Map(result.hits.map((hit) => [hit.input, hit.abs]))
    for (const input of missing) memory.set(`${baseKey}\0${input}`, found.get(input) ?? null)
  }
  const hits: Record<string, string> = {}
  for (const input of inputs) {
    const abs = memory.get(`${baseKey}\0${input}`)
    if (abs) hits[input] = abs
  }
  return hits
}

export function resetFileHitCache(): void {
  memory.clear()
}
