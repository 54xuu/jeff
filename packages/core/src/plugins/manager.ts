import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db/db.js'
import { kvRepo } from '../db/repos.js'
import type { McpServerCfg } from '../mcp/parse.js'
import type { PluginCommand, PluginInfo, PluginMcp } from '../ipc/contract.js'

/** 插件启用状态与密钥在本地 kv（不进 WebDAV：密钥敏感、启用状态跟机器走） */
const ENABLED_KEY = 'settings:plugins'
const SECRET_PREFIX = 'plugin-secret:'
/** 注入 MCP 的 key 前缀：避免覆盖用户手配的同名 server */
export const PLUGIN_MCP_PREFIX = 'plugin-'

export type PluginEnabledMap = Record<string, { enabled: boolean }>

/** plugin.json 的宽松形状（全部字段都在这里兜底校验，坏插件不应影响其它插件） */
interface RawPluginJson {
  id?: unknown
  name?: unknown
  version?: unknown
  icon?: unknown
  description?: unknown
  homepage?: unknown
  commands?: unknown
  mcp?: unknown
}

/**
 * 插件管理器：以目录为唯一事实源（~/.jeff/plugins/<id>/plugin.json）。
 *
 * 为什么以文件为主、DB 只存开关：插件天然是「用户可手工丢一个目录进来」的东西，
 * 让目录即注册表，删目录即卸载，最符合直觉；DB 里只放启用状态与密钥。
 */
export class PluginManager {
  private readonly kv

  constructor(
    private db: DB,
    private pluginsDir: string,
    private hooks: {
      /** 启用/停用后刷新 sidecar 配置（MCP 变更需引擎重启才生效） */
      onConfigChanged?: () => void
      onChanged?: () => void
      log?: (tag: string, detail?: unknown) => void
    } = {},
  ) {
    this.kv = kvRepo(db)
  }

  /** 插件根目录（不存在时创建） */
  root(): string {
    fs.mkdirSync(this.pluginsDir, { recursive: true })
    return this.pluginsDir
  }

