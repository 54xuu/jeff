import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyAsarBuffer } from './asar-integrity.mjs'

const archivePath = process.argv[2] || `release/${process.platform === 'win32' ? 'win' : 'linux'}-unpacked/resources/app.asar`

const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/desktop/package.json')
const expected = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
let result
try {
  result = verifyAsarBuffer(fs.readFileSync(archivePath), { expectedVersion: expected.version, expectedMain: expected.main })
} catch (error) {
  result = { ok: false, path: archivePath, error: error.message }
}
console.log(JSON.stringify({
  path: archivePath,
  ...result,
  failureCount: result.failures?.length || 0,
  failures: result.failures?.slice(0, 20),
}, null, 2))
if (!result.ok) process.exitCode = 1
