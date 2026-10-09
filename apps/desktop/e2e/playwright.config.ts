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
    { name: 'ui', testMatch: /(?:^|\/)(?:ui|p0-ux|file-links)\.spec\.ts$/ },
    { name: 'visual', testMatch: /visual\.spec\.ts/ },
    { name: 'v18', testMatch: /v18\.spec\.ts/ },
    { name: 'cron', testMatch: /cron\.spec\.ts/ },
    { name: 'engines', testMatch: /engines\.spec\.ts/ },
    { name: 'live', testMatch: /live\.spec\.ts/ },
    { name: 'live-file-links', testMatch: /live-file-links\.spec\.ts/ },
    { name: 'remote', testMatch: /remote\.spec\.ts/ },
    { name: 'file-links', testMatch: /file-links\.spec\.ts/ },
    { name: 'secrets', testMatch: /secrets\.spec\.ts/ },
  ],
})
