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
import { IPC, XIAOJIE_ID } from '@jeff/core'
import type { JeffCore } from '@jeff/core'

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
