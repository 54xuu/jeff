import type { DB } from '../db/db.js'
import { now } from '../db/db.js'

export interface IndexDoc {
  id: string // 唯一：src:<messageId>
  scope: string // private:<agentId> | group:<projectId>
  sessionId?: string
  sender: string // user | <agentName> | system
  ts: number
  text: string
}

export interface SearchHit {
  id: string
  scope: string
  sessionId: string
  sender: string
  ts: number
  snippet: string
  rank: number
}

/**
 * 会话全文索引（SQLite FTS5）。
 * CJK 处理：入库时把连续汉字切分成单字 token；查询时把中文关键词转成 phrase（"世 界"），
 * 从而支持中文子串检索（hermes_state_fts 的 bigram 思路的简化版，个人规模足够）。
 */
export class SessionIndex {
  constructor(private db: DB) {
    this.ensureSchema()
  }

  private ensureSchema(): void {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS msg_fts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts_idx USING fts5(body, content='msg_fts', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS msg_fts_ai AFTER INSERT ON msg_fts BEGIN
  INSERT INTO msg_fts_idx(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_ad AFTER DELETE ON msg_fts BEGIN
  INSERT INTO msg_fts_idx(msg_fts_idx, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_au AFTER UPDATE ON msg_fts BEGIN
  INSERT INTO msg_fts_idx(msg_fts_idx, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO msg_fts_idx(rowid, body) VALUES (new.rowid, new.body);
END;
`)
  }

  has(id: string): boolean {
    const row = this.db.prepare('SELECT id FROM msg_fts WHERE id = ?').get(id)
    return !!row
  }

  index(doc: IndexDoc): void {
    if (!doc.text?.trim()) return
    this.db
      .prepare(
        `INSERT INTO msg_fts (id, scope, session_id, sender, ts, body) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET scope=excluded.scope, session_id=excluded.session_id, sender=excluded.sender, ts=excluded.ts, body=excluded.body`,
      )
      .run(doc.id, doc.scope, doc.sessionId || '', doc.sender, doc.ts || now(), cjkSplit(doc.text))
  }

  search(query: string, opts: { limit?: number; scope?: string } = {}): SearchHit[] {
    const q = buildMatchQuery(query)
    if (!q) return []
    const limit = Math.min(opts.limit ?? 8, 30)
    const scopeFilter = opts.scope ? 'AND scope = ?' : ''
    const params: Array<string | number> = opts.scope ? [q, opts.scope, limit] : [q, limit]
    const rows = this.db
      .prepare(
        `SELECT f.id AS id, f.scope AS scope, f.session_id AS session_id, f.sender AS sender, f.ts AS ts,
                snippet(msg_fts_idx, 0, '「', '」', '…', 12) AS snippet, bm25(msg_fts_idx) AS rank
         FROM msg_fts_idx
         JOIN msg_fts f ON f.rowid = msg_fts_idx.rowid
         WHERE msg_fts_idx MATCH ? ${scopeFilter}
         ORDER BY rank LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: String(r['id']),
      scope: String(r['scope']),
      sessionId: String(r['session_id']),
      sender: String(r['sender']),
      ts: Number(r['ts']),
      snippet: String(r['snippet']),
      rank: Number(r['rank']),
    }))
  }
}

/** 连续 CJK 字符逐字切开（FTS unicode61 下每个字成为独立 token） */
export function cjkSplit(text: string): string {
  return text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]+/g, (m) => m.split('').join(' '))
}

/** 查询改写：CJK 词 → phrase；ASCII 词 → 原词；以 OR 连接 */
export function buildMatchQuery(query: string): string {
  const parts: string[] = []
  for (const raw of query.split(/\s+/)) {
    if (!raw) continue
    const cleaned = raw.replace(/["'()*:^]/g, ' ')
    if (!cleaned.trim()) continue
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(cleaned)) {
      const chars = cleaned.replace(/[^\u4e00-\u9fff\u3400-\u4dbf a-zA-Z0-9]/g, '').trim()
      if (!chars) continue
      parts.push(`"${cjkSplit(chars)}"`)
    } else {
      parts.push(`"${cleaned.replace(/ /g, '')}"*`)
    }
  }
  return parts.join(' OR ')
}
