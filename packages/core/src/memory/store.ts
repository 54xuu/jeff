import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { JeffPaths } from '../paths.js'

/** 记忆域：全局用户画像 / 每 agent / 每项目群 */
export type MemoryScope =
  | { kind: 'user' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'project'; projectId: string }

export const ENTRY_DELIMITER = '\n§\n'

/** 字符预算（hermes 式：容量即压缩，超限报错逼模型自我整合） */
export const MEMORY_BUDGETS: Record<MemoryScope['kind'], number> = {
  user: 1375,
  agent: 2200,
  project: 2200,
}

export interface MemoryOp {
  action: 'add' | 'replace' | 'remove'
  text?: string
  old_text?: string
  new_text?: string
}

export interface MemoryResult {
  ok: boolean
  error?: string
  entries?: string[]
  totalChars?: number
  budget?: number
}

function scopeKey(scope: MemoryScope): string {
  if (scope.kind === 'user') return 'user'
  if (scope.kind === 'agent') return `agent:${scope.agentId}`
  return `project:${scope.projectId}`
}

/**
 * hermes 式记忆存储：
 * - Markdown 文件，条目以 § 分隔；无时间戳无 schema
 * - 硬字符预算：超限报错并附带当前条目，让模型当轮自我整合（batch 原子腾挪）
 * - 唯一子串匹配：replace/remove 的 old_text 必须恰好命中一个条目
 * - 原子写（tmp+rename）+ 目录锁；add 精确去重
 */
export class MemoryStore {
  constructor(private paths: JeffPaths) {}

  file(scope: MemoryScope): string {
    const k = scopeKey(scope)
    if (k === 'user') return path.join(this.paths.memoryDir, 'USER.md')
    if (k.startsWith('agent:')) return path.join(this.paths.memoryDir, 'agents', k.slice(6), 'MEMORY.md')
    return path.join(this.paths.memoryDir, 'projects', k.slice(8), 'MEMORY.md')
  }

  label(scope: MemoryScope): string {
    if (scope.kind === 'user') return '全局用户画像'
    if (scope.kind === 'agent') return `agent ${scope.agentId} 记忆`
    return `项目 ${scope.projectId} 共享记忆`
  }

  budget(scope: MemoryScope): number {
    return MEMORY_BUDGETS[scope.kind]
  }

  /** 读取条目（文件不存在 → 空） */
  list(scope: MemoryScope): string[] {
    return parseEntries(this.readRaw(scope))
  }

  private readRaw(scope: MemoryScope): string {
    try {
      return fs.readFileSync(this.file(scope), 'utf8')
    } catch {
      return ''
    }
  }

  /** 注入 system prompt 的记忆块（空记忆返回 null） */
  renderBlock(scope: MemoryScope): string | null {
    const entries = this.list(scope)
    if (entries.length === 0) return null
    const total = entries.join('\n').length
    const pct = Math.min(100, Math.round((total / this.budget(scope)) * 100))
    return [`### ${this.label(scope)}（${entries.length} 条 · 预算 ${pct}%）`, ...entries.map((e) => `- ${e}`)].join('\n')
  }

  add(scope: MemoryScope, text: string): MemoryResult {
    return this.batch(scope, [{ action: 'add', text }])
  }

  replace(scope: MemoryScope, oldText: string, newText: string): MemoryResult {
    return this.batch(scope, [{ action: 'replace', old_text: oldText, new_text: newText }])
  }

  remove(scope: MemoryScope, oldText: string): MemoryResult {
    return this.batch(scope, [{ action: 'remove', old_text: oldText }])
  }

  /** 原子执行一组操作（预算只对最终状态检查） */
  batch(scope: MemoryScope, ops: MemoryOp[]): MemoryResult {
    const budget = this.budget(scope)
    if (ops.length === 0) return { ok: false, error: 'operations 为空', entries: this.list(scope), budget }
    for (const op of ops) {
      if (op.action === 'add' && !op.text?.trim()) return { ok: false, error: 'add 需要非空 text' }
      if (op.action === 'replace' && !op.old_text?.trim()) return { ok: false, error: 'replace 需要 old_text' }
      if (op.action === 'remove' && !op.old_text?.trim()) return { ok: false, error: 'remove 需要 old_text' }
      if (op.action === 'replace' && op.new_text == null) return { ok: false, error: 'replace 需要 new_text（可为空串）' }
    }
    const release = this.lock(scope)
    try {
      let entries = parseEntries(this.readRaw(scope))
      for (const op of ops) {
        if (op.action === 'add') {
          const text = normalize(op.text!)
          if (entries.some((e) => e === text)) continue // 精确去重
          entries.push(text)
        } else {
          const idx = matchUnique(entries, op.old_text!)
          if (idx < 0) {
            return { ok: false, error: `old_text 未匹配到唯一条目（0 或多个）:「${op.old_text!.slice(0, 60)}」`, entries, budget }
          }
          if (op.action === 'remove') {
            entries.splice(idx, 1)
          } else {
            entries[idx] = normalize(op.new_text ?? '')
          }
        }
        entries = dedupePreserveOrder(entries)
      }
      const total = entries.join(ENTRY_DELIMITER).length
      if (total > budget) {
        return {
          ok: false,
          error: `记忆超预算：${total}/${budget} 字符。请用 batch 原子操作先整合（合并或删除旧条目）再重试。当前条目如下：\n` + entries.map((e, i) => `${i + 1}. ${e}`).join('\n'),
          entries,
          totalChars: total,
          budget,
        }
      }
      this.writeEntries(scope, entries)
      return { ok: true, entries, totalChars: total, budget }
    } finally {
      release()
    }
  }

  /** 覆写整个文件（UI 编辑用） */
  writeRaw(scope: MemoryScope, content: string): void {
    const release = this.lock(scope)
    try {
      this.writeEntries(scope, parseEntries(content))
    } finally {
      release()
    }
  }

  private writeEntries(scope: MemoryScope, entries: string[]): void {
    const file = this.file(scope)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const content = entries.length === 0 ? '' : entries.join(ENTRY_DELIMITER) + '\n'
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, file)
  }

  /** 简单目录锁：mkdir 原子性 + 过期自动清理 */
  private lock(scope: MemoryScope): () => void {
    const dir = path.join(this.paths.memoryDir, '.locks')
    fs.mkdirSync(dir, { recursive: true })
    const lockDir = path.join(dir, `${sha(scopeKey(scope)).slice(0, 16)}.lock`)
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        fs.mkdirSync(lockDir)
        break
      } catch {
        if (Date.now() > deadline) {
          try {
            fs.rmSync(lockDir, { recursive: true, force: true })
          } catch {
            /* 忽略 */
          }
          continue
        }
        const idle = spin(20)
        if (!idle) break
      }
    }
    return () => {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
}

function spin(ms: number): boolean {
  const start = Date.now()
  while (Date.now() - start < ms) {
    /* busy-wait 极短 */
  }
  return true
}

function sha(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export function parseEntries(raw: string): string[] {
  if (!raw.trim()) return []
  return raw
    .split(ENTRY_DELIMITER)
    .map((e) => e.trim())
    .filter(Boolean)
}

function normalize(text: string): string {
  return text.trim().replace(/\s+\n/g, '\n')
}

function dedupePreserveOrder(entries: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of entries) {
    if (seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out
}

/** 唯一子串匹配：命中 0 条或多条都返回 -1（要求更精确） */
export function matchUnique(entries: string[], needle: string): number {
  let hit = -1
  let count = 0
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].includes(needle)) {
      count += 1
      hit = i
      if (count > 1) return -1
    }
  }
  return count === 1 ? hit : -1
}
