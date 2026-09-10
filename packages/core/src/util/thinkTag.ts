/**
 * 正文内联思考块提取：部分模型（DeepSeek-R1 / 第三方 OpenAI 兼容网关等）不走原生 reasoning 字段，
 * 而是把思考过程直接写在正文的 <think>...</think> 里。这里把这类片段抽出来交给「思考过程」折叠区，
 * 正文只保留给用户看的答案。
 *
 * 兼容：
 * - <think> / <thinking> 两种标签，大小写不敏感；
 * - 流式输出中标签未闭合（只有开标签）：已收到的部分照样归入思考，正文不显示半截推导；
 * - 围栏代码块（``` / ~~~）内的 <think> 是文档内容而非思考，原样保留。
 */

export interface ThinkExtractResult {
  /** 剥离思考块后的正文 */
  text: string
  /** 提取到的思考片段（按出现顺序，每块一条，已 trim、已丢弃空块） */
  reasoning: string[]
}

const TAG_RE = /<\/?think(?:ing)?>/gi
const TAG_TEST_RE = /<\/?think(?:ing)?>/i
const FENCE_RE = /^\s{0,3}(?:```|~~~)/

/** 从 Markdown 正文里剥出 <think> 片段；返回新正文与思考片段数组 */
export function extractThinkTags(md: string): ThinkExtractResult {
  if (!md || !/think/i.test(md)) return { text: md, reasoning: [] }

  const reasoning: string[] = []
  const lines: string[] = []
  let fenced = false
  let inThink = false
  let buf = ''

  const closeBlock = (): void => {
    const t = buf.trim()
    if (t) reasoning.push(t)
    buf = ''
    inThink = false
  }

  for (const line of md.split('\n')) {
    if (!inThink && FENCE_RE.test(line)) {
      fenced = !fenced
      lines.push(line)
      continue
    }
    if (fenced) {
      lines.push(line)
      continue
    }
    const startedInThink = inThink
    const hadTag = TAG_TEST_RE.test(line)
    if (!hadTag) {
      // 无标签：思考块续行（含空行）原样并入，否则原样保留在正文
      if (startedInThink) buf += (buf === '' ? '' : '\n') + line
      else lines.push(line)
      continue
    }

    let out = ''
    let last = 0
    // 本行是上一行思考块的续行时，首个思考片段前要补一个换行
    let pendingNl = startedInThink
    const appendThink = (piece: string): void => {
      if (!piece) return
      if (pendingNl && buf !== '') buf += '\n'
      pendingNl = false
      buf += piece
    }

    TAG_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = TAG_RE.exec(line))) {
      const piece = line.slice(last, m.index)
      if (inThink) appendThink(piece)
      else out += piece
      if (m[0][1] === '/') {
        closeBlock()
      } else {
        // 连续两个开标签：前一段当作一块思考收口，避免内容串到一起
        if (inThink) closeBlock()
        inThink = true
      }
      last = m.index + m[0].length
    }
    const tail = line.slice(last)
    if (inThink) appendThink(tail)
    else out += tail

    // 整行都被思考块吃掉：不要往正文里塞空行
    if (!out.trim() && (hadTag || startedInThink)) continue
    lines.push(out)
  }

  // 流式中标签还没闭合：已收到的思考先展示，正文不显示半截推导
  if (inThink) closeBlock()

  while (lines.length > 0 && !lines[0].trim()) lines.shift()
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()

  return { text: lines.join('\n'), reasoning }
}

/** 合并原生 reasoning 与 <think> 提取结果，统一给「思考过程」折叠区使用 */
export function mergeReasoning(
  native: string | string[] | undefined,
  fromText: string[],
): string[] | undefined {
  const list: string[] = []
  if (typeof native === 'string') {
    if (native.trim()) list.push(native.trim())
  } else if (Array.isArray(native)) {
    for (const n of native) if (n && n.trim()) list.push(n)
  }
  list.push(...fromText)
  return list.length > 0 ? list : undefined
}
