import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { openDb, type DB } from '../src/db/db.js'
import { agentRepo, kvRepo, projectRepo } from '../src/db/repos.js'
import { buildPaths } from '../src/paths.js'
import { JsonLines, executableCommand, launch, stopProcess } from '../src/engines/process.js'
import { JsonStreamParser, ReplyCollector } from '../src/engines/stream.js'
import { EngineClient } from '../src/engines/client.js'
import { ToolBridge } from '../src/tools/bridge.js'
import { agentSlug } from '../src/agents/registry.js'
import { GroupChat } from '../src/orchestrator/group.js'
import { PrivateChat } from '../src/chat/private.js'
import { REMOTE_POLICY } from '../src/remote/whitelist.js'
import { IPC } from '../src/ipc/contract.js'
import { executeJsonCli, RpcProcess } from '../src/engines/backends.js'

let root: string
let db: DB
let bridge: ToolBridge
beforeEach(async () => {
  const temp = path.resolve('../../.tmp/engine-tests')
  fs.mkdirSync(temp, { recursive: true })
  root = fs.mkdtempSync(path.join(temp, 'run-'))
  db = openDb(buildPaths(root)); bridge = new ToolBridge(); await bridge.start()
})
afterEach(async () => { await bridge.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })

describe('执行引擎会话与工具契约', () => {
  it('分段 UTF-8 JSON + 最终快照不重复，正文、思考和工具结果保留', () => {
    const reply = new ReplyCollector(() => {})
    const parser = new JsonStreamParser(reply, 'claude')
    const lines = new JsonLines((event) => parser.receive(event))
    const events = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } } },
      { type: 'assistant', message: { id: 'msg', content: [{ type: 'text', text: '你好世界' }, { type: 'thinking', thinking: '思考' }, { type: 'tool_use', id: 't', name: 'Read', input: { path: 'file' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: '内容' }] } },
      { type: 'result', subtype: 'success', result: '你好世界', session_id: 'native' },
    ]
    const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join('\n'))
    for (let i = 0; i < bytes.length; i++) lines.push(bytes.subarray(i, i + 1))
    lines.end()
    expect(reply.values().filter((part) => part.type === 'text')).toEqual([{ id: 'msg:0', type: 'text', text: '你好世界' }])
    expect(reply.values()).toContainEqual({ id: 't', type: 'tool', tool: 'Read', state: { status: 'completed', input: { path: 'file' }, output: '内容' } })
    expect(parser.success).toBe(true); expect(parser.sessionId).toBe('native')
  })
  it('有正文但缺少成功结束事件不算执行成功', () => {
    const parser = new JsonStreamParser(new ReplyCollector(() => {}), 'cursor')
    parser.receive({ type: 'assistant', message: { content: [{ type: 'text', text: '看起来成功' }] } })
    expect(parser.success).toBe(false); expect(parser.terminal).toBe(false)
    parser.receive({ type: 'result', subtype: 'error', is_error: true })
    expect(parser.success).toBe(false)
  })
  it('Cursor 增量、工具前 flush 与最终 flush 对账，保留思考和真实用量', () => {
    const reply = new ReplyCollector(() => {})
    const parser = new JsonStreamParser(reply, 'cursor')
    const message = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
    parser.receive({ type: 'thinking', subtype: 'delta', text: '检查文件' })
    parser.receive({ type: 'assistant', timestamp_ms: 1, message: message('你好') })
    parser.receive({ type: 'assistant', timestamp_ms: 2, model_call_id: 'flush', message: message('你好') })
    parser.receive({ type: 'assistant', timestamp_ms: 3, message: message('世界') })
    parser.receive({ type: 'assistant', message: message('你好世界') })
    parser.receive({ type: 'result', subtype: 'success', result: '你好世界', session_id: 's', usage: { inputTokens: 123, outputTokens: 45 } })
    expect(reply.values().filter((part) => part.type === 'text')).toEqual([{ id: 'cursor-text', type: 'text', text: '你好世界' }])
    expect(reply.values()).toContainEqual({ id: 'cursor-thinking:0', type: 'reasoning', text: '检查文件' })
    expect(parser.tokens).toEqual({ input: 123, output: 45 })
  })
  it('Cursor 嵌套调用 ID 合并起止事件；两种 JSON CLI 保留工具失败', () => {
    const reply = new ReplyCollector(() => {})
    const cursor = new JsonStreamParser(reply, 'cursor')
    cursor.receive({ type: 'tool_call', subtype: 'started', timestamp_ms: 1, tool_call: { toolCallId: 'call-1', readToolCall: { args: { path: 'missing' } } } })
    cursor.receive({ type: 'tool_call', subtype: 'completed', timestamp_ms: 2, tool_call: { toolCallId: 'call-1', readToolCall: { args: { path: 'missing' }, result: { error: '文件不存在' } } } })
    expect(reply.values()).toHaveLength(1)
    expect(reply.values()[0]).toMatchObject({ id: 'call-1', tool: 'read', state: { status: 'error' } })
    const claude = new JsonStreamParser(reply, 'claude')
    claude.receive({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: '读盘失败' }] } })
    expect(reply.values()[0]).toMatchObject({ state: { status: 'error', output: '读盘失败' } })
  })
  it('旧智能体默认 OpenCode，限制智能体不能绕过权限选择外部引擎', () => {
    const ordinary = agentRepo(db).create({ name: '开发' })
    expect(ordinary.execution_engine).toBe('opencode')
    expect(() => agentRepo(db).create({ name: '医护助手', execution_engine: 'codex' })).toThrow('禁用规则')
    expect(() => agentRepo(db).update(ordinary.id, { execution_engine: 'claude', category: '智慧病房' })).toThrow('禁用规则')
    expect(agentRepo(db).get(ordinary.id)?.execution_engine).toBe('opencode')
    expect(REMOTE_POLICY[IPC.enginesPathSave].policy).toBe('deny')
  })
  it('MCP 身份来自会话；隐藏的管理工具、伪造身份与关闭后凭证都被拒绝', async () => {
    let received: unknown
    bridge.register('jeff_memory', async (args) => { received = args; return 'saved' })
    bridge.register('jeff_agent_create', async () => { throw new Error('不应执行') })
    const session = bridge.openMcpSession('session-a', 'agent-a', new Set(['jeff_agent_create']))
    const call = async (method: string, params?: unknown) => (await fetch(session.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as Promise<any>
    const tools = await call('tools/list')
    expect(tools.result.tools.some((tool: any) => tool.name === 'jeff_agent_create')).toBe(false)
    expect((await call('tools/call', { name: 'jeff_agent_create' })).result.isError).toBe(true)
    expect((await call('tools/call', { name: 'jeff_memory', arguments: { __ctx: { sessionID: 'victim' } } })).result.isError).toBe(true)
    await call('tools/call', { name: 'jeff_memory', arguments: { action: 'get' } })
    expect(received).toEqual({ action: 'get', __ctx: { sessionID: 'session-a', agent: 'agent-a' } })
    session.close()
    expect((await fetch(session.url, { method: 'POST', body: '{}' })).status).toBe(403)
  })
  it('外部会话本地历史、改名、引擎切换与旧会话激活保持归属', async () => {
    const agent = agentRepo(db).create({ name: '开发', execution_engine: 'claude' })
    const client = new EngineClient(0, { db, root, workspace: root, bridge, mcp: () => ({}) })
    client.probe = async (id) => ({ id, label: id, path: '/fake', available: true, capabilities: { images: true, thinking: true, compression: false, contextStats: false, restrictedAgents: false } })
    const chat = new PrivateChat(db, () => client)
    const first = await chat.ensureSession(agent.id, agent.name)
    const cron = await chat.ensureDedicatedSession(agent.id, 'session:cron:one')
    expect(cron).not.toBe(first)
    await client.updateSession(first, { title: '历史' })
    expect((await client.getSession(first)).title).toBe('历史')
    agentRepo(db).update(agent.id, { execution_engine: 'codex' })
    const next = await chat.ensureSession(agent.id, agent.name)
    expect(next).not.toBe(first); expect(client.sessionEngine(first)).toBe('claude'); expect(client.sessionEngine(next)).toBe('codex')
    kvRepo(db).set(`engine:activated:${first}`, agent.id)
    kvRepo(db).set(`session:private:${agent.id}`, first)
    expect(await chat.ensureSession(agent.id, agent.name)).toBe(first)
    expect(await client.getMessages(first)).toEqual([])
    expect(() => client.sessionCompatible(first, 'unknown')).not.toThrow()
  })
  it('混合引擎群成员、群话题和定时任务各自隔离会话，拒绝跨身份激活', async () => {
    const a = agentRepo(db).create({ name: '成员A', execution_engine: 'codex' })
    const b = agentRepo(db).create({ name: '成员B', execution_engine: 'claude' })
    const project = projectRepo(db).create({ title: '混合群', leader_agent_id: a.id })
    const client = new EngineClient(0, { db, root, workspace: root, bridge, mcp: () => ({}) })
    client.probe = async (id) => ({ id, path: '/fake', label: id, available: true, capabilities: { images: true, thinking: true, compression: false, contextStats: false, restrictedAgents: false } })
    const group = new GroupChat(db, () => client)
    const first = await group.ensureSession(project.id, a.id)
    const second = await group.ensureSession(project.id, b.id)
    expect(client.sessionEngine(first)).toBe('codex'); expect(client.sessionEngine(second)).toBe('claude')
    const newThread = group.threads.createThread(project.id, '独立话题')
    const third = await group.ensureSession(project.id, a.id, newThread.id)
    expect(new Set([first, second, third]).size).toBe(3)
    expect(() => client.assertSessionOwner(first, b.id)).toThrow('其它智能体')
    kvRepo(db).set(`engine:activated:${first}`, b.id)
    expect(client.sessionCompatible(first, b.id)).toBe(false)
  })
  it('Windows npm shim resolves JS without interpolating shell metacharacters', () => {
    const entry = path.join(root, 'node_modules', 'cli', 'index.js')
    fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, '')
    const shim = path.join(root, 'cli.cmd'); fs.writeFileSync(shim, '@"%dp0%/node_modules/cli/index.js" %*')
    expect(executableCommand(shim).prefix).toEqual([entry])
  })
  it('Windows Cursor 官方启动器选择最新完整版本，不经过 PowerShell 解析提示词', () => {
    const shim = path.join(root, 'cursor-agent.cmd')
    fs.writeFileSync(shim, 'powershell.exe -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*')
    expect(() => executableCommand(shim)).toThrow('没有可用')
    for (const version of ['2026.08.31-4057e58', '2026.10.01-e373342', '2026.10.02-ffffff']) {
      const directory = path.join(root, 'versions', version)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'index.js'), '')
      if (!version.includes('10.02')) fs.writeFileSync(path.join(directory, 'node.exe'), '')
    }
    const chosen = path.join(root, 'versions', '2026.10.01-e373342')
    expect(executableCommand(shim)).toEqual({ file: path.join(chosen, 'node.exe'), prefix: [path.join(chosen, 'index.js')] })
    expect(executableCommand(path.join(root, 'cursor-agent.ps1'))).toEqual(executableCommand(shim))
  })
  it('真实子进程协议：续接 ID、MCP 服务端参数与历史落库一致', async () => {
    const binary = path.join(root, 'claude-fixture.cjs')
    fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
let input=''; process.stdin.on('data', b=>input+=b); process.stdin.on('end', async()=>{ try {
 const mcp=JSON.parse(fs.readFileSync(process.cwd()+'/mcp.json','utf8')).mcpServers.jeff;
 const result=await fetch(mcp.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'jeff_memory',arguments:{action:'add',text:'服务端事实'}}})}).then(r=>r.json());
 const resumed=process.argv.includes('--resume');
 console.log(JSON.stringify({type:'assistant',message:{id:'reply',content:[{type:'text',text:resumed?'续接':'首轮'}]}}));
 console.log(JSON.stringify({type:'result',subtype:'success',session_id:'native-fixture',result:result.result.content[0].text}));
} catch(e) { console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:e.message})); process.exitCode=1 }
});`, { mode: 0o700 })
    // --version and --help are read-only discovery; run transport uses the fixture above.
    const agent = agentRepo(db).create({ name: '协议测试', execution_engine: 'claude' })
    const received: any[] = []
    bridge.register('jeff_memory', async (args) => { received.push(args); return '服务端已保存' })
    const client = new EngineClient(0, { db, root, workspace: root, bridge, mcp: () => ({}) })
    client.probe = async (id) => ({ id, path: binary, label: id, available: true, capabilities: { images: true, thinking: true, compression: false, contextStats: false, restrictedAgents: false } })
    const session = await client.createSession({ agent: agentSlug(agent.id) })
    await client.sendMessage({ sessionId: session.id, text: '第一轮' })
    await client.sendMessage({ sessionId: session.id, text: '第二轮' })
    const history = await client.getMessages(session.id)
    expect(history.map((message) => message.info.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(history[3].parts).toContainEqual({ id: 'reply:0', type: 'text', text: '续接' })
    expect(received).toHaveLength(2)
    expect(received[0].__ctx.sessionID).toBe(session.id)
    expect(received[0].text).toBe('服务端事实')
    const restarted = new EngineClient(0, { db, root, workspace: root, bridge, mcp: () => ({}) })
    expect(await restarted.getMessages(session.id)).toEqual(history)
  })
  it('CLI 退出码 0 但没有终态必须失败；停止会释放正在运行的进程', async () => {
    const binary = path.join(root, 'silent-cli')
    fs.writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end",()=>process.exit(0))', { mode: 0o700 })
    const input = { engine: 'cursor' as const, binary, cwd: root, env: process.env, extraArgs: [], text: 'hello', signal: new AbortController().signal, reply: new ReplyCollector(() => {}), session: () => {} }
    await expect(executeJsonCli(input)).rejects.toThrow('未成功完成')
    fs.writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdin.resume(); setInterval(()=>{},1000)', { mode: 0o700 })
    const controller = new AbortController()
    const pending = executeJsonCli({ ...input, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow('已停止')
  })
  it.skipIf(process.platform === 'win32')('CLI 主进程异常退出后仍清理其遗留子进程组', async () => {
    const file = path.join(root, 'orphan.cjs')
    const pidFile = path.join(root, 'descendant.pid')
    fs.writeFileSync(file, `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(1)`)
    const child = launch(process.execPath, [file], root, process.env)
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    try {
      await stopProcess(child)
      await new Promise(resolve => setTimeout(resolve, 50))
      const stat = `/proc/${pid}/stat`
      expect(!fs.existsSync(stat) || fs.readFileSync(stat, 'utf8').split(' ')[2] === 'Z').toBe(true)
    } finally { try { process.kill(pid, 'SIGKILL') } catch { /* Already stopped. */ } }
  })
  it('RPC 启动退出时立即拒绝等待中的请求', async () => {
    const binary = path.join(root, 'dead-rpc')
    fs.writeFileSync(binary, '#!/usr/bin/env node\nprocess.exit(1)', { mode: 0o700 })
    const rpc = new RpcProcess(binary, [], root, process.env)
    try { await expect(rpc.request('initialize', {})).rejects.toThrow('已退出') }
    finally { await rpc.close() }
  })
})


it('Cursor MCP 配置位于 Jeff 私有工作目录，保持真实项目配置不变', async () => {
  const { prepareEnvironment } = await import('../src/engines/environment.js')
  const workspace = path.join(root, 'real-project')
  fs.mkdirSync(path.join(workspace, '.cursor'), { recursive: true })
  const original = path.join(workspace, '.cursor', 'mcp.json')
  fs.writeFileSync(original, '{"mcpServers":{"original":{}}}')
  const result = prepareEnvironment(root, 'isolated-session', 'cursor', '身份约定', workspace, 'http://127.0.0.1:1234/mcp/session', { plugin: { type: 'remote', enabled: true, url: 'http://127.0.0.1:5678/mcp', headers: { 'X-Test': 'fixture' } } })
  const injected = JSON.parse(fs.readFileSync(path.join(result.cwd, '.cursor', 'mcp.json'), 'utf8'))
  expect(injected.mcpServers.jeff.url).toBe('http://127.0.0.1:1234/mcp/session')
  expect(injected.mcpServers.plugin.headers).toEqual({ 'X-Test': 'fixture' })
  expect(fs.readFileSync(original, 'utf8')).toBe('{"mcpServers":{"original":{}}}')
})


it('Cursor 实际 MCP 事件保留真实工具名和参数，记忆调用可识别并隐藏诊断内容', () => {
  const reply = new ReplyCollector(() => {})
  const parser = new JsonStreamParser(reply, 'cursor')
  const args = { name: 'jeff-jeff_memory', toolName: 'jeff_memory', args: { action: 'add', text: 'api_key=test-private-value', privacy: 'private' } }
  parser.receive({ type: 'tool_call', subtype: 'started', call_id: 'mcp-call', tool_call: { mcpToolCall: { args } } })
  parser.receive({ type: 'tool_call', subtype: 'completed', call_id: 'mcp-call', tool_call: { mcpToolCall: { args, result: { success: { content: [{ type: 'text', text: '{"ok":true}' }] } } } } })
  const tool = reply.values()[0] as any
  expect(tool.tool).toBe('jeff_memory')
  expect(tool.state.input).toEqual(args.args)
  expect(tool.state.status).toBe('completed')
})

it('Claude 缺失或变化的快照 ID 不重复正文，空快照不抹掉流式输出', () => {
  const reply = new ReplyCollector(() => {})
  const parser = new JsonStreamParser(reply, 'claude')
  parser.receive({ type: 'stream_event', event: { type: 'message_start', message: { id: 'delta-native' } } })
  parser.receive({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '中文回答' } } })
  parser.receive({ type: 'assistant', message: { id: 'snapshot-native', content: [{ type: 'text', text: '中文回答' }] } })
  parser.receive({ type: 'assistant', message: { id: 'snapshot-native', content: [{ type: 'text', text: '' }] } })
  parser.receive({ type: 'stream_event', event: { type: 'message_start', message: {} } })
  parser.receive({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第二段' } } })
  parser.receive({ type: 'assistant', message: { content: [{ type: 'text', text: '第二段' }] } })
  parser.receive({ type: 'result', subtype: 'success', result: '第二段', session_id: 'native' })
  expect(reply.values().filter(part => part.type === 'text').map(part => (part as any).text)).toEqual(['中文回答', '第二段'])
})

it('Claude 仅返回空正文快照时采用成功终态的实际正文', () => {
  const reply = new ReplyCollector(() => {})
  const parser = new JsonStreamParser(reply, 'claude')
  parser.receive({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } })
  parser.receive({ type: 'result', subtype: 'success', result: '真实结果', session_id: 'native' })
  expect(reply.values().filter(part => part.type === 'text')).toEqual([{ id: 'result', type: 'text', text: '真实结果' }])
})

it('Claude 实际协议按内容块独立发送快照，正文索引不会覆盖思考或重复', () => {
  const reply = new ReplyCollector(() => {})
  const parser = new JsonStreamParser(reply, 'claude')
  parser.receive({ type: 'stream_event', event: { type: 'message_start', message: { id: 'native' } } })
  for (const [index, type, value] of [[0, 'thinking', '分析'], [1, 'text', '实际回答']] as const) {
    parser.receive({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type } } })
    parser.receive({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: type === 'text' ? { type: 'text_delta', text: value } : { type: 'thinking_delta', thinking: value } } })
    parser.receive({ type: 'assistant', message: { id: 'native', content: [type === 'text' ? { type, text: value } : { type, thinking: value }] } })
  }
  expect(reply.values()).toEqual([{ id: 'native:0', type: 'reasoning', text: '分析' }, { id: 'native:1', type: 'text', text: '实际回答' }])
})

it('Claude 身份规则通过私有文件显式注入，命令行不包含记忆内容', async () => {
  const { prepareEnvironment } = await import('../src/engines/environment.js')
  const system = '身份：测试助手；api_key=test-private-system'
  const result = prepareEnvironment(root, 'claude-system', 'claude', system, path.join(root, 'real-workspace'), 'http://127.0.0.1:1234/mcp/session', {})
  expect(result.extraArgs).toContain('--bare')
  const flag = result.extraArgs.indexOf('--append-system-prompt-file')
  expect(flag).toBeGreaterThan(-1)
  expect(fs.readFileSync(result.extraArgs[flag + 1], 'utf8')).toContain(system)
  expect(result.extraArgs.join(' ')).not.toContain('test-private-system')
})

it('Claude resumed turns read identity rules from a private file and keep rule text out of argv', async () => {
  const binary = path.join(root, 'claude-snapshot-cli.cjs')
  const argvFile = path.join(root, 'claude-argv.json')
  fs.writeFileSync(binary, `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(2)));process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'assistant',message:{id:'native',content:[{type:'text',text:'updated rule used'}]}})+'\\n');process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'updated rule used',session_id:'native'})+'\\n')})`, { mode: 0o700 })
  const guide = path.join(root, 'private-system.md')
  fs.writeFileSync(guide, 'secret memory must stay out of arguments')
  const reply = new ReplyCollector(() => {})
  await executeJsonCli({ engine: 'claude', binary, cwd: root, env: process.env, extraArgs: ['--bare', '--append-system-prompt-file', guide], text: 'hello', nativeSessionId: 'existing-thread', signal: new AbortController().signal, reply, session: () => {} })
  const args = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as string[]
  expect(args).not.toContain('--system-prompt-snapshot')
  expect(args).toContain('--append-system-prompt-file')
  expect(args).toContain(guide)
  expect(args).toContain('existing-thread')
  expect(args.join(' ')).not.toContain('secret memory')
})
