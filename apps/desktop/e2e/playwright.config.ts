import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: root,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalTimeout: 600_000,
  projects: [
    { name: 'ui', testMatch: /ui\.spec\.ts/ },
    { name: 'live', testMatch: /live\.spec\.ts/ },
  ],
})
