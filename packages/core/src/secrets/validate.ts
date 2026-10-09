const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const SECRET_NAME_MAX = 128
export const SECRET_VALUE_MAX = 8192
export const SECRET_NOTE_MAX = 200
export const SECRET_ENTRY_MAX = 200

const RESERVED_EXACT = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
])

const RESERVED_PREFIXES = ['LD_', 'DYLD_', 'ELECTRON_', 'JEFF_', 'XDG_', 'OPENCODE_']

export function isReservedName(name: string): boolean {
  const upper = name.toUpperCase()
  if (RESERVED_EXACT.has(upper)) return true
  return RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

export function validateSecretName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('请填写变量名')
  if (trimmed.length > SECRET_NAME_MAX) throw new Error(`变量名不能超过 ${SECRET_NAME_MAX} 个字符`)
  if (!NAME_RE.test(trimmed)) throw new Error('变量名只能包含字母、数字和下划线，且不能以数字开头')
  if (isReservedName(trimmed)) throw new Error(`「${trimmed}」是系统保留名，不能写入密码库`)
  return trimmed
}

export function validateSecretValue(value: string): string {
  if (value.length === 0) throw new Error('请填写值')
  if (value.length > SECRET_VALUE_MAX) throw new Error(`值不能超过 ${SECRET_VALUE_MAX} 个字符`)
  if (value.includes('\0')) throw new Error('值不能包含空字符')
  return value
}

export function validateSecretNote(note: string): string {
  const trimmed = note.trim()
  if (trimmed.length > SECRET_NOTE_MAX) throw new Error(`备注不能超过 ${SECRET_NOTE_MAX} 个字符`)
  return trimmed
}
