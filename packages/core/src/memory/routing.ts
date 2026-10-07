import fs from 'node:fs'
import path from 'node:path'
import type { MemoryStore, MemoryScope, MemoryOp, MemoryResult } from './store.js'
import { ENTRY_DELIMITER, matchUnique, parseEntries } from './store.js'

export type MemoryPrivacy = 'auto' | 'private' | 'public'
export const PRIVATE_MARKER = '[私有] '
const START = '<!-- Jeff 自动记忆规则：开始 -->'
const END = '<!-- Jeff 自动记忆规则：结束 -->'

/** 保守识别：保密标记与凭据形状优先于模型给出的 public。 */
export function isConfidential(text: string): boolean {
  return /\[私有\]|保密|机密|密码|口令|密钥|私钥|令牌|凭据|password|passwd|secret|api[_ -]?key|access[_ -]?token|bearer\s+\S+|-----BEGIN .*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{16,}/i.test(text)
}

export function containsCredentialValue(text: string): boolean {
  return /-----BEGIN .*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}|(?:密码|口令|密钥|私钥|令牌|password|passwd|secret|api[_ -]?key|access[_ -]?token)\s*(?:是|为|[:=：])\s*[`"']?[^\s`"'<>]{4,}/i.test(text)
}

export function publicMemoryContent(content: string): string {
  return parseEntries(content).filter((entry) => !isConfidential(entry)).join(ENTRY_DELIMITER)
}

function read(file: string): string {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}
function splitRules(raw: string): { manual: string; entries: string[] } {
  const start = raw.indexOf(START)
  if (start < 0) return { manual: raw, entries: [] }
  const end = raw.indexOf(END, start)
  if (end < 0) throw new Error('AGENTS.md 自动规则区块不完整，请先在设置中修复')
  return { manual: raw.slice(0, start) + raw.slice(end + END.length), entries: parseEntries(raw.slice(start + START.length, end)) }
}
function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** 一个入口管理两类条目；规则正文中的手工内容保持原样。同步调用在本进程内原子串行。 */
export class MemoryRouter {
  constructor(private store: MemoryStore, private legacyRules?: (scope: MemoryScope) => string) {}

  private readRules(scope: MemoryScope): string {
    const file = this.store.rulesFile(scope)
    return fs.existsSync(file) ? read(file) : this.legacyRules?.(scope) || ''
  }

  list(scope: MemoryScope): string[] {
    return [...this.store.list(scope), ...splitRules(this.readRules(scope)).entries]
  }

  batch(scope: MemoryScope, ops: MemoryOp[], privacy: MemoryPrivacy = 'auto'): MemoryResult & { destinations?: string[] } {
    const memoryFile = this.store.file(scope)
    const rulesFile = this.store.rulesFile(scope)
    const memoryBefore = read(memoryFile)
    const rulesExisted = fs.existsSync(rulesFile)
    const rulesBefore = this.readRules(scope)
    const rules = splitRules(rulesBefore)
    let memory = this.store.list(scope)
    let publicEntries = rules.entries
    const destinations = new Set<string>()
    if (!ops.length) return { ok: false, error: 'operations 为空' }
    for (const op of ops) {
      if (!['add', 'replace', 'remove'].includes(op.action)) return { ok: false, error: '未知记忆操作' }
      let text = op.action === 'add' ? op.text : op.new_text
      let wasPrivate = false
      if (op.action !== 'add') {
        if (!op.old_text?.trim()) return { ok: false, error: '需要 old_text' }
        const all = [...memory, ...publicEntries]
        const index = matchUnique(all, op.old_text)
        if (index < 0) return { ok: false, error: 'old_text 未匹配到唯一条目，请先 list 查看记忆和自动规则' }
        if (index < memory.length) { wasPrivate = isConfidential(memory[index]); memory.splice(index, 1) }
        else publicEntries.splice(index - memory.length, 1)
      }
      if (op.action === 'remove') continue
      if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '需要非空的新内容' }
      text = text.trim()
      if (text.includes(START) || text.includes(END) || text.includes(ENTRY_DELIMITER)) return { ok: false, error: '条目不能包含存储分隔符，请拆成多项 batch 操作' }
      if (wasPrivate || privacy === 'private' || isConfidential(text)) {
        if (!text.startsWith(PRIVATE_MARKER)) text = PRIVATE_MARKER + text
        if (!memory.includes(text)) memory.push(text)
        destinations.add(memoryFile)
      } else {
        if (!publicEntries.includes(text)) publicEntries.push(text)
        destinations.add(rulesFile)
      }
    }
    const total = memory.join(ENTRY_DELIMITER).length
    if (total > this.store.budget(scope)) return { ok: false, error: '私有记忆超预算，请合并旧条目后重试', budget: this.store.budget(scope), totalChars: total }
    if (publicEntries.join(ENTRY_DELIMITER).length > 24000) return { ok: false, error: '自动规则超过 24000 字符，请先整理' }
    const nextRules = publicEntries.length ? `${rules.manual.trimEnd()}\n\n${START}\n${publicEntries.join(ENTRY_DELIMITER)}\n${END}\n` : rules.manual
    try {
      this.store.writeRaw(scope, memory.join(ENTRY_DELIMITER))
      if (nextRules !== rulesBefore || (!rulesExisted && publicEntries.length > 0)) writeAtomic(rulesFile, nextRules)
    } catch (error) {
      writeAtomic(memoryFile, memoryBefore)
      if (rulesExisted) writeAtomic(rulesFile, rulesBefore)
      else fs.rmSync(rulesFile, { force: true })
      throw error
    }
    return { ok: true, destinations: [...destinations], totalChars: total, budget: this.store.budget(scope) }
  }
}
