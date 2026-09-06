import fs from 'node:fs'
import path from 'node:path'
import type { JeffPaths } from '../paths.js'
import type { ApiFormat, ThinkingTier } from '../ipc/contract.js'

/** 用户 provider 配置（存 kv settings:providers）。v1.2 起只有自定义提供商，无内置。 */
export interface ProviderModelCfg {
  id: string
  name?: string
  /** 支持图片输入（多模态） */
  attachment?: boolean
  /** 上下文窗口（tokens） */
  contextLimit?: number
  /** 最大输出 tokens */
  outputLimit?: number
  /** 支持的思考档位（多选；仅生成所选档位的 variant） */
  thinkingTiers?: ThinkingTier[]
}

export interface ProviderSetting {
  id: string // opencode provider id
  name: string // 展示名
  apiFormat: ApiFormat
  baseURL?: string
  apiKey?: string
  enabled: boolean
  models: ProviderModelCfg[]
}

/** Anthropic 各思考档位的 thinking budget（tokens） */
export const ANTHROPIC_BUDGET: Record<Exclude<ThinkingTier, 'none'>, number> = { low: 4096, high: 16384, max: 32768 }

/** API 格式 → opencode provider npm 适配包 */
export const API_FORMAT_NPM: Record<ApiFormat, string> = {
  chat: '@ai-sdk/openai-compatible',
  responses: '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
}

/** 兼容旧版 kv 数据：v1.1 的 kind:'builtin' 直接丢弃；custom 补齐新字段 */
export function migrateProviders(raw: unknown): ProviderSetting[] {
  if (!Array.isArray(raw)) return []
  const out: ProviderSetting[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    if (o.kind === 'builtin') continue // 内置预设已移除，直接丢弃
    const modelsRaw = Array.isArray(o.models) ? o.models : []
    const models: ProviderModelCfg[] = modelsRaw
      .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string')
      .map((m) => ({
        id: m.id as string,
        ...(typeof m.name === 'string' && m.name ? { name: m.name } : {}),
        ...(m.attachment === true ? { attachment: true } : {}),
        ...(typeof m.contextLimit === 'number' ? { contextLimit: m.contextLimit } : {}),
        ...(typeof m.outputLimit === 'number' ? { outputLimit: m.outputLimit } : {}),
        ...(Array.isArray(m.thinkingTiers) ? { thinkingTiers: (m.thinkingTiers as ThinkingTier[]).filter((t) => ['none', 'low', 'high', 'max'].includes(t)) } : {}),
      }))
    const apiFormat = o.apiFormat === 'responses' || o.apiFormat === 'anthropic' ? o.apiFormat : 'chat'
    out.push({
      id: String(o.id ?? ''),
      name: typeof o.name === 'string' && o.name ? o.name : String(o.id ?? ''),
      apiFormat,
      ...(typeof o.baseURL === 'string' && o.baseURL ? { baseURL: o.baseURL } : {}),
      ...(typeof o.apiKey === 'string' && o.apiKey ? { apiKey: o.apiKey } : {}),
      enabled: o.enabled !== false,
      models,
    })
  }
  return out.filter((p) => p.id)
}

/** 第一个启用提供商的第一个模型（去掉全局默认模型设置后的会话兜底） */
export function firstEnabledModel(providers: ProviderSetting[]): { providerID: string; modelID: string } | null {
  for (const p of providers) {
    if (!p.enabled) continue
    if (p.models.length > 0) return { providerID: p.id, modelID: p.models[0].id }
  }
  return null
}

/** 单个模型的思考 variant 配置（按 API 格式映射） */
export function thinkingVariant(apiFormat: ApiFormat, tier: ThinkingTier): Record<string, unknown> | undefined {
  if (tier === 'none') {
    return apiFormat === 'anthropic' ? { thinking: { type: 'disabled' } } : { reasoningEffort: 'none' }
  }
  if (apiFormat === 'anthropic') {
    return { thinking: { type: 'enabled', budgetTokens: ANTHROPIC_BUDGET[tier] } }
  }
  // OpenAI 系（chat / responses）：max 映射到 high（reasoningEffort 无 max 档）
  return { reasoningEffort: tier === 'max' ? 'high' : tier }
}

