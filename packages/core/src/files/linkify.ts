/**
 * 聊天正文里的文件路径识别（无 Node 依赖，桌面渲染层与手机共用）。
 * 只产出候选；是否变成可点击链接由调用方拿解析结果决定（文件必须真实存在）。
 * 围栏代码块里的路径保持原样。
 */

export const FILE_HREF_PREFIX = '#jeff-file:'

const EXT = 'md|markdown|mdx|txt|json|jsonc|csv|tsv|html|htm|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|pyi|sh|bash|zsh|yaml|yml|toml|ini|cfg|conf|log|sql|go|rs|java|kt|c|cpp|h|hpp|cs|rb|php|lua|swift|vue|svelte|svg|png|jpe?g|gif|webp|bmp|ico|pdf|zip|tar|gz|tgz|xz|7z|docx?|xlsx?|pptx?|ipynb|mp3|mp4|wav|webm|mov'
const NAME = '[\\w@~.\\u4e00-\\u9fff\\u3040-\\u30ff-]+'
const EXT_END = new RegExp(`\\.(?:${EXT})$`, 'i')
const BARE_RE = new RegExp(
  [
    'file://[^\\s)<>\'"]+',
    `~[/\\\\](?:${NAME}[/\\\\])*${NAME}\\.(?:${EXT})`,
    `[A-Za-z]:[/\\\\](?:${NAME}[/\\\\])*${NAME}\\.(?:${EXT})`,
    `/(?:${NAME}/)+${NAME}\\.(?:${EXT})`,
    `/${NAME}\\.(?:${EXT})`,
    `(?:${NAME}[/\\\\])+${NAME}\\.(?:${EXT})`,
    `${NAME}\\.(?:${EXT})`,
  ].join('|'),
  'gi',
)

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\n]+)\)/g
const LINK_RE = /\[([^\]]*)\]\(([^)\n]+)\)/g
const CODE_RE = /`([^`\n]+)`/g
const QUOTE_RE = /"([^"\n]{1,500})"|'([^'\n]{1,500})'/g
const URL_RE = /<https?:\/\/[^>\s]+>|https?:\/\/[^\s)<]+/gi

export interface FileCandidate {
  /** 交给解析器的路径（file:// 已解码，~/ 保留） */
  raw: string
  start: number
  end: number
  label: string
  /** 落在行内代码里时，反引号区间；替换时要拆掉反引号，否则链接不会渲染 */
  codeStart?: number
  codeEnd?: number
}

export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(p)
}

/** 渲染层简易拼接：处理 ./ ../ ；绝对路径与 ~/ 原样返回（~ 由主进程展开） */
export function joinWorkspacePath(ws: string, rel: string): string {
  const r = rel.replace(/\\/g, '/')
  if (/^([A-Za-z]:\/|\/|~\/)/.test(r)) return r
  const base = ws.replace(/[\\/]+$/, '')
  const parts: string[] = []
  for (const seg of r.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `${base}/${parts.join('/')}`
}

export function extractFileCandidates(text: string): FileCandidate[] {
  if (!text) return []
  const occupied: Array<[number, number]> = []
  const out: FileCandidate[] = []
  const overlaps = (s: number, e: number) => occupied.some(([ps, pe]) => s < pe && e > ps)
  const take = (s: number, e: number) => occupied.push([s, e])

  let fenced = false
  let offset = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineStart = offset
    const lineEnd = offset + line.length
    offset = lineEnd + (i < lines.length - 1 ? 1 : 0)
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced
      take(lineStart, lineEnd)
      continue
    }
    if (fenced) {
      take(lineStart, lineEnd)
      continue
    }
    scanLine(line, lineStart, overlaps, take, out)
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end)
  return out
}

function scanLine(
  line: string,
  base: number,
  overlaps: (s: number, e: number) => boolean,
  take: (s: number, e: number) => void,
  out: FileCandidate[],
): void {
  URL_RE.lastIndex = 0
  for (const m of line.matchAll(URL_RE)) {
    const s = base + (m.index ?? 0)
    take(s, s + m[0].length)
  }
  const add = (start: number, end: number, cand: FileCandidate) => {
    if (start >= end || overlaps(start, end)) return
    take(start, end)
    out.push(cand)
  }

  IMAGE_RE.lastIndex = 0
  for (const m of line.matchAll(IMAGE_RE)) {
    const raw = normalizeFileRef(m[2])
    if (!raw) continue
    const s = base + (m.index ?? 0)
    const e = s + m[0].length
    add(s, e, { raw, start: s, end: e, label: m[1].trim() || fileName(raw) })
  }
  LINK_RE.lastIndex = 0
  for (const m of line.matchAll(LINK_RE)) {
    const raw = normalizeFileRef(m[2])
    if (!raw) continue
    const s = base + (m.index ?? 0)
    const e = s + m[0].length
    add(s, e, { raw, start: s, end: e, label: m[1].trim() || fileName(raw) })
  }
  CODE_RE.lastIndex = 0
  for (const m of line.matchAll(CODE_RE)) {
    const codeStart = base + (m.index ?? 0)
    const codeEnd = codeStart + m[0].length
    if (overlaps(codeStart, codeEnd)) continue
    const inner = m[1]
    const innerBase = codeStart + 1
    const found = bareIn(inner, innerBase)
    if (found.length === 0) continue
    take(codeStart, codeEnd)
    for (const hit of found) {
      out.push({ ...hit, codeStart, codeEnd })
    }
  }
  QUOTE_RE.lastIndex = 0
  for (const m of line.matchAll(QUOTE_RE)) {
    const body = m[1] ?? m[2] ?? ''
    const raw = normalizeFileRef(body)
    if (!raw) continue
    const s = base + (m.index ?? 0)
    const e = s + m[0].length
    add(s, e, { raw, start: s, end: e, label: raw })
  }
  for (const hit of bareIn(line, base)) {
    if (overlaps(hit.start, hit.end)) continue
    add(hit.start, hit.end, hit)
  }
}

function bareIn(text: string, base: number): FileCandidate[] {
  const found: FileCandidate[] = []
  BARE_RE.lastIndex = 0
  for (const m of text.matchAll(BARE_RE)) {
    const token = m[0]
    const at = m.index ?? 0
    const raw = normalizeFileRef(token)
    if (!raw || !boundaryOk(text, at)) continue
    const s = base + at
    found.push({ raw, start: s, end: s + token.length, label: raw })
  }
  return found
}

function boundaryOk(text: string, start: number): boolean {
  if (start <= 0) return true
  const head = text.slice(start, start + 8)
  const prev = text[start - 1]
  const rooted = head.startsWith('/') || head.startsWith('~') || head.startsWith('file:') || /^[A-Za-z]:/.test(head)
  if (rooted) return prev !== '/' && prev !== '\\' && prev !== ':' && !/[A-Za-z0-9]/.test(prev)
  return !/[\w./\\~:]/.test(prev)
}

/** 把链接目标、引号内容或裸路径收成解析器用的路径；不是文件则返回 null */
export function normalizeFileRef(input: string): string | null {
  let t = input.trim()
  if (!t || t.length > 1000) return null
  if (t.startsWith('<') && t.endsWith('>') && t.length > 2) t = t.slice(1, -1).trim()
  else {
    const titled = /^(\S+)\s+["']/.exec(t)
    if (titled) t = titled[1]
  }
  if (/^(https?:|mailto:|#)/i.test(t)) return null
  if (/^file:\/\//i.test(t)) {
    try {
      const url = new URL(t)
      let p = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
      t = p
    } catch {
      return null
    }
  }
  const pathOnly = t.split(/[?#]/)[0]
  if (!EXT_END.test(pathOnly)) return null
  if (/[\r\n<>|]/.test(pathOnly)) return null
  return pathOnly
}

function fileName(p: string): string {
  const parts = p.split(/[/\\]/)
  return parts[parts.length - 1] || p
}

function linkMarkdown(label: string, abs: string): string {
  const safe = (label || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim() || fileName(abs)
  return `[${safe}](${FILE_HREF_PREFIX}${encodeURIComponent(abs)})`
}

/** 只把解析命中的候选换成站内文件链接；未命中的原文保持不变 */
export function applyResolvedLinks(text: string, hits: Record<string, string>): string {
  if (!text || !hits || Object.keys(hits).length === 0) return text
  const cands = extractFileCandidates(text)
  type Rep = { start: number; end: number; text: string }
  const reps: Rep[] = []
  const grouped = new Map<string, FileCandidate[]>()
  const singles: FileCandidate[] = []
  for (const c of cands) {
    if (c.codeStart == null || c.codeEnd == null) {
      singles.push(c)
      continue
    }
    const key = `${c.codeStart}:${c.codeEnd}`
    const list = grouped.get(key) || []
    list.push(c)
    grouped.set(key, list)
  }
  for (const group of grouped.values()) {
    if (!group.some((c) => hits[c.raw])) continue
    const start = group[0].codeStart as number
    const end = group[0].codeEnd as number
    let inner = text.slice(start + 1, end - 1)
    const innerBase = start + 1
    const ordered = [...group].sort((a, b) => b.start - a.start)
    for (const c of ordered) {
      const abs = hits[c.raw]
      if (!abs) continue
      const s = c.start - innerBase
      const e = c.end - innerBase
      inner = `${inner.slice(0, s)}${linkMarkdown(c.label, abs)}${inner.slice(e)}`
    }
    reps.push({ start, end, text: inner })
  }
  for (const c of singles) {
    const abs = hits[c.raw]
    if (!abs) continue
    reps.push({ start: c.start, end: c.end, text: linkMarkdown(c.label, abs) })
  }
  reps.sort((a, b) => b.start - a.start)
  let out = text
  for (const r of reps) out = `${out.slice(0, r.start)}${r.text}${out.slice(r.end)}`
  return out
}

export interface TextSegment {
  type: 'text' | 'file'
  value: string
  abs?: string
}

/** 纯文本（工具输出）拆段：命中的路径单独成段，反引号包住的整段路径不保留反引号 */
export function segmentResolvedText(text: string, hits: Record<string, string>): TextSegment[] {
  const cands = extractFileCandidates(text).filter((c) => hits[c.raw])
  const spans = cands.map((c) => {
    const wrapped = c.codeStart != null && c.codeEnd != null && text.slice(c.codeStart + 1, c.codeEnd - 1).trim() === c.raw
    return {
      start: wrapped ? (c.codeStart as number) : c.start,
      end: wrapped ? (c.codeEnd as number) : c.end,
      value: c.label || c.raw,
      abs: hits[c.raw],
    }
  }).sort((a, b) => a.start - b.start)
  const segs: TextSegment[] = []
  let last = 0
  for (const span of spans) {
    if (span.start < last) continue
    if (span.start > last) segs.push({ type: 'text', value: text.slice(last, span.start) })
    segs.push({ type: 'file', value: span.value, abs: span.abs })
    last = span.end
  }
  if (last < text.length) segs.push({ type: 'text', value: text.slice(last) })
  if (segs.length === 0) segs.push({ type: 'text', value: text })
  return segs
}
