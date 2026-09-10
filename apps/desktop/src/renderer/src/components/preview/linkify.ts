/**
 * 相对路径识别与链接化：
 * - linkifyWorkspaceMarkdown：把 Markdown 正文里裸写的相对文件路径（≥1 级目录 + 已知扩展名）
 *   转成 `#jeff-file:` 协议的站内链接，由 Markdown.tsx 的 <a> 渲染为可点击蓝色链接；
 * - splitTextWithFileLinks：纯文本（工具输出）拆段，供 inline 渲染链接。
 * 代码块 / 行内代码 / 现有链接 / URL 内的路径不会被改写。
 */

/** 站内文件链接 href 前缀（fragment 形式，react-markdown 默认 urlTransform 不会丢弃） */
export const FILE_HREF_PREFIX = '#jeff-file:'

/** 路径段：字母数字 _ . ~ @ - 与中日韩文字；路径必须至少含一级目录且带已知扩展名 */
const PATH_SRC = '(?:[\\w@~.\\u4e00-\\u9fff\\u3040-\\u30ff-]+/)+[\\w@~.\\u4e00-\\u9fff\\u3040-\\u30ff-]+\\.(?:md|markdown|mdx|txt|json|jsonc|csv|tsv|html|htm|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|pyi|sh|bash|zsh|yaml|yml|toml|ini|cfg|conf|log|sql|go|rs|java|kt|c|cpp|h|hpp|cs|rb|php|lua|swift|vue|svelte|svg|png|jpe?g|gif|webp|bmp|ico|pdf|zip|tar|gz|tgz|xz|7z|docx?|xlsx?|pptx?|ipynb)'
const PATH_RE = new RegExp(PATH_SRC, 'g')

/** 行内需要跳过的区域：行内代码、markdown 链接/图片、URL */
const PROTECTED_SRC = '`[^`\\n]*`|\\[[^\\]\\n]*\\]\\([^)\\n]*\\)|<https?://[^>\\s]+>|https?://[^\\s)\\]]+'
const PROTECTED_RE = new RegExp(PROTECTED_SRC, 'g')

/** markdown 正文链接化（逐行扫描，跨行维护围栏代码块状态） */
export function linkifyWorkspaceMarkdown(md: string): string {
  if (!md || !md.includes('/')) return md
  let fenced = false
  return md
    .split('\n')
    .map((line) => {
      // 围栏行（``` / ~~~）：切换状态，本身不改写
      if (/^\s{0,3}(```|~~~)/.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced) return line
      return linkifyLine(line)
    })
    .join('\n')
}

function linkifyLine(line: string): string {
  PATH_RE.lastIndex = 0
  if (!PATH_RE.test(line)) return line
  PATH_RE.lastIndex = 0

  // 受保护区：行内代码 / 已有链接 / URL，其中的路径保持原样
  const ranges: Array<[number, number]> = []
  PROTECTED_RE.lastIndex = 0
  for (const m of line.matchAll(PROTECTED_RE)) {
    const s = m.index ?? 0
    ranges.push([s, s + m[0].length])
  }
  const protectedAt = (s: number, e: number) => ranges.some(([ps, pe]) => s < pe && e > ps)

  let out = ''
  let last = 0
  PATH_RE.lastIndex = 0
  for (const m of line.matchAll(PATH_RE)) {
    const s = m.index ?? 0
    const e = s + m[0].length
    if (protectedAt(s, e)) continue
    // 紧跟在 / 或 : 后面的，多半是 URL / 路径的一部分，跳过
    const prev = s > 0 ? line[s - 1] : ''
    if (prev === '/' || prev === ':') continue
    out += `${line.slice(last, s)}[📄 ${m[0]}](${FILE_HREF_PREFIX}${encodeURIComponent(m[0])})`
    last = e
  }
  out += line.slice(last)
  return out
}

/** 纯文本拆段：path 段调用方渲染为链接，text 段原样输出 */
export function splitTextWithFileLinks(text: string): Array<{ type: 'text' | 'path'; value: string }> {
  const segs: Array<{ type: 'text' | 'path'; value: string }> = []
  PATH_RE.lastIndex = 0
  let last = 0
  for (const m of text.matchAll(PATH_RE)) {
    const s = m.index ?? 0
    const prev = s > 0 ? text[s - 1] : ''
    if (prev === '/' || prev === ':') continue
    if (s > last) segs.push({ type: 'text', value: text.slice(last, s) })
    segs.push({ type: 'path', value: m[0] })
    last = s + m[0].length
  }
  if (last < text.length) segs.push({ type: 'text', value: text.slice(last) })
  return segs
}

/** 从 React 子树里提取纯文本（rehype-highlight 会把 code 内容拆成 span，逐层拼接） */
export function nodeText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  const obj = node as { props?: { children?: unknown } }
  if (typeof obj === 'object' && obj.props) return nodeText(obj.props.children)
  return ''
}

/** 是否 Markdown 文件（可进预览器） */
export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(p)
}

/** 渲染层简易 path 拼接（无 node:path）：处理 ./ ../ 与绝对路径 */
export function joinWorkspacePath(ws: string, rel: string): string {
  const r = rel.replace(/\\/g, '/')
  // agent 直接给绝对路径（/ 或 C:/）时原样使用
  if (/^([A-Za-z]:\/|\/)/.test(r)) return r
  const base = ws.replace(/[\\/]+$/, '')
  const parts: string[] = []
  for (const seg of r.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `${base}/${parts.join('/')}`
}
