import type { ApiFormat } from '../ipc/contract.js'

/**
 * 把用户填写的 baseURL 收成各 SDK 真正要的前缀。
 *
 * opencode 1.18.30 带的 AI SDK 会自己追加路径（对齐 ZCode `normalizeModelProviderBaseUrlForKind`
 * 与 `normalizeAnthropicBaseURL`）：
 * - Chat（@ai-sdk/openai-compatible）追加 `/chat/completions`
 * - Responses（@ai-sdk/openai 的默认 languageModel）追加 `/responses`，且保留 `/v1`
 * - Anthropic（@ai-sdk/anthropic）追加 `/messages`，因此前缀必须落到 `/v1`
 *
 * 用户若把完整请求地址贴进来，先剥掉这段后缀，避免发出 `.../chat/completions/chat/completions`。
 */
const SDK_PATH_SUFFIX: Record<ApiFormat, string[]> = {
  chat: ['/chat/completions'],
  responses: ['/responses'],
  anthropic: ['/v1/messages', '/messages'],
}

const ANTHROPIC_OFFICIAL_SDK_BASE = 'https://api.anthropic.com/v1'

/** SDK 的 baseURL。Chat / Responses 没填时返回空串；Anthropic 没填时用官方 `/v1`。 */
export function sdkBaseURL(apiFormat: ApiFormat, raw: string | undefined): string {
  const collapsed = collapseDuplicatedAbsoluteUrl(String(raw ?? '').trim())
  if (!collapsed) return apiFormat === 'anthropic' ? ANTHROPIC_OFFICIAL_SDK_BASE : ''
  const stripped = stripPathSuffix(collapsed, SDK_PATH_SUFFIX[apiFormat])
  if (apiFormat === 'anthropic') return ensureAnthropicV1(stripped)
  return stripped
}

/** 连通探测要打的完整地址，与 sidecar 实际请求同一条路径。 */
export function providerRequestURL(apiFormat: ApiFormat, raw: string | undefined): string {
  const base = sdkBaseURL(apiFormat, raw)
  if (!base) return ''
  if (apiFormat === 'chat') return `${base}/chat/completions`
  if (apiFormat === 'responses') return `${base}/responses`
  return `${base}/messages`
}

/**
 * 旧设置页可能把已经拼好的 runtime baseURL 再当 path 拼一次，
 * 形成 `https://host/path/https://host/path`。只折叠完全重复的这一形态。
 */
function collapseDuplicatedAbsoluteUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  if (!normalized) return ''
  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return normalized
    const marker = `${parsed.protocol}//${parsed.host}`
    const second = normalized.indexOf(marker, marker.length)
    if (second < 0) return normalized
    const firstUrl = normalized.slice(0, second).replace(/\/+$/, '')
    const secondUrl = normalized.slice(second).replace(/\/+$/, '')
    if (firstUrl === secondUrl) return firstUrl
  } catch {
    return normalized
  }
  return normalized
}

function stripPathSuffix(baseURL: string, suffixes: string[]): string {
  try {
    const url = new URL(baseURL)
    let path = url.pathname.replace(/\/+$/, '')
    const lower = path.toLowerCase()
    for (const suffix of suffixes) {
      if (lower.endsWith(suffix)) {
        path = path.slice(0, path.length - suffix.length)
        break
      }
    }
    url.pathname = path || '/'
    return url.toString().replace(/\/+$/, '')
  } catch {
    let normalized = baseURL.replace(/\/+$/, '')
    const lower = normalized.toLowerCase()
    for (const suffix of suffixes) {
      if (lower.endsWith(suffix)) {
        normalized = normalized.slice(0, normalized.length - suffix.length)
        break
      }
    }
    return normalized.replace(/\/+$/, '')
  }
}

/** Anthropic SDK 只对恰好等于官方根地址的 baseURL 自动补 `/v1`，网关根地址必须在这里补上。 */
function ensureAnthropicV1(baseURL: string): string {
  try {
    const url = new URL(baseURL)
    const pathname = url.pathname.replace(/\/+$/, '')
    if (pathname.toLowerCase().endsWith('/v1')) {
      url.pathname = pathname || '/'
      return url.toString().replace(/\/+$/, '')
    }
    url.pathname = `${pathname}/v1`
    return url.toString().replace(/\/+$/, '')
  } catch {
    const without = baseURL.replace(/\/+$/, '')
    return without.toLowerCase().endsWith('/v1') ? without : `${without}/v1`
  }
}
