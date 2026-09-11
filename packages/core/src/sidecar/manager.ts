import { spawn, ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { JeffPaths } from '../paths.js'
import { augmentedPath } from '../util/nodePath.js'

export type SidecarStatus = 'stopped' | 'starting' | 'running' | 'crashed'

export interface SidecarOptions {
  paths: JeffPaths
  /** 显式指定 opencode 可执行文件（最高优先级） */
  binaryPath?: string
  /** 打包资源内的二进制目录（如 resources/oc-bin），按平台子目录查找 */
  resourceBinDir?: string
  /** spawn 时追加的环境变量（每次 spawn 时求值，可按设置动态变化，如跳过 LLM 证书校验） */
  extraEnv?: () => Record<string, string>
  minPort?: number
  maxPort?: number
}

/** opencode sidecar 进程管理：解析二进制 → 隔离环境 spawn → 健康轮询 → 崩溃重启 */
export class SidecarManager extends EventEmitter {
  /** 健康检查连续失败阈值（15s 一次，3 次 ≈ 45s），达到即判假运行并杀进程重启 */
  private static readonly HEALTH_FAIL_LIMIT = 3

  private proc: ChildProcess | null = null
  private opts: SidecarOptions
  private restarts = 0
  private stopping = false
  /** 期望运行中（start 置位 / 显式 stop 复位）：自动重启只在该标志为真时执行，防止 stop 后被旧 timer 拉起 */
  private wantedRunning = false
  /** 排队中的自动重启 timer（显式 stop 时取消） */
  private restartTimer: NodeJS.Timeout | null = null
  /** 健康检查连续失败计数（进程在但 HTTP 不通的「假运行」；达到阈值杀进程走重启链路） */
  private healthFails = 0
  private healthTimer: NodeJS.Timeout | null = null
  /** start/stop/自动重启统一串行队列：避免手动重启与崩溃自动重启交错产生新旧进程混跑 */
  private lifecycleQueue: Promise<unknown> = Promise.resolve()
  port = 0
  /** 每次健康启动成功 +1；调用方据此判断是否需要重绑定客户端（自动重启会换端口） */
  generation = 0
  status: SidecarStatus = 'stopped'
  lastError = ''

  constructor(opts: SidecarOptions) {
    super()
    this.opts = opts
  }

  /** 串行执行生命周期操作，保证 stop→start 与崩溃自动重启不交错 */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycleQueue.then(fn, fn)
    this.lifecycleQueue = run.catch(() => {})
    return run
  }

  /** 解析 opencode 可执行文件路径 */
  resolveBinary(): string | null {
    if (this.opts.binaryPath && fs.existsSync(this.opts.binaryPath)) return this.opts.binaryPath
    const envBin = process.env.JEFF_OPENCODE_BIN
    if (envBin && fs.existsSync(envBin)) return envBin
    // 打包资源目录：resources/oc-bin/{linux-x64|windows-x64}/opencode(.exe)
    if (this.opts.resourceBinDir) {
      const plat = process.platform === 'win32' ? 'windows-x64' : 'linux-x64'
      const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
      const cand = path.join(this.opts.resourceBinDir, plat, exe)
      if (fs.existsSync(cand)) return cand
    }
    // 常见安装位置
    const home = process.env.HOME || ''
    for (const cand of [path.join(home, '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')]) {
      if (cand && fs.existsSync(cand)) return cand
    }
    // PATH
    const dirs = (process.env.PATH || '').split(path.delimiter)
    for (const d of dirs) {
      const exe = path.join(d, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
      if (fs.existsSync(exe)) return exe
    }
    return null
  }

  /** 隔离环境变量（XDG + OPENCODE_CONFIG_DIR 重定向，不碰用户全局 opencode 配置） */
  private sidecarEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      // GUI 启动时 PATH 常缺 nvm 的 bin，opencode 拉起的 MCP local 命令（npx/uvx）会找不到
      PATH: augmentedPath(),
      XDG_CONFIG_HOME: this.opts.paths.ocConfigHome,
      XDG_DATA_HOME: this.opts.paths.ocDataHome,
      // 强制 opencode 只用我们的配置目录（否则会回退加载 ~/.opencode/opencode.json 用户全局配置）
      OPENCODE_CONFIG_DIR: this.opts.paths.ocConfigDir,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      // 技能只认 Jeff 自己的 skills 目录，不扫 ~/.claude、~/.agents 等外部目录
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      // 阻止 opencode 读取项目级 .opencode 配置造成串扰：cwd 固定在 Jeff 工作区
      HOME: process.env.HOME,
      // 动态附加项放最后，允许覆盖（如 NODE_TLS_REJECT_UNAUTHORIZED=0 跳过 LLM 证书校验）
      ...(this.opts.extraEnv?.() ?? {}),
    }
  }

  async start(): Promise<number> {
    return this.runExclusive(() => this.doStart())
  }

  private async doStart(): Promise<number> {
    if (this.status === 'running' || this.status === 'starting') return this.port
    this.wantedRunning = true
    const bin = this.resolveBinary()
    if (!bin) {
      this.lastError = '未找到 opencode 可执行文件（检查 JEFF_OPENCODE_BIN / 资源目录 / PATH）'
      this.status = 'crashed'
      this.emit('status', this.status, this.lastError)
      throw new Error(this.lastError)
    }
    this.status = 'starting'
    this.emit('status', this.status)
    const port = await pickFreePort(this.opts.minPort ?? 14096, this.opts.maxPort ?? 15096)
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1']
    const proc = spawn(bin, args, {
      cwd: this.opts.paths.workspaceDir,
      env: this.sidecarEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.proc = proc
    this.port = port
    proc.stdout?.on('data', (d) => this.emit('log', `[sidecar:out] ${String(d)}`))
    proc.stderr?.on('data', (d) => this.emit('log', `[sidecar:err] ${String(d)}`))
    proc.on('exit', (code, signal) => {
      this.proc = null
      if (this.stopping) {
        this.status = 'stopped'
        this.emit('status', this.status)
        return
      }
      this.status = 'crashed'
      this.emit('status', this.status, `exit code=${code} signal=${signal}`)
      this.scheduleRestart()
    })
    // 健康轮询直到就绪
    const ok = await this.waitHealthy(15000)
    if (!ok) {
      // 启动超时：清掉本次 spawn 的进程，防止僵尸残留占用端口（exit 事件会安排自动重启）
      try {
        proc.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
      this.proc = null
      this.lastError = `sidecar 启动超时（端口 ${port}）`
      this.status = 'crashed'
      this.emit('status', this.status, this.lastError)
      throw new Error(this.lastError)
    }
    this.status = 'running'
    this.restarts = 0
    this.generation += 1
    // 之前启动失败/崩溃留下的旧错误不再代表当前状态：恢复运行即清空（历史可看日志，不挂在现时错误上）
    this.lastError = ''
    this.emit('status', this.status)
    // 通知绑定方换端口重绑客户端（初次启动与崩溃自动重启都会走到这里）
    this.emit('ready', { port: this.port, generation: this.generation })
    this.startHealthMonitor()
    return port
  }

  private startHealthMonitor(): void {
    this.stopHealthMonitor()
    this.healthFails = 0
    this.healthTimer = setInterval(() => {
      if (this.status !== 'running') return
      void this.ping().then((ok) => {
        if (this.status !== 'running') return
        if (ok) {
          this.healthFails = 0
          return
        }
        // HTTP 不健康但进程未退：连续多次失败视为「假运行」（卡死），杀掉走 exit → 自动重启链路恢复
        this.healthFails += 1
        this.emit('log', `[sidecar] 健康检查未通过（${this.healthFails}/${SidecarManager.HEALTH_FAIL_LIMIT}，进程仍在）`)
        if (this.healthFails >= SidecarManager.HEALTH_FAIL_LIMIT) {
          const proc = this.proc
          if (!proc) return
          this.lastError = '引擎健康检查连续失败，自动重启'
          this.emit('log', '[sidecar] 健康检查连续失败，终止假运行进程以触发自动重启')
          try {
            proc.kill('SIGKILL')
          } catch {
            /* 已退出 */
          }
        }
      })
    }, 15000)
    this.healthTimer.unref?.()
  }

  private stopHealthMonitor(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  private scheduleRestart(): void {
    if (this.stopping || !this.wantedRunning) return
    this.restarts += 1
    if (this.restarts > 5) {
      this.lastError = 'sidecar 连续崩溃超过 5 次，停止重启'
      this.emit('status', this.status, this.lastError)
      return
    }
    const delay = Math.min(1000 * this.restarts, 5000)
    this.emit('log', `[sidecar] ${delay}ms 后第 ${this.restarts} 次重启`)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopping && this.wantedRunning) void this.runExclusive(() => this.doStart()).catch(() => {})
    }, delay)
    this.restartTimer.unref?.()
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/doc`, { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch {
      return false
    }
  }

  /** opencode 版本（`--version`，带缓存；供设置页「引擎服务」展示） */
  private versionCache: string | null = null
  async version(): Promise<string | null> {
    if (this.versionCache) return this.versionCache
    const bin = this.resolveBinary()
    if (!bin) return null
    try {
      const { execFile } = await import('node:child_process')
      const out = await new Promise<string>((resolve, reject) => {
        execFile(bin, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
      })
      this.versionCache = out.trim() || null
      return this.versionCache
    } catch {
      return null
    }
  }

  private async waitHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.proc) return false
      if (await this.ping()) return true
      await sleep(250)
    }
    return false
  }

  async stop(): Promise<void> {
    return this.runExclusive(() => this.doStop())
  }

  private async doStop(): Promise<void> {
    this.stopping = true
    this.wantedRunning = false
    // 取消排队中的自动重启：显式 stop 后不允许旧 timer 把进程拉起来
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.stopHealthMonitor()
    const proc = this.proc
    this.proc = null
    const killWait = process.env.JEFF_E2E === '1' ? 800 : 3000
    if (proc) {
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve())
        try {
          proc.kill(process.env.JEFF_E2E === '1' ? 'SIGKILL' : 'SIGTERM')
        } catch {
          /* 已退出 */
        }
        setTimeout(() => {
          try {
            if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL')
          } catch {
            /* 忽略 */
          }
          resolve()
        }, killWait).unref?.()
      })
    }
    this.status = 'stopped'
    this.stopping = false
    this.emit('status', this.status)
  }
}

export function pickFreePort(min: number, max: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      const srv = net.createServer()
      srv.once('error', () => (p < max ? tryPort(p + 1) : reject(new Error('无可用端口'))))
      srv.once('listening', () => srv.close(() => resolve(p)))
      srv.listen(p, '127.0.0.1')
    }
    tryPort(min)
  })
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
