import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse, stringify } from 'smol-toml'
import type { EngineId } from './contract.js'
import type { McpServerCfg } from '../mcp/parse.js'
import { skillsMount, userSkillsDir } from '../paths.js'
import { injectableEnv } from '../secrets/vault.js'

const json = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
function copy(source: string, target: string): void {
  if (fs.existsSync(source)) { fs.copyFileSync(source, target); fs.chmodSync(target, 0o600) }
}

function parseJsonc(text: string): Record<string, any> {
  let clean = ''
  let quoted = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (lineComment) { if (c === '\n' || c === '\r') { lineComment = false; clean += c } else clean += ' '; continue }
    if (blockComment) { if (c === '*' && next === '/') { clean += '  '; i++; blockComment = false } else clean += c === '\n' || c === '\r' ? c : ' '; continue }
    if (quoted) {
      clean += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') { quoted = true; clean += c; continue }
    if (c === '/' && next === '/') { lineComment = true; clean += '  '; i++; continue }
    if (c === '/' && next === '*') { blockComment = true; clean += '  '; i++; continue }
    clean += c
  }
  let withoutTrailingCommas = ''
  quoted = false
  escaped = false
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    if (quoted) {
      withoutTrailingCommas += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') { quoted = true; withoutTrailingCommas += c; continue }
    if (c === ',') {
      let next = i + 1
      while (/\s/.test(clean[next] || '')) next++
      if (clean[next] === '}' || clean[next] === ']') continue
    }
    withoutTrailingCommas += c
  }
  const parsed = JSON.parse(withoutTrailingCommas)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('系统 OpenCode 配置根节点必须为对象')
  return parsed
}

export function systemOpenCodePaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): { config: string[]; auth: string[] } {
  // XDG_*_HOME point to the base directory; OpenCode stores its own files in
  // the `opencode` child directory. OpenCode uses ~/.config and ~/.local/share
  // on Windows too, rather than roaming AppData.
  const configBase = env.XDG_CONFIG_HOME
    ? path.join(env.XDG_CONFIG_HOME, 'opencode')
    : path.join(home, '.config', 'opencode')
  const dataBase = env.XDG_DATA_HOME
    ? path.join(env.XDG_DATA_HOME, 'opencode')
    : path.join(home, '.local', 'share', 'opencode')
  const customConfig = env.OPENCODE_CONFIG
  const configDir = env.OPENCODE_CONFIG_DIR
  const config = [
    ...(customConfig ? [customConfig] : []),
    ...(configDir ? [path.join(configDir, 'opencode.json'), path.join(configDir, 'opencode.jsonc')] : []),
    path.join(configBase, 'opencode.json'), path.join(configBase, 'opencode.jsonc'),
    path.join(home, '.opencode', 'opencode.json'), path.join(home, '.opencode', 'opencode.jsonc'),
  ]
  const auth = [
    path.join(dataBase, 'auth.json'),
  ]
  return { config: [...new Set(config)], auth: [...new Set(auth)] }
}

export function readSystemOpenCodeProfile(env: NodeJS.ProcessEnv = process.env): { config: Record<string, any>; configPath?: string; authPath?: string } {
  const paths = systemOpenCodePaths(env)
  const configPath = paths.config.find((file) => fs.existsSync(file))
  const authPath = paths.auth.find((file) => fs.existsSync(file))
  let config: Record<string, any> = {}
  if (env.OPENCODE_CONFIG_CONTENT) {
    try { config = parseJsonc(env.OPENCODE_CONFIG_CONTENT) }
    catch { throw new Error('系统 OpenCode 的 OPENCODE_CONFIG_CONTENT 无法解析') }
  } else if (configPath) {
    try { config = parseJsonc(fs.readFileSync(configPath, 'utf8')) }
    catch { throw new Error('系统 OpenCode 配置无法解析；请检查 opencode.json / opencode.jsonc') }
  }
  return { config, ...(configPath ? { configPath } : {}), ...(authPath ? { authPath } : {}) }
}