  list(): PluginInfo[] {
    const enabledMap = this.kv.getJSON<PluginEnabledMap>(ENABLED_KEY, {})
    const dirs = this.listDirs()
    const out: PluginInfo[] = []
    for (const dir of dirs) {
      const info = this.readPlugin(dir, enabledMap)
      if (info) out.push(info)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  get(id: string): PluginInfo | undefined {
    return this.list().find((p) => p.id === id)
  }

  /** 已启用插件的快捷指令（聊天框 `/` 菜单数据源，name 已带前缀 /） */
  commands(): Array<PluginCommand & { pluginId: string; pluginName: string; icon: string }> {
    const out: Array<PluginCommand & { pluginId: string; pluginName: string; icon: string }> = []
    for (const p of this.list()) {
      if (!p.enabled || p.error) continue
      for (const c of p.commands) out.push({ ...c, pluginId: p.id, pluginName: p.name, icon: p.icon })
    }
    return out
  }

  /** 启用/停用：写 kv + 重算 MCP 注入并通知引擎刷新 */
  setEnabled(id: string, enabled: boolean): PluginInfo {
    const plugin = this.get(id)
    if (!plugin) throw new Error('插件不存在')
    if (plugin.error && enabled) throw new Error(`插件配置有误，无法启用：${plugin.error}`)
    const map = this.kv.getJSON<PluginEnabledMap>(ENABLED_KEY, {})
    map[id] = { enabled }
    this.kv.setJSON(ENABLED_KEY, map)
    this.applyMcpInjection()
    this.hooks.log?.('plugin-toggle', { id, enabled })
    this.hooks.onChanged?.()
    return this.get(id)!
  }

  saveSecret(id: string, secret: string): PluginInfo {
    if (!this.get(id)) throw new Error('插件不存在')
    const key = `${SECRET_PREFIX}${id}`
    if (secret) this.kv.set(key, secret)
    else this.kv.delete(key)
    this.applyMcpInjection()
    this.hooks.onChanged?.()
    return this.get(id)!
  }

  /**
   * 从本地目录导入插件：校验 plugin.json 后整目录复制到 ~/.jeff/plugins/<id>。
   * 同名已存在时覆盖（先校验再落盘，避免把已有插件搞坏）。
   */
  import(dir: string): PluginInfo {
    const src = path.resolve(dir)
    const manifest = path.join(src, 'plugin.json')
    if (!fs.existsSync(manifest)) throw new Error(`所选目录没有 plugin.json：${src}`)
    const parsed = this.parseManifest(manifest, path.basename(src))
    if (!parsed.info || parsed.error) throw new Error(parsed.error || 'plugin.json 解析失败')
    const id = parsed.info.id
    const dest = path.join(this.root(), id)
    if (path.resolve(src) === path.resolve(dest)) return this.get(id)!
    fs.rmSync(dest, { recursive: true, force: true })
    fs.cpSync(src, dest, { recursive: true })
    this.hooks.onChanged?.()
    const info = this.get(id)
    if (!info) throw new Error('导入失败：插件清单无法读取')
    return info
  }

  /** 卸载：删目录 + 清启用状态与密钥 + 摘掉 MCP 注入 */
  delete(id: string): { ok: boolean } {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('插件 id 非法')
    const dir = path.join(this.root(), id)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    const map = this.kv.getJSON<PluginEnabledMap>(ENABLED_KEY, {})
    delete map[id]
    this.kv.setJSON(ENABLED_KEY, map)
    this.kv.delete(`${SECRET_PREFIX}${id}`)
    this.applyMcpInjection()
    this.hooks.log?.('plugin-delete', { id })
    this.hooks.onChanged?.()
    return { ok: true }
  }

  /**
   * 把已启用插件的 MCP 声明写入 settings:mcp（key = plugin-<id>）。
   * 幂等：每次全量重算「插件贡献的部分」，用户手配的其它 server 原样保留。
   */
  applyMcpInjection(): void {
    const cur = this.kv.getJSON<Record<string, McpServerCfg>>('settings:mcp', {})
    const next: Record<string, McpServerCfg> = {}
    for (const [k, v] of Object.entries(cur)) {
      if (!k.startsWith(PLUGIN_MCP_PREFIX)) next[k] = v
    }
    for (const p of this.list()) {
      if (!p.enabled || p.error || !p.mcp) continue
      const cfg = this.toMcpCfg(p)
      if (cfg) next[`${PLUGIN_MCP_PREFIX}${p.id}`] = cfg
    }
    const before = JSON.stringify(cur)
    const after = JSON.stringify(next)
    if (before === after) return
    this.kv.setJSON('settings:mcp', next)
    this.hooks.log?.('plugin-mcp-injected', { servers: Object.keys(next).filter((k) => k.startsWith(PLUGIN_MCP_PREFIX)) })
    this.hooks.onConfigChanged?.()
  }

  private toMcpCfg(p: PluginInfo): McpServerCfg | null {
    const m = p.mcp
    if (!m) return null
    const secret = this.kv.get(`${SECRET_PREFIX}${p.id}`) || ''
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(m.headers || {})) headers[k] = String(v).replaceAll('${SECRET}', secret)
    if (m.type === 'local' || (!m.url && m.command?.length)) {
      if (!m.command?.length) return null
      const cfg: McpServerCfg = { type: 'local', enabled: true, command: m.command }
      if (m.environment) cfg.environment = m.environment
      return cfg
    }
    if (!m.url) return null
    const cfg: McpServerCfg = { type: 'remote', enabled: true, url: m.url }
    if (Object.keys(headers).length > 0) cfg.headers = headers
    return cfg
  }

  private listDirs(): string[] {
    try {
      return fs
        .readdirSync(this.root(), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => path.join(this.root(), e.name))
    } catch {
      return []
    }
  }

  private readPlugin(dir: string, enabledMap: PluginEnabledMap): PluginInfo | null {
    const manifest = path.join(dir, 'plugin.json')
    if (!fs.existsSync(manifest)) return null
    const { info, error } = this.parseManifest(manifest, path.basename(dir))
    const id = info?.id ?? path.basename(dir)
    const enabled = !!enabledMap[id]?.enabled
    if (!info) {
      // 坏插件也列出来（带错误），让用户看到「哪个插件有问题」而不是静默消失
      return {
        id,
        name: path.basename(dir),
        version: '',
        icon: '🧩',
        description: '',
        homepage: '',
        commands: [],
        mcp: null,
        enabled: false,
        dir,
        error: error || 'plugin.json 解析失败',
      }
    }
    return { ...info, enabled, dir, hasSecret: !!this.kv.get(`${SECRET_PREFIX}${info.id}`) }
  }

  /** 解析并校验 plugin.json（校验不通过返回 error，info 为 null） */
  private parseManifest(file: string, fallbackId: string): { info: Omit<PluginInfo, 'enabled' | 'dir' | 'hasSecret'> | null; error?: string } {
    let raw: RawPluginJson
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawPluginJson
    } catch (err) {
      return { info: null, error: `plugin.json 不是合法 JSON：${String((err as Error)?.message || err).slice(0, 200)}` }
    }
    const id = String(raw.id ?? fallbackId ?? '').trim()
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) return { info: null, error: `插件 id 非法（只允许字母数字 . _ -）：${id || '(空)'}` }
    const name = String(raw.name ?? id).trim() || id
    const homepage = String(raw.homepage ?? '').trim()
    if (homepage && !/^https?:\/\//i.test(homepage)) return { info: null, error: `homepage 必须是 http/https 地址：${homepage}` }
    const commands: PluginCommand[] = []
    if (raw.commands !== undefined) {
      if (!Array.isArray(raw.commands)) return { info: null, error: 'commands 必须是数组' }
      for (const c of raw.commands as unknown[]) {
        if (typeof c !== 'object' || c === null) return { info: null, error: 'commands 每一项必须是对象' }
        const o = c as Record<string, unknown>
        const nm = String(o.name ?? '').trim()
        const pr = String(o.prompt ?? '').trim()
        if (!nm.startsWith('/')) return { info: null, error: `指令名必须以 / 开头：${nm || '(空)'}` }
        if (!pr) return { info: null, error: `指令 ${nm} 缺少 prompt` }
        commands.push({ name: nm, ...(o.description ? { description: String(o.description) } : {}), prompt: pr })
      }
    }
    let mcp: PluginMcp | null = null
    if (raw.mcp !== undefined && raw.mcp !== null) {
      if (typeof raw.mcp !== 'object' || Array.isArray(raw.mcp)) return { info: null, error: 'mcp 必须是对象' }
      const m = raw.mcp as Record<string, unknown>
      const url = m.url === undefined ? '' : String(m.url)
      const command = Array.isArray(m.command) ? m.command.map(String) : m.command ? [String(m.command)] : []
      if (url && !/^https?:\/\//i.test(url)) return { info: null, error: `mcp.url 必须是 http/https 地址：${url}` }
      if (!url && command.length === 0) return { info: null, error: 'mcp 需要 url（remote）或 command（local）' }
      const headers: Record<string, string> = {}
      if (m.headers && typeof m.headers === 'object' && !Array.isArray(m.headers)) {
        for (const [k, v] of Object.entries(m.headers as Record<string, unknown>)) headers[k] = String(v)
      }
      const environment: Record<string, string> = {}
      if (m.environment && typeof m.environment === 'object' && !Array.isArray(m.environment)) {
        for (const [k, v] of Object.entries(m.environment as Record<string, unknown>)) environment[k] = String(v)
      }
      mcp = {
        ...(m.type === 'local' || m.type === 'remote' ? { type: m.type } : {}),
        ...(url ? { url } : {}),
        ...(command.length ? { command } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(Object.keys(environment).length ? { environment } : {}),
        ...(Array.isArray(m.tools) ? { tools: m.tools.map(String) } : {}),
      }
    }
    return {
      info: {
        id,
        name,
        version: String(raw.version ?? ''),
        icon: String(raw.icon ?? '🧩') || '🧩',
        description: String(raw.description ?? ''),
        homepage,
        commands,
        mcp,
      },
    }
  }
}
