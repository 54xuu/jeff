import { app, ipcMain, nativeTheme, dialog, shell, webContents, nativeImage } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
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
  FileNode,
  SiYuanConfigInfo,
  SiYuanNotebook,
  SiYuanSearchResult,
  SiYuanTarget,
} from '@jeff/core'
import {
  IPC, XIAOJIE_ID, engineId, agentRepo, projectRepo, projectAgentRepo, taskRepo, taskCardMessage, snapshotInstructions, APP_VERSION,
  PrivateChatStoppedError, BrowserHandoffPausedError, resolveSendText, resolveScreenshotScale,
  type ThinkingTier, type ChatPluginInvoke, type RemoteStatus,
} from '@jeff/core'
import { listDirs, makeDir } from '../../../../packages/core/src/remote/dirs.js'
import type { MemoryScopeInfo } from '@jeff/core'
import type { JeffCore, TaskRow } from '@jeff/core'
import { getMainWindow, getSidecarLogs, showDesktopNotification, setBrowserResult, setBrowserState } from './index.js'
import { getSiYuanConfig, getSiYuanTarget, listSiYuanDocuments, listSiYuanNotebooks, saveSiYuanConfig, saveSiYuanTarget, searchSiYuan, siYuanClient } from './siyuan.js'

type Handler = (payload: unknown) => Promise<unknown>

/** 从 PNG 字节里读实际像素尺寸（IHDR）——用来核对「截图拿到的尺寸就是请求的尺寸」 */
function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('截图返回的不是 PNG 数据')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * 注册全部 IPC handler：渲染进程 invoke('jeff:<channel>') → core 调用。
 */
