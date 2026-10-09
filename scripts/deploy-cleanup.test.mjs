import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanupCompletedWindowsRun, isValidRunId, planSnapshotRetention } from './deploy-cleanup.mjs'

const id = (suffix) => `2026-10-09T12000${suffix}-000Z`
const stagedPackageNames = ['Jeff-2.1.1.AppImage', 'jeff-2.1.1.apk']

test('snapshot retention keeps three newest successes, one newest failure, and every unknown', () => {
  const snapshots = [
    { runId: id('1'), status: 'success' }, { runId: id('2'), status: 'success' },
    { runId: id('3'), status: 'success' }, { runId: id('4'), status: 'success' },
    { runId: id('5'), status: 'failed' }, { runId: id('6'), status: 'failed' },
    { runId: id('7'), status: 'unknown' },
  ]
  const plan = planSnapshotRetention(snapshots)
  assert.deepEqual(plan.keep.map((entry) => entry.runId), [id('7'), id('6'), id('4'), id('3'), id('2')])
  assert.deepEqual(plan.remove.map((entry) => entry.runId), [id('5'), id('1')])
})

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-deploy-clean-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const directory of ['backups', 'results', 'runs', 'install-requests', 'current', 'incoming']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true })
  }
  return root
}

function addSnapshot(root, runId, status) {
  fs.mkdirSync(path.join(root, 'backups', runId, 'jeff'), { recursive: true })
  fs.writeFileSync(path.join(root, 'backups', runId, 'jeff', 'profile.db'), 'snapshot')
  if (status !== 'unknown') {
    fs.mkdirSync(path.join(root, 'results', runId), { recursive: true })
    fs.writeFileSync(path.join(root, 'results', runId, 'outcome.json'), JSON.stringify({ runId, ok: status === 'success' }))
  }
}

