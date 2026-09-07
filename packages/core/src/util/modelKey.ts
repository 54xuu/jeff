/**
 * 模型键：`providerID/modelID`
 * 注意 modelID 本身可含 `/`（如硅基流动 `Qwen/Qwen3.5-9B`），
 * 因此只能按「第一个 `/`」切开，不能用 split('/')[0]/[1]。
 */

export function formatModelKey(providerID: string, modelID: string): string {
  if (!providerID || !modelID) return ''
  return `${providerID}/${modelID}`
}

export function parseModelKey(key: string): { providerID: string; modelID: string } | null {
  const raw = (key || '').trim()
  if (!raw) return null
  const i = raw.indexOf('/')
  if (i <= 0 || i >= raw.length - 1) return null
  return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) }
}

/** 展示用：「提供商名 / 模型ID」；catalog 无命中时回退到 id */
export function modelDisplayLabel(
  m: { providerID: string; modelID: string },
  catalog: Array<{ id: string; name: string }>,
): string {
  const hit = catalog.find((c) => c.id === m.providerID)
  return `${hit?.name || m.providerID} / ${m.modelID}`
}

/** 发消息用：智能体绑定模型（否则兜底）+ thinking 非空则作为 variant */
export function agentPromptOpts(
  agent: { model_provider?: string; model_id?: string; thinking?: string } | null | undefined,
  defaultModel?: { providerID: string; modelID: string } | null,
): { model?: { providerID: string; modelID: string }; variant?: string } {
  const bound =
    agent?.model_provider && agent?.model_id
      ? { providerID: agent.model_provider, modelID: agent.model_id }
      : null
  const model = bound || (defaultModel?.providerID && defaultModel?.modelID ? defaultModel : null)
  const variant = (agent?.thinking || '').trim() || undefined
  return {
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
  }
}
