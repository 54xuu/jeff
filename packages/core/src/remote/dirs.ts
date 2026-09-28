import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface FsDirEntry {
  name: string
  path: string
}

const SKIP = new Set(['.git', 'node_modules', '.tmp', '.DS_Store', 'Thumbs.db', '__pycache__', '.venv', '.idea', '.vscode', '.pytest_cache', '.next', '.cache', 'desktop.ini'])

/** 不传 dir 时给出根、家目录和几个常用文件夹；传了只列子目录。 */
export function listDirs(dir?: string): { dir: string; parent?: string; entries: FsDirEntry[] } {
  if (!dir) {
    const home = os.homedir()
    const entries: FsDirEntry[] = []
    if (process.platform === 'win32') {
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const p = `${letter}:\\`
        if (fs.existsSync(p)) entries.push({ name: `${letter}:`, path: p })
      }
    } else {
      entries.push({ name: '根目录', path: '/' })
    }
    entries.push({ name: '家目录', path: home })
    for (const name of ['Desktop', '桌面', 'Documents', '文档', 'Downloads', '下载']) {
      const p = path.join(home, name)
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) entries.push({ name, path: p })
    }
    return { dir: '', entries }
  }
  const abs = path.resolve(dir)
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    throw new Error('目录不存在')
  }
  if (!st.isDirectory()) throw new Error('不是目录')
  const names = fs.readdirSync(abs, { withFileTypes: true })
  const entries: FsDirEntry[] = []
  for (const e of names) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue
    entries.push({ name: e.name, path: path.join(abs, e.name) })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  const parent = path.dirname(abs)
  return { dir: abs, parent: parent === abs ? undefined : parent, entries }
}

/** 在已有父目录下新建一层文件夹。 */
export function makeDir(dir: string): string {
  const abs = path.resolve(dir)
  const parent = path.dirname(abs)
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error('上级目录不存在')
  fs.mkdirSync(abs)
  return abs
}
