import { Agent, fetch as undiciFetch } from 'undici'
import type { ProviderSetting } from '../oc/configWriter.js'
import { providerRequestURL } from './endpoint.js'

export interface ProviderProbe {
  ok: boolean
  error?: string
  elapsedMs: number
}

/** llmTls「跳过证书校验」开启时使用的宽松 dispatcher（惰性创建，进程内共享） */
let tlsRelaxedAgent: Agent | null = null
function tlsDispatcher(skipVerify: boolean): Agent | undefined {
  if (!skipVerify) return undefined
  tlsRelaxedAgent ??= new Agent({ connect: { rejectUnauthorized: false } })
  return tlsRelaxedAgent
}

/**
 * 直连探测一个模型的连通性：按 apiFormat 向 baseURL 发一次最小补全请求（max_tokens=1）。
 * 与 sidecar 无关（传入当前编辑中的配置即可测，未保存的草稿也能测），
 * 仿 probeMcpServer：独立超时、返回 ok/error/耗时，只给设置页展示「能不能连」。
 */
export async function probeProviderModel(
  provider: ProviderSetting,
  modelId: string,
  timeoutMs = 15000,
  skipTlsVerify = false,
): Promise<ProviderProbe> {
  const started = Date.now()
  if (!modelId.trim()) return { ok: false, error: '缺少模型 id', elapsedMs: 0 }
  const apiKey = provider.apiKey || ''
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let url: string
  let body: unknown
  try {
    url = providerRequestURL(provider.apiFormat, provider.baseURL)
    if (!url) throw new Error('未配置 baseURL')
    if (provider.apiFormat === 'anthropic') {
      // 官方认 x-api-key；兼容网关常常只看 Authorization。两边都带，和 ZCode 的适配层一致。
      if (apiKey) {
        headers['x-api-key'] = apiKey
        headers.authorization = `Bearer ${apiKey}`
      }
      headers['anthropic-version'] = '2023-06-01'
      body = { model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
    } else if (provider.apiFormat === 'responses') {
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      body = { model: modelId, input: 'ping', max_output_tokens: 1 }
    } else {
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      body = { model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }
    }
    const res = await undiciFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: tlsDispatcher(skipTlsVerify),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let msg = text
      try {
        const j = JSON.parse(text) as { error?: { message?: string }; message?: string }
        msg = j?.error?.message || j?.message || text
      } catch {
        // 非 JSON 错误体，原样截断展示
      }
      throw new Error(`HTTP ${res.status}${msg ? `：${String(msg).slice(0, 160)}` : ''}`)
    }
    // 消费响应体，避免连接悬挂
    await res.arrayBuffer().catch(() => {})
    return { ok: true, elapsedMs: Date.now() - started }
  } catch (err) {
    const e = err as Error
    const reason =
      e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? `超时（${timeoutMs}ms 无响应）`
        : String((e as Error)?.message || err)
    return { ok: false, error: reason.slice(0, 200), elapsedMs: Date.now() - started }
  }
}
