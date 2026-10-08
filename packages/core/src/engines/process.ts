import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { StringDecoder } from 'node:string_decoder'

export function resolveExecutable(names: string[], explicit?: string): string | null {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.ps1'] : ['']
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.opencode', 'bin')]
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'cursor-agent'), path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'))
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'))
  }
  for (const name of explicit ? [explicit] : names) {
    for (const dir of path.isAbsolute(name) ? [''] : dirs) {
      for (const ext of extensions) {
        const candidate = path.isAbsolute(name) ? name + ext : path.join(dir, name + ext)
        try {
          fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
          if (fs.statSync(candidate).isFile()) return candidate
        } catch { /* Continue discovery. */ }
      }
    }
  }
  return null
}

/** Resolve npm shims to their JS entry point; never interpolate a prompt into cmd.exe. */
export function executableCommand(binary: string): { file: string; prefix: string[] } {
  if (/\.ps1$/i.test(binary)) {
    const shim = binary.replace(/\.ps1$/i, '.cmd')
    if (fs.existsSync(shim)) return executableCommand(shim)
    throw new Error('请指定 CLI 的原生 exe 或配套 cmd 启动器')
  }
  if (!/\.(cmd|bat)$/i.test(binary)) return { file: binary, prefix: [] }
  const source = fs.readFileSync(binary, 'utf8')
  const match = source.match(/(?:%dp0%|%~dp0)[\\/]([^"\r\n]+\.(?:c?js|mjs))/i)
  if (!match && /^(cursor-agent|agent)\.(cmd|bat)$/i.test(path.basename(binary)) && /cursor-agent\.ps1/i.test(source)) {
    // Cursor's official Windows shim delegates to PowerShell to pick a version.
    // Resolve that installed Node entry directly, keeping prompts out of shell parsing.
    const directory = path.dirname(binary)
    const versions = path.join(directory, 'versions')
    const installed = fs.existsSync(versions) ? fs.readdirSync(versions)
      .filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(name))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).map((name) => path.join(versions, name)) : []
    for (const candidate of [directory, ...installed]) {
      const node = path.join(candidate, 'node.exe')
      const entry = path.join(candidate, 'index.js')
      if (fs.existsSync(node) && fs.existsSync(entry)) return { file: node, prefix: [entry] }
    }
    throw new Error('Cursor 启动器没有可用的安装版本，请在本机修复 CLI 安装')
  }
  if (!match) throw new Error('不支持该 Windows 启动脚本，请选择 CLI 的原生 exe 或 npm 安装入口')
  const entry = path.resolve(path.dirname(binary), match[1])
  if (!fs.existsSync(entry)) throw new Error('CLI 启动脚本指向的文件不存在')
  const bundled = path.join(path.dirname(binary), 'node.exe')
  return { file: fs.existsSync(bundled) ? bundled : process.execPath, prefix: [entry] }
}

export function launch(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const command = executableCommand(binary)
  return spawn(command.file, [...command.prefix, ...args], {
    cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  })
}

export async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return
  if (child.exitCode !== null || child.signalCode !== null) {
    // Descendants may outlive a CLI that exited or crashed. The Unix group remains addressable.
    if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch { /* Group already gone. */ } }
    return
  }
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const signal = (force: boolean) => {
    if (process.platform === 'win32' && (child.exitCode !== null || child.signalCode !== null)) return
    if (process.platform === 'win32') {
      const args = ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])]
      execFile('taskkill.exe', args, { windowsHide: true }, () => {})
    } else {
      try { process.kill(-child.pid!, force ? 'SIGKILL' : 'SIGTERM') } catch { /* Already exited. */ }
    }
  }
  signal(false)
  let timer: NodeJS.Timeout | undefined
  await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000) })])
  if (timer) clearTimeout(timer)
  signal(true)
  await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000) })])
  if (timer) clearTimeout(timer)
}

/** UTF-8 and line boundaries may split anywhere, including between Chinese bytes. */
export class JsonLines {
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  constructor(private receive: (value: Record<string, any>) => void) {}
  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    this.drain()
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) throw new Error('CLI 消息超过 16MB，已停止执行')
  }
  end(): void {
    this.buffer += this.decoder.end()
    this.drain()
    if (this.buffer.trim()) this.receive(JSON.parse(this.buffer))
    this.buffer = ''
  }
  private drain(): void {
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.receive(JSON.parse(line))
    }
  }
}

export async function capture(binary: string, args: string[], timeout = 5000): Promise<string> {
  const child = launch(binary, args, os.homedir(), process.env)
  let output = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(0, 1024 * 1024) })
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000) })
  let timer: NodeJS.Timeout
  try {
    return await Promise.race([
      new Promise<string>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => code === 0
          ? resolve([output, stderr].filter(Boolean).join('\n').trim())
          : reject(new Error(`CLI 检测失败（退出码 ${code}）：${stderr.slice(0, 300)}`)))
      }),
      new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error('CLI 检测超时')), timeout) }),
    ])
  } finally { clearTimeout(timer!); await stopProcess(child) }
}