export function registerIpc(core: JeffCore): Record<string, Handler> {
  const handlers: Record<string, Handler> = {
    [IPC.enginesList]: async () => {
      // The window may be created while the first sidecar launch is still recovering.
      // Do not turn that brief startup window into an opaque TypeError in Settings.
      const client = core.oc
      if (!client) throw new Error('引擎服务正在初始化，请稍后重试')
      const engines = await client.engines()
      const oc = engines.find((engine) => engine.id === 'opencode')!
      oc.path = core.sidecar.resolveBinary(); oc.available = core.sidecar.status === 'running'
      oc.version = (await core.sidecar.version().catch(() => undefined)) || undefined
      return engines
    },
    [IPC.enginesProbe]: async (p) => core.oc.probe(engineId((p as { engine: string }).engine)),
    [IPC.enginesModels]: async (p) => core.oc.models(engineId((p as { engine: string }).engine)),
    [IPC.enginesPathSave]: async (p) => { const d = p as { engine: string; path: string }; return core.oc.savePath(engineId(d.engine), d.path) },
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
      const d = p as { id?: string; name: string; avatar?: string; description?: string; instructions?: string; model_provider?: string; model_id?: string; thinking?: string; category?: string; execution_engine?: import('@jeff/core').EngineId; engine_model?: string }
      const previous = d.id ? core.agents.get(d.id) : undefined
      if (previous && d.execution_engine && d.execution_engine !== (previous.execution_engine || 'opencode') && core.oc.hasInflight()) throw new Error('请等待当前任务完成后再切换执行引擎')
      const patch = {
        execution_engine: engineId(d.execution_engine ?? previous?.execution_engine ?? 'opencode'),
        engine_model: d.engine_model ?? previous?.engine_model ?? '',
        name: d.name,
        avatar: d.avatar,
        description: d.description,
        instructions: d.instructions,
        model_provider: d.model_provider ?? '',
        model_id: d.model_id ?? '',
        thinking: (d.thinking ?? '') as ThinkingTier | '',
        category: (d.category ?? '').trim(),
      }
      let row
      if (d.id === XIAOJIE_ID) {
        // 小杰固定名称/头像；个人简介、个人 Prompt 与引擎配置可由用户维护。
        const current = core.agents.get(XIAOJIE_ID)
        if (current && typeof d.instructions === 'string' && d.instructions !== current.instructions) snapshotInstructions(core.paths, XIAOJIE_ID, current.instructions)
        row = core.agents.update(XIAOJIE_ID, {
          execution_engine: patch.execution_engine,
          engine_model: patch.engine_model,
          model_provider: patch.model_provider,
          model_id: patch.model_id,
          thinking: patch.thinking,
          description: patch.description,
          instructions: patch.instructions,
          category: patch.category,
        })
      } else if (d.id) {
        // 改身份指令前先快照旧文本（与自改工具、小杰的 jeff_agent_update 共用同一份回滚历史）
        const cur = core.agents.get(d.id)
        if (cur && typeof d.instructions === 'string' && d.instructions !== cur.instructions) {
          snapshotInstructions(core.paths, d.id, cur.instructions)
        }
        row = core.agents.update(d.id, patch)
      } else {
        row = core.agents.create(patch)
      }
      if (!row) throw new Error('保存失败')
      if (previous && previous.execution_engine !== row.execution_engine) {
        core.kv().delete(`session:private:${row.id}`)
        const keys = core.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'session:%'").all() as Array<{ key: string; value: string }>
        for (const entry of keys) {
          const meta = core.resolveSession(entry.value)
          if (meta?.agentId === row.id) core.kv().delete(entry.key)
        }
      }
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
      const { agentId, limit } = p as { agentId: string; limit?: number }
      return core.privateChat.history(agentId, limit)
    },
    [IPC.chatSend]: async (p): Promise<{ ok: boolean; stopped?: boolean; cancelled?: boolean; waitingBrowser?: boolean }> => {
      const { agentId, text, images, plugin } = p as { agentId: string; text: string; images?: Array<{ mime: string; dataUrl: string }>; plugin?: ChatPluginInvoke }
      const row = core.agents.get(agentId)
      if (!row) throw new Error('智能体不存在')
      // 模型/思考由智能体资料决定，忽略前端覆盖
      try {
        await core.privateChat.send(agentId, row.name, resolveSendText(text, plugin), undefined, images)
        return { ok: true }
      } catch (err) {
        if (err instanceof BrowserHandoffPausedError) return { ok: true, waitingBrowser: true }
        // 用户主动停止是预期结果：返回 stopped，UI 不弹「发送失败」
        // cancelled=true 表示请求从未发出（引擎历史里没有这条用户消息），界面需保留本地记录
        if (err instanceof PrivateChatStoppedError) return { ok: true, stopped: true, cancelled: err.cancelled }
        throw err
      }
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
      // 会话未建好时停止请求要记成「意图」而不是丢弃（见 PrivateChat.stop）
      const r = await core.privateChat.stop(agentId)
      core.debugLog.log('chat-stop-req', { agentId, sessionId: r.sessionId, deferred: r.deferred })
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
          ...(o.contextLimit ? { contextLimit: o.contextLimit } : {}),
          thinkingTiers: o.thinkingTiers as Array<'none' | 'low' | 'high' | 'max'>,
        })
      }
      return { catalog: Array.from(byProvider.values()) }
    },
    [IPC.modelsConfigured]: async () => ({ models: core.configuredModels() }),
    [IPC.providersProbe]: async (p): Promise<import('@jeff/core').ProviderProbeResult> => {
      const { provider, modelId } = p as { provider: import('@jeff/core').ProviderSetting; modelId: string }
      return core.probeProvider(provider, modelId)
    },

    // ---------- 历史会话（聊天记录） ----------
    [IPC.sessionsList]: async (p) => {
      const d = p as { agentId?: string; projectId?: string }
      // 群侧改用 groupThreadsList；此处仅私聊
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
    [IPC.sessionRename]: async (p) => {
      const d = p as { sessionId: string; title: string }
      return core.renameSession(d.sessionId, d.title)
    },
    [IPC.groupThreadsList]: async (p) => {
      const { projectId } = p as { projectId: string }
      return { threads: core.listGroupThreads(projectId) }
    },
    [IPC.groupThreadNew]: async (p) => {
      const d = p as { projectId: string; title?: string }
      const r = core.newGroupThread(d.projectId, d.title)
      core.bus.emit('group-updated', { projectId: d.projectId })
      return r
    },
    [IPC.groupThreadActivate]: async (p) => {
      const d = p as { projectId: string; threadId: string }
      core.activateGroupThread(d.projectId, d.threadId)
      core.bus.emit('group-updated', { projectId: d.projectId })
      return { ok: true }
    },
    [IPC.groupThreadRename]: async (p) => {
      const d = p as { projectId: string; threadId: string; title: string }
      return core.renameGroupThread(d.projectId, d.threadId, d.title)
    },
    [IPC.groupThreadDelete]: async (p) => {
      const d = p as { projectId: string; threadId: string }
      await core.deleteGroupThread(d.projectId, d.threadId)
      core.bus.emit('group-updated', { projectId: d.projectId })
      return { ok: true }
    },
    [IPC.groupThreadPreview]: async (p) => {
      const d = p as { projectId: string; threadId: string }
      return { messages: core.previewGroupThread(d.projectId, d.threadId) }
    },
    [IPC.settingsGet]: async (): Promise<AppSettings> => {
      const kv = core.kv()
      return {
        theme: kv.getJSON<AppSettings['theme']>('settings:theme', 'system'),
        themePack: kv.getJSON<AppSettings['themePack']>('settings:themePack', 'cue'),
        // 提醒类开关默认全开：新装用户开箱即有提醒
        notifyDesktop: kv.getJSON<boolean>('settings:notifyDesktop', true),
        notifySound: kv.getJSON<boolean>('settings:notifySound', true),
        notifyOnlyBackground: kv.getJSON<boolean>('settings:notifyOnlyBackground', true),
        defaultModel: core.defaultModel(),
        webdav: kv.getJSON<AppSettings['webdav']>('settings:webdav', null) ?? undefined,
      }
    },
    [IPC.settingsSet]: async (p) => {
      const { theme, themePack, notifyDesktop, notifySound, notifyOnlyBackground } = p as Partial<AppSettings>
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
      // 提醒开关是布尔值，用 typeof 判断而不是真值判断：关掉（false）也必须落库
      if (typeof notifyDesktop === 'boolean') {
        core.kv().setJSON('settings:notifyDesktop', notifyDesktop)
        changed = true
      }
      if (typeof notifySound === 'boolean') {
        core.kv().setJSON('settings:notifySound', notifySound)
        changed = true
      }
      if (typeof notifyOnlyBackground === 'boolean') {
        core.kv().setJSON('settings:notifyOnlyBackground', notifyOnlyBackground)
        changed = true
      }
      if (changed) core.bus.emit('data-changed', 'settings')
      return { ok: true }
    },
    [IPC.notifyDesktop]: async (p) => {
      const d = p as { title: string; body?: string; kind?: 'agent' | 'group'; id?: string }
      return showDesktopNotification(d)
    },

    // ---------- WebDAV 同步 ----------
    [IPC.syncConfigure]: async (p): Promise<{ ok: boolean }> => {
      const d = p as {
        url: string
        username: string
        password: string
        basePath: string
        autoSync: boolean
        timeoutMs?: number
        tlsVerify?: boolean
      }
      if (!d.url || !d.basePath) throw new Error('url 与 basePath 必填')
      await core.configureSync({
        url: d.url.replace(/\/+$/, ''),
        username: d.username || '',
        password: d.password || '',
        basePath: d.basePath,
        autoSync: !!d.autoSync,
        timeoutMs: typeof d.timeoutMs === 'number' && d.timeoutMs > 0 ? d.timeoutMs : 60_000,
        tlsVerify: d.tlsVerify !== false,
      })
      return { ok: true }
    },
    [IPC.syncNow]: async (): Promise<unknown> => core.syncNow(),
    [IPC.syncStatus]: async (): Promise<{ config: unknown; report: unknown }> => ({
      config: core.syncConfig(),
      report: core.lastSyncReport,
    }),

    // ---------- 对话上下文 ----------
    [IPC.contextPreview]: async (p) => {
      const d = p as { agentId: string; projectId?: string; model?: { providerID: string; modelID: string } }
      if (!d.agentId) throw new Error('agentId 必填')
      return core.contextPreview(d)
    },
    [IPC.contextPromptDetails]: async (p) => {
      const d = p as { agentId: string; projectId?: string }
      if (!d.agentId) throw new Error('agentId 必填')
      return core.contextPromptDetails(d)
    },
    [IPC.contextCompress]: async (p) => {
      const d = p as { agentId: string; projectId?: string; model?: { providerID: string; modelID: string } }
      if (!d.agentId) throw new Error('agentId 必填')
      return core.contextCompress(d)
    },

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
          status: r.error === '已停用' ? 'disabled' : r.ok ? 'ok' : 'error',
          tools: r.tools || [],
          toolCount: (r.tools || []).length,
          error: r.error,
          elapsedMs: r.elapsedMs,
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
    [IPC.llmTlsGet]: async (): Promise<{ skipVerify: boolean }> => core.llmTlsConfig(),
    [IPC.llmTlsSet]: async (p): Promise<{ ok: boolean }> => {
      const { skip } = p as { skip: boolean }
      await core.setLlmTlsSkip(!!skip)
      core.bus.emit('data-changed', 'settings')
      return { ok: true }
    },
    [IPC.debugLogGet]: async (): Promise<{ enabled: boolean }> => core.debugLogConfig(),
    [IPC.debugLogSet]: async (p): Promise<{ ok: boolean }> => {
      const { enabled } = p as { enabled: boolean }
      core.setDebugLog(!!enabled)
      core.bus.emit('data-changed', 'settings')
      return { ok: true }
    },
    [IPC.debugLogOpenDir]: async (): Promise<{ ok: boolean; dir: string }> => {
      const dir = core.paths.logDir
      fs.mkdirSync(dir, { recursive: true })
      const { shell } = await import('electron')
      const err = await shell.openPath(dir)
      if (err) throw new Error(err)
      return { ok: true, dir }
    },
    [IPC.dialogPickDir]: async (p): Promise<string | null> => {
      const d = p as { title?: string; defaultPath?: string }
      const win = getMainWindow()
      if (!win) return null
      const r = await dialog.showOpenDialog(win, { title: d.title || '选择目录', defaultPath: d.defaultPath, properties: ['openDirectory', 'createDirectory'] })
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
    },

    // ---------- 工作空间文件浏览 ----------
    [IPC.fsListFiles]: async (p): Promise<{ dir: string; exists: boolean; nodes: FileNode[] }> => {
      const { dir } = p as { dir: string }
      return listFileTree(dir)
    },
    [IPC.fsReadFile]: async (p): Promise<{ file: string; content: string; size: number; truncated: boolean }> => {
      const { file } = p as { file: string }
      return readTextFile(file)
    },
    [IPC.fsOpenPath]: async (p): Promise<{ ok: boolean }> => {
      const { target, reveal } = p as { target: string; reveal?: boolean }
      const { shell } = await import('electron')
      if (reveal) {
        shell.showItemInFolder(target)
        return { ok: true }
      }
      const err = await shell.openPath(target)
      if (err) throw new Error(err)
      return { ok: true }
    },
    [IPC.fsListDirs]: async (p) => {
      const { dir } = (p || {}) as { dir?: string }
      return listDirs(dir)
    },
    [IPC.fsMkdir]: async (p) => {
      const { dir } = p as { dir: string }
      if (!dir) throw new Error('缺少目录')
      return { ok: true, dir: makeDir(dir) }
    },
    [IPC.remoteStatus]: async (): Promise<RemoteStatus> => ({
      connected: false,
      desktopId: '',
      desktopName: '',
      bound: null,
      openAtLogin: false,
      preventSleep: true,
      pairing: null,
    }),
    [IPC.remotePairStart]: async () => {
      throw new Error('远程控制还没启动')
    },
    [IPC.remotePairConfirm]: async () => ({ ok: true }),
    [IPC.remoteUnbind]: async () => ({ ok: true }),
    [IPC.remoteSettings]: async () => ({ ok: true }),
    [IPC.remoteFocus]: async () => ({ ok: true }),
    [IPC.remoteReconnect]: async () => ({ ok: true }),

    // ---------- skills 备份/恢复 ----------
    [IPC.skillsBackupNow]: async () => core.skillsBackupNow(),
    [IPC.skillsLast]: async () => core.lastSkillsBackup(),
    [IPC.skillsRestoreStage]: async () => core.skillsRestoreStage(),
    [IPC.skillsRestoreApply]: async () => core.skillsRestoreApply(),

    // ---------- 记忆管理 ----------
    [IPC.memoryScopes]: async (): Promise<MemoryScopeInfo[]> => {
      const out: MemoryScopeInfo[] = [{ kind: 'user', id: 'user', label: '全局用户画像', file: core.memory.file({ kind: 'user' }) }]
      for (const a of agentRepo(core.db).list()) {
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
      core.bus.emit('data-changed', 'memory')
      return { ok: true }
    },

    // ---------- 项目群 ----------
    [IPC.projectsList]: async (): Promise<ProjectInfo[]> => {
      const projects = projectRepo(core.db).list()
      return projects.map((p) => toProjectInfo(core, p))
    },
    [IPC.projectSave]: async (p): Promise<ProjectInfo> => {
      const d = p as { id?: string; title: string; description?: string; system_prompt?: string; icon?: string; leader_agent_id?: string | null; memberAgentIds?: string[]; memberConfigs?: Array<{ agent_id: string; duties?: string; model_override?: string | null; thinking_override?: string | null }>; workspace_dir?: string; siyuan_notebook_id?: string; siyuan_parent_doc_id?: string }
      if (!d.leader_agent_id) throw new Error('必须选择群主（leader）')
      // 成员快照语义：memberAgentIds 是完整集合，群主自动并入
      const existingMemberIds = d.id ? projectAgentRepo(core.db).listByProject(d.id).map((member) => member.agent_id) : []
      // 不带成员快照的项目资料更新（如移动端改工作区）必须保留现有成员。
      const memberIds = Array.from(new Set([...(d.memberAgentIds ?? existingMemberIds), d.leader_agent_id]))
      for (const mid of memberIds) {
        const a = agentRepo(core.db).get(mid)
        if (!a || a.deleted_at) throw new Error(`成员智能体不存在或已删除: ${mid}`)
      }
      const normalizedMemberConfigs = (d.memberConfigs || []).map((config) => {
        if (!memberIds.includes(config.agent_id)) throw new Error(`成员配置对象不属于本群: ${config.agent_id}`)
        const patch: { duties?: string; model_override?: string | null; thinking_override?: string | null } = {}
        if (config.duties !== undefined) {
          if (config.duties.length > 12000) throw new Error('成员职责不能超过 12000 个字符')
          patch.duties = config.duties
        }
        if (config.model_override !== undefined) {
          const model = config.model_override?.trim() || null
          if (model && model.length > 500) throw new Error('模型覆盖不能超过 500 个字符')
          patch.model_override = model
        }
        if (config.thinking_override !== undefined) {
          const thinking = config.thinking_override?.trim() || null
          if (thinking && !['none', 'low', 'medium', 'high', 'max'].includes(thinking)) throw new Error('不支持的思考程度')
          patch.thinking_override = thinking
        }
        return { agent_id: config.agent_id, patch }
      })
      const currentProject = d.id ? projectRepo(core.db).get(d.id) : undefined
      if ((d.siyuan_notebook_id !== undefined || d.siyuan_parent_doc_id !== undefined) && (d.siyuan_notebook_id?.trim() || d.siyuan_parent_doc_id?.trim())) {
        if (!getSiYuanConfig(core).tokenConfigured) throw new Error('先在「设置 → 思源知识库」配置服务，再绑定项目群目录')
        const notebookId = d.siyuan_notebook_id?.trim() ?? currentProject?.siyuan_notebook_id ?? ''
        const parentDocId = d.siyuan_parent_doc_id?.trim() ?? currentProject?.siyuan_parent_doc_id ?? ''
        const client = siYuanClient(core)
        if (notebookId && !(await client.listNotebooks()).some((notebook) => notebook.id === notebookId)) throw new Error('所选思源笔记本不存在或不可用')
        if (parentDocId && (!notebookId || (await client.documentMeta(parentDocId)).notebookId !== notebookId)) throw new Error('思源父文档不属于所选笔记本')
      }
      let row: import('@jeff/core').ProjectRow | undefined
      if (d.id) {
        const existing = projectRepo(core.db).get(d.id)
        if (!existing) throw new Error('项目不存在')
        row = projectRepo(core.db).update(d.id, {
          title: d.title, description: d.description, system_prompt: d.system_prompt, icon: d.icon, leader_agent_id: d.leader_agent_id,
          ...(d.workspace_dir !== undefined ? { workspace_dir: d.workspace_dir } : {}),
          ...(d.siyuan_notebook_id !== undefined ? { siyuan_notebook_id: d.siyuan_notebook_id.trim() } : {}),
          ...(d.siyuan_parent_doc_id !== undefined ? { siyuan_parent_doc_id: d.siyuan_parent_doc_id.trim() } : {}),
        })
        if (!row) throw new Error('项目不存在')
      } else {
        row = projectRepo(core.db).create({ title: d.title, description: d.description, system_prompt: d.system_prompt, icon: d.icon, leader_agent_id: d.leader_agent_id, workspace_dir: d.workspace_dir || '', siyuan_notebook_id: d.siyuan_notebook_id, siyuan_parent_doc_id: d.siyuan_parent_doc_id })
      }
      // 事务化成员快照：差集删除 + 群主唯一（直接用 create/update 返回的 row，不按可重复的 title 回查）
      projectAgentRepo(core.db).replaceMembers(row.id, d.leader_agent_id, memberIds)
      for (const config of normalizedMemberConfigs) projectAgentRepo(core.db).updateConfig(row.id, config.agent_id, config.patch)
      core.bus.emit('data-changed', 'projects')
      return toProjectInfo(core, row)
    },
    [IPC.siyuanConfigGet]: async (): Promise<SiYuanConfigInfo> => getSiYuanConfig(core),
    [IPC.siyuanConfigSave]: async (p): Promise<SiYuanConfigInfo> => {
      const d = p as { baseUrl: string; token?: string }
      const saved = saveSiYuanConfig(core, d)
      core.bus.emit('data-changed', 'settings')
      return saved
    },
    [IPC.siyuanSearch]: async (p): Promise<SiYuanSearchResult[]> => {
      const { keyword, notebookId } = p as { keyword: string; notebookId?: string }
      return searchSiYuan(core, keyword, notebookId || '')
    },
    [IPC.siyuanNotebooks]: async (): Promise<SiYuanNotebook[]> => listSiYuanNotebooks(core),
    [IPC.siyuanDocuments]: async (p): Promise<SiYuanSearchResult[]> => listSiYuanDocuments(core, (p as { notebookId: string }).notebookId),
    [IPC.siyuanTargetGet]: async (): Promise<SiYuanTarget> => getSiYuanTarget(core),
    [IPC.siyuanTargetSave]: async (p): Promise<SiYuanTarget> => {
      const target = p as SiYuanTarget
      if (target.notebookId) {
        const client = siYuanClient(core)
        if (!(await client.listNotebooks()).some((notebook) => notebook.id === target.notebookId)) throw new Error('所选思源笔记本不存在或不可用')
        if (target.parentDocId && (await client.documentMeta(target.parentDocId)).notebookId !== target.notebookId) throw new Error('所选父文档不属于笔记本')
      }
      const saved = saveSiYuanTarget(core, target)
      core.bus.emit('data-changed', 'settings')
      return saved
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
        return { agent_id: m.agent_id, role: m.role, name: a?.name || m.agent_id, avatar: a?.avatar || '🤖',
          duties: m.duties || '', model_override: m.model_override ?? null, thinking_override: m.thinking_override ?? null,
          execution_engine: a?.execution_engine || 'opencode', engine_model: a?.engine_model || '',
          model_provider: a?.model_provider || '', model_id: a?.model_id || '', thinking: a?.thinking || '' }
      })
    },
    [IPC.projectAddMember]: async (p): Promise<{ ok: boolean }> => {
      const { projectId, agentId } = p as { projectId: string; agentId: string }
      const project = projectRepo(core.db).get(projectId)
      if (!project || project.deleted_at) throw new Error('项目不存在')
      const agent = agentRepo(core.db).get(agentId)
      if (!agent || agent.deleted_at) throw new Error('智能体不存在或已删除')
      projectAgentRepo(core.db).add(projectId, agentId, 'worker')
      core.bus.emit('data-changed', 'projects')
      return { ok: true }
    },
    [IPC.projectRemoveMember]: async (p): Promise<{ ok: boolean }> => {
      const { projectId, agentId } = p as { projectId: string; agentId: string }
      const project = projectRepo(core.db).get(projectId)
      if (!project || project.deleted_at) throw new Error('项目不存在')
      if (project.leader_agent_id === agentId) throw new Error('不能移除群主；请先改群主')
      const agent = agentRepo(core.db).get(agentId)
      if (!agent || agent.deleted_at) throw new Error('智能体不存在或已删除')
      projectAgentRepo(core.db).remove(projectId, agentId)
      core.bus.emit('data-changed', 'projects')
      return { ok: true }
    },

    // ---------- 任务 ----------
    [IPC.tasksList]: async (p): Promise<TaskInfo[]> => {
      const { projectId } = p as { projectId: string }
      return taskRepo(core.db).listByProject(projectId).map((task) => toTaskInfo(task, core.tasks.activeForTask(task.id)))
    },
    [IPC.taskSave]: async (p): Promise<TaskInfo> => {
      const d = p as { id?: string; project_id: string; title: string; goal?: string; description?: string; priority?: string; assignee_id?: string; due_at?: number | null; depends_on?: string[]; acceptance_criteria?: string }
      let row
      if (d.id) {
        if (core.tasks.hasActiveTask(d.id)) throw new Error('任务正在执行，暂时不能修改任务要求')
        if (d.assignee_id && !projectAgentRepo(core.db).getRole(d.project_id, d.assignee_id)) throw new Error('负责人必须是当前项目群成员')
        row = taskRepo(core.db).update(d.id, {
          title: d.title,
          goal: d.goal,
          description: d.description,
          priority: d.priority,
          ...(d.due_at !== undefined ? { due_at: d.due_at } : {}),
          ...(d.depends_on !== undefined ? { depends_on: JSON.stringify(d.depends_on) } : {}),
          ...(d.acceptance_criteria !== undefined ? { acceptance_criteria: d.acceptance_criteria } : {}),
          ...(d.assignee_id !== undefined ? { assignee_type: d.assignee_id ? 'agent' : 'none', assignee_id: d.assignee_id } : {}),
        })
      } else {
        if (!projectRepo(core.db).get(d.project_id)) throw new Error('项目群不存在')
        if (d.assignee_id && !projectAgentRepo(core.db).getRole(d.project_id, d.assignee_id)) throw new Error('负责人必须是当前项目群成员')
        row = taskRepo(core.db).create({
          project_id: d.project_id,
          title: d.title,
          goal: d.goal,
          description: d.description,
          priority: d.priority,
          due_at: d.due_at,
          depends_on: d.depends_on,
          acceptance_criteria: d.acceptance_criteria,
          assignee_type: d.assignee_id ? 'agent' : 'none',
          assignee_id: d.assignee_id || '',
        })
      }
      if (!row) throw new Error('任务保存失败')
      const card = taskCardMessage(core.db, row.project_id, row.id)
      if (card.content) core.groupChat.addSystemMessage(row.project_id, card.content, card.meta)
      core.bus.emit('data-changed', 'tasks')
      core.bus.emit('group-updated', { projectId: row.project_id })
      return toTaskInfo(row, core.tasks.activeForTask(row.id))
    },
    [IPC.taskDelete]: async (p): Promise<{ ok: boolean }> => {
      const { id } = p as { id: string }
      const cur = taskRepo(core.db).get(id)
      if (cur && core.tasks.hasActiveTask(id)) throw new Error('任务正在执行，请先停止执行后再删除')
      const ok = cur ? taskRepo(core.db).softDelete(id) : false
      if (cur) {
        core.bus.emit('data-changed', 'tasks')
        core.bus.emit('group-updated', { projectId: cur.project_id })
      }
      return { ok }
    },
    [IPC.taskStart]: async (p) => {
      const { id } = p as { id: string }
      const run = core.tasks.start(id)
      core.bus.emit('data-changed', 'tasks')
      return run
    },
    [IPC.taskStop]: async (p) => {
      const { id, runId } = p as { id: string; runId: string }
      const run = core.tasks.stop(id, runId)
      core.bus.emit('data-changed', 'tasks')
      return run
    },
    [IPC.taskRuns]: async (p) => core.tasks.list((p as { id: string }).id),
    [IPC.taskReview]: async (p) => {
      const data = p as { id: string; action: 'approve' | 'return' | 'reopen'; submissionId?: string; specHash?: string; feedback?: string }
      const task = core.tasks.review(data.id, data)
      core.bus.emit('data-changed', 'tasks')
      return toTaskInfo(task, core.tasks.activeForTask(task.id))
    },

    // ---------- 群聊 ----------
    [IPC.groupHistory]: async (p): Promise<unknown> => {
      const { projectId, limit } = p as { projectId: string; limit?: number }
      return core.historyActive(projectId, limit)
    },
    [IPC.groupSend]: async (p): Promise<{ routedTo?: string; summaryFailed?: boolean; summaryError?: string; waitingBrowser?: boolean }> => {
      const { projectId, text, images, plugin } = p as { projectId: string; text: string; images?: Array<{ mime: string; dataUrl: string }>; plugin?: ChatPluginInvoke }
      // 模型/思考由路由目标智能体资料决定，忽略前端覆盖
      try {
        return await core.groupChat.send({ projectId, text: resolveSendText(text, plugin), images })
      } catch (err) {
        if (err instanceof BrowserHandoffPausedError) return { waitingBrowser: true }
        throw err
      }
    },
    [IPC.groupStop]: async (p): Promise<{ ok: boolean }> => {
      const { projectId } = p as { projectId: string }
      await core.abortGroup(projectId)
      return { ok: true }
    },

    // ---------- 定时任务 ----------
    [IPC.cronList]: async () => core.listCronTasks(),
    [IPC.cronSave]: async (p) => {
      const r = core.saveCronTask(p as Parameters<JeffCore['saveCronTask']>[0])
      core.bus.emit('data-changed', 'cron')
      return r
    },
    [IPC.cronDelete]: async (p) => {
      const r = core.deleteCronTask((p as { id: string }).id)
      core.bus.emit('data-changed', 'cron')
      return r
    },
    [IPC.cronRun]: async (p) => core.runCronTaskNow((p as { id: string }).id),
    [IPC.cronRuns]: async (p) => core.listCronRuns((p as { id: string }).id),

    // ---------- 插件 ----------
    [IPC.pluginsList]: async () => core.listPlugins(),
    [IPC.pluginSetEnabled]: async (p) => {
      const d = p as { id: string; enabled: boolean }
      return core.setPluginEnabled(d.id, d.enabled)
    },
    [IPC.pluginSaveSecret]: async (p) => {
      const d = p as { id: string; secret: string }
      return core.savePluginSecret(d.id, d.secret)
    },
    [IPC.pluginSaveSettings]: async (p) => {
      const d = p as { id: string; secret?: string; homepage?: string }
      return core.savePluginSettings(d)
    },
    [IPC.pluginDelete]: async (p) => core.deletePlugin((p as { id: string }).id),
    [IPC.pluginRefresh]: async () => core.refreshPlugins(),
    [IPC.pluginBackupNow]: async () => core.backupPluginsNow(),
    [IPC.pluginBackupLast]: async () => core.lastPluginsBackup(),
    [IPC.pluginRestore]: async () => {
      const r = await core.restorePlugins()
      core.bus.emit('data-changed', 'plugins')
      return r
    },
    [IPC.pluginImport]: async (p): Promise<import('@jeff/core').PluginInfo> => {
      const d = p as { dir?: string }
      let dir = d.dir
      if (!dir) {
        const win = getMainWindow()
        if (!win) throw new Error('窗口不可用，无法选择目录')
        const r = await dialog.showOpenDialog(win, { title: '选择插件目录（含 plugin.json）', properties: ['openDirectory'] })
        if (r.canceled || r.filePaths.length === 0) throw new Error('已取消')
        dir = r.filePaths[0]
      }
      return core.importPlugin(dir)
    },

    // ---------- 内置浏览器（渲染层回报主进程下发的动作结果） ----------
    [IPC.browserResult]: async (p) => {
      setBrowserResult(p as import('@jeff/core').BrowserResult)
      return { ok: true }
    },
    [IPC.browserState]: async (p) => {
      setBrowserState(p as import('@jeff/core').BrowserState)
      return { ok: true }
    },
    [IPC.browserHandoffGet]: async () => core.browserHandoffInfo(),
    [IPC.browserHandoffOpen]: async () => core.openBrowserHandoffConversation(),
    [IPC.browserQueueGet]: async () => core.browserQueueInfo(),
    [IPC.browserQueuePrioritize]: async (p) => ({ ok: core.prioritizeBrowserWaiter((p as { id: string }).id) }),
    [IPC.browserHandoffTakeover]: async () => core.takeOverBrowser(),
    [IPC.browserHandoffReturn]: async () => core.returnBrowserToAI(),
    [IPC.browserHandoffCancel]: async () => { await core.cancelBrowserHandoff(); return { ok: true } },
    /**
     * 页面截图：走 Chrome DevTools Protocol 的 Page.captureScreenshot，按「请求的矩形」重新栅格化。
     *
     * 为什么不用 webview 的 capturePage（两条弯路都实测过）：
     * ① 它给的是渲染器**已呈现的那一帧**，尺寸不由你定（元素撑到 5659 高，拿回 1946）；
     * ② 元素被面板裁切时尺寸更怪，拉回请求尺寸只会得到空白图或错位图。
     *
     * 注意（实测边界）：渲染表面大约只能覆盖到窗口尺寸出头一点，请求远大于窗口时 Chromium 会
     * 平铺/裁剪——那一档由渲染层事先拦下（见 BrowserPanel 的窗口尺寸校验），这里不做猜测性兜底：
     * 拿到的尺寸与请求不符就如实报错，绝不用拉伸把「没截到」伪装成「截到了」。
     */
    [IPC.browserPageShot]: async (p): Promise<import('@jeff/core').BrowserPageShot> => {
      if (core.browserHandoffInfo()?.status === 'waiting_user') throw new Error('你正在接管内置浏览器；为保护认证信息，AI 截图已暂停。')
      const { webContentsId, width, height, beyondViewport, y } = p as {
        webContentsId: number
        width: number
        height: number
        beyondViewport: boolean
        y?: number
      }
      const target = webContents.fromId(webContentsId)
      if (!target || target.isDestroyed()) throw new Error(`找不到要截图的页面（webContents ${webContentsId} 已关闭？）`)
      if (!(width > 0) || !(height > 0)) throw new Error(`截图尺寸非法：${width}x${height}`)
      const already = target.debugger.isAttached()
      if (!already) {
        try {
          target.debugger.attach('1.3')
        } catch (err) {
          throw new Error(`截图需要调试通道，但附加失败（是不是开着 DevTools？）：${String((err as Error)?.message || err).slice(0, 160)}`)
        }
      }
      try {
        const shot = (await target.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: !!beyondViewport,
          clip: { x: 0, y: Math.max(0, Math.round(y || 0)), width, height, scale: 1 },
        })) as { data: string }
        const buf = Buffer.from(shot.data, 'base64')
        const size = pngDimensions(buf)
        if (size.width === width && size.height === height) {
          return { dataUrl: `data:image/png;base64,${shot.data}`, width, height }
        }
        /**
         * 高 DPI 屏上 CDP 按**设备像素**出图（请求 541x406 拿回 1082x812；Windows 137.5% 缩放
         * 则是 937x703 → 1288x967）。契约是「图片尺寸 = 视口 CSS 像素」，所以按同一比例压回请求尺寸。
         * 比例必须宽高等比且落在 1x–4x（含 1.25/1.375/1.5/1.75 这类非整数 DPR）；对不上才是渲染表面裁剪。
         */
        const k = resolveScreenshotScale({ width, height }, size)
        if (k) {
          const img = nativeImage.createFromBuffer(buf).resize({ width, height })
          return { dataUrl: `data:image/png;base64,${img.toPNG().toString('base64')}`, width, height }
        }
        throw new Error(
          `截图只拿到 ${size.width}x${size.height}（请求 ${width}x${height}）：这块画面超出了当前窗口能渲染的范围，请把窗口放大或改用更小的分辨率`,
        )
      } finally {
        if (!already) target.debugger.detach()
      }
    },
  }

  for (const channel of Object.keys(handlers)) {
    ipcMain.handle(`jeff:${channel}`, (_evt, payload) => {
      const handler = handlers[channel]
      if (!handler) throw new Error(`未注册通道 ${channel}`)
      return handler(payload)
    })
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
      ipcMain.handle(`jeff:${channel}`, (_evt, payload) => handlers[channel](payload))
    }
  }
  return handlers
}

