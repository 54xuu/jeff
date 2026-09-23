import { describe, expect, it } from 'vitest'
import {
  HISTORY_LIMIT,
  agentDraftKey,
  arrowShouldRecallHistory,
  cronLastLabel,
  groupDraftKey,
  isStuck,
  messageWithQuotes,
  pinKey,
  pushHistory,
  readDraft,
  relativeDayTime,
  slashDismissKey,
  sortedPinKeys,
  stepHistory,
  unpinKey,
  withId,
  withoutId,
  writeDraft,
  type DraftSnapshot,
  type KvStorage,
} from '../src/util/chatUi.js'

function mem(): KvStorage & { bag: Map<string, string> } {
  const bag = new Map<string, string>()
  return {
    bag,
    getItem: (k) => (bag.has(k) ? bag.get(k)! : null),
    setItem: (k, v) => {
      bag.set(k, v)
    },
    removeItem: (k) => {
      bag.delete(k)
    },
  }
}

const empty = (): DraftSnapshot => ({ before: '', after: '', chip: null, quotes: [] })

describe('slash 关闭签名', () => {
  it('同一字段、位置、查询得到同一签名', () => {
    expect(slashDismissKey('after', 0, 'e2e')).toBe(slashDismissKey('after', 0, 'e2e'))
    expect(slashDismissKey('after', 0, 'e2e')).not.toBe(slashDismissKey('after', 0, 'e2'))
    expect(slashDismissKey('before', 0, 'e2e')).not.toBe(slashDismissKey('after', 0, 'e2e'))
  })
})

describe('发送历史', () => {
  it('空输入才用方向键回填，翻历史中途也可以', () => {
    expect(arrowShouldRecallHistory({ text: '', caret: 0, browsing: false, slashOpen: false })).toBe(true)
    expect(arrowShouldRecallHistory({ text: '你好', caret: 1, browsing: false, slashOpen: false })).toBe(false)
    expect(arrowShouldRecallHistory({ text: '你好', caret: 1, browsing: true, slashOpen: false })).toBe(true)
    expect(arrowShouldRecallHistory({ text: '', caret: 0, browsing: false, slashOpen: true })).toBe(false)
  })

  it('上翻从最近一条开始，下翻越过最近一条回到 -1', () => {
    expect(stepHistory(3, -1, 'older')).toBe(0)
    expect(stepHistory(3, 0, 'older')).toBe(1)
    expect(stepHistory(3, 2, 'older')).toBe(2)
    expect(stepHistory(3, 0, 'newer')).toBe(-1)
    expect(stepHistory(0, -1, 'older')).toBe(-1)
  })

  it('环形保留最近若干条，连续相同内容不重复压入', () => {
    let list: DraftSnapshot[] = []
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) list = pushHistory(list, { ...empty(), after: `m${i}` })
    expect(list).toHaveLength(HISTORY_LIMIT)
    expect(list[0]?.after).toBe(`m${HISTORY_LIMIT + 4}`)
    const again = pushHistory(list, { ...empty(), after: list[0]!.after })
    expect(again).toHaveLength(HISTORY_LIMIT)
  })
})

describe('草稿与贴底', () => {
  it('按会话键读写，空草稿会删掉', () => {
    const kv = mem()
    const key = agentDraftKey('ses_1')
    expect(groupDraftKey('prj_1', 'th_1')).toContain('prj_1')
    writeDraft(kv, key, { ...empty(), after: '半句' })
    expect(readDraft(kv, key)?.after).toBe('半句')
    writeDraft(kv, key, empty())
    expect(readDraft(kv, key)).toBeNull()
  })

  it('距底部小于阈值算贴底', () => {
    expect(isStuck(1000, 900, 100)).toBe(true)
    expect(isStuck(1000, 100, 100)).toBe(false)
  })
})

describe('未读、置顶、引用、定时文案', () => {
  it('未读去重，取消置顶', () => {
    expect(withId(['a'], 'a')).toEqual(['a'])
    expect(withoutId(['a', 'b'], 'a')).toEqual(['b'])
    const pins = pinKey({}, 'group:1', 2)
    expect(sortedPinKeys(pinKey(pins, 'agent:2', 5))[0]).toBe('agent:2')
    expect(unpinKey(pins, 'group:1')).toEqual({})
  })

  it('引用拼进正文', () => {
    const text = messageWithQuotes('接着问', [{ source: 'chat', text: '原话' }])
    expect(text).toContain('对话选区')
    expect(text).toContain('接着问')
    expect(messageWithQuotes('  ', [])).toBe('')
  })

  it('定时卡片：从未跑过、今天、昨天、失败', () => {
    const now = new Date(2026, 8, 22, 15, 0, 0).getTime()
    expect(cronLastLabel(null, null, now).text).toBe('尚未运行')
    const today = new Date(2026, 8, 22, 8, 5, 0).getTime()
    expect(cronLastLabel('ok', today, now).text).toBe('上次成功 · 08:05')
    const yesterday = new Date(2026, 8, 21, 8, 5, 0).getTime()
    expect(relativeDayTime(yesterday, now)).toBe('昨天 08:05')
    expect(cronLastLabel('failed', yesterday, now).failed).toBe(true)
    expect(cronLastLabel('running', today, now).text).toContain('执行中')
  })
})
