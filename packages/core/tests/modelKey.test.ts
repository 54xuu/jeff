import { describe, expect, it } from 'vitest'
import { formatModelKey, parseModelKey, modelDisplayLabel, agentPromptOpts } from '../src/util/modelKey.js'

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

  it('agentPromptOpts：绑定模型 + thinking；空 thinking 不传 variant', () => {
    expect(
      agentPromptOpts(
        { model_provider: 'p', model_id: 'm1', thinking: 'high' },
        { providerID: 'fallback', modelID: 'fb' },
      ),
    ).toEqual({ model: { providerID: 'p', modelID: 'm1' }, variant: 'high' })
    expect(agentPromptOpts({ model_provider: '', model_id: '', thinking: '' }, { providerID: 'fallback', modelID: 'fb' })).toEqual({
      model: { providerID: 'fallback', modelID: 'fb' },
    })
    expect(agentPromptOpts(null, null)).toEqual({})
  })
})