export function toAgentInfo(row: import('@jeff/core').AgentRow): AgentInfo {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    description: row.description,
    instructions: row.instructions,
    execution_engine: row.execution_engine || 'opencode',
    engine_model: row.engine_model || '',
    model_provider: row.model_provider,
    model_id: row.model_id,
    thinking: row.thinking || '',
    category: row.category || '',
    builtin: !!row.builtin,
    archived: !!row.archived,
  }
}

/** ProjectRow → IPC 响应（projectsList 与 projectSave 共用；成员数现查） */
function toProjectInfo(core: JeffCore, row: import('@jeff/core').ProjectRow): ProjectInfo {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    system_prompt: row.system_prompt || '',
    icon: row.icon,
    status: row.status,
    leader_agent_id: row.leader_agent_id,
    workspace_dir: row.workspace_dir || '',
    siyuan_notebook_id: row.siyuan_notebook_id || '',
    siyuan_parent_doc_id: row.siyuan_parent_doc_id || '',
    updated_at: row.updated_at,
    memberCount: projectAgentRepo(core.db).listByProject(row.id).length,
  }
}

function toTaskInfo(row: TaskRow, active_run: TaskInfo['active_run'] = null): TaskInfo {
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
    due_at: row.due_at ?? null,
    depends_on: parseJsonStringArray(row.depends_on),
    acceptance_criteria: row.acceptance_criteria || '',
    evidence_paths: parseJsonStringArray(row.evidence_paths),
    goal: row.goal || '',
    result_summary: row.result_summary || '',
    submission_id: row.submission_id || '',
    submitted_spec_hash: row.submitted_spec_hash || '',
    review_feedback: row.review_feedback || '',
    reviewed_submission_id: row.reviewed_submission_id || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    active_run,
  }
}

