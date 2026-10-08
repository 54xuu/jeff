import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EngineId } from './contract.js'
import { launch, JsonLines, stopProcess } from './process.js'
import { JsonStreamParser, ReplyCollector } from './stream.js'
import { APP_VERSION } from '../version.js'

export interface ExecutionInput {
  engine: Exclude<EngineId, 'opencode'>
  binary: string
  cwd: string
  env: NodeJS.ProcessEnv
  extraArgs: string[]
  text: string
  model?: string
  thinking?: string
  nativeSessionId?: string
  images?: Array<{ mime: string; dataUrl: string }>
  signal: AbortSignal
  reply: ReplyCollector
  session: (id: string) => void
}
export interface ExecutionResult { nativeSessionId?: string; tokens?: { input: number; output: number } }

function stoppedError(signal: AbortSignal): Error {
  return new Error(signal.reason?.message === '执行超时' ? '执行引擎超时，请检查本机 CLI 状态；请求不会自动重发' : '已停止生成 abort')
}

/** RPC requests settle on exit and cancellation; stdout is drained before writing stdin. */
export class RpcProcess {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  readonly child: ChildProcessWithoutNullStreams
  onNotification: (method: string, params: any) => void = () => {}
  onRequest: (method: string, params: any) => unknown = () => ({ decision: 'decline' })
  onError: (error: Error) => void = () => {}
  private closed = false
  constructor(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = launch(binary, args, cwd, env)
    const fail = (error: Error) => {
      if (this.closed) return
      this.closed = true
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
      this.pending.clear()
      this.onError(error)
    }
    const parser = new JsonLines((event) => {
      if (event.id !== undefined && event.method) {
        this.write({ id: event.id, result: this.onRequest(event.method, event.params) })
      } else if (event.id !== undefined) {
        const waiter = this.pending.get(event.id)
        if (!waiter) return
        this.pending.delete(event.id); clearTimeout(waiter.timer)
        event.error ? waiter.reject(new Error(event.error.message || 'Codex RPC 失败')) : waiter.resolve(event.result)
      } else if (event.method) this.onNotification(event.method, event.params)
    })
    this.child.stdout.on('data', (chunk) => { try { parser.push(chunk) } catch (err) { fail(err as Error); void stopProcess(this.child) } })
    this.child.stderr.on('data', () => { /* Auth diagnostics must not leak into UI/logs. */ })
    this.child.stdin.on('error', fail)
    this.child.once('error', fail)
    this.child.once('close', (code) => fail(new Error(`Codex 服务已退出（${code}）`)))
  }
  private write(value: unknown): void { this.child.stdin.write(JSON.stringify(value) + '\n') }
  notify(method: string, params?: unknown): void { this.write({ method, params }) }
  request(method: string, params: unknown, timeout = 60000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex 服务已退出'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 超时`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }
  async close(): Promise<void> { this.child.stdin.end(); await stopProcess(this.child) }
}

export async function executeCodex(input: ExecutionInput): Promise<ExecutionResult> {
  const rpc = new RpcProcess(input.binary, ['app-server', '--listen', 'stdio://'], input.cwd, input.env)
  let native = input.nativeSessionId
  let turnId: string | undefined
  let tokens: ExecutionResult['tokens']
  let settle: (error?: Error) => void = () => {}
  const completed = new Promise<void>((resolve, reject) => { settle = (error) => error ? reject(error) : resolve() })
  // A rejection can arrive while thread/start is pending.
  void completed.catch(() => {})
  rpc.onError = settle
  rpc.onRequest = (method) => method.endsWith('/requestApproval') ? { decision: 'accept' } : { answers: {} }
  rpc.onNotification = (method, params) => {
    if (params?.threadId && native && params.threadId !== native) return
    if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage?.last
      if (usage) tokens = { input: usage.inputTokens || 0, output: usage.outputTokens || 0 }
    }
    if (method === 'turn/started') turnId = params.turn?.id
    if (method === 'item/agentMessage/delta') input.reply.text(params.itemId, 'text', params.delta, true)
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') input.reply.text(`${params.itemId}:reasoning:${params.summaryIndex ?? 0}`, 'reasoning', params.delta, true)
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item || {}
      if (item.type === 'agentMessage' && method === 'item/completed') input.reply.text(item.id, 'text', item.text || '')
      if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type)) {
        input.reply.tool(item.id, item.tool || item.type, { status: method === 'item/started' ? 'running' : item.status === 'failed' || item.error || item.result?.isError ? 'error' : 'completed',
          input: item.arguments || item.command || item.changes, output: item.aggregatedOutput || (item.result ? JSON.stringify(item.result) : undefined) })
      }
    }
    if (method === 'turn/completed') {
      if (turnId && params.turn?.id !== turnId) return
      settle(params.turn?.status === 'completed' ? undefined : new Error(params.turn?.error?.message || `Codex 回合${params.turn?.status === 'interrupted' ? '已停止 abort' : '失败'}`))
    }
    if (method === 'error' && params.willRetry !== true) settle(new Error(params.error?.message || 'Codex 执行失败'))
  }
  const abort = () => {
    settle(stoppedError(input.signal))
    void (async () => {
      if (native && turnId) await rpc.request('turn/interrupt', { threadId: native, turnId }, 2000).catch(() => {})
      await rpc.close()
    })()
  }
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    if (input.signal.aborted) throw stoppedError(input.signal)
    await rpc.request('initialize', { clientInfo: { name: 'jeff', title: 'Jeff', version: APP_VERSION } })
    rpc.notify('initialized')
    const thread = await rpc.request(native ? 'thread/resume' : 'thread/start', {
      ...(native ? { threadId: native } : {}), cwd: input.cwd, model: input.model || undefined,
      approvalPolicy: 'never', sandbox: 'danger-full-access',
    })
    native = thread.thread.id
    input.session(native!)
    if (input.signal.aborted) throw stoppedError(input.signal)
    const content = [{ type: 'text', text: input.text }, ...(input.images || []).map((image) => ({ type: 'image', url: image.dataUrl }))]
    await rpc.request('turn/start', { threadId: native, input: content, ...(input.thinking ? { effort: input.thinking === 'max' ? 'xhigh' : input.thinking } : {}) })
    await completed
    return { nativeSessionId: native, tokens }
  } finally { input.signal.removeEventListener('abort', abort); await rpc.close() }
}

