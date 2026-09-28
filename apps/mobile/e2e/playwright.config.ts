import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    viewport: { width: 390, height: 844 },
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5277',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5277 --strictPort',
    cwd: appRoot,
    url: 'http://127.0.0.1:5277/?fixture=markdown',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
