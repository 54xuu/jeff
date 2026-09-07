#!/usr/bin/env node
// 下载 opencode CLI 二进制到 apps/desktop/resources/oc-bin/<platform>/，
// 供 electron-builder extraResources 打包进安装包。
// 用法：node scripts/fetch-opencode.mjs [version] [targets...]（默认 1.18.26 全平台）
import { execSync } from 'node:child_process'
import zlib from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const VERSION = process.argv[2] || '1.18.26'
const TARGETS = process.argv.slice(3).length ? process.argv.slice(3) : ['linux-x64', 'windows-x64']
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(desktopDir, 'resources', 'oc-bin')

function assetUrl(target) {
  if (target === 'linux-x64') {
    return `https://github.com/anomalyco/opencode/releases/download/v${VERSION}/opencode-linux-x64.tar.gz`
  }
  if (target === 'windows-x64') {
    return `https://github.com/anomalyco/opencode/releases/download/v${VERSION}/opencode-windows-x64.zip`
  }
  throw new Error(`未知目标: ${target}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// CI runner 下载 ~180MB 大文件偶发断流，单次 fetch 即失败会导致整个 release job 挂掉；
// 这里重试 3 次（2s/4s/8s 退避），fetch 与传输中途的失败都算。
async function downloadTo(url, dest) {
  const attempts = 3
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest))
      return
    } catch (err) {
      lastErr = err
      if (i < attempts) {
        const delay = 2000 * 2 ** (i - 1)
        console.log(`[fetch-opencode] 下载失败（第 ${i} 次）：${err.message}，${delay / 1000}s 后重试 ${url}`)
        await sleep(delay)
      }
    }
  }
  throw new Error(`下载失败（共 ${attempts} 次）: ${url} — ${lastErr?.message ?? lastErr}`)
}

/** 纯 Node 最小 zip 解压（store + deflate），跨平台无 shell 依赖 */
function extractZip(archive, dir) {
  const buf = fs.readFileSync(archive)
  // 找 End of Central Directory（0x06054b50，从尾部向前）
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: 未找到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip: central directory 损坏')
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    // local file header
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const data = buf.slice(dataStart, dataStart + compSize)
    const outPath = path.join(dir, name.replace(/\\/g, '/'))
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    if (method === 0) {
      fs.writeFileSync(outPath, data)
    } else if (method === 8) {
      fs.writeFileSync(outPath, zlib.inflateRawSync(data))
    } else {
      throw new Error(`zip: 不支持的压缩方法 ${method}（${name}）`)
    }
  }
}

function extract(archive, dir) {
  if (archive.endsWith('.tar.gz')) {
    execSync(`tar -xzf "${archive}" -C "${dir}"`, { stdio: 'inherit' })
  } else {
    extractZip(archive, dir)
  }
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return p
    if (entry.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    }
  }
  return null
}

async function fetchTarget(target) {
  const dir = path.join(outDir, target)
  const exe = target === 'windows-x64' ? 'opencode.exe' : 'opencode'
  const marker = path.join(dir, `.version-${VERSION}`)
  if (fs.existsSync(marker) && fs.existsSync(path.join(dir, exe))) {
    console.log(`[fetch-opencode] ${target} 已就绪（${VERSION}）`)
    return
  }
  fs.mkdirSync(dir, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fetch-'))
  const url = assetUrl(target)
  console.log(`[fetch-opencode] ${target} 下载 ${url}`)
  const archive = path.join(tmp, path.basename(url))
  await downloadTo(url, archive)
  console.log(`[fetch-opencode] ${target} 解压 → ${dir}`)
  extract(archive, dir)
  const exePath = path.join(dir, exe)
  if (!fs.existsSync(exePath)) {
    const found = findFile(dir, exe)
    if (!found) throw new Error(`解压后未找到 ${exe}（目录: ${JSON.stringify(fs.readdirSync(dir, { recursive: true }))}）`)
    fs.renameSync(found, exePath)
  }
  if (process.platform !== 'win32') fs.chmodSync(exePath, 0o755)
  fs.writeFileSync(marker, VERSION)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`[fetch-opencode] ${target} 完成 → ${exePath}`)
}

for (const t of TARGETS) {
  await fetchTarget(t)
}
console.log('[fetch-opencode] 全部完成')
