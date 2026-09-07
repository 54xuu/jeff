import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPaths } from '../src/paths.js'
import { writeSidecarConfig, migrateProviders, firstEnabledModel, thinkingVariant, type ProviderSetting } from '../src/oc/configWriter.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-cfg-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('migrateProviders（v1.1 → v1.2 数据迁移）', () => {
  it('丢弃 builtin、补齐 custom 新字段', () => {
    const raw = [
      { id: 'deepseek', kind: 'builtin', name: 'DeepSeek', apiKey: 'sk-ds' },
      { id: 'myproxy', kind: 'custom', name: '我的中转', baseURL: 'http://x/v1', apiKey: 'sk-x', models: [{ id: 'm1', name: 'Model One', attachment: true }] },
    ]
    const out = migrateProviders(raw)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('myproxy')
    expect(out[0].apiFormat).toBe('chat')
    expect(out[0].enabled).toBe(true)
    expect(out[0].models[0].id).toBe('m1')
    expect(out[0].models[0].attachment).toBe(true)
  })
})

describe('firstEnabledModel（会话兜底模型解析）', () => {
  it('返回第一个启用提供商的第一个模型；跳过禁用', () => {
    const ps = migrateProviders([
      { id: 'a', kind: 'custom', enabled: false, models: [{ id: 'm-a1' }] },
      { id: 'b', kind: 'custom', enabled: true, models: [{ id: 'm-b1' }, { id: 'm-b2' }] },
    ])
    expect(firstEnabledModel(ps)).toEqual({ providerID: 'b', modelID: 'm-b1' })
    expect(firstEnabledModel([])).toBeNull()
  })
})

describe('thinkingVariant（思考档位跨厂商映射）', () => {
  it('Chat：none→thinking.disabled；强度带 enabled + reasoningEffort（max 保留）', () => {
    expect(thinkingVariant('chat', 'none')).toEqual({ thinking: { type: 'disabled' } })
    expect(thinkingVariant('chat', 'low')).toEqual({ thinking: { type: 'enabled' }, reasoningEffort: 'low' })
    expect(thinkingVariant('chat', 'high')).toEqual({ thinking: { type: 'enabled' }, reasoningEffort: 'high' })
    expect(thinkingVariant('chat', 'max')).toEqual({ thinking: { type: 'enabled' }, reasoningEffort: 'max' })
  })
  it('Responses：none→reasoningEffort none；强度保留 max', () => {
    expect(thinkingVariant('responses', 'none')).toEqual({ reasoningEffort: 'none' })
    expect(thinkingVariant('responses', 'low')).toEqual({ reasoningEffort: 'low' })
    expect(thinkingVariant('responses', 'max')).toEqual({ reasoningEffort: 'max' })
  })
  it('Anthropic：budgetTokens low=4096 high=16384 max=32768，none 显式禁用', () => {
    expect(thinkingVariant('anthropic', 'low')).toEqual({ thinking: { type: 'enabled', budgetTokens: 4096 } })
    expect(thinkingVariant('anthropic', 'high')).toEqual({ thinking: { type: 'enabled', budgetTokens: 16384 } })
    expect(thinkingVariant('anthropic', 'max')).toEqual({ thinking: { type: 'enabled', budgetTokens: 32768 } })
    expect(thinkingVariant('anthropic', 'none')).toEqual({ thinking: { type: 'disabled' } })
  })
})

