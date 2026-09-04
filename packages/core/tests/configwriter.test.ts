import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPaths } from '../src/paths.js'
import { writeSidecarConfig, type ProviderSetting } from '../src/oc/configWriter.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-cfg-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('writeSidecarConfig', () => {
  it('写入自定义 provider 与 auth，保留既有 mcp 配置', () => {
    const p = buildPaths(tmp)
    fs.mkdirSync(p.ocConfigDir, { recursive: true })
    const configFile = path.join(p.ocConfigDir, 'opencode.json')
    fs.writeFileSync(configFile, JSON.stringify({ mcp: { keep: { enabled: true } } }))

    const providers: ProviderSetting[] = [
      { id: 'deepseek', kind: 'builtin', name: 'DeepSeek', apiKey: 'sk-ds' },
      { id: 'myproxy', kind: 'custom', name: '我的中转', baseURL: 'http://x/v1', apiKey: 'sk-x', models: [{ id: 'm1', name: 'Model One' }] },
    ]
    writeSidecarConfig(p, providers, { defaultModel: { providerID: 'deepseek', modelID: 'deepseek-chat' } })

    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>
    expect(cfg['mcp']).toEqual({ keep: { enabled: true } })
    const pv = cfg['provider'] as Record<string, { npm?: string; models?: unknown }>
    expect(pv['deepseek']).toBeUndefined() // builtin 不写 provider 配置
    expect(pv['myproxy']?.npm).toBe('@ai-sdk/openai-compatible')
    expect(cfg['small_model']).toBe('deepseek/deepseek-chat')

    const auth = JSON.parse(fs.readFileSync(path.join(p.ocConfigDir, 'auth.json'), 'utf8')) as Record<string, { type: string; key: string }>
    expect(auth['deepseek'].key).toBe('sk-ds')
    expect(auth['myproxy'].key).toBe('sk-x')
  })

  it('空 provider 列表也产出合法配置', () => {
    const p = buildPaths(tmp)
    writeSidecarConfig(p, [])
    const cfg = JSON.parse(fs.readFileSync(path.join(p.ocConfigDir, 'opencode.json'), 'utf8')) as Record<string, unknown>
    expect((cfg['provider'] as unknown[])).toEqual({})
  })
})