function parseJsonStringArray(value: string | undefined): string[] {
  try { const parsed: unknown = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [] } catch { return [] }
}

// ---------- 工作空间文件浏览 ----------

/** 文件树忽略名单：版本控制/依赖/构建产物等常规噪音（不滤 dist/out，任务可能输出到那里） */
const FS_IGNORE = new Set(['.git', 'node_modules', '.tmp', '.DS_Store', 'Thumbs.db', '__pycache__', '.venv', '.idea', '.vscode', '.pytest_cache', '.next', '.cache', 'desktop.ini'])
const FS_MAX_DEPTH = 12
const FS_MAX_NODES = 4000

/** 递归列出目录树：目录在前按名排序；超上限截断并标记 truncated */
async function listFileTree(dir: string): Promise<{ dir: string; exists: boolean; nodes: FileNode[] }> {
  let st
  try {
    st = await fsp.stat(dir)
  } catch {
    return { dir, exists: false, nodes: [] }
  }
  if (!st.isDirectory()) return { dir, exists: false, nodes: [] }
  let budget = FS_MAX_NODES
  const nodes = await listDirLevel(dir, '', 0, () => --budget > 0)
  return { dir, exists: true, nodes }

  async function listDirLevel(absDir: string, relBase: string, depth: number, hasBudget: () => boolean): Promise<FileNode[]> {
    if (depth > FS_MAX_DEPTH) return []
    let entries
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: FileNode[] = []
    const dirs: Array<{ name: string; e: import('node:fs').Dirent }> = []
    const files: Array<{ name: string; e: import('node:fs').Dirent }> = []
    for (const e of entries) {
      if (FS_IGNORE.has(e.name) || e.name.startsWith('.jeff-')) continue
      if (e.isDirectory()) dirs.push({ name: e.name, e })
      else files.push({ name: e.name, e })
    }
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'zh-CN')
    dirs.sort(byName)
    files.sort(byName)
    for (const d of [...dirs, ...files]) {
      if (!hasBudget()) break
      const rel = relBase ? `${relBase}/${d.name}` : d.name
      const abs = path.join(absDir, d.name)
      let isDir = d.e.isDirectory()
      let size = 0
      let mtime = 0
      try {
        const s = await fsp.stat(abs)
        isDir = s.isDirectory()
        size = s.size
        mtime = s.mtimeMs
      } catch {
        /* 竞态删除：仍保留条目 */
      }
      const node: FileNode = {
        name: d.name,
        rel,
        abs,
        dir: isDir,
        ext: isDir ? '' : path.extname(d.name).slice(1).toLowerCase(),
        size,
        mtime,
      }
      if (isDir) {
        node.children = await listDirLevel(abs, rel, depth + 1, hasBudget)
        if (node.children.length === 0 && !hasBudget()) node.truncated = true
      }
      out.push(node)
    }
    return out
  }
}

/** 单文件上限 8MB，超出返回截断内容（不炸渲染层） */
const FS_READ_LIMIT = 8 * 1024 * 1024

async function readTextFile(file: string): Promise<{ file: string; content: string; size: number; truncated: boolean }> {
  const st = await fsp.stat(file).catch(() => null)
  if (!st) throw new Error('文件不存在或已被移动')
  if (st.isDirectory()) throw new Error('这是一个目录，无法预览')
  const size = st.size
  const truncated = size > FS_READ_LIMIT
  const buf = await fsp.readFile(file)
  // 二进制探测：首 8KB 含 NUL 视为二进制，拒绝 UTF-8 预览
  if (buf.subarray(0, 8192).includes(0)) throw new Error('二进制文件不支持预览，可用系统程序打开')
  return { file, content: buf.subarray(0, FS_READ_LIMIT).toString('utf8'), size, truncated }
}
