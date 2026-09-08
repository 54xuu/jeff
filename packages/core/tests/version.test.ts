import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION } from '../src/version.js'

/** 防版本漂移：core 常量必须与三处 package.json 完全一致（AGENTS.md 发版规范） */
describe('版本一致性', () => {
  it('APP_VERSION 与三处 package.json 一致', () => {
    const coreDir = path.dirname(fileURLToPath(import.meta.url))
    const readVersion = (p: string): string => {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { version: string }
      return pkg.version
    }
    const versions = {
      app: APP_VERSION,
      root: readVersion(path.join(coreDir, '../../../package.json')),
      core: readVersion(path.join(coreDir, '../package.json')),
      desktop: readVersion(path.join(coreDir, '../../../apps/desktop/package.json')),
    }
    expect(new Set(Object.values(versions)).size).toBe(1)
  })
})
