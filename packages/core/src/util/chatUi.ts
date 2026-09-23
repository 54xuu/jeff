/**
 * 聊天界面的本地偏好与纯判定（草稿键、slash 关闭签名、发送历史、贴底、未读、置顶、定时卡片文案）。
 * 不碰 DOM、不进数据库、不进同步。渲染层用 localStorage 存取。
 */

export const HISTORY_LIMIT = 30
export const QUOTE_MAX_CHARS = 500
export const STICK_THRESHOLD_PX = 80
export const UNREAD_STORAGE_KEY = 'jeff:unread'
export const PIN_STORAGE_KEY = 'jeff:pins'

export interface KvStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface DraftChip {
  pluginId: string
  pluginName: string
  command: string
  icon: string
  iconSvg?: string
}

export interface DraftQuote {
  id: string
  source: 'chat' | 'browser'
  text: string
}

/** 一条可持久化的输入草稿（不含图片） */
export interface DraftSnapshot {
  before: string
  after: string
  chip: DraftChip | null
  quotes: DraftQuote[]
}

export interface ScrollMemory {
  stick: boolean
  scrollTop: number
}

export function agentDraftKey(sessionId: string): string {
  return `jeff:draft:agent:${sessionId}`
}

export function groupDraftKey(projectId: string, threadId: string): string {
  return `jeff:draft:group:${projectId}:${threadId}`
}

export function historyKey(draftKey: string): string {
  return `jeff:history:${draftKey}`
}

export function scrollKey(draftKey: string): string {
  return `jeff:scroll:${draftKey}`
}

/** Esc 关掉 slash 后，同一字段、同一位置、同一查询不再自动弹出 */
export function slashDismissKey(field: string, start: number, query: string): string {
  return `${field}:${start}:${query}`
}

export function isDraftEmpty(d: DraftSnapshot): boolean {
  return !d.before.trim() && !d.after.trim() && !d.chip && d.quotes.length === 0
}

export function readDraft(kv: KvStorage, key: string): DraftSnapshot | null {
  const raw = kv.getItem(key)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<DraftSnapshot>
    if (typeof v.after !== 'string') return null
    return {
      before: typeof v.before === 'string' ? v.before : '',
      after: v.after,
      chip: v.chip && typeof v.chip.pluginId === 'string' ? v.chip : null,
      quotes: Array.isArray(v.quotes) ? v.quotes.filter((q) => q && typeof q.text === 'string' && (q.source === 'chat' || q.source === 'browser')) : [],
    }
  } catch {
    return null
  }
}

export function writeDraft(kv: KvStorage, key: string, draft: DraftSnapshot): void {
  if (isDraftEmpty(draft)) {
    kv.removeItem(key)
    return
  }
  kv.setItem(key, JSON.stringify(draft))
}

export function pushHistory(list: DraftSnapshot[], item: DraftSnapshot, limit = HISTORY_LIMIT): DraftSnapshot[] {
  if (isDraftEmpty(item)) return list
  const last = list[0]
  if (last && last.before === item.before && last.after === item.after && last.chip?.command === item.chip?.command && last.chip?.pluginId === item.chip?.pluginId) {
    return list
  }
  return [{ ...item, quotes: [] }, ...list].slice(0, limit)
}

export function readHistory(kv: KvStorage, draftKey: string): DraftSnapshot[] {
  const raw = kv.getItem(historyKey(draftKey))
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    const out: DraftSnapshot[] = []
    for (const item of v) {
      const d = item as Partial<DraftSnapshot> | null
      if (!d || typeof d.after !== 'string') continue
      out.push({
        before: typeof d.before === 'string' ? d.before : '',
        after: d.after,
        chip: d.chip && typeof d.chip.pluginId === 'string' ? d.chip : null,
        quotes: [],
      })
    }
    return out
  } catch {
    return []
  }
}

export function writeHistory(kv: KvStorage, draftKey: string, list: DraftSnapshot[]): void {
  kv.setItem(historyKey(draftKey), JSON.stringify(list.slice(0, HISTORY_LIMIT)))
}

