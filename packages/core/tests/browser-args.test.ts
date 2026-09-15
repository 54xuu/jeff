import { describe, it, expect } from 'vitest'
import { normalizeViewportArgs, parseFullPageFlag, shotName, VIEWPORT_LIMITS } from '../src/tools/browserArgs.js'
import { allToolDefs } from '../src/tools/definitions.js'

/**
 * 浏览器工具参数的规范化规则（v1.8.7）：
 * 这两条规则过去在内联代码里、没有单测，被真模型咬过——现在钉在这里。
 */
describe('jeff_browser_set_viewport 参数规范化', () => {
  it('一个字段都没给（含全空串）→ 明确报错，而不是静默改成自适应', () => {
    // 为什么这条重要：模型会一次把所有字段补空再调 update 类工具（AGENTS.md 硬规矩②），
    // 若把空串当 auto，它就能把刚设好的分辨率抹掉，还回复「已按你的要求设置」。
    expect(() => normalizeViewportArgs({})).toThrow(/没有要设置的分辨率/)
    expect(() => normalizeViewportArgs({ preset: '' })).toThrow(/没有要设置的分辨率/)
    expect(() => normalizeViewportArgs({ preset: '   ', width: '', height: '' })).toThrow(/没有要设置的分辨率/)
    expect(normalizeViewportArgs({ preset: 'auto' })).toEqual({ mode: 'auto' })
    expect(normalizeViewportArgs({ preset: '自适应' })).toEqual({ mode: 'auto' })
  })

  it('preset="4:3" → 比例自适应；全角冒号/空格容错', () => {
    expect(normalizeViewportArgs({ preset: '4:3' })).toEqual({ mode: 'ratio', aspect: 4 / 3, ratio: '4:3' })
    expect(normalizeViewportArgs({ preset: '4：3' })).toEqual({ mode: 'ratio', aspect: 4 / 3, ratio: '4:3' })
    expect(normalizeViewportArgs({ preset: 'ratio' })).toEqual({ mode: 'ratio', aspect: 4 / 3, ratio: '4:3' })
  })

  it('同时传 width/height → 精确像素（字符串/数字/"1697px" 都认）', () => {
    expect(normalizeViewportArgs({ width: 1697, height: 1063 })).toEqual({ mode: 'fixed', width: 1697, height: 1063 })
    expect(normalizeViewportArgs({ width: '1697', height: '1063' })).toEqual({ mode: 'fixed', width: 1697, height: 1063 })
    expect(normalizeViewportArgs({ width: '1697px', height: '1063' })).toEqual({ mode: 'fixed', width: 1697, height: 1063 })
    // 精确分辨率优先于 preset（模型偶尔两个都给，这时「点名要的像素」更该赢）
    expect(normalizeViewportArgs({ preset: '4:3', width: 1697, height: 1063 })).toEqual({ mode: 'fixed', width: 1697, height: 1063 })
  })

  it('只给一边 / 越界 / 不认识的 preset → 明确报错（不猜意图）', () => {
    expect(() => normalizeViewportArgs({ width: 1697 })).toThrow(/一起传/)
    expect(() => normalizeViewportArgs({ height: 1063 })).toThrow(/一起传/)
    expect(() => normalizeViewportArgs({ width: 100, height: 1063 })).toThrow(/320-5120/)
    expect(() => normalizeViewportArgs({ width: 1697, height: 100 })).toThrow(/240-5120/)
    expect(() => normalizeViewportArgs({ width: 1697, height: 1063.5 })).toThrow(/整数/)
    expect(() => normalizeViewportArgs({ preset: '16:9' })).toThrow(/只支持/)
  })

  it('边界值恰好可用（320x240 与 5120x5120）', () => {
    expect(normalizeViewportArgs({ width: VIEWPORT_LIMITS.minWidth, height: VIEWPORT_LIMITS.minHeight })).toEqual({ mode: 'fixed', width: 320, height: 240 })
    expect(normalizeViewportArgs({ width: 5120, height: 5120 })).toEqual({ mode: 'fixed', width: 5120, height: 5120 })
  })
})

describe('jeff_browser_screenshot 参数与文件名', () => {
  it('full_page 只认「真」值，空串/未传一律当只截可视区', () => {
    expect(parseFullPageFlag(undefined)).toBe(false)
    expect(parseFullPageFlag('')).toBe(false)
    expect(parseFullPageFlag('  ')).toBe(false)
    expect(parseFullPageFlag('false')).toBe(false)
    expect(parseFullPageFlag(true)).toBe(true)
    expect(parseFullPageFlag('true')).toBe(true)
    expect(parseFullPageFlag('TRUE')).toBe(true)
  })

  it('文件名带标题：清掉路径分隔符等非法字符、截断、空标题退回 shot', () => {
    expect(shotName('公众号文章：如何优雅地写测试')).toBe('公众号文章：如何优雅地写测试')
    expect(shotName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j')
    expect(shotName('带\n换行\t与  多空格')).toBe('带 换行 与 多空格')
    expect(shotName('')).toBe('shot')
    expect(shotName('   ')).toBe('shot')
    expect(shotName('/')).toBe('shot')
    expect(shotName('x'.repeat(200)).length).toBe(60)
    expect(shotName('trailing...  ')).toBe('trailing')
  })
})

describe('工具定义与实现的一致性（新参数必须对模型可见）', () => {
  it('jeff_browser_set_viewport 必须声明 preset/width/height', () => {
    const d = allToolDefs().find((x) => x.name === 'jeff_browser_set_viewport')
    expect(d, '缺少 jeff_browser_set_viewport 定义').toBeTruthy()
    expect(Object.keys(d!.args).sort()).toEqual(['height', 'preset', 'width'])
  })

  it('jeff_browser_screenshot 必须声明 full_page', () => {
    const d = allToolDefs().find((x) => x.name === 'jeff_browser_screenshot')
    expect(d).toBeTruthy()
    expect(Object.keys(d!.args)).toContain('full_page')
  })

  it('给模型的浏览器工具参数只用标量（嵌套对象会被模型丢成空串）', () => {
    for (const d of allToolDefs()) {
      if (!d.name.startsWith('jeff_browser_')) continue
      for (const [key, spec] of Object.entries(d.args)) {
        const type = (spec as { type?: string }).type
        expect(['string', 'number', 'boolean'].includes(String(type)), `${d.name}.${key} 的类型是 ${type}，应当只用标量`).toBe(true)
      }
    }
  })
})
