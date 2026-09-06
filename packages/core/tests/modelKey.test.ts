import { describe, expect, it } from 'vitest'
import { formatModelKey, parseModelKey, modelDisplayLabel } from '../src/util/modelKey.js'

describe('modelKey', () => {
  it('format + parse round-trip with slash in modelID', () => {
    const key = formatModelKey('siliconflow-cn', 'Qwen/Qwen3.5-9B')
    expect(key).toBe('siliconflow-cn/Qwen/Qwen3.5-9B')
    expect(parseModelKey(key)).toEqual({ providerID: 'siliconflow-cn', modelID: 'Qwen/Qwen3.5-9B' })
  })

  it('parse rejects empty / missing slash', () => {
    expect(parseModelKey('')).toBeNull()
    expect(parseModelKey('onlyprovider')).toBeNull()
    expect(parseModelKey('/noid')).toBeNull()
    expect(parseModelKey('noprovider/')).toBeNull()
  })

  it('modelDisplayLabel prefers catalog name', () => {
    expect(
      modelDisplayLabel(
        { providerID: 'siliconflow-cn', modelID: 'Qwen/Qwen3.5-9B' },
        [{ id: 'siliconflow-cn', name: '硅基流动' }],
      ),
    ).toBe('硅基流动 / Qwen/Qwen3.5-9B')
  })
})
