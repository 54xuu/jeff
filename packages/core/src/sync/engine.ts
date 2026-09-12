import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { createClient, WebDAVClient } from 'webdav'
import type { DB } from '../db/db.js'
import { agentRepo, projectAgentRepo, projectRepo, taskRepo, type AgentRow, type ProjectAgentRow, type ProjectRow, type TaskRow } from '../db/repos.js'
import type { JeffPaths } from '../paths.js'
import type { MemoryStore, MemoryScope } from '../memory/store.js'
import type { SkillsBackupReport, SkillsRestoreApply, SkillsRestoreStage } from '../ipc/contract.js'

export interface WebdavConfig {
  url: string
  username: string
  password: string
  basePath: string // 远端基目录，如 /jeff（必须以 / 开头）
  autoSync: boolean
  /** 单次请求超时 ms；默认 60000 */
  timeoutMs?: number
  /** 是否校验证书；默认 true */
  tlsVerify?: boolean
}

/** 规范化远端基目录：去尾斜杠、补前导 /；空则 /jeff */
export function normalizeWebdavBasePath(raw: string | undefined | null): string {
  let b = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!b) return '/jeff'
  if (!b.startsWith('/')) b = `/${b}`
  return b
}

/** 把 webdav/HTTP 错误翻成可读中文（保留原消息便于排查） */
export function formatWebdavError(err: unknown): string {
  const raw = String((err as Error)?.message || err)
  const m = /Invalid response:\s*(\d+)\s*([A-Za-z ]+)?/i.exec(raw)
  if (m) {
    const code = Number(m[1])
    const hint =
      code === 401
        ? '认证失败：请检查用户名/密码'
        : code === 403
          ? '拒绝访问：常见原因是远端目录不存在或无权写入子目录（请确认基目录以 / 开头，且账号对基目录有写权限）'
          : code === 404
            ? '路径不存在：请检查服务器 URL 与远端基目录'
            : code === 405
              ? '方法不被允许（目录可能已存在；若持续失败请检查服务器 WebDAV 配置）'
              : code === 409
                ? '冲突：父目录可能不存在'
                : '请求被服务器拒绝'
    return `${hint}（HTTP ${code}${m[2] ? ` ${m[2].trim()}` : ''}）· ${raw}`.slice(0, 300)
  }
  if (/TLS|ECONNRESET|socket disconnected|certificate/i.test(raw)) {
    return `TLS/网络连接失败：${raw}`.slice(0, 300)
  }
  return raw.slice(0, 300)
}

export interface SyncReport {
  ok: boolean
  at: number
  uploaded: number
  downloaded: number
  conflicts: string[]
  error?: string
}

/**
 * WebDAV 同步（实体级双向合并）：
 * - 远端：<basePath>/{agents,projects,tasks,settings}.json + tombstones.json + manifest.json
 *         + memory/*.md + agents-md/{user,project-*}.md
 * - 合并：按实体 updatedAt LWW；软删除 = 墓碑（deletedAt 时间参与 LWW）；双端都改 → 记录冲突并按 LWW 取胜
 * - settings 含 providers/defaultModel/theme/themePack/mcp（webdav 配置本身不同步）
 * - 项目 workspace_dir 按设备保留（应用远端时忽略路径）
 * - 会话数据不同步（chat_message / opencode 会话）
 * - skills 目录（~/.agents/skills）为整目录镜像备份：备份 = 远端 skills/ 与本地完全一致（本地删除 → 远端也删，删前归档）；恢复 = 本地整个目录被备份替换。相对路径统一 posix，跨 Windows/Linux 通用
 */