/** 单个模型在 opencode.json 里的 models 条目 */
function modelEntry(apiFormat: ApiFormat, m: ProviderModelCfg): Record<string, unknown> {
  const entry: Record<string, unknown> = {}
  if (m.name) entry.name = m.name
  if (m.contextLimit || m.outputLimit) {
    entry.limit = { ...(m.contextLimit ? { context: m.contextLimit } : {}), ...(m.outputLimit ? { output: m.outputLimit } : {}) }
  }
  // 不声明 attachment/modalities 时 opencode 视为不支持图片输入，会把图片替换成错误文本
  if (m.attachment) {
    entry.attachment = true
    entry.modalities = { input: ['text', 'image'], output: ['text'] }
  }
  const tiers = (m.thinkingTiers ?? []).filter((t) => ['none', 'low', 'high', 'max'].includes(t))
  if (tiers.length > 0) {
    const variants: Record<string, unknown> = {}
    for (const t of tiers) {
      const v = thinkingVariant(apiFormat, t)
      if (v) variants[t] = v
    }
    if (Object.keys(variants).length > 0) entry.variants = variants
  }
  return entry
}

/** 写 opencode.json（provider 声明）+ auth.json（密钥）。保留 mcp/skill 等其余字段。 */
export function writeSidecarConfig(
  p: JeffPaths,
  providers: ProviderSetting[],
  opts: { mcp?: Record<string, unknown>; smallModel?: { providerID: string; modelID: string } | null } = {},
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
    if (!pv.enabled) continue
    providerCfg[pv.id] = {
      npm: API_FORMAT_NPM[pv.apiFormat] ?? API_FORMAT_NPM.chat,
      name: pv.name || pv.id,
      options: { ...(pv.baseURL ? { baseURL: pv.baseURL } : {}) },
      models: Object.fromEntries((pv.models || []).map((m) => [m.id, modelEntry(pv.apiFormat, m)])),
    }
  }
  cfg['provider'] = providerCfg
  if (opts.mcp) cfg['mcp'] = opts.mcp
  // skills：直接挂载用户级 ~/.agents/skills（opencode skills.paths 支持 ~ 展开，跨平台免 symlink）
  const skillsCfg = (cfg['skills'] as { paths?: string[] } | undefined) ?? {}
  const skillPaths = new Set(skillsCfg.paths ?? [])
  skillPaths.add('~/.agents/skills')
  cfg['skills'] = { ...skillsCfg, paths: [...skillPaths] }
  const small = opts.smallModel ?? firstEnabledModel(providers)
  if (small) {
    // model：agent 未绑定模型时的会话默认；small_model：标题生成等轻量任务
    cfg['model'] = `${small.providerID}/${small.modelID}`
    cfg['small_model'] = `${small.providerID}/${small.modelID}`
  } else {
    delete cfg['model']
    delete cfg['small_model']
  }
  cfg['permission'] = { edit: 'allow', bash: 'allow', webfetch: 'allow' }
  fs.mkdirSync(p.ocConfigDir, { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8')

  // auth.json：opencode 从 XDG_DATA_HOME/opencode/auth.json 读密钥（不是 config 目录！）
  const authDir = path.join(p.ocDataHome, 'opencode')
  fs.mkdirSync(authDir, { recursive: true })
  const auth: Record<string, { type: string; key: string }> = {}
  for (const pv of providers) {
    if (pv.apiKey) auth[pv.id] = { type: 'api', key: pv.apiKey }
  }
  fs.writeFileSync(path.join(authDir, 'auth.json'), JSON.stringify(auth, null, 2), 'utf8')
}
