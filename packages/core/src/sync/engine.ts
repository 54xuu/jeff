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
  basePath: string // 远端基目录，如 /dav/jeff
  autoSync: boolean
  /** 单次请求超时 ms；默认 60000 */
  timeoutMs?: number
  /** 是否校验证书；默认 true */
  tlsVerify?: boolean
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
 * - 远端：<basePath>/{agents,projects,tasks,settings}.json + tombstones.json + manifest.json + memory/*.md
 * - 合并：按实体 updatedAt LWW；软删除 = 墓碑（deletedAt 时间参与 LWW）；双端都改 → 记录冲突并按 LWW 取胜
 * - 会话数据不同步（chat_message / opencode 会话）
 * - skills 目录（~/.agents/skills）为单向备份：只上传不下载、本地删除不传播、覆盖前归档旧版本
 */
export class SyncEngine {
  private davClient: WebDAVClient | null = null
  /** 重入锁：同一时刻只允许一个 sync 在跑（自动定时器与手动按钮并发会交叉读写远端） */
  private syncing = false

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
      const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 60_000
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
    return (this.cfg().basePath.replace(/\/+$/, '') || '/jeff')
  }

  async sync(): Promise<SyncReport> {
    // 重入保护：跳过并发调用（不排队，等下一轮防抖/手动触发）
    if (this.syncing) {
      const skipped: SyncReport = { ok: false, at: Date.now(), uploaded: 0, downloaded: 0, conflicts: [], error: '上一轮同步仍在进行，本次跳过' }
      this.onReport(skipped)
      return skipped
    }
    this.syncing = true
    try {
      return await this.doSync()
    } finally {
      this.syncing = false
    }
  }

  private async doSync(): Promise<SyncReport> {
    const report: SyncReport = { ok: false, at: Date.now(), uploaded: 0, downloaded: 0, conflicts: [] }
    try {
      const client = this.client()
      const base = this.base()
      await client.createDirectory(base, { recursive: true }).catch(() => {})
      await client.createDirectory(`${base}/memory`, { recursive: true }).catch(() => {})

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
      for (const f of await this.listMemoryFiles(base, client)) {
        // f 形如 memory/<name>.md（与推送时的 rel 一致）
        const content = String((await client.getFileContents(`${base}/${f}`)) ?? '')
        const mtime = await this.remoteMtime(`${base}/${f}`)
        const key = memKeyFromRel(f)
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

      // 5.5 skills 单向备份（独立于实体同步：失败不拖垮整体，也不写进 report 计数）
      try {
        await this.backupSkills()
      } catch {
        /* backupSkills 内部已记录失败详情到 kv */
      }

      // 6. 记录状态
      const nextLast: Record<string, number> = {}
      for (const [id, rec] of merged) nextLast[id] = rec.updatedAt
      this.kvSetJSON('sync:laststate', nextLast)
      this.kvSetJSON('sync:lastreport', report)
      report.ok = true
    } catch (err) {
      report.error = String((err as Error)?.message || err).slice(0, 300)
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
      // webdav 配置本身不同步（每台设备自己的连接信息）
    }
    const settingsUpdated = Number(
      (this.db.prepare('SELECT updated_at FROM kv WHERE key = ?').get('settings:providers') as { updated_at?: number } | undefined)?.updated_at || 0,
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
    for (const [id, rec] of merged) {
      if (id === 'settings') {
        const d = (rec.data || {}) as { providers?: unknown; defaultModel?: unknown; theme?: unknown; themePack?: unknown }
        this.kvSetJSON('settings:providers', d.providers ?? [])
        this.kvSetJSON('settings:defaultModel', d.defaultModel ?? null)
        this.kvSetJSON('settings:theme', d.theme ?? 'system')
        this.kvSetJSON('settings:themePack', d.themePack ?? 'weui')
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
        if (!exists) {
          this.db
            .prepare(`INSERT INTO project (id, title, description, icon, status, leader_agent_id, workspace_dir, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(id, d.project.title, d.project.description, d.project.icon, d.project.status, d.project.leader_agent_id, d.project.workspace_dir || '', d.project.created_at, rec.updatedAt, rec.deletedAt)
        } else {
          this.db
            .prepare(`UPDATE project SET title=?, description=?, icon=?, status=?, leader_agent_id=?, workspace_dir=?, updated_at=?, deleted_at=? WHERE id=?`)
            .run(d.project.title, d.project.description, d.project.icon, d.project.status, d.project.leader_agent_id, d.project.workspace_dir || exists.workspace_dir || '', rec.updatedAt, rec.deletedAt, id)
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
      if (rec.id.startsWith('mem:')) {
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
    } catch {
      return []
    }
  }

  private async getJsonObj(name: string): Promise<Record<string, number>> {
    try {
      const buf = await this.client().getFileContents(`${this.base()}/${name}.json`)
      const text = typeof buf === 'string' ? buf : (buf as Buffer).toString('utf8')
      return JSON.parse(text) as Record<string, number>
    } catch {
      return {}
    }
  }

  private async listMemoryFiles(base: string, client: WebDAVClient): Promise<string[]> {
    try {
      const stat = await client.stat(`${base}/memory`)
      if (!stat) return []
      const items = (await client.getDirectoryContents(`${base}/memory`)) as Array<{ filename: string; basename: string; type: string }>
      return items.filter((i) => i.type === 'file' && i.basename.endsWith('.md')).map((i) => `memory/${i.basename}`)
    } catch {
      return []
    }
  }

  private async remoteMtime(path: string): Promise<number> {
    try {
      const stat = (await this.client().stat(path)) as { lastmod?: string; mtime?: number | Date }
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
   * 单向备份 ~/.agents/skills → <base>/skills/**：
   * - 只上传：本地删除不传播（远端永不因本地消失而删）
   * - 内容变化时先把远端旧文件归档到 <base>/skills-versions/<rel>/<时间戳> 再覆盖（多设备互不抹历史）
   */
  async backupSkills(): Promise<SkillsBackupReport> {
    const report: SkillsBackupReport = { ok: false, at: Date.now(), uploaded: 0, archived: 0, skipped: 0 }
    try {
      const client = this.client()
      const base = this.base()
      const root = this.skillsDir()
      const files = this.listSkillFiles(root)
      const lastHashes = this.skillsKv<Record<string, string>>('hashes', {})
      const hashes: Record<string, string> = {}
      for (const rel of files) {
        const content = fs.readFileSync(path.join(root, rel))
        const hash = contentHash(content)
        hashes[rel] = hash
        // 远端当前内容（仅当上次备份后有变化才拉取对比，减少请求）
        let remoteContent: Buffer | null = null
        try {
          remoteContent = (await client.getFileContents(`${base}/skills/${rel}`)) as Buffer
        } catch {
          remoteContent = null
        }
        if (remoteContent && contentHash(remoteContent) === hash) {
          report.skipped += 1
          continue
        }
        if (remoteContent && remoteContent.length > 0) {
          // 归档远端旧版本（按相对路径 + 时间戳），永不覆盖 versions
          const verPath = `${base}/skills-versions/${rel}/${Date.now()}`
          const verDir = verPath.slice(0, verPath.lastIndexOf('/'))
          await client.createDirectory(verDir, { recursive: true }).catch(() => {})
          await client.putFileContents(verPath, remoteContent, { overwrite: false }).catch(() => {})
          report.archived += 1
        }
        await client.putFileContents(`${base}/skills/${rel}`, content, { overwrite: true })
        report.uploaded += 1
      }
      hashes.__uploadedAt = String(Date.now())
      this.skillsKvSet('hashes', hashes)
      this.skillsKvSet('last', { ...report, ok: true, fileCount: files.length })
      report.ok = true
    } catch (err) {
      report.error = String((err as Error)?.message || err).slice(0, 300)
      this.skillsKvSet('last', report)
    }
    return report
  }

  /** 上次备份报告（设置页展示） */
  lastSkillsBackup(): (SkillsBackupReport & { fileCount?: number }) | null {
    return this.skillsKv<(SkillsBackupReport & { fileCount?: number }) | null>('last', null)
  }

  /** 恢复第一段：下载远端 skills 全量到暂存目录（<data>/restore-staging/skills），绝不碰本地 skills */
  async restoreSkillsStage(): Promise<SkillsRestoreStage> {
    try {
      const client = this.client()
      const base = this.base()
      const staging = path.join(this.paths.restoreStagingDir, 'skills')
      fs.rmSync(staging, { recursive: true, force: true })
      fs.mkdirSync(staging, { recursive: true })
      const files = await this.listRemoteFiles(`${base}/skills`)
      for (const rel of files) {
        const buf = (await client.getFileContents(`${base}/skills/${rel}`)) as Buffer
        const target = path.join(staging, ...rel.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, buf)
      }
      return { ok: true, files, total: files.length }
    } catch (err) {
      return { ok: false, files: [], total: 0, error: String((err as Error)?.message || err).slice(0, 300) }
    }
  }

  /**
   * 恢复第二段（显式确认后）：先把本地 skills 全量快照到 <data>/backups/skills-<时间戳>/，
   * 再把暂存区文件覆盖进 ~/.agents/skills。只覆盖备份中存在的文件，绝不删除本地多出的文件。
   */
  async restoreSkillsApply(): Promise<SkillsRestoreApply> {
    const staging = path.join(this.paths.restoreStagingDir, 'skills')
    const root = this.skillsDir()
    try {
      const files = this.listSkillFiles(staging)
      if (files.length === 0) return { ok: false, restored: 0, snapshotDir: '', error: '暂存区为空：请先执行「检查备份」' }
      // 1. 本地快照（可手工回退的兜底）
      const snapshotDir = path.join(this.paths.backupsDir, `skills-${Date.now()}`)
      fs.mkdirSync(snapshotDir, { recursive: true })
      for (const rel of this.listSkillFiles(root)) {
        const target = path.join(snapshotDir, ...rel.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(path.join(root, rel), target)
      }
      // 2. 覆盖式恢复（不删除本地多出的文件）
      let restored = 0
      for (const rel of files) {
        const target = path.join(root, ...rel.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(path.join(staging, ...rel.split('/')), target)
        restored += 1
      }
      return { ok: true, restored, snapshotDir }
    } catch (err) {
      return { ok: false, restored: 0, snapshotDir: '', error: String((err as Error)?.message || err).slice(0, 300) }
    }
  }

  /** 递归列远端目录文件（相对 baseDir 的 posix 相对路径）；跳过 self 引用防死循环 */
  private async listRemoteFiles(baseDir: string): Promise<string[]> {
    const client = this.client()
    const out: string[] = []
    const visited = new Set<string>()
    const norm = (p: string) => p.replace(/\/+$/, '')
    const walk = async (dir: string, rel: string): Promise<void> => {
      const key = norm(dir)
      if (visited.has(key)) return
      visited.add(key)
      let items: Array<{ filename: string; basename: string; type: string }>
      try {
        items = (await client.getDirectoryContents(dir)) as Array<{ filename: string; basename: string; type: string }>
      } catch {
        return
      }
      for (const item of items) {
        // 防御：部分服务器/代理会返回目录自身 href（带尾斜杠），不能当作子项递归
        if (norm(item.filename) === key) continue
        if (item.type === 'directory') await walk(item.filename, `${rel}${item.basename}/`)
        else out.push(`${rel}${item.basename}`)
      }
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

function contentHash(buf: Buffer): string {
  // FNV-1a 32 位足够做「内容是否变化」对比，避免引入 crypto 依赖
  let h = 0x811c9dc5
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i]
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}:${buf.length}`
}
