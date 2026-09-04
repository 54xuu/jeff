import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { buildPaths, ensureDirs, jeffRoot, type JeffPaths } from './paths.js'
import { openDb, type DB } from './db/db.js'
import { agentRepo, kvRepo, type AgentRow } from './db/repos.js'
import { SidecarManager } from './sidecar/manager.js'
import { OcClient } from './oc/client.js'
import { writeSidecarConfig, type ProviderSetting } from './oc/configWriter.js'
import { AgentRegistry, XIAOJIE_INSTRUCTIONS } from './agents/registry.js'
import { XIAOJIE_ID } from './ipc/contract.js'
import { ToolBridge, renderBridgePlugin } from './tools/bridge.js'
import { registerAdminTools } from './tools/adminTools.js'
import { allToolDefs } from './tools/definitions.js'
import { PrivateChat } from './chat/private.js'

export const APP_VERSION = '0.1.0'
export { buildPaths, ensureDirs, jeffRoot } from './paths.js'
export { openDb } from './db/db.js'

/** Jeff 核心实例：桌面主进程与测试脚本共用 */
export class JeffCore extends EventEmitter {
  paths: JeffPaths
  db!: DB
  sidecar!: SidecarManager
  oc!: OcClient
  registry!: AgentRegistry
  bridge = new ToolBridge()
  privateChat!: PrivateChat
  bus = new EventEmitter()
  private started = false
  private registryDirty = false

  constructor(home?: string) {
    super()
    this.paths = buildPaths(jeffRoot(home))
  }

  async init(opts: { resourceBinDir?: string; binaryPath?: string } = {}): Promise<void> {
    if (this.started) return
    ensureDirs(this.paths)
    this.db = openDb(this.paths)
    this.seedXiaojie()
    this.registry = new AgentRegistry(this.db, this.paths)

    // 工具桥（先注册工具，再启动，再渲染插件文件）
    registerAdminTools(this.bridge, {
      db: this.db,
      onChanged: () => {
        this.syncRegistry()
        this.markRegistryDirty()
        this.bus.emit('data-changed', 'agents')
      },
    })
    await this.bridge.start()
    this.writeBridgePlugin()

    // sidecar 配置（provider/auth）+ agent 定义文件（必须在 sidecar 启动前就位）
    this.writeSidecarConfig()
    this.syncRegistry()

    // sidecar 启动
    this.sidecar = new SidecarManager({ paths: this.paths, resourceBinDir: opts.resourceBinDir, binaryPath: opts.binaryPath })
    this.sidecar.on('status', (status: string, error?: string) => {
      this.bus.emit('sidecar-status', { status, error })
      this.emit('sidecar-status', { status, error })
    })
    this.sidecar.on('log', (line: string) => this.emit('sidecar-log', line))
    await this.sidecar.start()
    this.oc = new OcClient(this.sidecar.port)
    this.oc.startEventStream()
    this.oc.on('event', (evt: { type?: string; properties?: Record<string, unknown> }) => this.handleOcEvent(evt))

    this.privateChat = new PrivateChat(this.db, () => this.oc, { beforeEnsure: () => this.restartIfRegistryDirty() })
    this.started = true
  }

  /** agent md 同步（带全局默认模型兜底） */
  syncRegistry(): void {
    this.registry.syncAll(this.defaultModel() ?? undefined)
  }

  /** agent 定义有变化：md 已同步，下次会话前需重启 sidecar（opencode 不热加载 agent） */
  markRegistryDirty(): void {
    this.registryDirty = true
  }

  private async restartIfRegistryDirty(): Promise<void> {
    if (!this.registryDirty || !this.sidecar) return
    this.registryDirty = false
    await this.restartSidecar()
  }

  /** 重启 sidecar 并重建客户端/会话对象 */
  async restartSidecar(): Promise<void> {
    const old = this.oc
    await this.sidecar.stop()
    await this.sidecar.start()
    old?.stopEventStream()
    this.oc = new OcClient(this.sidecar.port)
    this.oc.startEventStream()
    this.oc.on('event', (evt: { type?: string; properties?: Record<string, unknown> }) => this.handleOcEvent(evt))
    this.privateChat = new PrivateChat(this.db, () => this.oc, { beforeEnsure: () => this.restartIfRegistryDirty() })
  }

