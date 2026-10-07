import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { OcClient, DEFAULT_SEND_TIMEOUT_MS, type SessionInfo, type SessionMessage, type AssistantInfo } from '../oc/client.js'
import { agentRepo, kvRepo, type AgentRow } from '../db/repos.js'
import type { DB } from '../db/db.js'
import { agentSlug, agentDeniedTools } from '../agents/registry.js'
import type { ToolBridge } from '../tools/bridge.js'
import type { McpServerCfg } from '../mcp/parse.js'
import type { DebugLogFn } from '../logger.js'
import { ENGINE_IDS, ENGINE_LABELS, ENGINE_CAPABILITIES, engineId, assertAgentEngine, type EngineId, type EngineStatus } from './contract.js'
import { capture, resolveExecutable } from './process.js'
import { prepareEnvironment } from './environment.js'
import { executeCodex, executeJsonCli, RpcProcess } from './backends.js'
import { ReplyCollector } from './stream.js'

interface Binding {
  id: string
  engine: EngineId
  agentId: string
  nativeSessionId?: string
  directory: string
  title: string
  created: number
  updated: number
  configVersion: number
  model?: string
  thinking?: string
}
const bindingKey = (id: string) => `engine:session:${id}`
const historyKey = (id: string) => `engine:messages:${id}`

