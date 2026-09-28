import { afterEach, describe, expect, it } from 'vitest'
import { consumeBack, pushBack } from './backstack'

afterEach(() => {
  while (consumeBack()) {
    /* 清掉用例残留 */
  }
})

describe('backstack', () => {
  it('后压入的先消费', () => {
    const order: string[] = []
    pushBack(() => order.push('a'))
    pushBack(() => order.push('b'))
    expect(consumeBack()).toBe(true)
    expect(order).toEqual(['b'])
    expect(consumeBack()).toBe(true)
    expect(order).toEqual(['b', 'a'])
    expect(consumeBack()).toBe(false)
  })

  it('取消注册后不再消费', () => {
    let n = 0
    const off = pushBack(() => {
      n += 1
    })
    off()
    expect(consumeBack()).toBe(false)
    expect(n).toBe(0)
  })
})