/** 404 / 文件不存在 → 当作远端尚无此文件；其它错误必须抛出，禁止当成空数组回推覆盖远端 */
function isNotFoundError(err: unknown): boolean {
  const raw = String((err as Error)?.message || err)
  if (/Invalid response:\s*404\b/i.test(raw)) return true
  if (/\b404\b/.test(raw) && /not found|ENOENT|404/i.test(raw)) return true
  const status = Number((err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode)
  return status === 404
}
export class SyncEngine {
  private davClient: WebDAVClient | null = null
  /** 重入锁：同一时刻只允许一个 sync 在跑 */
  private syncing = false
  private syncStartedAt = 0
  private idleWaiters: Array<() => void> = []
  /** skills 备份独立跑，不占用 sync 锁 */
  private skillsBusy = false
  /** 卡住超过此时长则强制释放锁（毫秒） */
  private static readonly STUCK_MS = 120_000
  /** 手动同步等待上一轮结束的最长时间 */
  private static readonly WAIT_MS = 60_000

  constructor(
    private db: DB,
    private paths: JeffPaths,
    private memory: MemoryStore,
    private getConfig: () => WebdavConfig | null,
    private onReport: (r: SyncReport) => void = () => {},
  ) {}

  private cfg(): WebdavConfig {
    const cfg = this.getConfig()
    if (!cfg || !cfg.url) throw new Error('WebDAV 未配置')
    return cfg
  }

  private client(): WebDAVClient {
    if (!this.davClient) {
      const cfg = this.cfg()
      const rawTimeout = cfg.timeoutMs
      const timeoutMs = typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout : 60_000
      const tlsVerify = cfg.tlsVerify !== false
      this.davClient = createClient(cfg.url, {
        username: cfg.username,
        password: cfg.password,
        httpsAgent: new https.Agent({
          timeout: timeoutMs,
          rejectUnauthorized: tlsVerify,
        }),
      })
    }
    return this.davClient
  }

  /** 重置 client（配置变更后） */
  resetClient(): void {
    this.davClient = null
  }

  private base(): string {
    return normalizeWebdavBasePath(this.cfg().basePath)
  }

  private notifyIdle(): void {
    const waiters = this.idleWaiters.splice(0)
    for (const w of waiters) w()
  }

  private waitUntilIdle(ms: number): Promise<boolean> {
    if (!this.syncing) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.idleWaiters.indexOf(done)
        if (idx >= 0) this.idleWaiters.splice(idx, 1)
        resolve(false)
      }, ms)
      const done = () => {
        clearTimeout(timer)
        resolve(true)
      }
      this.idleWaiters.push(done)
    })
  }

  async sync(): Promise<SyncReport> {
    // 卡住看门狗：上一轮异常挂起时强制解锁
    if (this.syncing && this.syncStartedAt > 0 && Date.now() - this.syncStartedAt > SyncEngine.STUCK_MS) {
      this.syncing = false
      this.notifyIdle()
    }
    if (this.syncing) {
      const freed = await this.waitUntilIdle(SyncEngine.WAIT_MS)
      if (!freed || this.syncing) {
        // 再等一轮看门狗
        if (this.syncing && Date.now() - this.syncStartedAt > SyncEngine.STUCK_MS) {
          this.syncing = false
          this.notifyIdle()
        }
      }
      if (this.syncing) {
        const skipped: SyncReport = {
          ok: false,
          at: Date.now(),
          uploaded: 0,
          downloaded: 0,
          conflicts: [],
          error: '上一轮同步仍在进行，请稍后再试（若长时间卡住请重启 Jeff）',
        }
        this.onReport(skipped)
        return skipped
      }
    }
    this.syncing = true
    this.syncStartedAt = Date.now()
    let report: SyncReport
    try {
      report = await this.doSync()
    } finally {
      this.syncing = false
      this.syncStartedAt = 0
      this.notifyIdle()
    }
    // skills 在锁外后台跑：避免数百文件 PUT/GET 拖死「立即同步」
    if (report.ok) this.scheduleSkillsBackup()
    return report
  }

  private scheduleSkillsBackup(): void {
    if (this.skillsBusy) return
    this.skillsBusy = true
    void this.backupSkills()
      .catch(() => {
        /* backupSkills 内部已写 kv */
      })
      .finally(() => {
        this.skillsBusy = false
      })
  }

  /**
   * 确保远端目录存在（逐级 MKCOL，不用 recursive）。
   * 部分 Apache/istio WebDAV 对 recursive MKCOL 或无尾斜杠的 PROPFIND/stat 会误回 401。
   */
  private async ensureCollection(path: string): Promise<void> {
    const normalized = path.replace(/\/+$/, '') || '/'
    const parts = normalized.split('/').filter(Boolean)
    let cur = ''
    for (const part of parts) {
      cur += `/${part}`
      if (await this.collectionExists(cur)) continue
      try {
        await this.client().createDirectory(cur, { signal: AbortSignal.timeout(this.requestTimeoutMs()) })
      } catch (err) {
        const msg = String((err as Error)?.message || err)
        // 已存在
        if (/405|409|Method Not Allowed|Conflict/i.test(msg)) continue
        if (await this.collectionExists(cur)) continue
        throw new Error(`无法创建远端目录 ${cur}: ${formatWebdavError(err)}`)
      }
      if (!(await this.collectionExists(cur))) {
        throw new Error(`远端目录创建后仍不可访问：${cur}`)
      }
    }
  }

  /** 目录是否存在；优先带尾斜杠（避免 Apache 301 后部分客户端丢认证变 401） */
  private requestTimeoutMs(): number {
    const raw = this.cfg().timeoutMs
    return typeof raw === 'number' && raw > 0 ? raw : 60_000
  }

  private async collectionExists(path: string): Promise<boolean> {
    const client = this.client()
    const bare = path.replace(/\/+$/, '') || '/'
    const withSlash = bare === '/' ? '/' : `${bare}/`
    const signal = () => AbortSignal.timeout(this.requestTimeoutMs())
    for (const p of [withSlash, bare]) {
      try {
        const st = (await client.stat(p, { signal: signal() })) as { type?: string }
        if (st) return true
      } catch {
        /* try next */
      }
      try {
        await client.getDirectoryContents(p, { signal: signal() })
        return true
      } catch {
        /* try next */
      }
    }
    return false
  }

  private async doSync(): Promise<SyncReport> {
    const report: SyncReport = { ok: false, at: Date.now(), uploaded: 0, downloaded: 0, conflicts: [] }
    try {
      const client = this.client()
      const base = this.base()
      await this.ensureCollection(base)
      await this.ensureCollection(`${base}/memory`)
      await this.ensureCollection(`${base}/agents-md`)

      // 1. 拉远端 → 归一化（墓碑时间并入 updatedAt）
      const remote = new Map<string, RemoteRec>()
      for (const name of ['agents', 'projects', 'tasks', 'settings'] as const) {
        for (const raw of await this.getJsonArray(name)) {
          remote.set(raw.id, { id: raw.id, updatedAt: raw.updatedAt, deletedAt: raw.deletedAt, data: raw.data, memoryFile: null })
        }
      }
      const tomb = await this.getJsonObj('tombstones')
      for (const [id, t] of Object.entries(tomb)) {
        const cur = remote.get(id)
        if (cur) {
          if (t > cur.updatedAt) {
            cur.updatedAt = t
            cur.deletedAt = t
          }
        } else {
          remote.set(id, { id, updatedAt: t, deletedAt: t, data: null, memoryFile: null })
        }
      }
      // 远端记忆文件
      for (const f of await this.listMdFiles(base, client, 'memory')) {
        const content = String((await client.getFileContents(`${base}/${f}`)) ?? '')
        const mtime = await this.remoteMtime(`${base}/${f}`)
        const key = memKeyFromRel(f)
        remote.set(key, { id: key, updatedAt: mtime, deletedAt: null, data: null, memoryFile: { rel: f, content, mtime } })
      }
      // 远端 AGENTS.md
      for (const f of await this.listMdFiles(base, client, 'agents-md')) {
        const content = String((await client.getFileContents(`${base}/${f}`)) ?? '')
        const mtime = await this.remoteMtime(`${base}/${f}`)
        const key = amdKeyFromRel(f)
        if (!key) continue
        remote.set(key, { id: key, updatedAt: mtime, deletedAt: null, data: null, memoryFile: { rel: f, content, mtime } })
      }

      // 2. 本地
      const local = this.collectLocal()
      const lastState = this.kvGetJSON<Record<string, number>>('sync:laststate', {})

      // 3. 合并
      const merged = new Map<string, LocalRec & { memoryFile?: { rel: string; content: string; mtime: number } | null }>()
      for (const [id, l] of local) merged.set(id, { ...l })
      for (const [id, r] of remote) {
        const l = merged.get(id)
        if (!l) {
          merged.set(id, { id, updatedAt: r.updatedAt, deletedAt: r.deletedAt, data: r.data, memoryFile: r.memoryFile })
          continue
        }
        if (l.updatedAt > (lastState[id] || 0) && r.updatedAt > (lastState[id] || 0) && l.updatedAt !== r.updatedAt) {
          report.conflicts.push(id) // 双端都改过
        }
        // LWW；平局且远端是删除 → 删除优先（避免同毫秒丢墓碑）
        if (r.updatedAt > l.updatedAt || (r.updatedAt === l.updatedAt && r.deletedAt != null && l.deletedAt == null)) {
          merged.set(id, { id, updatedAt: r.updatedAt, deletedAt: r.deletedAt, data: r.data, memoryFile: r.memoryFile })
        }
      }

      // 4. 应用到本地
      report.downloaded = this.applyToLocal(merged)

      // 5. 推远端
      report.uploaded += await this.pushToRemote(merged)

      // 6. 记录状态（skills 备份由 sync() 在锁外 schedule）
      const nextLast: Record<string, number> = {}
      for (const [id, rec] of merged) nextLast[id] = rec.updatedAt
      this.kvSetJSON('sync:laststate', nextLast)
      this.kvSetJSON('sync:lastreport', report)
      report.ok = true
    } catch (err) {
      report.error = formatWebdavError(err)
      this.kvSetJSON('sync:lastreport', report)
    }
    this.onReport(report)
    return report
  }

  // ---------- 本地收集 ----------
  private collectLocal(): Map<string, LocalRec> {
    const out = new Map<string, LocalRec>()
    for (const a of agentRepo(this.db).list(true)) {
      out.set(a.id, { id: a.id, updatedAt: a.updated_at, deletedAt: a.deleted_at, data: a, memoryFile: null })
    }
    for (const p of projectRepo(this.db).list(true)) {
      const members = projectAgentRepo(this.db).listByProject(p.id)
      out.set(p.id, { id: p.id, updatedAt: p.updated_at, deletedAt: p.deleted_at, data: { project: p, members }, memoryFile: null })
    }
    const allTasks = this.db.prepare('SELECT id FROM task').all() as unknown as Array<{ id: string }>
    for (const { id } of allTasks) {
      const t = taskRepo(this.db).get(id)
      if (t) out.set(t.id, { id: t.id, updatedAt: t.updated_at, deletedAt: t.deleted_at, data: t, memoryFile: null })
    }
    const settings = {
      providers: this.kvGet('settings:providers'),
      defaultModel: this.kvGet('settings:defaultModel'),
      theme: this.kvGet('settings:theme'),
      themePack: this.kvGet('settings:themePack'),
      mcp: this.kvGet('settings:mcp'),
      // webdav 配置本身不同步（每台设备自己的连接信息）
    }
    const settingsUpdated = Math.max(
      this.kvUpdatedAt('settings:providers'),
      this.kvUpdatedAt('settings:defaultModel'),
      this.kvUpdatedAt('settings:theme'),
      this.kvUpdatedAt('settings:themePack'),
      this.kvUpdatedAt('settings:mcp'),
    )
    out.set('settings', { id: 'settings', updatedAt: settingsUpdated, deletedAt: null, data: settings, memoryFile: null })
    // 记忆文件（mtime 作为版本）
    for (const [key, scope] of this.memoryScopes()) {
      const file = this.memory.file(scope)
      let content = ''
      let mtime = 0
      try {
        content = fs.readFileSync(file, 'utf8')
        mtime = Math.floor(fs.statSync(file).mtimeMs)
      } catch {
        continue
      }
      out.set(key, { id: key, updatedAt: mtime, deletedAt: null, data: null, memoryFile: { rel: memRel(scope), content, mtime } })
    }
    for (const rec of this.collectAgentsMd()) out.set(rec.id, rec)
    return out
  }

  private kvUpdatedAt(key: string): number {
    return Number((this.db.prepare('SELECT updated_at FROM kv WHERE key = ?').get(key) as { updated_at?: number } | undefined)?.updated_at || 0)
  }

  /** 收集用户级 + 项目级 AGENTS.md；权威副本优先，工作空间旧文件作首迁源 */
  private collectAgentsMd(): LocalRec[] {
    const out: LocalRec[] = []
    const pushFile = (id: string, file: string, rel: string) => {
      try {
        const content = fs.readFileSync(file, 'utf8')
        const mtime = Math.floor(fs.statSync(file).mtimeMs)
        out.push({ id, updatedAt: mtime, deletedAt: null, data: null, memoryFile: { rel, content, mtime } })
      } catch {
        /* 文件不存在则跳过 */
      }
    }
    pushFile('amd:user', this.paths.agentsMdUser, 'agents-md/user.md')
    for (const p of projectRepo(this.db).list()) {
      const auth = path.join(this.paths.agentsMdDir, `${p.id}.md`)
      const legacy = path.join(p.workspace_dir || this.paths.workspaceDir, 'AGENTS.md')
      if (fs.existsSync(auth)) pushFile(`amd:project:${p.id}`, auth, `agents-md/project-${p.id}.md`)
      else if (fs.existsSync(legacy)) pushFile(`amd:project:${p.id}`, legacy, `agents-md/project-${p.id}.md`)
    }
    return out
  }

  private memoryScopes(): Array<[string, MemoryScope]> {
    const out: Array<[string, MemoryScope]> = [['mem:user', { kind: 'user' }]]
    for (const a of agentRepo(this.db).list()) out.push([`mem:agent:${a.id}`, { kind: 'agent', agentId: a.id }])
    for (const p of projectRepo(this.db).list()) out.push([`mem:project:${p.id}`, { kind: 'project', projectId: p.id }])
    return out
  }

  // ---------- 应用到本地 ----------
  private applyToLocal(merged: Map<string, LocalRec & { memoryFile?: { rel: string; content: string; mtime: number } | null }>): number {
    let n = 0
    this.db.exec('BEGIN')
    try {
      for (const [id, rec] of merged) {
        if (id === 'settings') {
          const d = (rec.data || {}) as {
            providers?: unknown
            defaultModel?: unknown
            theme?: unknown
            themePack?: unknown
            mcp?: unknown
          }
          this.kvSetJSON('settings:providers', d.providers ?? [])
          this.kvSetJSON('settings:defaultModel', d.defaultModel ?? null)
          this.kvSetJSON('settings:theme', d.theme ?? 'system')
          this.kvSetJSON('settings:themePack', d.themePack ?? 'weui')
          this.kvSetJSON('settings:mcp', d.mcp ?? {})
          n += 1
          continue
        }
        if (id.startsWith('mem:')) {
          if (rec.memoryFile) {
            const file = this.memory.file(memScopeFromRel(rec.memoryFile.rel))
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, rec.memoryFile.content, 'utf8')
            n += 1
          }
          continue
        }
        if (id.startsWith('amd:')) {
          if (rec.memoryFile) {
            const file = amdLocalFile(this.paths, id)
            if (file) {
              fs.mkdirSync(path.dirname(file), { recursive: true })
              fs.writeFileSync(file, rec.memoryFile.content, 'utf8')
              n += 1
            }
          }
          continue
        }
        if (id.startsWith('agt_')) {
          const d = rec.data as AgentRow | null
          if (!d) continue
          const exists = agentRepo(this.db).get(id)
          if (!exists) {
            this.db
              .prepare(
                `INSERT INTO agent (id, name, avatar, description, instructions, model_provider, model_id, thinking, builtin, archived, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(id, d.name, d.avatar, d.description, d.instructions, d.model_provider, d.model_id, (d as { thinking?: string }).thinking || '', d.builtin, d.archived, d.created_at, rec.updatedAt, rec.deletedAt)
          } else {
            this.db
              .prepare(`UPDATE agent SET name=?, avatar=?, description=?, instructions=?, model_provider=?, model_id=?, thinking=?, builtin=?, archived=?, updated_at=?, deleted_at=? WHERE id=?`)
              .run(d.name, d.avatar, d.description, d.instructions, d.model_provider, d.model_id, (d as { thinking?: string }).thinking || exists.thinking || '', d.builtin, d.archived, rec.updatedAt, rec.deletedAt, id)
          }
          n += 1
          continue
        }
        if (id.startsWith('prj_')) {
          const d = rec.data as { project: ProjectRow; members: ProjectAgentRow[] } | null
          if (!d) continue
          const exists = projectRepo(this.db).get(id)
          // workspace_dir 按设备保留：已有保留本机；新建留空（不拷贝远端路径）
          const workspaceDir = exists ? exists.workspace_dir || '' : ''
          if (!exists) {
            this.db
              .prepare(`INSERT INTO project (id, title, description, icon, status, leader_agent_id, workspace_dir, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
              .run(id, d.project.title, d.project.description, d.project.icon, d.project.status, d.project.leader_agent_id, workspaceDir, d.project.created_at, rec.updatedAt, rec.deletedAt)
          } else {
            this.db
              .prepare(`UPDATE project SET title=?, description=?, icon=?, status=?, leader_agent_id=?, updated_at=?, deleted_at=? WHERE id=?`)
              .run(d.project.title, d.project.description, d.project.icon, d.project.status, d.project.leader_agent_id, rec.updatedAt, rec.deletedAt, id)
          }
          this.db.prepare('DELETE FROM project_agent WHERE project_id = ?').run(id)
          for (const m of d.members) {
            this.db.prepare('INSERT INTO project_agent (project_id, agent_id, role, position, created_at) VALUES (?,?,?,?,?)').run(id, m.agent_id, m.role, m.position, m.created_at)
          }
          n += 1
          continue
        }
        if (id.startsWith('task_')) {
          const d = rec.data as TaskRow | null
          if (!d) continue
          const exists = taskRepo(this.db).get(id)
          if (!exists) {
            this.db
              .prepare(
                `INSERT INTO task (id, project_id, number, title, description, status, priority, assignee_type, assignee_id, parent_task_id, position, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(id, d.project_id, d.number, d.title, d.description, d.status, d.priority, d.assignee_type, d.assignee_id, d.parent_task_id, d.position, d.created_at, rec.updatedAt, rec.deletedAt)
          } else {
            this.db
              .prepare(
                `UPDATE task SET project_id=?, number=?, title=?, description=?, status=?, priority=?, assignee_type=?, assignee_id=?, parent_task_id=?, position=?, updated_at=?, deleted_at=? WHERE id=?`,
              )
              .run(d.project_id, d.number, d.title, d.description, d.status, d.priority, d.assignee_type, d.assignee_id, d.parent_task_id, d.position, rec.updatedAt, rec.deletedAt, id)
          }
          n += 1
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
    return n
  }

  // ---------- 推远端 ----------
  private async pushToRemote(merged: Map<string, LocalRec & { memoryFile?: { rel: string; content: string; mtime: number } | null }>): Promise<number> {
    const client = this.client()
    const base = this.base()
    let uploaded = 0
    const byName: Record<string, Array<{ id: string; updatedAt: number; deletedAt: number | null; data: unknown }>> = { agents: [], projects: [], tasks: [], settings: [] }
    const tomb: Record<string, number> = {}
    for (const rec of merged.values()) {
      if (rec.id.startsWith('mem:') || rec.id.startsWith('amd:')) {
        if (rec.memoryFile) {
          await client.putFileContents(`${base}/${rec.memoryFile.rel}`, rec.memoryFile.content, { overwrite: true })
          uploaded += 1
        }
        continue
      }
      if (rec.id === 'settings') byName.settings.push({ id: rec.id, updatedAt: rec.updatedAt, deletedAt: null, data: rec.data })
      else if (rec.id.startsWith('agt_')) byName.agents.push({ id: rec.id, updatedAt: rec.updatedAt, deletedAt: rec.deletedAt, data: rec.data })
      else if (rec.id.startsWith('prj_')) byName.projects.push({ id: rec.id, updatedAt: rec.updatedAt, deletedAt: rec.deletedAt, data: rec.data })
      else if (rec.id.startsWith('task_')) byName.tasks.push({ id: rec.id, updatedAt: rec.updatedAt, deletedAt: rec.deletedAt, data: rec.data })
      if (rec.deletedAt != null) tomb[rec.id] = rec.deletedAt
    }
    for (const name of ['agents', 'projects', 'tasks', 'settings'] as const) {
      await client.putFileContents(`${base}/${name}.json`, JSON.stringify(byName[name], null, 2), { overwrite: true })
      uploaded += 1
    }
    await client.putFileContents(`${base}/tombstones.json`, JSON.stringify(tomb, null, 2), { overwrite: true })
    await client.putFileContents(`${base}/manifest.json`, JSON.stringify({ updatedAt: Date.now() }), { overwrite: true })
    return uploaded
  }

  // ---------- 远端原语 ----------
  private async getJsonArray(name: string): Promise<Array<{ id: string; updatedAt: number; deletedAt: number | null; data: unknown }>> {
    try {
      const buf = await this.client().getFileContents(`${this.base()}/${name}.json`)
      const text = typeof buf === 'string' ? buf : (buf as Buffer).toString('utf8')
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : []
    } catch (err) {
      if (isNotFoundError(err)) return []
      throw new Error(`拉取 ${name}.json 失败: ${formatWebdavError(err)}`)
    }
  }

  private async getJsonObj(name: string): Promise<Record<string, number>> {
    try {
      const buf = await this.client().getFileContents(`${this.base()}/${name}.json`)
      const text = typeof buf === 'string' ? buf : (buf as Buffer).toString('utf8')
      return JSON.parse(text) as Record<string, number>
    } catch (err) {
      if (isNotFoundError(err)) return {}
      throw new Error(`拉取 ${name}.json 失败: ${formatWebdavError(err)}`)
    }
  }

  private async listMdFiles(base: string, client: WebDAVClient, dirName: 'memory' | 'agents-md'): Promise<string[]> {
    try {
      const dir = `${base}/${dirName}/`
      const items = (await client.getDirectoryContents(dir)) as Array<{ filename: string; basename: string; type: string }>
      return items.filter((i) => i.type === 'file' && i.basename.endsWith('.md')).map((i) => `${dirName}/${i.basename}`)
    } catch {
      return []
    }
  }

  private async remoteMtime(filePath: string): Promise<number> {
    try {
      const stat = (await this.client().stat(filePath)) as { lastmod?: string; mtime?: number | Date }
      const m = stat?.mtime
      if (typeof m === 'number') return Math.floor(m)
      if (m instanceof Date) return Math.floor(m.getTime())
      if (stat?.lastmod) return Math.floor(new Date(stat.lastmod).getTime())
    } catch {
      /* 忽略 */
    }
    return 0
  }

  // ---------- skills 单向备份（安全第一：本地永不自动写回，远端永不删除） ----------
  private skillsDir(): string {
    // 默认 ~/.agents/skills（agent skills 标准目录）；测试/便携模式可用 JEFF_SKILLS_DIR 覆盖
    return process.env.JEFF_SKILLS_DIR || path.join(os.homedir(), '.agents', 'skills')
  }

  private skillsKv<T>(key: string, fallback: T): T {
    return this.kvGetJSON<T>(`sync:skills:${key}`, fallback)
  }

  private skillsKvSet(key: string, value: unknown): void {
    this.kvSetJSON(`sync:skills:${key}`, value)
  }

  /** 递归列出 skills 目录下的所有文件（相对路径）；目录不存在返回空 */
  private listSkillFiles(root: string): string[] {
    const out: string[] = []
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(full)
        else if (ent.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
    if (!fs.existsSync(root)) return out
    walk(root)
    return out
  }

  /**
   * 整目录镜像备份 ~/.agents/skills → <base>/skills/**：
   * - 全量对齐：远端 skills/ 始终与本地目录一致——新增/变化上传，本地已删除的文件远端同步删除
   * - 覆盖或删除前先把远端旧版归档到 <base>/skills-versions/<rel>/<时间戳>（误删可从归档找回）
   * - 相对路径统一 posix（/），Windows 备份的内容 Linux 可直接恢复
   * - 安全阀：本地目录不存在，或本地为空而远端有备份时，报错跳过不改远端（防错误路径/空目录把远端清空）；
   *   镜像删除加熔断：单次要删的文件超过远端文件数的 30% 且 >10 个时报错中止（再点一次「立即备份」确认才执行），
   *   防本地目录暂缺/误判把远端备份大面积误删
   * - 自愈：跳过判定 = 本地哈希未变 且 远端列表里确实还有该文件——远端被中断的备份删掉过文件时，
   *   下次备份会自动补传，不会出现「本地哈希说已上传、远端实际没有」的永久不一致
   * - 清单：备份完成后写 <base>/skills-manifest.json（全部文件相对路径）；部分服务器列不出含 index.html
   *   的目录（PROPFIND 405），恢复端靠清单把这些目录下的文件按直连路径补全下载
   * - 性能：并发列目录/上传/删除（每请求带超时）+ 目录创建缓存；数百文件应在数十秒内完成
   */
  async backupSkills(): Promise<SkillsBackupReport> {
    const startedAt = Date.now()
    const report: SkillsBackupReport = { ok: false, at: startedAt, uploaded: 0, archived: 0, skipped: 0, deleted: 0 }
    try {
      const client = this.client()
      const base = this.base()
      const root = this.skillsDir()
      const rawTimeout = this.cfg().timeoutMs
      const timeoutMs = typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout : 60_000
      const reqOpts = () => ({ signal: AbortSignal.timeout(timeoutMs) })
      const remoteDir = `${base}/skills`
      const versionsDir = `${base}/skills-versions`

      if (!fs.existsSync(root)) {
        report.error = `本地 skills 目录不存在（${root}），已跳过备份；为防误清空，未改动远端`
        this.skillsKvSet('last', report)
        return report
      }
      const files = this.listSkillFiles(root)
      const remoteFiles = await this.listRemoteFiles(remoteDir, timeoutMs)
      if (files.length === 0 && remoteFiles.length > 0) {
        report.error = `本地 skills 目录为空，但远端备份有 ${remoteFiles.length} 个文件。为防误清空远端，本次未做任何改动；如确要清空，请先在设置里从备份恢复或手工处理。`
        this.skillsKvSet('last', report)
        return report
      }

      await this.ensureCollection(remoteDir)
      const lastHashes = this.skillsKv<Record<string, string>>('hashes', {})
      const remoteSet = new Set(remoteFiles)
      const hashes: Record<string, string> = {}
      // 目录创建缓存：同一目录只探测/创建一次（collectionExists 每次要 2~3 个请求）
      const ensuredDirs = new Set<string>([remoteDir, versionsDir])
      const ensureDir = async (dir: string): Promise<void> => {
        if (ensuredDirs.has(dir)) return
        await this.ensureCollection(dir)
        ensuredDirs.add(dir)
      }

      // 1) 并发上传：新增（不在 hashes 或远端已丢失）直接 PUT；有变化的先归档远端旧版再覆盖
      const toUpload = files.filter((rel) => {
        const content = fs.readFileSync(path.join(root, rel))
        const hash = contentHash(content)
        hashes[rel] = hash
        // 自愈：哈希相同但远端列表里已经没有该文件（上次备份被中断/误删）→ 不能跳过，必须补传
        if (lastHashes[rel] === hash && remoteSet.has(rel)) {
          report.skipped += 1
          return false
        }
        return true
      })
      await pMap(toUpload, 8, async (rel) => {
        const content = fs.readFileSync(path.join(root, rel))
        const remotePath = `${remoteDir}/${rel}`
        await ensureDir(remotePath.slice(0, remotePath.lastIndexOf('/')))
        // 从未备份过该文件：直接 PUT，不做远端 GET（首次全量探测会拖死备份）
        if (!(rel in lastHashes)) {
          await client.putFileContents(remotePath, content, { overwrite: true, ...reqOpts() })
          report.uploaded += 1
          return
        }
        // 内容相对上次备份有变：先拉远端旧版归档，再覆盖
        let remoteContent: Buffer | null = null
        try {
          remoteContent = await davGetWithRetry(client, remotePath, timeoutMs)
        } catch {
          remoteContent = null
        }
        if (remoteContent && contentHash(remoteContent) === contentHash(content)) {
          report.skipped += 1
          return
        }
        if (remoteContent && remoteContent.length > 0) {
          const verPath = `${versionsDir}/${rel}/${Date.now()}-${report.archived}`
          await ensureDir(verPath.slice(0, verPath.lastIndexOf('/')))
          await client.putFileContents(verPath, remoteContent, { overwrite: false, ...reqOpts() }).catch(() => {})
          report.archived += 1
        }
        await client.putFileContents(remotePath, content, { overwrite: true, ...reqOpts() })
        report.uploaded += 1
      })

      // 上传阶段先落一次哈希：即使后续删除阶段被中断，也已上传的文件不会因哈希缺失而反复重传
      this.skillsKvSet('hashes', hashes)

      // 2) 并发镜像删除：远端有、本地没有的文件 → 归档后从远端删除（本地删除操作传播到远端/其他平台）
      const localSet = new Set(files)
      const toDelete = remoteFiles.filter((rel) => !localSet.has(rel))
      // 熔断：单次删除超过远端文件数的 30% 且 >10 个 → 中止等人工确认（再点一次备份且待删集合一致才执行），
      // 防本地目录暂缺（编辑中/挂载异常/误判）把远端备份大面积清掉
      const exceeds = toDelete.length > 10 && toDelete.length * 100 > remoteFiles.length * 30
      const pendingSig = this.skillsKv<string | null>('pendingDelete', null)
      if (toDelete.length > 0 && exceeds) {
        const sig = [...toDelete].sort().join('\n')
        if (sig !== pendingSig) {
          this.skillsKvSet('pendingDelete', sig)
          report.error = `本次备份要删除远端 ${toDelete.length} 个文件（远端共 ${remoteFiles.length} 个，超过 30% 安全阈值），已中止。若确属你主动批量删除，请再点一次「立即备份 skills」确认执行；若是本地目录暂缺/误删，请先恢复本地文件。示例：${toDelete.slice(0, 3).join('、')}。本次已上传 ${report.uploaded} 个文件，远端删除未执行。`
          this.skillsKvSet('last', report)
          return report
        }
      }
      if (pendingSig) this.skillsKvSet('pendingDelete', null)
      await pMap(toDelete, 8, async (rel) => {
        const remotePath = `${remoteDir}/${rel}`
        let old: Buffer | null = null
        try {
          old = await davGetWithRetry(client, remotePath, timeoutMs)
        } catch {
          old = null
        }
        if (old && old.length > 0) {
          const verPath = `${versionsDir}/${rel}/${Date.now()}-del${report.deleted}`
          await ensureDir(verPath.slice(0, verPath.lastIndexOf('/')))
          await client.putFileContents(verPath, old, { overwrite: false, ...reqOpts() }).catch(() => {})
          report.archived += 1
        }
        await client.deleteFile(remotePath, reqOpts()).catch(() => {})
        delete hashes[rel]
        report.deleted += 1
      })

      hashes.__uploadedAt = String(Date.now())
      this.skillsKvSet('hashes', hashes)
      // 写备份清单（全部文件相对路径）：部分服务器列不出含 index.html 的目录（PROPFIND 405），
      // 恢复端靠清单把这些目录下的文件按直连路径补全下载；放在 skills/ 之外避免被镜像删除逻辑当作多余文件
      const manifest = JSON.stringify({ at: Date.now(), files })
      await client.putFileContents(`${base}/skills-manifest.json`, Buffer.from(manifest, 'utf8'), {
        overwrite: true,
        ...reqOpts(),
      })
      this.skillsKvSet('last', { ...report, ok: true, fileCount: files.length, elapsedMs: Date.now() - startedAt })
      report.ok = true
    } catch (err) {
      report.error = formatWebdavError(err)
      this.skillsKvSet('last', report)
    }
    return report
  }

  /** 上次备份报告（设置页展示） */
  lastSkillsBackup(): (SkillsBackupReport & { fileCount?: number }) | null {
    return this.skillsKv<(SkillsBackupReport & { fileCount?: number }) | null>('last', null)
  }

  /**
   * 恢复第一段：下载远端 skills 全量到暂存目录（<data>/restore-staging/skills），绝不碰本地 skills。
   * 并发下载（每请求带超时）；远端没有备份文件时返回失败（设置页不会给出「确认恢复」入口，防误清空）。
   */
  async restoreSkillsStage(): Promise<SkillsRestoreStage> {
    try {
      const client = this.client()
      const base = this.base()
      const remoteDir = `${base}/skills`
      const staging = path.join(this.paths.restoreStagingDir, 'skills')
      fs.rmSync(staging, { recursive: true, force: true })
      fs.mkdirSync(staging, { recursive: true })
      const rawTimeout = this.cfg().timeoutMs
      const timeoutMs = typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout : 60_000
      let files: string[]
      const warnings: string[] = []
      try {
        files = await this.listRemoteFiles(remoteDir, timeoutMs, { strict: true, warnings })
      } catch (err) {
        if (isNotFoundError(err)) {
          return { ok: false, files: [], total: 0, error: `远端 ${remoteDir} 下还没有备份文件。先在已有完整 skills 的设备上点「立即备份 skills」。` }
        }
        return { ok: false, files: [], total: 0, error: String((err as Error)?.message || err).slice(0, 300) }
      }
      if (files.length === 0) {
        return { ok: false, files: [], total: 0, error: `远端 ${remoteDir} 下没有任何备份文件。先在已有完整 skills 的设备上点「立即备份 skills」。` }
      }
      // 备份清单补全：部分服务器列不出含 index.html 的目录（PROPFIND 405），目录列表缺的文件按清单直连下载
      let manifestFiles: string[] | null = null
      try {
        const mbuf = await davGetWithRetry(client, `${base}/skills-manifest.json`, timeoutMs)
        const parsed = JSON.parse(mbuf.toString('utf8')) as { files?: unknown }
        if (Array.isArray(parsed?.files)) manifestFiles = parsed.files.filter((x): x is string => typeof x === 'string')
      } catch {
        /* 旧备份没有清单，忽略 */
      }
      if (manifestFiles && manifestFiles.length > 0) {
        const listed = new Set(files)
        const extra = manifestFiles.filter((rel) => !listed.has(rel))
        if (extra.length > 0) {
          warnings.push(`有 ${extra.length} 个文件在服务器目录列表中看不到（服务端无法列出其所在目录），已按备份清单补全下载`)
          files = [...files, ...extra]
        }
      }
      const failed: string[] = []
      await pMap(files, 8, async (rel) => {
        try {
          const buf = await davGetWithRetry(client, `${remoteDir}/${rel}`, timeoutMs)
          const target = path.join(staging, ...rel.split('/'))
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, buf)
        } catch (err) {
          failed.push(`${rel}: ${String((err as Error)?.message || err).slice(0, 80)}`)
        }
      })
      if (failed.length > 0) {
        return { ok: false, files: [], total: 0, error: `有 ${failed.length} 个备份文件下载失败（已中止恢复，本地未改动）：${failed.slice(0, 3).join('；')}` }
      }
      return { ok: true, files, total: files.length, warnings: warnings.length > 0 ? warnings : undefined }
    } catch (err) {
      return { ok: false, files: [], total: 0, error: String((err as Error)?.message || err).slice(0, 300) }
    }
  }

  /**
   * 恢复第二段（显式确认后）：把本地 skills 整个目录替换为备份内容。
   * 1. 先把本地现状全量快照到 <data>/backups/skills-<时间戳>/（可手工回退的兜底）；
   * 2. 把暂存区完整拷成本地 ready 目录并逐文件校验后，再替换本地 skills——
   *    「先备好、再换入」：换入阶段失败自动从快照回滚，绝不把本地留在半空状态
   *    （其他平台删除的文件在本地同步消失，跨平台镜像语义）。
   */
  async restoreSkillsApply(): Promise<SkillsRestoreApply> {
    const staging = path.join(this.paths.restoreStagingDir, 'skills')
    const root = this.skillsDir()
    let snapshotDir = ''
    try {
      const files = this.listSkillFiles(staging)
      if (files.length === 0) return { ok: false, restored: 0, removed: 0, snapshotDir: '', error: '暂存区为空：请先执行「检查备份」' }
      // 1. 本地快照（可手工回退的兜底）
      const localFiles = this.listSkillFiles(root)
      snapshotDir = path.join(this.paths.backupsDir, `skills-${Date.now()}`)
      fs.mkdirSync(snapshotDir, { recursive: true })
      for (const rel of localFiles) {
        const target = path.join(snapshotDir, ...rel.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(path.join(root, rel), target)
      }
      // 2. 在数据目录里先把「恢复后的完整目录」备好并校验（此时本地 skills 尚未动）
      const readyDir = path.join(this.paths.restoreStagingDir, `skills-ready-${Date.now()}`)
      fs.rmSync(readyDir, { recursive: true, force: true })
      fs.mkdirSync(readyDir, { recursive: true })
      for (const rel of files) {
        const target = path.join(readyDir, ...rel.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(path.join(staging, ...rel.split('/')), target)
      }
      if (this.listSkillFiles(readyDir).length !== files.length) {
        throw new Error('恢复目录准备不完整，已中止（本地未被改动）')
      }
      // 3. 换入：优先 rename（同盘原子）；跨盘降级为 rm+copy，失败即从快照回滚
      let restored = 0
      fs.rmSync(root, { recursive: true, force: true })
      try {
        try {
          fs.renameSync(readyDir, root)
          restored = files.length
        } catch {
          fs.mkdirSync(root, { recursive: true })
          for (const rel of files) {
            const target = path.join(root, ...rel.split('/'))
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.copyFileSync(path.join(readyDir, ...rel.split('/')), target)
            restored += 1
          }
        }
      } catch (copyErr) {
        // 回滚：把快照原样拷回，本地不丢数据
        fs.rmSync(root, { recursive: true, force: true })
        fs.mkdirSync(root, { recursive: true })
        for (const rel of this.listSkillFiles(snapshotDir)) {
          const target = path.join(root, ...rel.split('/'))
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.copyFileSync(path.join(snapshotDir, ...rel.split('/')), target)
        }
        throw new Error(`恢复换入失败，已从恢复前快照回滚本地目录：${String((copyErr as Error)?.message || copyErr).slice(0, 200)}`)
      }
      // 目录状态变了：用刚恢复的内容（= 远端备份内容）重建 hashes，下次备份无需全量重传
      const newHashes: Record<string, string> = {}
      for (const rel of files) newHashes[rel] = contentHash(fs.readFileSync(path.join(staging, ...rel.split('/'))))
      newHashes.__uploadedAt = String(Date.now())
      this.skillsKvSet('hashes', newHashes)
      const backupSet = new Set(files)
      const removed = localFiles.filter((r) => !backupSet.has(r)).length
      return { ok: true, restored, removed, snapshotDir }
    } catch (err) {
      return { ok: false, restored: 0, removed: 0, snapshotDir: '', error: String((err as Error)?.message || err).slice(0, 300) }
    }
  }

  /**
   * 递归列远端目录文件（相对 baseDir 的 posix 相对路径）；跳过 self 引用防死循环。
   * 目录按有界并发（8）列举——数百目录的串行 PROPFIND 会拖到分钟级。
   * strict（恢复前检查）：目录列不动时分级探测——stat 404 = 不存在（可能是被标成目录的无扩展名文件，
   * 尝试按文件下载收进列表）；stat 207 = 目录真实存在但列不出（服务端怪癖，其下文件由备份清单补全）；
   * stat 401/405 = 确定性坏条目，跳过并告警；其余错误中止，防用不完整列表做恢复。
   */
  private async listRemoteFiles(baseDir: string, timeoutMs?: number, opts?: { strict?: boolean; warnings?: string[] }): Promise<string[]> {
    const client = this.client()
    const out: string[] = []
    const visited = new Set<string>()
    const norm = (p: string) => p.replace(/\/+$/, '')
    const perReq = timeoutMs ?? this.requestTimeoutMs()
    const walk = async (dir: string, rel: string): Promise<void> => {
      const key = norm(dir)
      if (visited.has(key)) return
      visited.add(key)
      let items: Array<{ filename: string; basename: string; type: string }>
      try {
        // 长连接偶发被服务端/代理静默断开 → 请求永久挂起；重试一次走新连接
        items = (await davListWithRetry(client, dir, perReq)) as Array<{ filename: string; basename: string; type: string }>
      } catch (err) {
        if (opts?.strict) {
          // 分级探测：Depth 0 PROPFIND（stat）区分「目录真实存在但列不出 / 不存在 / 坏条目」
          let statState: 'ok' | 'notfound' | 'blocked' | 'other' = 'other'
          let statErr: unknown
          try {
            await davStatWithRetry(client, dir, perReq)
            statState = 'ok'
          } catch (e) {
            statErr = e
            if (isNotFoundError(e)) statState = 'notfound'
            else if (isAuthzOrMethodError(e)) statState = 'blocked'
          }
          if (statState === 'ok') {
            // Depth 0 PROPFIND 通了但 Depth 1 列不出：目录真实存在，只是服务端列不出（如含 index.html 的目录）
            opts.warnings?.push(`服务端无法列出目录（其下文件由备份清单补全）：${dir}`)
            return
          }
          if (statState === 'notfound') {
            // 目录不存在：有的服务器把无扩展名文件标成目录；先探测能否当作文件下载，能则收进文件列表
            try {
              const buf = await davGetWithRetry(client, dir, perReq)
              out.push(rel.replace(/\/+$/, ''))
              void buf
              return
            } catch (getErr) {
              // 401/405 = 服务端确定性坏条目（既不能列也不能下也不能删），跳过并告警
              if (isAuthzOrMethodError(getErr)) {
                opts.warnings?.push(`服务端坏条目已跳过：${dir}（无法列目录/下载/删除，建议在 WebDAV 服务器上手工清理）`)
                return
              }
              throw new Error(`列目录失败：${dir}（${String((getErr as Error)?.message || getErr).slice(0, 120)}）——为防用不完整的列表做恢复，已中止`)
            }
          }
          if (statState === 'blocked') {
            opts.warnings?.push(`服务端无法列出目录（405/401，其下文件由备份清单补全）：${dir}`)
            return
          }
          throw new Error(`列目录失败：${dir}（${String((statErr as Error)?.message || statErr).slice(0, 120)}）——为防用不完整的列表做恢复，已中止`)
        }
        return
      }
      await pMap(items, 8, async (item) => {
        // 防御：部分服务器/代理会返回目录自身 href（带尾斜杠），不能当作子项递归
        if (norm(item.filename) === key) return
        if (item.type === 'directory') await walk(item.filename, `${rel}${item.basename}/`)
        else out.push(`${rel}${item.basename}`)
      })
    }
    await walk(baseDir, '')
    return out
  }

  // ---------- kv 原语 ----------
  private kvGet(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined
    if (!row?.value) return null
    try {
      return JSON.parse(row.value)
    } catch {
      return row.value
    }
  }

  private kvGetJSON<T>(key: string, fallback: T): T {
    const v = this.kvGet(key)
    return v == null ? fallback : (v as T)
  }

  private kvSetJSON(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value ?? null), Date.now())
  }
}

interface LocalRec {
  id: string
  updatedAt: number
  deletedAt: number | null
  data: unknown
  memoryFile?: { rel: string; content: string; mtime: number } | null
}

interface RemoteRec {
  id: string
  updatedAt: number
  deletedAt: number | null
  data: unknown
  memoryFile?: { rel: string; content: string; mtime: number } | null
}

function memRel(scope: MemoryScope): string {
  if (scope.kind === 'user') return 'memory/user.md'
  if (scope.kind === 'agent') return `memory/agent-${scope.agentId}.md`
  return `memory/project-${scope.projectId}.md`
}

function memKeyFromRel(rel: string): string {
  const name = path.basename(rel, '.md')
  if (name === 'user') return 'mem:user'
  if (name.startsWith('agent-')) return `mem:agent:${name.slice(6)}`
  return `mem:project:${name.slice(8)}`
}

function memScopeFromRel(rel: string): MemoryScope {
  const name = path.basename(rel, '.md')
  if (name === 'user') return { kind: 'user' }
  if (name.startsWith('agent-')) return { kind: 'agent', agentId: name.slice(6) }
  return { kind: 'project', projectId: name.slice(8) }
}

function amdKeyFromRel(rel: string): string | null {
  const name = path.basename(rel, '.md')
  if (name === 'user') return 'amd:user'
  if (name.startsWith('project-')) return `amd:project:${name.slice(8)}`
  return null
}

function amdLocalFile(paths: JeffPaths, id: string): string | null {
  if (id === 'amd:user') return paths.agentsMdUser
  if (id.startsWith('amd:project:')) return path.join(paths.agentsMdDir, `${id.slice('amd:project:'.length)}.md`)
  return null
}

function contentHash(buf: Buffer): string {
  // FNV-1a 32 位足够做「内容是否变化」对比，避免引入 crypto 依赖
  let h = 0x811c9dc5
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i]
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}:${buf.length}`
}

/** 服务端确定性坏条目：目录列不动 + 下载也不行的路径（401/405），只能跳过并提示用户手工清理 */
function isAuthzOrMethodError(err: unknown): boolean {
  return /Invalid response:\s*(401|405)\b/i.test(String((err as Error)?.message || err))
}

/** GET 类请求重试助手：长连接被静默断开时请求会永久挂起（或到超时才断），重试走新连接即可恢复 */
const DAV_RETRY_DELAY_MS = 800

async function davListWithRetry(client: WebDAVClient, dir: string, timeoutMs: number): Promise<unknown> {
  try {
    return await client.getDirectoryContents(dir, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if (isNotFoundError(err)) throw err
    // 重试 = 新请求新信号；被中止的连接已被销毁，重试大概率拿到新连接即成功
    await new Promise((r) => setTimeout(r, DAV_RETRY_DELAY_MS))
    return await client.getDirectoryContents(dir, { signal: AbortSignal.timeout(timeoutMs) })
  }
}

async function davGetWithRetry(client: WebDAVClient, fileUrl: string, timeoutMs: number): Promise<Buffer> {
  try {
    return (await client.getFileContents(fileUrl, { signal: AbortSignal.timeout(timeoutMs) })) as Buffer
  } catch (err) {
    if (isNotFoundError(err)) throw err
    await new Promise((r) => setTimeout(r, DAV_RETRY_DELAY_MS))
    return (await client.getFileContents(fileUrl, { signal: AbortSignal.timeout(timeoutMs) })) as Buffer
  }
}

/** Depth 0 PROPFIND（stat）重试助手：探测路径是否存在（207）/ 不存在（404）/ 坏条目（401/405） */
async function davStatWithRetry(client: WebDAVClient, fileUrl: string, timeoutMs: number): Promise<unknown> {
  try {
    return await client.stat(fileUrl, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if (isNotFoundError(err)) throw err
    await new Promise((r) => setTimeout(r, DAV_RETRY_DELAY_MS))
    return await client.stat(fileUrl, { signal: AbortSignal.timeout(timeoutMs) })
  }
}

/** 有界并发跑异步任务（保持完成计数；单个任务抛错则整体 reject） */
async function pMap<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}
