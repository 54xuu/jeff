import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse, stringify } from 'smol-toml'
import type { EngineId } from './contract.js'
import type { McpServerCfg } from '../mcp/parse.js'
import { userSkillsDir } from '../paths.js'

const json = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
function copy(source: string, target: string): void {
  if (fs.existsSync(source)) { fs.copyFileSync(source, target); fs.chmodSync(target, 0o600) }
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

/** Only generated runtime files live here. Target projects and global CLI config remain untouched. */
export function prepareEnvironment(root: string, id: string, engine: EngineId, system: string, workspace: string,
  bridgeUrl: string, servers: Record<string, McpServerCfg>): { cwd: string; env: NodeJS.ProcessEnv; extraArgs: string[] } {
  const cwd = path.join(root, 'engines', engine, id)
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 })
  const env = { ...process.env }
  const skills = userSkillsDir()
  const skillGuide = fs.existsSync(skills) ? fs.readdirSync(skills).filter((name) => fs.existsSync(path.join(skills, name, 'SKILL.md')))
    .map((name) => `${name}: ${path.join(skills, name, 'SKILL.md')}`).join('\n') : ''
  const instructions = `${system}\n\n【工作目录】真实目标目录为 ${workspace}。文件操作使用该目录的绝对路径；所有命令先 cd 到该目录。当前运行目录仅用于 Jeff 会话配置。\n【技能】只使用以下技能；需要时读取对应 SKILL.md，不加载其它来源：\n${skillGuide}\n【提问】需要用户回答时用普通回复说明问题，不调用终端交互提问工具。`
  const mcp = nativeMcp(servers, bridgeUrl)
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
    return { cwd, env, extraArgs: [] }
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
    return { cwd, env, extraArgs: ['--bare', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', path.join(cwd, 'mcp.json'), '--add-dir', workspace, '--append-system-prompt-file', path.join(cwd, 'CLAUDE.md')] }
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
  return { cwd, env, extraArgs: ['--workspace', cwd, '--add-dir', workspace, '--trust', '--approve-mcps'] }
}