test('cleanup prunes only known stale snapshots and run evidence already verified locally', (t) => {
  const root = fixture(t)
  const known = [
    [id('1'), 'success'], [id('2'), 'success'], [id('3'), 'success'], [id('4'), 'success'],
    [id('5'), 'failed'], [id('6'), 'failed'], [id('7'), 'unknown'],
  ]
  for (const [runId, status] of known) addSnapshot(root, runId, status)
  const current = id('8')
  addSnapshot(root, current, 'success')
  fs.mkdirSync(path.join(root, 'runs', current), { recursive: true })
  fs.mkdirSync(path.join(root, 'results', current), { recursive: true })
  fs.writeFileSync(path.join(root, 'results', current, 'outcome.json'), JSON.stringify({ runId: current, ok: true }))
  fs.mkdirSync(path.join(root, 'install-requests'), { recursive: true })
  fs.writeFileSync(path.join(root, 'install-requests', `${current}.json`), '{}')
  fs.writeFileSync(path.join(root, 'current', 'Jeff-2.1.1.AppImage'), 'current package')
  fs.writeFileSync(path.join(root, 'current', 'Jeff-1.8.0.AppImage'), 'unrelated staged package')
  fs.writeFileSync(path.join(root, 'current', 'smoke.json'), '{"desktop":{}}')
  fs.writeFileSync(path.join(root, 'incoming', 'jeff-2.1.1.apk'), 'current package')
  fs.writeFileSync(path.join(root, 'incoming', 'Jeff-1.8.0.AppImage'), 'unrelated staged package')
  fs.writeFileSync(path.join(root, 'incoming', 'diagnostic-ui-runner.cjs'), 'keep')
  fs.writeFileSync(path.join(root, 'incoming', 'browser-handoff.json'), 'keep')
  fs.writeFileSync(path.join(root, 'incoming', 'manifest.json'), JSON.stringify({ runId: current }))
  const requestFile = path.join(root, 'incoming', `${current}.cleanup.json`)
  fs.writeFileSync(requestFile, '{}')

  const report = cleanupCompletedWindowsRun({
    root,
    request: {
      runId: current,
      outcome: { runId: current, ok: true },
      suite: 'smoke',
      evidenceVerified: true,
      localEvidenceRunIds: [current, id('1')],
      stagedPackageNames,
      requestFile,
    },
  })

  assert.deepEqual(report.removedSnapshots, [id('5'), id('2'), id('1')])
  assert.deepEqual(report.removedRuns, [current])
  assert.equal(fs.existsSync(path.join(root, 'backups', id('7'))), true)
  assert.equal(fs.existsSync(path.join(root, 'backups', id('6'), 'deploy-outcome.json')), true)
  assert.equal(fs.existsSync(path.join(root, 'backups', current, 'deploy-outcome.json')), true)
  assert.equal(fs.existsSync(path.join(root, 'current', 'Jeff-2.1.1.AppImage')), false)
  assert.equal(fs.existsSync(path.join(root, 'current', 'Jeff-1.8.0.AppImage')), true)
  assert.equal(fs.existsSync(path.join(root, 'current', 'smoke.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'incoming', 'jeff-2.1.1.apk')), false)
  assert.equal(fs.existsSync(path.join(root, 'incoming', 'Jeff-1.8.0.AppImage')), true)
  assert.equal(fs.existsSync(path.join(root, 'incoming', 'diagnostic-ui-runner.cjs')), true)
  assert.equal(fs.existsSync(path.join(root, 'incoming', 'browser-handoff.json')), true)
  assert.equal(fs.existsSync(path.join(root, 'incoming', 'manifest.json')), false)
  assert.equal(fs.existsSync(requestFile), false)

  const repeated = cleanupCompletedWindowsRun({
    root,
    request: { runId: current, outcome: { runId: current, ok: true }, suite: 'smoke', evidenceVerified: true, localEvidenceRunIds: [current], stagedPackageNames },
  })
  assert.deepEqual(repeated.removedSnapshots, [])
  assert.deepEqual(repeated.removedRuns, [])
})

test('cleanup refuses mismatched outcomes and unverified evidence without changing files', (t) => {
  const root = fixture(t)
  const current = id('9')
  addSnapshot(root, current, 'success')
  const marker = path.join(root, 'backups', current, 'jeff', 'profile.db')
  const base = { runId: current, outcome: { runId: current, ok: true }, evidenceVerified: false, localEvidenceRunIds: [], stagedPackageNames }
  assert.throws(() => cleanupCompletedWindowsRun({ root, request: base }), /before local evidence/)
  assert.throws(() => cleanupCompletedWindowsRun({ root, request: { ...base, outcome: { runId: id('x'), ok: true }, evidenceVerified: true } }), /does not match/)
  assert.equal(fs.existsSync(marker), true)
  assert.equal(fs.existsSync(path.join(root, 'backups', current, 'deploy-outcome.json')), false)
})

test('cleanup validates paths before mutation and rejects traversal run IDs', (t) => {
  const root = fixture(t)
  const current = id('8')
  addSnapshot(root, current, 'success')
  const base = { runId: current, outcome: { runId: current, ok: true }, evidenceVerified: true, localEvidenceRunIds: [], stagedPackageNames }
  assert.throws(() => cleanupCompletedWindowsRun({ root, request: { ...base, requestFile: path.join(os.tmpdir(), 'outside.json') } }), /matching run request/)
  assert.equal(fs.existsSync(path.join(root, 'backups', current, 'deploy-outcome.json')), false)
  assert.equal(isValidRunId('../../outside'), false)
})

test('unsafe symlinked result metadata aborts before snapshot markers or cleanup are changed', (t) => {
  const root = fixture(t)
  const current = id('8')
  addSnapshot(root, current, 'unknown')
  const external = path.join(os.tmpdir(), `jeff-outcome-${process.pid}.json`)
  fs.writeFileSync(external, JSON.stringify({ runId: current, ok: true }))
  t.after(() => fs.rmSync(external, { force: true }))
  fs.mkdirSync(path.join(root, 'results', current), { recursive: true })
  fs.symlinkSync(external, path.join(root, 'results', current, 'outcome.json'))
  fs.writeFileSync(path.join(root, 'incoming', 'Jeff-1.8.0.AppImage'), 'keep')

  assert.throws(() => cleanupCompletedWindowsRun({
    root,
    request: { runId: current, outcome: { runId: current, ok: true }, evidenceVerified: true, localEvidenceRunIds: [current], stagedPackageNames },
  }), /symbolic link/)
  assert.equal(fs.existsSync(path.join(root, 'backups', current, 'deploy-outcome.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'backups', current, 'jeff', 'profile.db')), true)
  assert.equal(fs.existsSync(path.join(root, 'incoming', 'Jeff-1.8.0.AppImage')), true)
})

test('pending worker requests defer shared staging cleanup', (t) => {
  const root = fixture(t)
  const current = id('9')
  addSnapshot(root, current, 'success')
  fs.writeFileSync(path.join(root, 'incoming', 'another.request.json'), '{}')
  fs.writeFileSync(path.join(root, 'incoming', 'Jeff-1.8.0.AppImage'), 'keep while worker is pending')
  fs.writeFileSync(path.join(root, 'current', 'smoke.json'), '{"desktop":{}}')
  const report = cleanupCompletedWindowsRun({
    root,
    request: { runId: current, outcome: { runId: current, ok: true }, evidenceVerified: true, localEvidenceRunIds: [current], stagedPackageNames },
  })
  assert.equal(report.stageCleanupDeferred, true)
  assert.equal(fs.existsSync(path.join(root, 'incoming', 'Jeff-1.8.0.AppImage')), true)
  assert.equal(fs.existsSync(path.join(root, 'current', 'smoke.json')), true)
})

test('a symlinked pending request also defers shared staging cleanup', (t) => {
  const root = fixture(t)
  const current = id('9')
  addSnapshot(root, current, 'success')
  const external = path.join(os.tmpdir(), `jeff-pending-${process.pid}.json`)
  fs.writeFileSync(external, '{}')
  t.after(() => fs.rmSync(external, { force: true }))
  const pending = path.join(root, 'incoming', 'other.request.json')
  fs.symlinkSync(external, pending)
  fs.writeFileSync(path.join(root, 'incoming', 'Jeff-1.8.0.AppImage'), 'keep while worker is pending')

  const report = cleanupCompletedWindowsRun({
    root,
    request: { runId: current, outcome: { runId: current, ok: true }, evidenceVerified: true, localEvidenceRunIds: [current], stagedPackageNames },
  })
  assert.equal(report.stageCleanupDeferred, true)
  assert.equal(fs.existsSync(path.join(root, 'incoming', 'Jeff-1.8.0.AppImage')), true)
  assert.equal(fs.lstatSync(pending).isSymbolicLink(), true)
})