  /** 内置小杰：不存在则创建；存在则强制对齐指令（保持与代码同步，不可被改） */
  private seedXiaojie(): void {
    const agents = agentRepo(this.db)
    const existing = agents.get(XIAOJIE_ID)
    if (!existing) {
      agents.create({
        id: XIAOJIE_ID,
        name: '小杰',
        avatar: '🧑‍💻',
        description: 'Jeff 内置管家：问答、创建与管理一切',
        builtin: 1,
      })
    }
    agents.update(XIAOJIE_ID, { instructions: XIAOJIE_INSTRUCTIONS })
  }

  /** 把工具桥插件写进 sidecar 插件目录 */
  writeBridgePlugin(): void {
    fs.mkdirSync(this.paths.ocPluginsDir, { recursive: true })
    const defs = allToolDefs().map((d) => ({ name: d.name, description: d.description, args: d.args }))
    const plugin = renderBridgePlugin(this.bridge.url(), this.bridge.token, defs)
    fs.writeFileSync(path.join(this.paths.ocPluginsDir, 'jeff-bridge.js'), plugin, 'utf8')
  }

  writeSidecarConfig(): void {
    const kv = kvRepo(this.db)
    const providers = kv.getJSON<ProviderSetting[]>('settings:providers', [])
    const defaultModel = kv.getJSON<{ providerID: string; modelID: string } | null>('settings:defaultModel', null)
    writeSidecarConfig(this.paths, providers, { defaultModel: defaultModel ?? undefined })
  }

  /** SSE 事件 → bus（UI 刷新信号） */
  private handleOcEvent(evt: { type?: string; properties?: Record<string, unknown> }): void {
    if (!evt?.type) return
    if (evt.type === 'message.updated' || evt.type === 'message.part.updated' || evt.type === 'message.part.delta') {
      const sessionId = evt.properties?.sessionID as string | undefined
      if (!sessionId) return
      const agentId = this.agentIdForSession(sessionId)
      if (agentId) this.bus.emit('chat-updated', { agentId, sessionId })
    }
  }

  /** session → agent 反查（私聊映射） */
  agentIdForSession(sessionId: string): string | null {
    const kv = kvRepo(this.db)
    for (const agent of agentRepo(this.db).list()) {
      if (kv.get(`session:private:${agent.id}`) === sessionId) return agent.id
    }
    return null
  }

  async dispose(): Promise<void> {
    if (!this.started) return
    this.oc?.stopEventStream()
    await this.sidecar?.stop().catch(() => {})
    await this.bridge?.stop().catch(() => {})
    this.db?.close()
    this.started = false
  }

  get isStarted(): boolean {
    return this.started
  }

  /** 便捷访问器 */
  get agents() {
    return agentRepo(this.db)
  }

  kv() {
    return kvRepo(this.db)
  }

  listProviders(): ProviderSetting[] {
    return this.kv().getJSON<ProviderSetting[]>('settings:providers', [])
  }

  defaultModel(): { providerID: string; modelID: string } | null {
    return this.kv().getJSON<{ providerID: string; modelID: string } | null>('settings:defaultModel', null)
  }

  async saveProviders(providers: ProviderSetting[], defaultModel?: { providerID: string; modelID: string } | null): Promise<void> {
    this.kv().setJSON('settings:providers', providers)
    if (defaultModel !== undefined) this.kv().setJSON('settings:defaultModel', defaultModel ?? null)
    this.writeSidecarConfig()
    // 重启 sidecar 使 provider 生效
    await this.restartSidecar()
  }

  /** 小杰默认模型兜底：小杰 agent 行未配模型时用全局默认 */
  xiaojieAgentRow(): AgentRow {
    return agentRepo(this.db).get(XIAOJIE_ID)!
  }
}

export * from './ipc/contract.js'
export * from './db/repos.js'
export * from './oc/client.js'
export * from './oc/configWriter.js'
export * from './chat/private.js'
export { XIAOJIE_SLUG, agentSlug } from './agents/registry.js'
export { XIAOJIE_ID, BUILTIN_PROVIDER_PRESETS } from './ipc/contract.js'
export { SidecarManager } from './sidecar/manager.js'
export { ToolBridge } from './tools/bridge.js'
