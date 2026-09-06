import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { seedJeffHomeSync } from './seed.mjs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(__dirname, '../../../..')
export const DESKTOP_ROOT = path.resolve(__dirname, '../..')
export const DEFAULT_E2E_HOME = path.join(REPO_ROOT, '.tmp/jeff-e2e-home')
export const E2E_ENV_FILE = path.join(REPO_ROOT, '.tmp/e2e.env')

export function loadE2eEnv(file = E2E_ENV_FILE): Record<string, string> {
  if (!fs.existsSync(file)) return {}
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

export function electronBinary(): string {
  const electronPath = require('electron') as string
  if (!electronPath || !fs.existsSync(electronPath)) {
    throw new Error('找不到 electron 可执行文件，请先 npm install')
  }
  return electronPath
}

export function mainEntry(): string {
  const main = path.join(DESKTOP_ROOT, 'out/main/index.js')
  if (!fs.existsSync(main)) {
    throw new Error(`找不到 ${main}，请先 npm run build -w jeff-desktop`)
  }
  return main
}

export type SeedOpts = {
  apiKey?: string
  baseURL?: string
  modelId?: string
  providerId?: string
  providerName?: string
  mcp?: boolean
  mysqlPass?: string
  mysqlHost?: string
  testAgent?: boolean
}

export type LaunchResult = {
  app: ElectronApplication
  page: Page
  home: string
}

export async function launchJeff(opts: {
  home?: string
  seed?: SeedOpts
  envExtra?: Record<string, string>
}): Promise<LaunchResult> {
  const home = opts.home || DEFAULT_E2E_HOME
  const fileEnv = loadE2eEnv()
  if (opts.seed) {
    seedJeffHomeSync({
      home,
      apiKey: opts.seed.apiKey ?? fileEnv.SILICONFLOW_API_KEY ?? '',
      baseURL: opts.seed.baseURL ?? fileEnv.SILICONFLOW_BASE_URL,
      modelId: opts.seed.modelId ?? fileEnv.SILICONFLOW_MODEL,
      mysqlPass: opts.seed.mysqlPass ?? fileEnv.MYSQL_PASS,
      mysqlHost: opts.seed.mysqlHost ?? fileEnv.MYSQL_HOST,
      ...opts.seed,
    })
  } else if (!fs.existsSync(path.join(home, 'jeff.db'))) {
    seedJeffHomeSync({ home, apiKey: fileEnv.SILICONFLOW_API_KEY || '' })
  }

  const env = {
    ...process.env,
    ...fileEnv,
    JEFF_HOME: home,
    JEFF_E2E: '1',
    ...opts.envExtra,
  }
  // 开发态 E2E：优先用打包产物里的 opencode，再回退 PATH / ~/.opencode
  if (!env.JEFF_OPENCODE_BIN) {
    const cand = [
      path.join(DESKTOP_ROOT, 'release/linux-unpacked/resources/oc-bin/linux-x64/opencode'),
      path.join(process.env.HOME || '', '.opencode/bin/opencode'),
    ]
    for (const c of cand) {
      if (fs.existsSync(c)) {
        env.JEFF_OPENCODE_BIN = c
        break
      }
    }
  }

  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [mainEntry(), `--user-data-dir=${path.join(home, 'electron-user-data')}`, '--no-sandbox'],
    env,
    timeout: 60000,
  })

  const page = await app.firstWindow({ timeout: 60000 })
  await page.waitForSelector('[data-testid="nav-rail"]', { timeout: 60000 })
  return { app, page, home }
}

export async function closeJeff(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  const pid = proc?.pid
  try {
    await Promise.race([
      app.evaluate(async ({ app: electronApp }) => {
        electronApp.exit(0)
      }).catch(() => {}),
      new Promise<void>((r) => setTimeout(r, 800)),
    ])
  } catch {
    /* ignore */
  }
  try {
    await Promise.race([app.close().catch(() => {}), new Promise<void>((r) => setTimeout(r, 800))])
  } catch {
    /* ignore */
  }
  if (pid) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }
  try {
    proc?.kill('SIGKILL')
  } catch {
    /* ignore */
  }
}
