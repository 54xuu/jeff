#!/usr/bin/env node
// Jeff 冒烟截图脚本：启动打包产物（或 electron 开发产物），逐视图截图后自动退出。
// 用法：node scripts/smoke.mjs <app 二进制路径> [选项]
//   --out <dir>      截图输出目录（默认 .tmp/smoke-shots）
//   --views <a,b,c>  视图列表：chat,contacts,group,settings:providers|memory|mcp|sync|appearance|about
//   --theme <t>      截图前切主题（light/dark）
//   --home <dir>     JEFF_HOME 覆盖（隔离数据目录）
//   --delay <ms>     启动后等待渲染就绪的时间（默认 2500）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const appBin = args[0] && !args[0].startsWith('--') ? args[0] : null
if (!appBin || !fs.existsSync(appBin)) {
  console.error('用法：node scripts/smoke.mjs <app 二进制路径> [--out dir] [--views a,b,c] [--theme dark] [--home dir] [--delay ms]')
  process.exit(1)
}
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const outDir = path.resolve(flag('out', '.tmp/smoke-shots'))
const views = flag('views', 'chat,contacts,settings:providers,settings:appearance,settings:memory,settings:mcp,settings:sync,settings:about')
const theme = flag('theme', '')
const home = flag('home', '')
const delay = Number(flag('delay', '2500'))

fs.mkdirSync(outDir, { recursive: true })
const env = {
  ...process.env,
  JEFF_SMOKE: '1',
  JEFF_SMOKE_VIEWS: views,
  JEFF_SMOKE_OUT_DIR: outDir,
  JEFF_SMOKE_DELAY_MS: String(delay),
}
if (theme) env.JEFF_SMOKE_THEME = theme
if (home) env.JEFF_HOME = home

console.log(`[smoke] 启动 ${appBin}`)
console.log(`[smoke] 视图: ${views}${theme ? ` · 主题: ${theme}` : ''} → ${outDir}`)
const child = spawn(appBin, [], { env, stdio: ['ignore', 'inherit', 'inherit'] })
const timer = setTimeout(() => {
  console.error('[smoke] 超时（120s），强制退出')
  child.kill('SIGKILL')
}, 120000)
child.on('exit', (code) => {
  clearTimeout(timer)
  const shots = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.png')) : []
  console.log(`[smoke] 退出码 ${code}，产出 ${shots.length} 张截图：`)
  for (const s of shots) console.log(`  - ${path.join(outDir, s)}`)
  process.exit(code === 0 && shots.length > 0 ? 0 : 1)
})
