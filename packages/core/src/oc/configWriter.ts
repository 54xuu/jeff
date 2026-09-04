import fs from 'node:fs'
import path from 'node:path'
import type { JeffPaths } from '../paths.js'
import { BUILTIN_PROVIDER_PRESETS } from '../ipc/contract.js'

/** 用户的 provider 配置（存于 kv settings:providers） */
export interface ProviderSetting {
  id: string // opencode provider id
  kind: 'builtin' | 'custom'
  name: string // 展示名
  apiKey?: string
  /** custom（OpenAI 兼容端点）专用 */
  baseURL?: string
  /** custom 的模型 id 列表 */
  models?: Array<{ id: string; name?: string }>
}



/** 写 opencode.json（provider 声明）+ auth.json（密钥）。保留 mcp/skill 等其余字段。 */
export function writeSidecarConfig(
  p: JeffPaths,
  providers: ProviderSetting[],
  opts: { defaultModel?: { providerID: string; modelID: string }; mcp?: Record<string, unknown> } = {},
): void {
  const configFile = path.join(p.ocConfigDir, 'opencode.json')
  let cfg: Record<string, unknown> = {}
  try {
    cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>
  } catch {
    /* 首次不存在 */
  }
  const providerCfg: Record<string, unknown> = {}
  for (const pv of providers) {
    if (pv.kind === 'custom') {
      providerCfg[pv.id] = {
        npm: '@ai-sdk/openai-compatible',
        name: pv.name || pv.id,
        options: { baseURL: pv.baseURL || '' },
        models: Object.fromEntries((pv.models || []).map((m) => [m.id, m.name ? { name: m.name } : {}])),
      }
    }
    // builtin provider 不写配置（models.dev 目录自动提供），只写 auth
  }
  cfg['provider'] = providerCfg
  if (opts.mcp) cfg['mcp'] = opts.mcp
  if (opts.defaultModel?.providerID && opts.defaultModel?.modelID) {
    cfg['small_model'] = `${opts.defaultModel.providerID}/${opts.defaultModel.modelID}`
  }
  cfg['permission'] = { edit: 'allow', bash: 'allow', webfetch: 'allow' }
  fs.mkdirSync(p.ocConfigDir, { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8')

  // auth.json：API key（含 custom 端点）
  const auth: Record<string, { type: string; key: string }> = {}
  for (const pv of providers) {
    if (pv.apiKey) auth[pv.id] = { type: 'api', key: pv.apiKey }
  }
  fs.writeFileSync(path.join(p.ocConfigDir, 'auth.json'), JSON.stringify(auth, null, 2), 'utf8')
}
