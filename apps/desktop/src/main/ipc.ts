import { app, ipcMain, nativeTheme, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AgentInfo,
  InvokeMap,
  ProjectInfo,
  ProjectMember,
  TaskInfo,
  ProviderCatalogItem,
  AppSettings,
  AppInfo,
} from '@jeff/core'
import { IPC, XIAOJIE_ID, agentRepo, projectRepo, projectAgentRepo, taskRepo, taskCardMessage, APP_VERSION, type ThinkingTier } from '@jeff/core'
import type { MemoryScopeInfo } from '@jeff/core'
import type { JeffCore, TaskRow } from '@jeff/core'
import { getMainWindow, getSidecarLogs } from './index.js'

type Handler = (payload: unknown) => Promise<unknown>

/**
 * 注册全部 IPC handler：渲染进程 invoke('jeff:<channel>') → core 调用。
 */
export function registerIpc(core: JeffCore): void {
  const handlers: Record<string, Handler> = {
    [IPC.appInfo]: async (): Promise<AppInfo> => ({
      version: app.getVersion(),
      jeffVersion: APP_VERSION,
      sidecarStatus: core.sidecar?.status ?? 'stopped',
      sidecarError: core.sidecar?.lastError || undefined,
      sidecarPort: core.sidecar?.port || undefined,
      opencodeBinary: core.sidecar?.resolveBinary() ?? null,
      opencodeVersion: (await core.sidecar?.version().catch(() => null)) ?? undefined,
      dataDir: core.paths.root,
    }),

    // ---------- agents ----------
    [IPC.agentsList]: async (): Promise<AgentInfo[]> =>
      core.agents.list().filter((a) => !a.archived).map(toAgentInfo),
    [IPC.agentsGet]: async (p): Promise<AgentInfo> => {
      const { id } = p as { id: string }
      const row = core.agents.get(id)
      if (!row) throw new Error('智能体不存在')
      return toAgentInfo(row)
    },
    [IPC.agentsUpsert]: async (p): Promise<AgentInfo> => {
      const d = p as { id?: string; name: string; avatar?: string; description?: string; instructions?: string; model_provider?: string; model_id?: string; thinking?: string }
      const patch = {
        name: d.name,
        avatar: d.avatar,
        description: d.description,
        instructions: d.instructions,
        model_provider: d.model_provider ?? '',
        model_id: d.model_id ?? '',
        thinking: (d.thinking ?? '') as ThinkingTier | '',
      }
      let row
      if (d.id === XIAOJIE_ID) {
        // 小杰可配模型/思考/指令外的一切（名称头像锁定），指令保持内置
        row = core.agents.update(XIAOJIE_ID, { model_provider: patch.model_provider, model_id: patch.model_id, thinking: patch.thinking, description: patch.description })
      } else if (d.id) {
        row = core.agents.update(d.id, patch)
      } else {
        row = core.agents.create(patch)
      }
      if (!row) throw new Error('保存失败')
      core.syncRegistry()
      core.markRegistryDirty()
      core.bus.emit('data-changed', 'agents')
      return toAgentInfo(row)
    },
    [IPC.agentsDelete]: async (p): Promise<{ ok: boolean }> => {
      const { id } = p as { id: string }
      if (id === XIAOJIE_ID) throw new Error('小杰是内置管家，不可删除')
      const ok = core.agents.softDelete(id)
      if (ok) {
        core.registry.remove(id)
        core.syncRegistry()
        core.markRegistryDirty()
        core.bus.emit('data-changed', 'agents')
      }
      return { ok }
    },

    // ---------- 私聊 ----------
    [IPC.chatHistory]: async (p): Promise<unknown> => {
      const { agentId } = p as { agentId: string }
      return core.privateChat.history(agentId)
    },
    [IPC.chatSend]: async (p): Promise<{ ok: boolean }> => {
      const { agentId, text, model, variant, images } = p as { agentId: string; text: string; model?: { providerID: string; modelID: string }; variant?: string; images?: Array<{ mime: string; dataUrl: string }> }
      const row = core.agents.get(agentId)
      if (!row) throw new Error('智能体不存在')
      await core.privateChat.send(agentId, row.name, text, model, images, variant || undefined)
      return { ok: true }
    },
    [IPC.chatNew]: async (p): Promise<{ sessionId: string }> => {
      const { agentId } = p as { agentId: string }
      const row = core.agents.get(agentId)
      if (!row) throw new Error('智能体不存在')
      const sessionId = await core.privateChat.newSession(agentId, row.name)
      return { sessionId }
    },
    [IPC.chatStop]: async (p): Promise<void> => {
      const { agentId } = p as { agentId: string }
      const sessionId = core.privateChat.getSessionId(agentId)
      if (sessionId) await core.oc.abortSession(sessionId)
    },

    // ---------- provider / 设置 ----------
    [IPC.providersList]: async () => ({
      providers: core.listProviders(),
    }),
    [IPC.providersSave]: async (p) => {
      const { providers } = p as { providers: InvokeMap[typeof IPC.providersSave]['providers'] }
      await core.saveProviders(providers)
      core.bus.emit('data-changed', 'settings')
      return { ok: true }
    },
    [IPC.providersCatalog]: async (): Promise<{ catalog: ProviderCatalogItem[] }> => {
      // v1.3：目录直接来自供应商配置（不再调 opencode 平台接口，避免冒出未添加的模型）
      const options = core.configuredModels()
      const byProvider = new Map<string, ProviderCatalogItem>()
      for (const o of options) {
        let item = byProvider.get(o.providerID)
        if (!item) {
          item = { id: o.providerID, name: o.providerName, models: [] }
          byProvider.set(o.providerID, item)
        }
        item.models.push({
          providerID: o.providerID,
          modelID: o.modelID,
          label: o.label,
          thinkingTiers: o.thinkingTiers as Array<'none' | 'low' | 'high' | 'max'>,
        })
      }
      return { catalog: Array.from(byProvider.values()) }
    },
    [IPC.modelsConfigured]: async () => ({ models: core.configuredModels() }),

    // ---------- 历史会话（聊天记录） ----------
    [IPC.sessionsList]: async (p) => {
      const d = p as { agentId?: string; projectId?: string }
      if (d.projectId) return { sessions: await core.listGroupSessions(d.projectId) }
      if (d.agentId) return { sessions: await core.listAgentSessions(d.agentId) }
      throw new Error('agentId 与 projectId 至少提供一个')
    },
    [IPC.sessionPreview]: async (p) => {
      const { sessionId } = p as { sessionId: string }
      return { messages: await core.previewSession(sessionId) }
    },
    [IPC.sessionActivate]: async (p) => {
      const d = p as { scope: 'private' | 'group'; agentId: string; projectId?: string; sessionId: string }
      core.activateSession(d.scope, d.agentId, d.sessionId, d.projectId)
      return { ok: true }
    },
    [IPC.sessionDelete]: async (p) => {
      const { sessionId } = p as { sessionId: string }
      await core.deleteSession(sessionId)
      return { ok: true }
    },
    [IPC.settingsGet]: async (): Promise<AppSettings> => {
      const kv = core.kv()
      return {
        theme: kv.getJSON<AppSettings['theme']>('settings:theme', 'system'),
        themePack: kv.getJSON<AppSettings['themePack']>('settings:themePack', 'weui'),
        defaultModel: core.defaultModel(),
        webdav: kv.getJSON<AppSettings['webdav']>('settings:webdav', null) ?? undefined,
      }
    },
    [IPC.settingsSet]: async (p) => {
      const { theme, themePack } = p as { theme?: AppSettings['theme']; themePack?: AppSettings['themePack'] }
      let changed = false
      if (theme) {
        core.kv().setJSON('settings:theme', theme)
        nativeTheme.themeSource = theme
        changed = true
      }
      if (themePack) {
        core.kv().setJSON('settings:themePack', themePack)
        changed = true
      }
      if (changed) core.bus.emit('data-changed', 'settings')
      return { ok: true }
    },

    // ---------- WebDAV 同步 ----------
    [IPC.syncConfigure]: async (p): Promise<{ ok: boolean }> => {
      const d = p as { url: string; username: string; password: string; basePath: string; autoSync: boolean }
      if (!d.url || !d.basePath) throw new Error('url 与 basePath 必填')
      await core.configureSync({ url: d.url.replace(/\/+$/, ''), username: d.username || '', password: d.password || '', basePath: d.basePath, autoSync: !!d.autoSync })
      return { ok: true }
    },
    [IPC.syncNow]: async (): Promise<unknown> => core.syncNow(),
    [IPC.syncStatus]: async (): Promise<{ config: unknown; report: unknown }> => ({
      config: core.syncConfig(),
      report: core.lastSyncReport,
    }),

    // ---------- MCP 连接器 ----------
    [IPC.mcpList]: async (): Promise<Record<string, import('@jeff/core').McpServerCfg>> => core.listMcp(),
    [IPC.mcpSave]: async (p): Promise<{ ok: boolean }> => {
      const d = p as { servers: Record<string, import('@jeff/core').McpServerCfg> }
      await core.saveMcp(d.servers)
      core.bus.emit('data-changed', 'settings')
      return { ok: true }
    },
    [IPC.mcpProbe]: async (): Promise<Record<string, import('@jeff/core').McpProbeResult>> => {
      const raw = await core.probeMcp()
      const out: Record<string, import('@jeff/core').McpProbeResult> = {}
      for (const [name, r] of Object.entries(raw)) {
        out[name] = {
          name,
          status: r.ok ? 'ok' : 'error',
          tools: r.tools || [],
          toolCount: (r.tools || []).length,
          error: r.error,
        }
      }
      return out
    },

    // ---------- AGENTS.md ----------
    [IPC.agentsMdList]: async () => core.agentsMdList(),
    [IPC.agentsMdGet]: async (p): Promise<{ content: string; file: string }> => {
      const d = p as { kind: 'user' | 'project'; id: string }
      return core.agentsMdGet(d.kind, d.id)
    },
    [IPC.agentsMdSave]: async (p): Promise<{ ok: boolean }> => {
      const d = p as { kind: 'user' | 'project'; id: string; content: string }
      core.agentsMdSave(d.kind, d.id, d.content)
      return { ok: true }
    },

    // ---------- 引擎服务 ----------
    [IPC.sidecarRestart]: async (): Promise<{ ok: boolean }> => {
      await core.restartSidecar()
      return { ok: true }
    },
    [IPC.sidecarLogs]: async (): Promise<{ lines: string[] }> => ({ lines: getSidecarLogs() }),
    [IPC.dialogPickDir]: async (p): Promise<string | null> => {
      const d = p as { title?: string; defaultPath?: string }
      const win = getMainWindow()
      if (!win) return null
      const r = await dialog.showOpenDialog(win, { title: d.title || '选择目录', defaultPath: d.defaultPath, properties: ['openDirectory', 'createDirectory'] })
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
    },

    // ---------- skills 备份/恢复 ----------
    [IPC.skillsBackupNow]: async () => core.skillsBackupNow(),
    [IPC.skillsLast]: async () => core.lastSkillsBackup(),
    [IPC.skillsRestoreStage]: async () => core.skillsRestoreStage(),
    [IPC.skillsRestoreApply]: async () => core.skillsRestoreApply(),

    // ---------- 记忆管理 ----------
    [IPC.memoryScopes]: async (): Promise<MemoryScopeInfo[]> => {
      const out: MemoryScopeInfo[] = [{ kind: 'user', id: 'user', label: '全局用户画像', file: core.memory.file({ kind: 'user' }) }]
      for (const a of agentRepo(core.db).list()) {
        if (a.builtin) continue
        out.push({ kind: 'agent', id: a.id, label: `${a.avatar} ${a.name}`, file: core.memory.file({ kind: 'agent', agentId: a.id }) })
      }
      for (const pr of projectRepo(core.db).list()) {
        out.push({ kind: 'project', id: pr.id, label: `${pr.icon} ${pr.title}`, file: core.memory.file({ kind: 'project', projectId: pr.id }) })
      }
      return out
    },
    [IPC.memoryGet]: async (p): Promise<{ content: string; label: string; budget: number }> => {
      const d = p as { kind: 'user' | 'agent' | 'project'; id: string }
      const scope = d.kind === 'user' ? ({ kind: 'user' } as const) : d.kind === 'agent' ? ({ kind: 'agent', agentId: d.id } as const) : ({ kind: 'project', projectId: d.id } as const)
      const budget = d.kind === 'user' ? 1375 : d.kind === 'agent' ? 2200 : 2200
      return { content: core.memory.list(scope).join('\n§\n'), label: core.memory.label(scope), budget }
    },
    [IPC.memorySave]: async (p): Promise<{ ok: boolean }> => {
      const d = p as { kind: 'user' | 'agent' | 'project'; id: string; content: string }
      const scope = d.kind === 'user' ? ({ kind: 'user' } as const) : d.kind === 'agent' ? ({ kind: 'agent', agentId: d.id } as const) : ({ kind: 'project', projectId: d.id } as const)
      core.memory.writeRaw(scope, d.content)
      return { ok: true }
    },

    // ---------- 项目群 ----------
    [IPC.projectsList]: async (): Promise<ProjectInfo[]> => {
      const projects = projectRepo(core.db).list()
      return projects.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        icon: p.icon,
        status: p.status,
        leader_agent_id: p.leader_agent_id,
        workspace_dir: p.workspace_dir || '',
        updated_at: p.updated_at,
        memberCount: projectAgentRepo(core.db).listByProject(p.id).length,
      }))
    },
    [IPC.projectSave]: async (p): Promise<ProjectInfo> => {
      const d = p as { id?: string; title: string; description?: string; icon?: string; leader_agent_id?: string | null; memberAgentIds?: string[]; workspace_dir?: string }
      if (!d.leader_agent_id) throw new Error('必须选择群主（leader）')
      if (d.id) {
        const row = projectRepo(core.db).update(d.id, { title: d.title, description: d.description, icon: d.icon, leader_agent_id: d.leader_agent_id, ...(d.workspace_dir !== undefined ? { workspace_dir: d.workspace_dir } : {}) })
        if (!row) throw new Error('项目不存在')
        projectAgentRepo(core.db).add(d.id, d.leader_agent_id, 'leader', 0)
        for (const mid of d.memberAgentIds || []) {
          if (mid !== d.leader_agent_id) projectAgentRepo(core.db).add(d.id, mid, 'worker')
        }
      } else {
        const row = projectRepo(core.db).create({ title: d.title, description: d.description, icon: d.icon, leader_agent_id: d.leader_agent_id, workspace_dir: d.workspace_dir || '' })
        projectAgentRepo(core.db).add(row.id, d.leader_agent_id, 'leader', 0)
        for (const mid of d.memberAgentIds || []) {
          if (mid !== d.leader_agent_id) projectAgentRepo(core.db).add(row.id, mid, 'worker')
        }
      }
      core.bus.emit('data-changed', 'projects')
      const row = projectRepo(core.db).list().find((x) => x.title === d.title)!
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        icon: row.icon,
        status: row.status,
        leader_agent_id: row.leader_agent_id,
        workspace_dir: row.workspace_dir || '',
        updated_at: row.updated_at,
        memberCount: projectAgentRepo(core.db).listByProject(row.id).length,
      }
    },
    [IPC.projectDelete]: async (p): Promise<{ ok: boolean }> => {
      const { id } = p as { id: string }
      const ok = projectRepo(core.db).softDelete(id)
      core.bus.emit('data-changed', 'projects')
      return { ok }
    },
    [IPC.projectMembers]: async (p): Promise<ProjectMember[]> => {
      const { projectId } = p as { projectId: string }
      return projectAgentRepo(core.db).listByProject(projectId).map((m) => {
        const a = agentRepo(core.db).get(m.agent_id)
        return { agent_id: m.agent_id, role: m.role, name: a?.name || m.agent_id, avatar: a?.avatar || '🤖' }
      })
    },
    [IPC.projectAddMember]: async (p): Promise<{ ok: boolean }> => {
      const { projectId, agentId } = p as { projectId: string; agentId: string }
      projectAgentRepo(core.db).add(projectId, agentId, 'worker')
      core.bus.emit('data-changed', 'projects')
      return { ok: true }
    },
    [IPC.projectRemoveMember]: async (p): Promise<{ ok: boolean }> => {
      const { projectId, agentId } = p as { projectId: string; agentId: string }
      const project = projectRepo(core.db).get(projectId)
      if (project?.leader_agent_id === agentId) throw new Error('不能移除群主；请先改群主')
      projectAgentRepo(core.db).remove(projectId, agentId)
      core.bus.emit('data-changed', 'projects')
      return { ok: true }
    },

    // ---------- 任务 ----------
    [IPC.tasksList]: async (p): Promise<TaskInfo[]> => {
      const { projectId } = p as { projectId: string }
      return taskRepo(core.db).listByProject(projectId).map(toTaskInfo)
    },
    [IPC.taskSave]: async (p): Promise<TaskInfo> => {
      const d = p as { id?: string; project_id: string; title: string; description?: string; status?: string; priority?: string; assignee_id?: string }
      let row
      if (d.id) {
        row = taskRepo(core.db).update(d.id, {
          title: d.title,
          description: d.description,
          status: d.status,
          priority: d.priority,
          ...(d.assignee_id !== undefined ? { assignee_type: d.assignee_id ? 'agent' : 'none', assignee_id: d.assignee_id } : {}),
        })
      } else {
        row = taskRepo(core.db).create({
          project_id: d.project_id,
          title: d.title,
          description: d.description,
          status: d.status,
          priority: d.priority,
          assignee_type: d.assignee_id ? 'agent' : 'none',
          assignee_id: d.assignee_id || '',
        })
      }
      if (!row) throw new Error('任务保存失败')
      const card = taskCardMessage(core.db, row.project_id, row.id)
      if (card.content) core.groupChat.addSystemMessage(row.project_id, card.content, card.meta)
      core.bus.emit('data-changed', 'tasks')
      core.bus.emit('group-updated', { projectId: row.project_id })
      return toTaskInfo(row)
    },
    [IPC.taskDelete]: async (p): Promise<{ ok: boolean }> => {
      const { id } = p as { id: string }
      const cur = taskRepo(core.db).get(id)
      const ok = cur ? taskRepo(core.db).softDelete(id) : false
      if (cur) {
        core.bus.emit('data-changed', 'tasks')
        core.bus.emit('group-updated', { projectId: cur.project_id })
      }
      return { ok }
    },

    // ---------- 群聊 ----------
    [IPC.groupHistory]: async (p): Promise<unknown> => {
      const { projectId } = p as { projectId: string }
      return core.groupChat.history(projectId)
    },
    [IPC.groupSend]: async (p): Promise<{ routedTo: string }> => {
      const { projectId, text, model, variant, images } = p as { projectId: string; text: string; model?: { providerID: string; modelID: string }; variant?: string; images?: Array<{ mime: string; dataUrl: string }> }
      return core.groupChat.send({ projectId, text, model, variant: variant || undefined, images })
    },
    [IPC.groupStop]: async (p): Promise<{ ok: boolean }> => {
      const { projectId } = p as { projectId: string }
      await core.abortGroup(projectId)
      return { ok: true }
    },
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(`jeff:${channel}`, (_evt, payload) => handler(payload))
  }

  // 冒烟钩子（JEFF_SMOKE=1）：渲染层逐视图驱动截图后退出
  if (process.env.JEFF_SMOKE === '1') {
    let seq = 0
    handlers[IPC.smokeShot] = async (p) => {
      const { name } = p as { name: string }
      const win = getMainWindow()
      if (win) {
        const image = await win.webContents.capturePage()
        const dir = process.env.JEFF_SMOKE_OUT_DIR || path.join(app.getPath('temp'), 'jeff-smoke')
        fs.mkdirSync(dir, { recursive: true })
        seq += 1
        const file = path.join(dir, `${String(seq).padStart(2, '0')}-${name}.png`)
        fs.writeFileSync(file, image.toPNG())
        console.log(`[jeff-smoke] screenshot saved: ${file}`)
      }
      return { ok: true }
    }
    handlers[IPC.smokeDone] = async () => {
      setTimeout(() => app.exit(0), 300)
      return { ok: true }
    }
    for (const channel of [IPC.smokeShot, IPC.smokeDone]) {
      const handler = handlers[channel]
      ipcMain.handle(`jeff:${channel}`, (_evt, payload) => handler(payload))
    }
  }
}

export function toAgentInfo(row: import('@jeff/core').AgentRow): AgentInfo {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    description: row.description,
    instructions: row.instructions,
    model_provider: row.model_provider,
    model_id: row.model_id,
    thinking: row.thinking || '',
    builtin: !!row.builtin,
    archived: !!row.archived,
  }
}

function toTaskInfo(row: TaskRow): TaskInfo {
  return {
    id: row.id,
    project_id: row.project_id,
    number: row.number,
    key: `JEF-${row.number}`,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignee_type: row.assignee_type,
    assignee_id: row.assignee_id,
    parent_task_id: row.parent_task_id,
  }
}
