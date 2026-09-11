import type { DB } from '../db/db.js'
import { chatMessageRepo, kvRepo } from '../db/repos.js'
import { genId } from '../util/id.js'
import { composeAutoTitle, placeholderTitle } from '../util/title.js'

export interface GroupThreadMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /**
   * 自动命名会话：标题先是 `{时间戳}-新会话` 占位，首条用户消息落库后补任务名。
   * 显式命名、手动改名、以及本次改动之前建的旧会话都没有这个字段（视为 false）。
   */
  autoTitle?: boolean
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
    return this.createThread(projectId).id
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
    const explicit = (title || '').trim()
    const meta: GroupThreadMeta = {
      id,
      // 未显式命名 = 自动命名会话：先占位，首条用户消息落库后补上任务名
      title: explicit || placeholderTitle(now),
      autoTitle: !explicit,
      createdAt: now,
      updatedAt: now,
    }
    const kv = this.kv()
    kv.setJSON(THREAD_KEY(projectId, id), meta)
    kv.set(ACTIVE_KEY(projectId), id)
    return meta
  }

  /**
   * 首条用户消息落库后补任务名：`{创建时间戳}-{任务中文名称}`。
   * 只作用于自动命名的会话；显式命名/手动改名过/旧会话（autoTitle 非 true）一律不动。
   */
  autoTitleFromFirstMessage(projectId: string, threadId: string, text: string): void {
    const cur = this.getMeta(projectId, threadId)
    if (!cur || cur.autoTitle !== true) return
    const next: GroupThreadMeta = {
      ...cur,
      title: composeAutoTitle(cur.createdAt, text),
      autoTitle: false,
      updatedAt: Date.now(),
    }
    this.kv().setJSON(THREAD_KEY(projectId, threadId), next)
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
    const next: GroupThreadMeta = { ...cur, title: t, updatedAt: Date.now(), autoTitle: false }
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
    // 最后会话指针若指向被删 thread 的 session，一并清理（防 abort 打到已删除会话 / lastGroupAgentId 误判）
    const last = kv.get(LAST_OC_KEY(projectId))
    if (last && ocSessionIds.includes(last)) kv.delete(LAST_OC_KEY(projectId))
    if (wasActive) {
      kv.delete(ACTIVE_KEY(projectId))
      const rest = this.listThreads(projectId)
      if (rest.length > 0) kv.set(ACTIVE_KEY(projectId), rest[0].id)
      else this.createThread(projectId)
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
      // 承载旧数据的迁移会话保留原命名且不参与自动命名：用「当下时间」改写历史会话的名字会失真
      const hasLegacy = msgs.length > 0 || legacySessions.length > 0
      const meta: GroupThreadMeta = {
        id: threadId,
        title: hasLegacy ? '默认会话' : placeholderTitle(now),
        autoTitle: !hasLegacy,
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
