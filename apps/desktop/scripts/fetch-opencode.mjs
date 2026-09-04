#!/usr/bin/env node
// 下载 opencode CLI 二进制到 apps/desktop/resources/oc-bin/<platform>/，
// 供 electron-builder extraResources 打包进安装包。
// 用法：node scripts/fetch-opencode.mjs [version] [targets...]（默认 1.18.26 全平台）
import { execSync } from 'node:child_process'
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

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}: ${url}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest))
}

function extract(archive, dir) {
  if (archive.endsWith('.tar.gz')) {
    execSync(`tar -xzf "${archive}" -C "${dir}"`, { stdio: 'inherit' })
    return
  }
  if (process.platform === 'win32') {
    execSync(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${archive}' -DestinationPath '${dir}'"`, { stdio: 'inherit' })
  } else {
    execSync(`unzip -o -q "${archive}" -d "${dir}"`, { stdio: 'inherit' })
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