/**
 * 发送历史上翻。index -1 表示还没在翻；0 是最近一条。
 * older 往更早走，newer 往回走，越过最近一条则回到 -1（调用方恢复翻之前的草稿）。
 */
export function stepHistory(len: number, index: number, dir: 'older' | 'newer'): number {
  if (len <= 0) return -1
  if (dir === 'older') {
    if (index < 0) return 0
    return Math.min(len - 1, index + 1)
  }
  if (index <= 0) return -1
  return index - 1
}

/** 输入为空，或已经在翻历史时，方向键才回填；多行正文中间的光标不抢 */
export function arrowShouldRecallHistory(opts: { text: string; caret: number; browsing: boolean; slashOpen: boolean }): boolean {
  if (opts.slashOpen) return false
  if (opts.browsing) return true
  if (opts.text.length === 0) return true
  return false
}

export function isStuck(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = STICK_THRESHOLD_PX): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold
}

export function readScroll(kv: KvStorage, draftKey: string): ScrollMemory | null {
  const raw = kv.getItem(scrollKey(draftKey))
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<ScrollMemory>
    if (typeof v.stick !== 'boolean' || typeof v.scrollTop !== 'number') return null
    return { stick: v.stick, scrollTop: v.scrollTop }
  } catch {
    return null
  }
}

export function writeScroll(kv: KvStorage, draftKey: string, mem: ScrollMemory): void {
  kv.setItem(scrollKey(draftKey), JSON.stringify(mem))
}

export function readIdList(kv: KvStorage, key: string): string[] {
  const raw = kv.getItem(key)
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function withId(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id]
}

export function withoutId(list: string[], id: string): string[] {
  return list.filter((x) => x !== id)
}

export function readPins(kv: KvStorage): Record<string, number> {
  const raw = kv.getItem(PIN_STORAGE_KEY)
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === 'number') out[k] = n
    }
    return out
  } catch {
    return {}
  }
}

export function pinKey(pins: Record<string, number>, key: string, at: number): Record<string, number> {
  return { ...pins, [key]: at }
}

export function unpinKey(pins: Record<string, number>, key: string): Record<string, number> {
  const next = { ...pins }
  delete next[key]
  return next
}

/** 最近置顶的排在前面 */
export function sortedPinKeys(pins: Record<string, number>): string[] {
  return Object.entries(pins)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
}

export function clipQuote(text: string, max = QUOTE_MAX_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}…`
}

/** 把引用拼进发出去的正文，模型能看见来源 */
export function messageWithQuotes(body: string, quotes: Array<{ source: 'chat' | 'browser'; text: string }>): string {
  const blocks = quotes
    .filter((q) => q.text.trim())
    .map((q) => {
      const label = q.source === 'browser' ? '网页选区' : '对话选区'
      const quoted = q.text
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
      return `> ${label}\n${quoted}`
    })
  const head = blocks.join('\n>\n')
  const tail = body.trimEnd()
  if (!head) return tail
  if (!tail.trim()) return head
  return `${head}\n\n${tail}`
}

const STATUS_WORD: Record<string, string> = {
  running: '执行中',
  ok: '成功',
  failed: '失败',
  missed: '已错过',
  skipped: '已跳过',
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 今天只显示时刻，昨天带「昨天」，更早带日期 */
export function relativeDayTime(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const day = Math.round((start(n) - start(d)) / 86_400_000)
  if (day === 0) return hm
  if (day === 1) return `昨天 ${hm}`
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

export function cronLastLabel(status: string | null, at: number | null, now = Date.now()): { text: string; failed: boolean } {
  if (!status || at == null) return { text: '尚未运行', failed: false }
  const word = STATUS_WORD[status] || status
  return { text: `上次${word} · ${relativeDayTime(at, now)}`, failed: status === 'failed' }
}

export const XIAOJIE_SUGGESTIONS = [
  '帮我建一个每天早上 8 点的资讯早报',
  '看看我已经安装了哪些插件',
  '你能帮我做哪些事？',
] as const
