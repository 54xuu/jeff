#!/usr/bin/env node
// 下载 opencode CLI 二进制到 apps/desktop/resources/oc-bin/<platform>/，
// 供 electron-builder extraResources 打包进安装包。
// 用法：node scripts/fetch-opencode.mjs [version]（默认 1.18.26）
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = process.argv[2] || '1.18.26'
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(desktopDir, 'resources', 'oc-bin')

const TARGETS = process.argv[3]
  ? [process.argv[3]]
  : ['linux-x64', 'windows-x64']

function fetchTarget(target) {
  const dir = path.join(outDir, target)
  const marker = path.join(dir, `.version-${VERSION}`)
  const exe = target === 'windows-x64' ? 'opencode.exe' : 'opencode'
  if (fs.existsSync(marker) && fs.existsSync(path.join(dir, exe))) {
    console.log(`[fetch-opencode] ${target} 已就绪（${VERSION}）`)
    return
  }
  fs.mkdirSync(dir, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fetch-'))
  let url
  if (target === 'linux-x64') {
    url = `https://github.com/anomalyco/opencode/releases/download/v${VERSION}/opencode-linux-x64.tar.gz`
  } else if (target === 'windows-x64') {
    url = `https://github.com/anomalyco/opencode/releases/download/v${VERSION}/opencode-windows-x64.zip`
  } else {
    throw new Error(`未知目标: ${target}`)
  }
  console.log(`[fetch-opencode] 下载 ${url}`)
  const archive = path.join(tmp, path.basename(url))
  execSync(`curl -fsSL --retry 3 -o "${archive}" "${url}"`, { stdio: 'inherit' })
  if (url.endsWith('.tar.gz')) {
    execSync(`tar -xzf "${archive}" -C "${dir}"`, { stdio: 'inherit' })
  } else {
    if (process.platform === 'win32') {
      execSync(`powershell -Command "Expand-Archive -Force -Path '${archive}' -DestinationPath '${dir}'"`, { stdio: 'inherit' })
    } else {
      execSync(`unzip -o -q "${archive}" -d "${dir}"`, { stdio: 'inherit' })
    }
  }
  // 某些压缩包把二进制放在子目录，拍平
  const exePath = path.join(dir, exe)
  if (!fs.existsSync(exePath)) {
    const found = findFile(dir, exe)
    if (!found) throw new Error(`解压后未找到 ${exe}`)
    fs.renameSync(found, exePath)
  }
  if (process.platform !== 'win32') fs.chmodSync(exePath, 0o755)
  fs.writeFileSync(marker, VERSION)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`[fetch-opencode] ${target} → ${exePath}`)
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

import os from 'node:os'
for (const t of TARGETS) fetchTarget(t)
console.log('[fetch-opencode] 完成')
