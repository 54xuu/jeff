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