export function systemOpenCodeModelOptions(env: NodeJS.ProcessEnv = process.env): Array<{ id: string; label: string }> {
  const { config } = readSystemOpenCodeProfile(env)
  const models: Array<{ id: string; label: string }> = []
  for (const [providerId, provider] of Object.entries(config.provider || {})) {
    if (!provider || typeof provider !== 'object') continue
    for (const [modelId, model] of Object.entries((provider as any).models || {})) {
      const qualified = `${providerId}/${modelId}`
      models.push({ id: qualified, label: `${(model as any)?.name || modelId} · ${providerId}` })
    }
  }
  if (typeof config.model === 'string' && config.model && !models.some((item) => item.id === config.model)) models.unshift({ id: config.model, label: `${config.model} · 系统默认` })
  return models.sort((a, b) => a.id.localeCompare(b.id))
}
export function nativeMcp(servers: Record<string, McpServerCfg>, bridgeUrl: string): Record<string, unknown> {
  const result: Record<string, unknown> = { jeff: { type: 'http', url: bridgeUrl } }
  for (const [name, server] of Object.entries(servers)) {
    if (!server.enabled || name === 'jeff') continue
    result[name] = server.type === 'local'
      ? { type: 'stdio', command: server.command?.[0], args: server.command?.slice(1) || [], env: server.environment || {} }
      : { type: 'http', url: server.url, headers: server.headers || {} }
  }
  return result
}

function openCodeMcp(servers: Record<string, McpServerCfg>, bridgeUrl: string): Record<string, unknown> {
  const result: Record<string, unknown> = { jeff: { type: 'remote', url: bridgeUrl, enabled: true } }
  for (const [name, server] of Object.entries(servers)) {
    if (!server.enabled || name === 'jeff') continue
    result[name] = server.type === 'local'
      ? { type: 'local', command: server.command || [], environment: server.environment || {}, enabled: true }
      : { type: 'remote', url: server.url, headers: server.headers || {}, enabled: true }
  }
  return result
}