/** Compatibility facade keeps old OpenCode IDs while routing every session operation by engine. */
export class EngineClient extends OcClient {
  private runs = new Map<string, AbortController>()
  private stopped = new Map<string, number>()
  private completions = new Map<string, Promise<void>>()
  constructor(port: number, private deps: {
    db: DB; root: string; workspace: string; bridge: ToolBridge; mcp: () => Record<string, McpServerCfg>
  }, log?: DebugLogFn) { super(port, log) }
  private kv() { return kvRepo(this.deps.db) }
  private binding(id: string): Binding | null { return this.kv().getJSON<Binding | null>(bindingKey(id), null) }
  override sessionCompatible(id: string, agentId: string): boolean {
    const engine = this.sessionEngine(id)
    const agent = agentRepo(this.deps.db).get(agentId)
    return !!agent && (!this.binding(id) || this.binding(id)!.agentId === agentId) && (engine === (agent.execution_engine || 'opencode') || this.kv().get(`engine:activated:${id}`) === agentId)
  }
  private agent(slug?: string): AgentRow | undefined { return agentRepo(this.deps.db).list().find((agent) => agentSlug(agent.id) === slug) }
  assertSessionOwner(id: string, agentId: string): void {
    const binding = this.binding(id)
    if (binding && binding.agentId !== agentId) throw new Error('不能激活其它智能体的会话')
    if (id.startsWith('jeff_') && !binding) throw new Error('会话不存在')
  }
  sessionEngine(id: string): EngineId { return this.binding(id)?.engine || 'opencode' }
  private save(binding: Binding): void { this.kv().setJSON(bindingKey(binding.id), binding) }
  private sessionInfo(binding: Binding): SessionInfo {
    return { id: binding.id, title: binding.title, directory: binding.directory, agent: agentSlug(binding.agentId),
      engine: binding.engine, time: { created: binding.created, updated: binding.updated } }
  }
  async probe(id: EngineId): Promise<EngineStatus> {
    engineId(id)
    const configured = this.kv().get(`engine:path:${id}`) || undefined
    const binary = id === 'opencode' ? configured || null : resolveExecutable(id === 'cursor' ? ['cursor-agent', 'agent'] : [id], configured)
    const base: EngineStatus = { id, label: ENGINE_LABELS[id], path: binary, available: false, capabilities: ENGINE_CAPABILITIES[id], configuredPath: configured }
    if (id === 'opencode') return { ...base, available: true }
    if (!binary) return { ...base, error: '未找到 CLI；请在本机安装并登录，或指定可执行文件路径' }
    try {
      const version = await capture(binary, ['--version'])
      const help = await capture(binary, id === 'codex' ? ['app-server', '--help'] : ['--help'])
      const required = id === 'codex' ? ['stdio'] : id === 'cursor' ? ['stream-json', '--stream-partial-output', '--add-dir', '--approve-mcps'] : ['stream-json', '--include-partial-messages', '--strict-mcp-config', '--effort', '--bare', '--append-system-prompt']
      if (required.some((flag) => !help.includes(flag))) throw new Error('该 CLI 版本不支持所需的执行协议')
      return { ...base, version: version.split('\n')[0], available: true }
    } catch (err) { return { ...base, error: String((err as Error).message) } }
  }
  async engines(): Promise<EngineStatus[]> { return Promise.all(ENGINE_IDS.map((id) => this.probe(id))) }
  async savePath(id: EngineId, value: string): Promise<EngineStatus> {
    engineId(id)
    if (id === 'opencode') throw new Error('默认 OpenCode 使用 Jeff 内置引擎，无需配置外部路径')
    if (value.trim() && !path.isAbsolute(value.trim())) throw new Error('请填写 CLI 可执行文件的绝对路径')
    this.kv().set(`engine:path:${id}`, value.trim())
    return this.probe(id)
  }
  async models(id: EngineId): Promise<{ models: Array<{ id: string; label: string }>; manual: boolean }> {
    engineId(id)
    if (id === 'opencode') return { models: [], manual: false }
    const status = await this.probe(id)
    if (!status.available || !status.path) throw new Error(status.error || 'CLI 不可用')
    if (id === 'cursor') {
      const raw = await capture(status.path, ['--list-models'], 15000)
      const models = raw.split('\n').map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter((line) => /^[a-z][\w.-]+\s+[-–]/i.test(line))
        .map((line) => ({ id: line.split(/\s+/)[0], label: line }))
      return { models, manual: true }
    }
    if (id === 'codex') {
      const environment = prepareEnvironment(this.deps.root, 'model-catalog', id, '', this.deps.workspace, 'http://127.0.0.1:1', {})
      const rpc = new RpcProcess(status.path, ['app-server', '--listen', 'stdio://'], environment.cwd, environment.env)
      try {
        await rpc.request('initialize', { clientInfo: { name: 'jeff', version: '1.12.0' } }); rpc.notify('initialized')
        const result = await rpc.request('model/list', { limit: 100 }, 15000)
        return { models: (result.data || []).map((model: any) => ({ id: model.model || model.id, label: model.displayName || model.model || model.id })), manual: true }
      } finally { await rpc.close() }
    }
    // Claude versions do not share a stable non-inference model-list command.
    return { models: [], manual: true }
  }
  override async createSession(input: Parameters<OcClient['createSession']>[0]): Promise<SessionInfo> {
    const agent = this.agent(input.agent)
    if (!agent) return super.createSession(input)
    assertAgentEngine(agent)
    const engine = agent.execution_engine || 'opencode'
    if (engine === 'opencode') {
      const session = await super.createSession(input)
      this.save({ id: session.id, engine, agentId: agent.id, title: session.title || '', directory: input.directory || this.deps.workspace,
        created: Date.now(), updated: Date.now(), configVersion: agent.instructions_version })
      return session
    }
    const status = await this.probe(engine)
    if (!status.available) throw new Error(status.error || '执行引擎不可用')
    const binding: Binding = { id: `jeff_${randomUUID()}`, engine, agentId: agent.id, directory: input.directory || this.deps.workspace,
      title: input.title || '', created: Date.now(), updated: Date.now(), configVersion: agent.instructions_version,
      model: agent.engine_model || '', thinking: agent.thinking || '' }
    this.save(binding)
    return this.sessionInfo(binding)
  }
  override async getSession(id: string): Promise<SessionInfo> {
    const binding = this.binding(id)
    return binding && binding.engine !== 'opencode' ? this.sessionInfo(binding) : super.getSession(id)
  }
  override async listSessions(directory?: string): Promise<SessionInfo[]> {
    const rows = this.deps.db.prepare("SELECT value FROM kv WHERE key LIKE 'engine:session:%'").all() as Array<{ value: string }>
    const external = rows.map((row) => JSON.parse(row.value) as Binding).filter((binding) => binding.engine !== 'opencode' && (!directory || binding.directory === directory))
    let native: SessionInfo[]
    try { native = await super.listSessions(directory) }
    catch (error) { if (!external.length) throw error; native = [] }
    return [...native, ...external.map((binding) => this.sessionInfo(binding))]
  }
  override async getMessages(id: string, timeout?: number, signal?: AbortSignal): Promise<SessionMessage[]> {
    if (this.sessionEngine(id) === 'opencode') return super.getMessages(id, timeout, signal)
    return this.kv().getJSON<SessionMessage[]>(historyKey(id), [])
  }
  override async updateSession(id: string, patch: { title?: string }): Promise<SessionInfo> {
    const binding = this.binding(id)
    if (!binding || binding.engine === 'opencode') return super.updateSession(id, patch)
    binding.title = patch.title ?? binding.title; binding.updated = Date.now(); this.save(binding)
    return this.sessionInfo(binding)
  }
  override async deleteSession(id: string): Promise<void> {
    if (this.runs.has(id)) throw new Error('会话正在执行，不能删除')
    const engine = this.sessionEngine(id)
    if (engine === 'opencode') await super.deleteSession(id)
    else if (/^jeff_[0-9a-f-]+$/.test(id)) fs.rmSync(path.join(this.deps.root, 'engines', engine, id), { recursive: true, force: true })
    this.kv().delete(bindingKey(id)); this.kv().delete(historyKey(id))
  }
  override hasInflight(): boolean { return this.runs.size > 0 || super.hasInflight() }
  override isAbortRequested(id: string, windowMs = 120000): boolean { return Date.now() - (this.stopped.get(id) || 0) < windowMs || super.isAbortRequested(id, windowMs) }
  override async abortSession(id: string): Promise<void> {
    if (this.sessionEngine(id) === 'opencode') return super.abortSession(id)
    this.stopped.set(id, Date.now()); this.runs.get(id)?.abort()
  }
  async disposeEngines(): Promise<void> {
    for (const run of this.runs.values()) run.abort()
    await Promise.allSettled([...this.completions.values()])
  }
  override async summarize(input: Parameters<OcClient['summarize']>[0]): Promise<AssistantInfo> {
    if (this.sessionEngine(input.sessionId) !== 'opencode') throw new Error('该执行引擎暂不支持手动压缩上下文')
    return super.summarize(input)
  }
  override async sendMessage(input: Parameters<OcClient['sendMessage']>[0]): Promise<AssistantInfo> {
    const binding = this.binding(input.sessionId)
    if (!binding || binding.engine === 'opencode') return super.sendMessage(input)
    if (this.runs.has(binding.id)) throw new Error('该会话正在执行')
    const controller = new AbortController()
    this.runs.set(binding.id, controller)
    this.stopped.delete(binding.id)
    let finish = () => {}
    this.completions.set(binding.id, new Promise<void>((resolve) => { finish = resolve }))
    const timeout = setTimeout(() => controller.abort(new Error('执行超时')), input.timeoutMs || DEFAULT_SEND_TIMEOUT_MS)
    try { return await this.sendExternal(input, binding, controller) }
    finally {
      clearTimeout(timeout); this.runs.delete(binding.id); finish(); this.completions.delete(binding.id)
      this.emit('inflight-idle')
    }
  }
  private async sendExternal(input: Parameters<OcClient['sendMessage']>[0], binding: Binding, controller: AbortController): Promise<AssistantInfo> {
    const engine = binding.engine
    if (engine === 'opencode') throw new Error('执行引擎路由错误')
    const agent = agentRepo(this.deps.db).get(binding.agentId)
    if (!agent) throw new Error('会话所属智能体不存在')
    assertAgentEngine({ ...agent, execution_engine: binding.engine })
    const caps = ENGINE_CAPABILITIES[binding.engine]
    if (input.images?.length && !caps.images) throw new Error('该执行引擎不支持图片输入，请切换引擎后新建会话')
    const currentEngine = agent.execution_engine || 'opencode'
    const thinking = currentEngine === binding.engine ? input.variant : binding.thinking || undefined
    if (thinking && !caps.thinking) throw new Error('该执行引擎不支持独立思考档位，请在智能体资料中设为跟随引擎')
    const status = await this.probe(binding.engine)
    if (controller.signal.aborted) throw new Error('已停止生成 abort')
    if (!status.available || !status.path) throw new Error(status.error || '执行引擎不可用')
    const messages = await this.getMessages(binding.id)
    messages.push({ info: { id: randomUUID(), role: 'user', time: { created: Date.now() } }, parts: [{ id: randomUUID(), type: 'text', text: input.text }, ...(input.images || []).map((image) => ({ id: randomUUID(), type: 'file', mime: image.mime, url: image.dataUrl }))] })
    this.kv().setJSON(historyKey(binding.id), messages)
    if (input.noReply) return { id: randomUUID(), role: 'assistant', parts: [] }
    const messageId = randomUUID()
    const info: AssistantInfo = { id: messageId, role: 'assistant', agent: agentSlug(agent.id), time: { created: Date.now() }, engine: binding.engine }
    this.emit('event', { type: 'message.updated', properties: { sessionID: binding.id, info } })
    const reply = new ReplyCollector((part) => this.emit('event', { type: 'message.part.updated', properties: {
      sessionID: binding.id, part: { ...part, sessionID: binding.id, messageID: messageId },
    } }))
    const mcp = this.deps.bridge.openMcpSession(binding.id, agentSlug(agent.id), agentDeniedTools(agent))
    try {
      const environment = prepareEnvironment(this.deps.root, binding.id, binding.engine, `${agent.instructions}\n${input.system || ''}`, binding.directory, mcp.url, this.deps.mcp())
      if (currentEngine === binding.engine) { binding.model = agent.engine_model || ''; binding.thinking = thinking || ''; this.save(binding) }
      const options = { engine, binary: status.path, ...environment, text: input.text,
        nativeSessionId: binding.nativeSessionId, model: (currentEngine === binding.engine ? agent.engine_model : binding.model) || undefined, thinking,
        images: input.images, signal: controller.signal, reply, session: (nativeSessionId: string) => { binding.nativeSessionId = nativeSessionId; this.save(binding) } }
      const result = await (binding.engine === 'codex' ? executeCodex(options) : executeJsonCli(options))
      info.time!.completed = Date.now(); info.tokens = result.tokens
      info.parts = reply.values(); binding.updated = Date.now(); binding.configVersion = agent.instructions_version; this.save(binding)
      return info
    } catch (err) {
      info.error = { message: String((err as Error).message) }
      throw err
    } finally {
      messages.push({ info, parts: reply.values() })
      if (info.error) messages.push({ info: { id: randomUUID(), role: 'system', time: { created: Date.now() } }, parts: [{ id: randomUUID(), type: 'text', text: controller.signal.aborted && controller.signal.reason?.message !== '执行超时' ? '已停止生成' : `执行失败：${(info.error as { message: string }).message}` }] })
      this.kv().setJSON(historyKey(binding.id), messages)
      mcp.close()
      this.emit('event', { type: 'session.idle', properties: { sessionID: binding.id } })
    }
  }
}
