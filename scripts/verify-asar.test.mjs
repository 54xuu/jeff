import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { verifyAsarBuffer } from './asar-integrity.mjs'

function makeAsar(files, metadata = {}) {
  const dataParts = []
  let offset = 0
  const tree = {}
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content)
    tree[name] = {
      size: bytes.length + (metadata[name]?.sizeDelta || 0),
      offset: String(offset + (metadata[name]?.offsetDelta || 0)),
      integrity: { hash: crypto.createHash('sha256').update(bytes).digest('hex') },
    }
    dataParts.push(bytes)
    offset += bytes.length
  }
  const json = Buffer.from(JSON.stringify({ files: tree }))
  const jsonPadding = Buffer.alloc((4 - (json.length % 4)) % 4)
  const payload = Buffer.concat([Buffer.alloc(4), json, jsonPadding])
  payload.writeUInt32LE(json.length, 0)
  const pickle = Buffer.concat([Buffer.alloc(4), payload])
  pickle.writeUInt32LE(payload.length, 0)
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(pickle.length, 4)
  return Buffer.concat([prefix, pickle, ...dataParts])
}

test('ASAR integrity verifier accepts a valid archive and checks app package metadata', () => {
  const archive = makeAsar({ 'package.json': JSON.stringify({ version: '1.12.0', main: 'out/main/index.js' }), 'out/main/index.js': 'ok' })
  const result = verifyAsarBuffer(archive, { expectedVersion: '1.12.0', expectedMain: 'out/main/index.js' })
  assert.equal(result.ok, true)
  assert.equal(result.entries, 2)
  assert.deepEqual(result.failures, [])
})

test('ASAR integrity verifier catches stale size and subsequent offsets after a changed entry', () => {
  const archive = makeAsar({
    'node_modules/@jeff/core/src/chat/private.ts': 'source text',
    'package.json': JSON.stringify({ version: '1.12.0', main: 'out/main/index.js' }),
    'out/main/index.js': 'main',
  }, {
    'node_modules/@jeff/core/src/chat/private.ts': { sizeDelta: 13 },
    'package.json': { offsetDelta: 13 },
    'out/main/index.js': { offsetDelta: 13 },
  })
  const result = verifyAsarBuffer(archive, { expectedVersion: '1.12.0', expectedMain: 'out/main/index.js' })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.path.includes('private.ts')))
  assert.ok(result.failures.some((failure) => failure.path === 'package.json'))
})

test('ASAR integrity verifier rejects malformed header boundaries and invalid package JSON', () => {
  assert.throws(() => verifyAsarBuffer(Buffer.alloc(20)), /ASAR header boundaries are invalid/)
  const archive = makeAsar({ 'package.json': '{invalid' })
  const result = verifyAsarBuffer(archive)
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.path === 'package.json'))
})
