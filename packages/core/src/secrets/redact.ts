const MIN_REDACT_LENGTH = 8

let needles: Array<{ value: string; name: string }> = []

/** 由密码库在加载和变更后刷新。只处理已启用且长度足够的精确值。 */
export function setSecretValues(entries: Array<{ name: string; value: string }>): void {
  needles = entries
    .filter((entry) => entry.value.length >= MIN_REDACT_LENGTH)
    .sort((a, b) => b.value.length - a.value.length)
}

export function redactText(input: string): string {
  if (!input || needles.length === 0) return input
  let out = input
  for (const needle of needles) {
    if (!out.includes(needle.value)) continue
    out = out.split(needle.value).join(`••••(${needle.name})`)
  }
  return out
}

/** 测试隔离用 */
export function clearSecretValues(): void {
  needles = []
}
