import { app, ipcMain, nativeTheme } from 'electron'
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
import { IPC, XIAOJIE_ID, agentRepo, projectRepo, projectAgentRepo, taskRepo, taskCardMessage } from '@jeff/core'
import type { JeffCore, TaskRow } from '@jeff/core'

type Handler = (payload: unknown) => Promise<unknown>

/**
 * 注册全部 IPC handler：渲染进程 invoke('jeff:<channel>') → core 调用。
 */
export function registerIpc(core: JeffCore): void {
  const handlers: Record<string, Handler> = {
    [IPC.appInfo]: async (): Promise<AppInfo> => ({
      version: app.getVersion(),
      jeffVersion: '0.1.0',
      sidecarStatus: core.sidecar?.status ?? 'stopped',
      opencodeBinary: core.sidecar?.resolveBinary() ?? null,
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
      const d = p as { id?: string; name: string; avatar?: string; description?: string; instructions?: string; model_provider?: string; model_id?: string }
      if (d.id === XIAOJIE_ID) throw new Error('小杰是内置管家，不可编辑')
      const row = d.id
        ? core.agents.update(d.id, { name: d.name, avatar: d.avatar, description: d.description, instructions: d.instructions, model_provider: d.model_provider ?? '', model_id: d.model_id ?? '' })
        : core.agents.create({ name: d.name, avatar: d.avatar, description: d.description, instructions: d.instructions, model_provider: d.model_provider, model_id: d.model_id })
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
      const row = core.agents.get(agentId)
      return core.privateChat.history(agentId)
    },
    [IPC.chatSend]: async (p): Promise<{ ok: boolean }> => {
      const { agentId, text, model } = p as { agentId: string; text: string; model?: { providerID: string; modelID: string } }
      const row = core.agents.get(agentId)
      if (!row) throw new Error('智能体不存在')
      await core.privateChat.send(agentId, row.name, text, model)
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
      defaultModel: core.defaultModel(),
    }),
    [IPC.providersSave]: async (p) => {
      const { providers, defaultModel } = p as { providers: InvokeMap[typeof IPC.providersSave]['providers']; defaultModel?: { providerID: string; modelID: string } | null }
      await core.saveProviders(providers, defaultModel)
      core.bus.emit('data-changed', 'settings')
      return { ok: true }
    },
    [IPC.providersCatalog]: async (): Promise<{ catalog: ProviderCatalogItem[] }> => {
      const providers = await core.oc.listProviders()
      const catalog: ProviderCatalogItem[] = providers.map((pv) => ({
        id: pv.id,
        name: pv.name || pv.id,
        models: Object.keys(pv.models || {}).map((mid) => ({ providerID: pv.id, modelID: mid, label: `${pv.name || pv.id} / ${mid}` })),
      }))
      return { catalog }
    },
    [IPC.modelsDefault]: async (p) => {
      const { defaultModel } = p as { defaultModel?: { providerID: string; modelID: string } | null }
      core.kv().setJSON('settings:defaultModel', defaultModel ?? null)
      return { ok: true }
    },
    [IPC.settingsGet]: async (): Promise<AppSettings> => {
      const kv = core.kv()
      return {
        theme: kv.getJSON<AppSettings['theme']>('settings:theme', 'system'),
        defaultModel: core.defaultModel(),
        webdav: kv.getJSON<AppSettings['webdav']>('settings:webdav', null) ?? undefined,
      }
    },
    [IPC.settingsSet]: async (p) => {
      const { theme } = p as { theme?: AppSettings['theme'] }
      if (theme) {
        core.kv().setJSON('settings:theme', theme)
        nativeTheme.themeSource = theme
      }
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
        updated_at: p.updated_at,
        memberCount: projectAgentRepo(core.db).listByProject(p.id).length,
      }))
    },
    [IPC.projectSave]: async (p): Promise<ProjectInfo> => {
      const d = p as { id?: string; title: string; description?: string; icon?: string; leader_agent_id?: string | null; memberAgentIds?: string[] }
      if (!d.leader_agent_id) throw new Error('必须选择群主（leader）')
      if (d.id) {
        const row = projectRepo(core.db).update(d.id, { title: d.title, description: d.description, icon: d.icon, leader_agent_id: d.leader_agent_id })
        if (!row) throw new Error('项目不存在')
        projectAgentRepo(core.db).add(d.id, d.leader_agent_id, 'leader', 0)
        for (const mid of d.memberAgentIds || []) {
          if (mid !== d.leader_agent_id) projectAgentRepo(core.db).add(d.id, mid, 'member')
        }
      } else {
        const row = projectRepo(core.db).create({ title: d.title, description: d.description, icon: d.icon, leader_agent_id: d.leader_agent_id })
        projectAgentRepo(core.db).add(row.id, d.leader_agent_id, 'leader', 0)
        for (const mid of d.memberAgentIds || []) {
          if (mid !== d.leader_agent_id) projectAgentRepo(core.db).add(row.id, mid, 'member')
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
      const { projectId, agentId, role } = p as { projectId: string; agentId: string; role?: string }
      projectAgentRepo(core.db).add(projectId, agentId, role || 'member')
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
      const { projectId, text, model } = p as { projectId: string; text: string; model?: { providerID: string; modelID: string } }
      return core.groupChat.send({ projectId, text, model })
    },
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(`jeff:${channel}`, (_evt, payload) => handler(payload))
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
