import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 本机常见的 node / uv 等运行时 bin 目录。
 * GUI（桌面图标）启动的 Electron 继承的 PATH 通常不含 nvm 的 bin，
 * 导致 MCP local 命令（npx/uvx …）spawn 失败（终端启动则正常）——本机已装的解释器要补进 PATH。
 */
export function runtimeBinDirs(): string[] {
  const home = os.homedir()
  const dirs: string[] = []
  // nvm（可能装了多个版本，最新的排前面）
  try {
    const nvmRoot = path.join(home, '.nvm', 'versions', 'node')
    if (fs.existsSync(nvmRoot)) {
      const versions = fs
        .readdirSync(nvmRoot)
        .sort()
        .reverse()
        .map((v) => path.join(nvmRoot, v, process.platform === 'win32' ? '' : 'bin'))
      dirs.push(...versions)
    }
  } catch {
    /* 无 nvm */
  }
  // fnm / volta / asdf（常见布局）
  dirs.push(
    path.join(home, '.local', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.cargo', 'bin'),
    '/usr/local/bin',
  )
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'))
  }
  return dirs.filter(Boolean)
}

/** 在现有 PATH 前补上运行时 bin 目录（去重；已存在的目录不重复追加） */
export function augmentedPath(current?: string): string {
  const cur = current ?? process.env.PATH ?? ''
  const parts = cur.split(path.delimiter).filter(Boolean)
  const add = runtimeBinDirs().filter((d) => !parts.includes(d) && fs.existsSync(d))
  return [...add, ...parts].join(path.delimiter)
}
