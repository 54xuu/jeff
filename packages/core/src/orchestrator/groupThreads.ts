import type { DB } from '../db/db.js'
import { chatMessageRepo, kvRepo } from '../db/repos.js'
import { genId } from '../util/id.js'

export interface GroupThreadMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

const ACTIVE_KEY = (projectId: string) => `group:activeThread:${projectId}`
const THREAD_KEY = (projectId: string, threadId: string) => `group:thread:${projectId}:${threadId}`
const SESSION_KEY = (projectId: string, threadId: string, agentId: string) => `session:group:${projectId}:${threadId}:${agentId}`
/** 旧版：无 thread 的 agent 会话 */
const LEGACY_SESSION_KEY = (projectId: string, agentId: string) => `session:group:${projectId}:${agentId}`
const LAST_OC_KEY = (projectId: string) => `session:group:last:${projectId}`

export function groupMsgScope(projectId: string, threadId: string): string {
  return `group:${projectId}:${threadId}`
}

export function legacyGroupMsgScope(projectId: string): string {
  return `group:${projectId}`
}

function defaultTitle(): string {
  const when = new Date()
  const stamp = `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  return `会话 · ${stamp}`
}

/** 群话题（thread）读写与旧数据迁移 */
export class GroupThreadStore {
  constructor(private db: DB) {}

  private kv() {
    return kvRepo(this.db)
  }

  getActiveThreadId(projectId: string): string | null {
    this.ensureMigrated(projectId)
    return this.kv().get(ACTIVE_KEY(projectId))
  }

  /** 保证有 active thread；必要时迁移旧消息 */
  ensureActiveThread(projectId: string): string {
    this.ensureMigrated(projectId)
    const kv = this.kv()
    let id = kv.get(ACTIVE_KEY(projectId))
    if (id && kv.get(THREAD_KEY(projectId, id))) return id
    // 若有任意 thread，取最近更新的
    const list = this.listThreads(projectId)
    if (list.length > 0) {
      kv.set(ACTIVE_KEY(projectId), list[0].id)
      return list[0].id
    }
    return this.createThread(projectId, '默认会话').id
  }

  getMeta(projectId: string, threadId: string): GroupThreadMeta | null {
    return this.kv().getJSON<GroupThreadMeta | null>(THREAD_KEY(projectId, threadId), null)
  }

  listThreads(projectId: string): GroupThreadMeta[] {
    this.ensureMigrated(projectId)
    const rows = this.kv().prefixScan(`group:thread:${projectId}:`)
    const out: GroupThreadMeta[] = []
    for (const [, raw] of rows) {
      try {
        const m = JSON.parse(raw) as GroupThreadMeta
        if (m?.id) out.push(m)
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  createThread(projectId: string, title?: string): GroupThreadMeta {
    const id = genId('thr')
    const now = Date.now()
    const meta: GroupThreadMeta = {
      id,
      title: (title || '').trim() || defaultTitle(),
      createdAt: now,
      updatedAt: now,
    }
    const kv = this.kv()
    kv.setJSON(THREAD_KEY(projectId, id), meta)
    kv.set(ACTIVE_KEY(projectId), id)
    return meta
  }

  setActive(projectId: string, threadId: string): void {
    if (!this.getMeta(projectId, threadId)) throw new Error('会话不存在')
    this.kv().set(ACTIVE_KEY(projectId), threadId)
  }

  rename(projectId: string, threadId: string, title: string): GroupThreadMeta {
    const t = title.trim()
    if (!t) throw new Error('标题不能为空')
    const cur = this.getMeta(projectId, threadId)
    if (!cur) throw new Error('会话不存在')
    const next: GroupThreadMeta = { ...cur, title: t, updatedAt: Date.now() }
    this.kv().setJSON(THREAD_KEY(projectId, threadId), next)
    return next
  }

  touch(projectId: string, threadId: string): void {
    const cur = this.getMeta(projectId, threadId)
    if (!cur) return
    this.kv().setJSON(THREAD_KEY(projectId, threadId), { ...cur, updatedAt: Date.now() })
  }

  /** 删除话题元数据、消息、该 thread 下 agent 会话指针；返回需删的 opencode session ids */
  deleteThread(projectId: string, threadId: string): { ocSessionIds: string[]; wasActive: boolean } {
    const kv = this.kv()
    const wasActive = kv.get(ACTIVE_KEY(projectId)) === threadId
    const ocSessionIds: string[] = []
    for (const [key, value] of kv.prefixScan(`session:group:${projectId}:${threadId}:`)) {
      if (value) ocSessionIds.push(value)
      kv.delete(key)
    }
    chatMessageRepo(this.db).deleteByScope(groupMsgScope(projectId, threadId))
    kv.delete(THREAD_KEY(projectId, threadId))
    if (wasActive) {
      kv.delete(ACTIVE_KEY(projectId))
      const rest = this.listThreads(projectId)
      if (rest.length > 0) kv.set(ACTIVE_KEY(projectId), rest[0].id)
      else this.createThread(projectId, '默认会话')
    }
    return { ocSessionIds, wasActive }
  }

  sessionKey(projectId: string, threadId: string, agentId: string): string {
    return SESSION_KEY(projectId, threadId, agentId)
  }

  setLastOcSession(projectId: string, sessionId: string): void {
    this.kv().set(LAST_OC_KEY(projectId), sessionId)
  }

  getLastOcSession(projectId: string): string | null {
    return this.kv().get(LAST_OC_KEY(projectId))
  }

  /**
   * 一次性迁移：旧 scope `group:<projectId>` → 默认 thread；
   * 旧 session:group:<projectId>:<agentId> → session:group:<projectId>:<threadId>:<agentId>
   */
  ensureMigrated(projectId: string): void {
    const kv = this.kv()
    const flag = `group:threadMigrated:${projectId}`
    if (kv.get(flag)) return

    const legacyScope = legacyGroupMsgScope(projectId)
    const msgs = chatMessageRepo(this.db).listByScope(legacyScope, 5000)
    const legacySessions = kv.prefixScan(`session:group:${projectId}:`).filter(([k]) => {
      // 排除 last、以及已是三元 thread 形式（多一段）
      if (k === LAST_OC_KEY(projectId)) return false
      const parts = k.split(':')
      // session:group:projectId:agentId → 4 parts
      // session:group:projectId:threadId:agentId → 5 parts
      return parts.length === 4
    })

    const existingThreads = kv.prefixScan(`group:thread:${projectId}:`)
    if (msgs.length === 0 && legacySessions.length === 0 && existingThreads.length === 0) {
      // 全新群：不强制建 thread，等第一次用
      kv.set(flag, '1')
      return
    }

    let threadId = kv.get(ACTIVE_KEY(projectId))
    if (!threadId || !kv.get(THREAD_KEY(projectId, threadId))) {
      const now = Date.now()
      threadId = genId('thr')
      const meta: GroupThreadMeta = {
        id: threadId,
        title: msgs.length > 0 || legacySessions.length > 0 ? '默认会话' : defaultTitle(),
        createdAt: now,
        updatedAt: now,
      }
      kv.setJSON(THREAD_KEY(projectId, threadId), meta)
      kv.set(ACTIVE_KEY(projectId), threadId)
    }

    if (msgs.length > 0) {
      chatMessageRepo(this.db).reScope(legacyScope, groupMsgScope(projectId, threadId))
    }

    for (const [key, value] of legacySessions) {
      const agentId = key.slice(`session:group:${projectId}:`.length)
      if (!agentId || agentId.includes(':')) continue
      kv.set(SESSION_KEY(projectId, threadId, agentId), value)
      kv.delete(key)
      // 兼容旧 LEGACY_SESSION_KEY 命名
      if (key !== LEGACY_SESSION_KEY(projectId, agentId)) {
        /* already handled by length===4 filter */
      }
    }

    kv.set(flag, '1')
  }
}