describe('writeSidecarConfig（v1.2 三格式 + variants）', () => {
  it('chat 格式：npm 包 + limit + variants + skills 挂载', () => {
    const p = buildPaths(tmp)
    fs.mkdirSync(p.ocConfigDir, { recursive: true })
    const configFile = path.join(p.ocConfigDir, 'opencode.json')
    fs.writeFileSync(configFile, JSON.stringify({ mcp: { keep: { enabled: true } } }))

    const providers: ProviderSetting[] = [
      {
        id: 'myproxy',
        name: '我的中转',
        apiFormat: 'chat',
        baseURL: 'http://x/v1',
        apiKey: 'sk-x',
        enabled: true,
        models: [
          { id: 'm1', name: 'Model One', contextLimit: 128000, outputLimit: 8192, thinkingTiers: ['none', 'low', 'max'] },
          { id: 'm2', attachment: true },
        ],
      },
    ]
    writeSidecarConfig(p, providers)

    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, never>
    expect(cfg['mcp']).toEqual({ keep: { enabled: true } })
    const pv = cfg['provider'] as Record<string, { npm?: string; options?: { baseURL?: string }; models?: Record<string, { limit?: { context?: number; output?: number }; variants?: Record<string, unknown>; attachment?: boolean }> }>
    expect(pv['myproxy']?.npm).toBe('@ai-sdk/openai-compatible')
    expect(pv['myproxy']?.options?.baseURL).toBe('http://x/v1')
    const m1 = pv['myproxy']?.models?.['m1']
    expect(m1?.limit).toEqual({ context: 128000, output: 8192 })
    expect(m1?.variants?.['low']).toEqual({ thinking: { type: 'enabled' }, reasoningEffort: 'low' })
    expect(m1?.variants?.['max']).toEqual({ thinking: { type: 'enabled' }, reasoningEffort: 'max' })
    expect(m1?.variants?.['none']).toEqual({ thinking: { type: 'disabled' } })
    expect(m1?.variants?.['high']).toBeUndefined() // 未选中的档位不生成
    expect(pv['myproxy']?.models?.['m2']?.attachment).toBe(true)
    // skills 挂载 ~/.agents/skills
    expect((cfg['skills'] as { paths?: string[] }).paths).toContain('~/.agents/skills')
    // model / small_model = 第一个启用提供商的第一个模型
    expect(cfg['model']).toBe('myproxy/m1')
    expect(cfg['small_model']).toBe('myproxy/m1')

    const auth = JSON.parse(fs.readFileSync(path.join(p.ocDataHome, 'opencode', 'auth.json'), 'utf8')) as Record<string, { type: string; key: string }>
    expect(auth['myproxy'].key).toBe('sk-x')
  })

  it('anthropic 格式：npm 包与 thinking budget variants', () => {
    const p = buildPaths(tmp)
    const providers: ProviderSetting[] = [
      { id: 'cl', name: 'Claude', apiFormat: 'anthropic', baseURL: 'https://api.anthropic.com', enabled: true, models: [{ id: 'claude-x', thinkingTiers: ['low', 'high', 'max'] }] },
    ]
    writeSidecarConfig(p, providers)
    const cfg = JSON.parse(fs.readFileSync(path.join(p.ocConfigDir, 'opencode.json'), 'utf8')) as Record<string, never>
    const pv = cfg['provider'] as Record<string, { npm?: string; models?: Record<string, { variants?: Record<string, { thinking?: { type: string; budgetTokens?: number } }> }> }>
    expect(pv['cl']?.npm).toBe('@ai-sdk/anthropic')
    const variants = pv['cl']?.models?.['claude-x']?.variants
    expect(variants?.['low']?.thinking).toEqual({ type: 'enabled', budgetTokens: 4096 })
    expect(variants?.['max']?.thinking).toEqual({ type: 'enabled', budgetTokens: 32768 })
  })

  it('responses 格式使用 @ai-sdk/openai；禁用提供商不写入配置也不参与默认模型', () => {
    const p = buildPaths(tmp)
    const providers: ProviderSetting[] = [
      { id: 'off', name: 'Off', apiFormat: 'responses', enabled: false, models: [{ id: 'gpt' }] },
      { id: 'on', name: 'On', apiFormat: 'responses', enabled: true, models: [{ id: 'm1' }] },
    ]
    writeSidecarConfig(p, providers)
    const cfg = JSON.parse(fs.readFileSync(path.join(p.ocConfigDir, 'opencode.json'), 'utf8')) as Record<string, never>
    const pv = cfg['provider'] as Record<string, { npm?: string }>
    expect(pv['off']).toBeUndefined()
    expect(pv['on']?.npm).toBe('@ai-sdk/openai')
    expect(cfg['model']).toBe('on/m1')
  })

  it('空 provider 列表也产出合法配置且无 model 键', () => {
    const p = buildPaths(tmp)
    writeSidecarConfig(p, [])
    const cfg = JSON.parse(fs.readFileSync(path.join(p.ocConfigDir, 'opencode.json'), 'utf8')) as Record<string, unknown>
    expect(cfg['provider']).toEqual({})
    expect(cfg['model']).toBeUndefined()
    expect(cfg['small_model']).toBeUndefined()
  })
})