/** Only generated runtime files live here. Target projects and global CLI config remain untouched. */
export function prepareEnvironment(root: string, id: string, engine: EngineId, system: string, workspace: string,
  bridgeUrl: string, servers: Record<string, McpServerCfg>, extraEnv: Record<string, string> = {}): { cwd: string; env: NodeJS.ProcessEnv; extraArgs: string[]; instructions: string } {
  const cwd = path.join(root, 'engines', engine, id)
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 })
  const env = { ...process.env, ...injectableEnv(extraEnv) }
  const skills = userSkillsDir()
  const skillGuide = fs.existsSync(skills) ? fs.readdirSync(skills).filter((name) => fs.existsSync(path.join(skills, name, 'SKILL.md')))
    .map((name) => `${name}: ${path.join(skills, name, 'SKILL.md')}`).join('\n') : ''
  const instructions = composeAdapterInstructions(system, workspace, skillGuide)
  const mcp = nativeMcp(servers, bridgeUrl)
  if (engine === 'opencode-system') {
    const profile = readSystemOpenCodeProfile(process.env)
    const configDir = path.join(cwd, 'config')
    const dataHome = path.join(cwd, 'data')
    const dataDir = path.join(dataHome, 'opencode')
    const agentDir = path.join(configDir, 'agent')
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const sourceConfig = profile.config
    const providers = sourceConfig.provider && typeof sourceConfig.provider === 'object' ? sourceConfig.provider : {}
    const config: Record<string, unknown> = {
      '$schema': 'https://opencode.ai/config.json',
      provider: providers,
      mcp: openCodeMcp(servers, bridgeUrl),
      skills: { paths: [skillsMount()] },
      permission: { '*': 'allow', question: 'deny', plan_enter: 'deny', plan_exit: 'deny' },
      snapshot: false,
      autoupdate: false,
      ...(typeof sourceConfig.model === 'string' ? { model: sourceConfig.model } : {}),
      ...(typeof sourceConfig.small_model === 'string' ? { small_model: sourceConfig.small_model } : {}),
    }
    const configFile = path.join(configDir, 'opencode.json')
    json(configFile, config)
    fs.writeFileSync(path.join(agentDir, 'jeff-agent.md'), `---\ndescription: ${JSON.stringify('Jeff Agent')}\nmode: all\n---\n\n${instructions}\n`, { mode: 0o600 })
    if (profile.authPath) copy(profile.authPath, path.join(dataDir, 'auth.json'))
    for (const key of ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_TUI_CONFIG']) delete env[key]
    env.OPENCODE_CONFIG = configFile
    env.OPENCODE_CONFIG_DIR = configDir
    env.XDG_CONFIG_HOME = path.join(cwd, 'xdg-config')
    env.XDG_DATA_HOME = dataHome
    env.XDG_STATE_HOME = path.join(cwd, 'xdg-state')
    if (process.platform === 'win32') {
      env.APPDATA = path.join(cwd, 'appdata')
      env.LOCALAPPDATA = path.join(cwd, 'local-appdata')
    }
    env.OPENCODE_DISABLE_AUTOUPDATE = '1'
    env.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1'
    return { cwd, env, extraArgs: ['--agent', 'jeff-agent'], instructions }
  }
  if (engine === 'codex') {
    const home = path.join(cwd, 'codex-home')
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    const source = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    const configPath = path.join(source, 'config.toml')
    const sourceConfig = fs.existsSync(configPath) ? parse(fs.readFileSync(configPath, 'utf8')) : {}
    const config: Record<string, any> = {}
    for (const key of ['model', 'model_provider', 'model_providers', 'model_reasoning_effort', 'service_tier', 'cli_auth_credentials_store']) {
      if (sourceConfig[key] !== undefined) config[key] = sourceConfig[key]
    }
    config.skills = { bundled: { enabled: false }, include_instructions: false }
    config.features = { plugins: false, apps: false, recommended_plugins: false, skip_host_skill_discovery: true, multi_agent: false, multi_agent_v2: false }
    config.agents = { enabled: false }
    config.developer_instructions = instructions
    config.approval_policy = 'never'
    config.sandbox_mode = 'danger-full-access'
    config.mcp_servers = Object.fromEntries(Object.entries(mcp).map(([name, raw]) => {
      const server = raw as any
      return [name, server.command ? { command: server.command, args: server.args, env: server.env }
        : { url: server.url, http_headers: server.headers || {} }]
    }))
    fs.writeFileSync(path.join(home, 'config.toml'), stringify(config), { mode: 0o600 })
    copy(path.join(source, 'auth.json'), path.join(home, 'auth.json'))
    env.CODEX_HOME = home
    return { cwd, env, extraArgs: [], instructions }
  }
  const configDir = path.join(cwd, 'config')
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  if (engine === 'claude') {
    const source = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    copy(path.join(source, '.credentials.json'), path.join(configDir, '.credentials.json'))
    const userSettings = path.join(source, 'settings.json')
    const original = fs.existsSync(userSettings) ? JSON.parse(fs.readFileSync(userSettings, 'utf8')) : {}
    const settings: Record<string, unknown> = {}
    for (const key of ['env', 'apiKeyHelper', 'model', 'awsAuthRefresh', 'awsCredentialExport']) if (original[key]) settings[key] = original[key]
    json(path.join(configDir, 'settings.json'), settings)
    env.CLAUDE_CONFIG_DIR = configDir
    json(path.join(cwd, 'mcp.json'), { mcpServers: mcp })
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), instructions)
    return { cwd, env, extraArgs: ['--bare', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', path.join(cwd, 'mcp.json'), '--add-dir', workspace, '--append-system-prompt-file', path.join(cwd, 'CLAUDE.md')], instructions }
  }
  const source = process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), '.cursor')
  const originalFile = path.join(source, 'cli-config.json')
  const original = fs.existsSync(originalFile) ? JSON.parse(fs.readFileSync(originalFile, 'utf8')) : {}
  const settings: Record<string, unknown> = {}
  for (const key of ['auth', 'authInfo', 'model', 'selectedModel', 'modelParameters', 'apiKey', 'endpoint', 'network']) if (original[key]) settings[key] = original[key]
  json(path.join(configDir, 'cli-config.json'), settings)
  json(path.join(configDir, 'mcp.json'), { mcpServers: mcp })
  // Cursor discovers project MCP from .cursor/mcp.json, including with a custom config directory.
  const projectConfig = path.join(cwd, '.cursor')
  fs.mkdirSync(projectConfig, { recursive: true, mode: 0o700 })
  json(path.join(projectConfig, 'mcp.json'), { mcpServers: mcp })
  env.CURSOR_CONFIG_DIR = configDir
  env.CURSOR_DATA_DIR = path.join(cwd, 'data')
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), instructions)
  return { cwd, env, extraArgs: ['--workspace', cwd, '--add-dir', workspace, '--trust', '--approve-mcps'], instructions }
}

/** Jeff-owned instruction payload appended for external CLI adapters. */
export function composeAdapterInstructions(system: string, workspace: string, skillGuide?: string): string {
  const guide = skillGuide ?? (() => {
    const skills = userSkillsDir()
    return fs.existsSync(skills) ? fs.readdirSync(skills).filter((name) => fs.existsSync(path.join(skills, name, 'SKILL.md')))
      .map((name) => `${name}: ${path.join(skills, name, 'SKILL.md')}`).join('\n') : ''
  })()
  return `${system}\n\n【工作目录】真实目标目录为 ${workspace}。文件操作使用该目录的绝对路径；所有命令先 cd 到该目录。当前运行目录仅用于 Jeff 会话配置。\n【技能】只使用以下技能；需要时读取对应 SKILL.md，不加载其它来源：\n${guide}\n【提问】需要用户回答时用普通回复说明问题，不调用终端交互提问工具。`
}
