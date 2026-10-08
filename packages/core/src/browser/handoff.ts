import { randomToken } from '../util/id.js'

/** 本机浏览器接管记录。页面内容、Cookie、表单值和认证 URL 参数不得进入此对象。 */
export interface BrowserHandoffRecord {
  id: string
  status: 'waiting_user' | 'resuming'
  sessionId: string
  kind: 'private' | 'group'
  agentId: string
  projectId?: string
  threadId?: string
  cronTaskId?: string
  cronRunId?: string
  taskRunId?: string
  taskLabel: string
  site: string
  siteUrl: string
  reason: 'login' | 'captcha' | 'qr' | 'verification' | 'other'
  requestedAt: number
  error?: string
}

export type PublicBrowserHandoff = Omit<BrowserHandoffRecord, 'sessionId'>

/**
 * Stores one durable, non-terminal browser handoff. Persistence is injected so the state remains
 * local to Jeff's existing database and can be tested without opening an application database.
 */
export class BrowserHandoffManager {
  constructor(
    private readonly read: () => BrowserHandoffRecord | null,
    private readonly write: (record: BrowserHandoffRecord | null) => void,
    private readonly now: () => number = Date.now,
  ) {}

  current(): BrowserHandoffRecord | null {
    return this.read()
  }

  begin(input: Omit<BrowserHandoffRecord, 'id' | 'status' | 'requestedAt' | 'error'>): BrowserHandoffRecord {
    const current = this.read()
    if (current) {
      if (current.sessionId === input.sessionId) return current
      throw new Error('内置浏览器正由另一个任务等待用户接管，请先交还或取消当前任务。')
    }
    const record: BrowserHandoffRecord = {
      ...input,
      id: `bho_${randomToken(12)}`,
      status: 'waiting_user',
      requestedAt: this.now(),
    }
    this.write(record)
    return record
  }

  markResuming(id: string): BrowserHandoffRecord {
    const current = this.require(id)
    const next = { ...current, status: 'resuming' as const, error: undefined }
    this.write(next)
    return next
  }

  markWaiting(id: string, error?: string): BrowserHandoffRecord {
    const current = this.require(id)
    const next = { ...current, status: 'waiting_user' as const, ...(error ? { error: error.slice(0, 300) } : { error: undefined }) }
    this.write(next)
    return next
  }

  clear(id?: string): BrowserHandoffRecord | null {
    const current = this.read()
    if (!current || (id && current.id !== id)) return current
    this.write(null)
    return current
  }

  private require(id: string): BrowserHandoffRecord {
    const current = this.read()
    if (!current || current.id !== id) throw new Error('浏览器接管任务已变化，请刷新状态后重试。')
    return current
  }
}

export class BrowserHandoffPausedError extends Error {
  readonly code = 'BROWSER_HANDOFF_PAUSED'
  constructor(readonly sessionId: string) {
    super('任务已暂停，正在等待你完成浏览器验证。')
    this.name = 'BrowserHandoffPausedError'
  }
}

export function publicBrowserHandoff(record: BrowserHandoffRecord | null): PublicBrowserHandoff | null {
  if (!record) return null
  const { sessionId: _sessionId, ...safe } = record
  return safe
}
