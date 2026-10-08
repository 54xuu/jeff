import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type PromptContextKind =
  | 'agent-instructions'
  | 'agents-md-user'
  | 'agents-md-project'
  | 'group-identity'
  | 'group-description'
  | 'group-workspace'
  | 'group-rules'
  | 'member-duty'
  | 'member-roster'
  | 'memory-policy'
  | 'memory-agent'
  | 'memory-project'
  | 'memory-user'
  | 'web-search-guide'
  | 'task'
  | 'delegation'
  | 'subtask-steer'
  | 'unclassified-system'

export type PromptContextScope = 'user' | 'agent' | 'project' | 'thread' | 'task' | 'run'
export type PromptReadStatus = 'loaded' | 'empty' | 'missing' | 'error' | 'generated'
export type PromptDelivery = 'system' | 'agent-definition'

export interface PromptContextBlock {
  id: string
  kind: PromptContextKind
  scope: PromptContextScope
  source: string
  readStatus: PromptReadStatus
  delivery?: PromptDelivery
  /** Empty/missing source blocks remain visible in preview but are omitted from the model prompt. */
  included: boolean
  content: string
}

export interface PromptContextMetadata {
  agentId: string
  sessionId?: string
  projectId?: string
  threadId?: string
  taskId?: string
  taskRunId?: string
  engine?: string
  agentInstructionsVersion?: number
}

export interface PromptContext {
  version: 1
  metadata: PromptContextMetadata
  blocks: Array<PromptContextBlock & { contentHash: string }>
  system: string
  systemHash: string
  contextHash: string
}

export interface PromptSnapshotRecord {
  id: string
  sessionId: string
  agentId: string
  projectId?: string
  threadId?: string
  taskId?: string
  taskRunId?: string
  engine: string
  sentAt: number
  context: PromptContext
  /** Exact Jeff `system` string handed to the engine adapter for this send. */
  system: string
  systemHash: string
  /** Jeff-owned agent definition or adapter instruction file contents; never includes provider internals. */
  adapterPrompt?: string
  adapterPromptHash?: string
}

const KIND_ORDER: Record<PromptContextKind, number> = {
  'agent-instructions': 0,
  'agents-md-user': 10,
  'agents-md-project': 11,
  'group-identity': 20,
  'group-description': 21,
  'group-workspace': 22,
  'group-rules': 30,
  'member-duty': 40,
  'member-roster': 41,
  'memory-policy': 50,
  'web-search-guide': 51,
  'memory-agent': 60,
  'memory-project': 61,
  'memory-user': 62,
  task: 80,
  delegation: 90,
  'subtask-steer': 100,
  'unclassified-system': 110,
}

function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/**
 * Assemble Jeff-owned context in one stable order. Personal instructions are recorded as a
 * semantic block but delivered through the engine's Agent definition; every other included block
 * becomes the `system` string. Input order breaks ties so repeated blocks remain deterministic.
 */
export function composePromptContext(metadata: PromptContextMetadata, sourceBlocks: PromptContextBlock[]): PromptContext {
  const blocks = sourceBlocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => KIND_ORDER[a.block.kind] - KIND_ORDER[b.block.kind] || a.index - b.index)
    .map(({ block }) => ({ ...block, delivery: block.delivery || 'system', contentHash: hash(block.content) }))
  const system = blocks
    .filter((block) => block.included && block.delivery === 'system' && block.content.trim())
    .map((block) => block.content.trim())
    .join('\n\n')
  const systemHash = hash(system)
  const contextHash = hash(JSON.stringify({
    version: 1,
    metadata,
    blocks: blocks.map(({ contentHash, delivery, id, included, kind, readStatus, scope, source }) =>
      ({ id, kind, scope, source, readStatus, delivery, included, contentHash })),
    systemHash,
  }))
  return { version: 1, metadata, blocks, system, systemHash, contextHash }
}

/**
 * Local-only immutable prompt evidence. It is intentionally file-backed instead of part of the
 * WebDAV entity set. Snapshots contain user memory and rules, so the directory and files are
 * owner-only on POSIX; retention bounds both exposure and disk growth.
 */
export class PromptSnapshotStore {
  private readonly directory: string
  constructor(root: string, private readonly retentionMs = 30 * 24 * 60 * 60 * 1000, private readonly perSessionLimit = 50) {
    this.directory = path.join(root, 'prompt-snapshots')
  }

  write(record: Omit<PromptSnapshotRecord, 'id' | 'sentAt' | 'systemHash' | 'adapterPromptHash'> & {
    id?: string
    sentAt?: number
    systemHash?: string
    adapterPromptHash?: string
  }): PromptSnapshotRecord {
    const id = record.id || crypto.randomUUID()
    const sentAt = record.sentAt ?? Date.now()
    const snapshot: PromptSnapshotRecord = {
      ...record,
      id,
      sentAt,
      systemHash: hash(record.system),
      ...(record.adapterPrompt === undefined ? {} : { adapterPromptHash: hash(record.adapterPrompt) }),
    }
    const sessionDir = this.sessionDir(record.sessionId)
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(this.directory, 0o700); fs.chmodSync(sessionDir, 0o700) } catch { /* Windows ACLs inherit from JEFF_HOME. */ }
    const filename = `${String(sentAt).padStart(13, '0')}-${id}.json`
    const target = path.join(sessionDir, filename)
    const temporary = `${target}.tmp-${process.pid}`
    fs.writeFileSync(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(temporary, 0o600) } catch { /* Windows ACLs inherit from JEFF_HOME. */ }
    fs.renameSync(temporary, target)
    this.pruneSession(sessionDir, sentAt)
    return snapshot
  }

  latest(sessionId: string): PromptSnapshotRecord | null {
    const sessionDir = this.sessionDir(sessionId)
    let files: string[]
    try { files = fs.readdirSync(sessionDir).filter((name) => name.endsWith('.json')).sort().reverse() }
    catch { return null }
    for (const name of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(sessionDir, name), 'utf8')) as PromptSnapshotRecord
        if (parsed.sessionId === sessionId) return parsed
      } catch { /* Ignore incomplete or damaged snapshot and continue to the preceding send. */ }
    }
    return null
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.directory, hash(sessionId).slice(0, 24))
  }

  private pruneSession(directory: string, now: number): void {
    const cutoff = now - this.retentionMs
    const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort().reverse()
    for (const [index, name] of files.entries()) {
      const timestamp = Number(name.slice(0, 13))
      if (index >= this.perSessionLimit || !Number.isFinite(timestamp) || timestamp < cutoff) {
        fs.rmSync(path.join(directory, name), { force: true })
      }
    }
  }
}

export function makePromptBlock(block: PromptContextBlock): PromptContextBlock {
  return { delivery: 'system', ...block }
}
