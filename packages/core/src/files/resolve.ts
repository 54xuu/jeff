/**
 * 把聊天里识别出的路径解析成真实文件。
 * 顺序：绝对路径与 ~/ → 按基准目录精确拼接 → 受限递归搜索（同名取最近修改）。
 * 相对路径不允许用 ../ 或符号链接逃出基准目录。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const IGNORE = new Set(['.git', 'node_modules', '.tmp', '.DS_Store', 'Thumbs.db', '__pycache__', '.venv', '.idea', '.vscode', '.pytest_cache', '.next', '.cache', 'desktop.ini'])
const MAX_DEPTH = 5
const MAX_ENTRIES = 5000
const MAX_INPUTS = 200

const BLOCKED_EXT = new Set(['exe', 'bat', 'cmd', 'com', 'scr', 'ps1', 'sh', 'bash', 'zsh', 'app', 'msi', 'dll', 'so', 'dylib'])

export interface ResolvedFile {
  input: string
  abs: string
  kind: 'file' | 'dir'
}

export function isBlockedExecutable(target: string): boolean {
  const ext = path.extname(target).replace(/^\./, '').toLowerCase()
  return BLOCKED_EXT.has(ext)
}

/** reveal：调用方要求在文件夹中显示；block-reveal：可执行文件改为显示并提示 */
export function openDecision(target: string, reveal?: boolean): 'open' | 'reveal' | 'block-reveal' {
  if (reveal) return 'reveal'
  if (isBlockedExecutable(target)) return 'block-reveal'
  return 'open'
}

export async function resolveFilePaths(opts: { inputs: string[]; bases?: string[]; homeDir?: string }): Promise<ResolvedFile[]> {
  const home = opts.homeDir || os.homedir()
  const bases = [...new Set((opts.bases || []).map((b) => b.trim()).filter(Boolean).map((b) => path.resolve(b)))]
  const inputs = [...new Set(opts.inputs.map((s) => s.trim()).filter(Boolean))].slice(0, MAX_INPUTS)
  const indexCache = new Map<string, Indexed[]>()
  const out: ResolvedFile[] = []
  for (const input of inputs) {
    const decoded = decodeInput(input, home)
    if (isAbsolutePath(decoded)) {
      const hit = await accept(decoded, bases, true)
      if (hit) out.push({ input, abs: hit.abs, kind: hit.kind })
      continue
    }
    let exact: Located | null = null
    for (const base of bases) {
      const joined = joinInside(base, decoded)
      if (!joined) continue
      exact = await accept(joined, bases, false)
      if (exact) break
    }
    if (exact) {
      out.push({ input, abs: exact.abs, kind: exact.kind })
      continue
    }
    const searched = await searchBases(decoded, bases, indexCache)
    if (searched) out.push({ input, abs: searched.abs, kind: searched.kind })
  }
  return out
}

interface Located {
  abs: string
  kind: 'file' | 'dir'
  mtime: number
}

interface Indexed extends Located {
  rel: string
}

function decodeInput(input: string, home: string): string {
  let t = input.trim()
  if (/^file:\/\//i.test(t)) {
    const url = new URL(t)
    let p = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
    t = p
  }
  if (t === '~') return home
  if (t.startsWith('~/') || t.startsWith('~\\')) return path.join(home, t.slice(2))
  return t
}

function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)
}

function joinInside(base: string, rel: string): string | null {
  const abs = path.resolve(base, rel)
  const root = path.resolve(base)
  const back = path.relative(root, abs)
  if (back.startsWith('..') || path.isAbsolute(back)) return null
  return abs
}

async function accept(abs: string, bases: string[], allowOutside: boolean): Promise<Located | null> {
  const st = await fsp.stat(abs).catch(() => null)
  if (!st || (!st.isFile() && !st.isDirectory())) return null
  const real = await fsp.realpath(abs).catch(() => null)
  if (!real) return null
  if (!allowOutside && !(await insideAny(real, bases))) return null
  return { abs: real, kind: st.isDirectory() ? 'dir' : 'file', mtime: st.mtimeMs }
}

async function insideAny(real: string, bases: string[]): Promise<boolean> {
  for (const base of bases) {
    const root = await fsp.realpath(base).catch(() => null)
    if (!root) continue
    if (real === root || real.startsWith(root + path.sep)) return true
  }
  return false
}

async function searchBases(rel: string, bases: string[], cache: Map<string, Indexed[]>): Promise<Located | null> {
  const want = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  const hasSlash = want.includes('/')
  const baseName = want.split('/').pop() || want
  let best: Indexed | null = null
  for (const base of bases) {
    let entries = cache.get(base)
    if (!entries) {
      entries = []
      await walk(base, entries)
      cache.set(base, entries)
    }
    for (const entry of entries) {
      const norm = entry.rel.replace(/\\/g, '/')
      const matched = hasSlash ? norm === want || norm.endsWith(`/${want}`) : path.posix.basename(norm) === baseName
      if (!matched) continue
      if (!best || entry.mtime > best.mtime) best = entry
    }
  }
  return best
}

async function walk(base: string, entries: Indexed[]): Promise<void> {
  const budget = { n: 0 }
  const rec = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || budget.n >= MAX_ENTRIES) return
    const dirents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!dirents) return
    for (const ent of dirents) {
      if (budget.n >= MAX_ENTRIES) return
      if (IGNORE.has(ent.name) || ent.name.startsWith('.')) continue
      budget.n += 1
      const abs = path.join(dir, ent.name)
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isSymbolicLink()) {
        const real = await fsp.realpath(abs).catch(() => null)
        if (!real || !(await insideAny(real, [base]))) continue
        const st = await fsp.stat(abs).catch(() => null)
        if (!st) continue
        if (st.isDirectory()) {
          await rec(abs, childRel, depth + 1)
          continue
        }
        if (st.isFile()) entries.push({ abs: real, rel: childRel, kind: 'file', mtime: st.mtimeMs })
        continue
      }
      if (ent.isDirectory()) await rec(abs, childRel, depth + 1)
      else if (ent.isFile()) {
        const st = await fsp.stat(abs).catch(() => null)
        if (!st) continue
        entries.push({ abs, rel: childRel, kind: 'file', mtime: st.mtimeMs })
      }
    }
  }
  await rec(base, '', 0)
}