export async function executeJsonCli(input: ExecutionInput): Promise<ExecutionResult> {
  const claude = input.engine === 'claude'
  const args = claude
    ? ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'bypassPermissions', '--disallowedTools', 'AskUserQuestion']
    : ['-p', '--output-format', 'stream-json', '--force', '--stream-partial-output']
  if (input.model) args.push('--model', input.model)
  if (claude && input.thinking) args.push('--effort', input.thinking)
  if (input.nativeSessionId) args.push('--resume', input.nativeSessionId)
  args.push(...input.extraArgs)
  const child = launch(input.binary, args, input.cwd, input.env)
  const parser = new JsonStreamParser(input.reply, claude ? 'claude' : 'cursor')
  let parseError: Error | undefined
  let authRequired = false
  let stderrTail = ''
  const lines = new JsonLines((event) => { parser.receive(event); if (parser.sessionId) input.session(parser.sessionId) })
  child.stdout.on('data', (chunk) => {
    try { lines.push(chunk) } catch (err) { parseError = err as Error; void stopProcess(child) }
  })
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    authRequired ||= /authentication required|not logged in|not authenticated/i.test(stderrTail)
  })
  const abort = () => { void stopProcess(child) }
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); child.stdin.on('error', reject) })
    if (input.signal.aborted) { await stopProcess(child); throw stoppedError(input.signal) }
    if (claude) {
      child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'text', text: input.text }, ...(input.images || []).map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.dataUrl.split(',')[1] } })),
      ] } }) + '\n')
    } else child.stdin.end(input.text + '\n')
    const code = await exited
    if (input.signal.aborted) throw stoppedError(input.signal)
    if (parseError) throw parseError
    lines.end()
    if (code !== 0 || !parser.terminal || !parser.success) throw new Error(authRequired ? 'CLI 尚未登录；请在电脑终端完成登录后重试' : parser.error || `CLI 未成功完成（退出码 ${code}）；请检查本机 CLI 登录和模型配置`)
    if (!parser.sessionId) throw new Error('CLI 没有返回会话 ID，无法保证续接')
    return { nativeSessionId: parser.sessionId, tokens: parser.tokens }
  } finally { input.signal.removeEventListener('abort', abort); await stopProcess(child) }
}

/** Run the installed system OpenCode CLI with a private XDG/config/data profile. */
export async function executeOpenCode(input: ExecutionInput): Promise<ExecutionResult> {
  const args = ['run', '--format', 'json', '--dir', input.cwd, ...input.extraArgs]
  if (input.nativeSessionId) args.push('--session', input.nativeSessionId)
  if (input.model) args.push('--model', input.model)
  if (input.thinking) args.push('--variant', input.thinking)
  args.push('--', input.text)
  const child = launch(input.binary, args, input.cwd, input.env)
  const parser = new JsonStreamParser(input.reply, 'opencode')
  let parseError: Error | undefined
  let stderr = ''
  const lines = new JsonLines((event) => {
    parser.receive(event)
    if (parser.sessionId) input.session(parser.sessionId)
  })
  child.stdout.on('data', (chunk) => {
    try { lines.push(chunk) } catch (error) { parseError = error as Error; void stopProcess(child) }
  })
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1600) })
  child.stdin.on('error', (error) => { parseError ||= error; void stopProcess(child) })
  const abort = () => { void stopProcess(child) }
  input.signal.addEventListener('abort', abort, { once: true })
  // The prompt is passed as a positional argument. Close stdin so the CLI's
  // one-shot run can finish instead of waiting forever for additional input.
  child.stdin.end()
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    if (input.signal.aborted) throw stoppedError(input.signal)
    if (parseError) throw parseError
    lines.end()
    if (parser.error) throw new Error(parser.error)
    if (code !== 0) {
      const auth = /authentication|unauthorized|not logged in|api key/i.test(stderr)
      throw new Error(auth ? '系统 OpenCode 请求未通过认证；请检查系统 CLI 的账号登录状态' : `系统 OpenCode 执行失败（退出码 ${code}）；请检查系统配置与模型连接`)
    }
    if (!parser.sessionId) throw new Error('系统 OpenCode 没有返回会话 ID，无法安全续接')
    parser.success = true
    return { nativeSessionId: parser.sessionId, tokens: parser.tokens }
  } finally {
    input.signal.removeEventListener('abort', abort)
    await stopProcess(child)
  }
}
