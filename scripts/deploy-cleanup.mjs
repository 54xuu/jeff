#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{6}-\d{3}Z$/
const VERSIONED_PACKAGE_RE = /^(?:Jeff-\d+\.\d+\.\d+\.AppImage|jeff-desktop_\d+\.\d+\.\d+_amd64\.deb|jeff-Setup-\d+\.\d+\.\d+\.exe(?:\.blockmap)?|jeff-\d+\.\d+\.\d+\.apk|app-release-androidTest\.apk)$/

export function isValidRunId(value) {
  return typeof value === 'string' && RUN_ID_RE.test(value)
}

function newestFirst(left, right) {
  return right.runId.localeCompare(left.runId)
}

export function planSnapshotRetention(snapshots, { successful = 3, failed = 1 } = {}) {
  const knownSuccesses = snapshots.filter((entry) => entry.status === 'success').sort(newestFirst)
  const knownFailures = snapshots.filter((entry) => entry.status === 'failed').sort(newestFirst)
  const unknown = snapshots.filter((entry) => entry.status === 'unknown')
  const keep = new Set([
    ...knownSuccesses.slice(0, successful).map((entry) => entry.runId),
    ...knownFailures.slice(0, failed).map((entry) => entry.runId),
    ...unknown.map((entry) => entry.runId),
  ])
  return {
    keep: snapshots.filter((entry) => keep.has(entry.runId)).sort(newestFirst),
    remove: snapshots.filter((entry) => !keep.has(entry.runId)).sort(newestFirst),
  }
}

function containedPath(root, ...parts) {
  const base = path.resolve(root)
  const target = path.resolve(base, ...parts)
  const relative = path.relative(base, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing path outside deployment root: ${parts.join(path.sep)}`)
  }
  return target
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function containedStat(root, ...parts) {
  const target = containedPath(root, ...parts)
  const base = path.resolve(root)
  const relative = path.relative(base, target)
  const segments = relative.split(path.sep)
  let current = base
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index])
    const stat = lstatOrNull(current)
    if (!stat) return null
    if (stat.isSymbolicLink()) throw new Error(`Refusing a symbolic link inside deployment data: ${path.relative(base, current)}`)
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Refusing a non-directory deployment path component: ${path.relative(base, current)}`)
    }
    if (index === segments.length - 1) return stat
  }
  return null
}

function removeContained(root, ...parts) {
  const target = containedPath(root, ...parts)
  const stat = containedStat(root, ...parts)
  if (!stat) return false
  fs.rmSync(target, { recursive: stat.isDirectory(), force: true })
  return true
}

function readJson(file) {
  const absolute = path.resolve(file)
  const root = path.parse(absolute).root
  const segments = absolute.slice(root.length).split(path.sep)
  let current = root
  let stat = null
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index])
    stat = lstatOrNull(current)
    if (!stat) return null
    if (stat.isSymbolicLink()) throw new Error(`Refusing to read deployment metadata through a symbolic link: ${current}`)
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Refusing a non-directory deployment metadata path component: ${current}`)
    }
  }
  if (!stat) return null
  if (!stat.isFile()) throw new Error(`Refusing to read non-file deployment metadata: ${file}`)
  try { return JSON.parse(fs.readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

function readOutcome(file, runId) {
  const value = readJson(file)
  if (!value || value.runId !== runId || typeof value.ok !== 'boolean') return null
  return { runId, ok: value.ok, status: value.ok ? 'success' : 'failed' }
}

function directoryNames(root, relative) {
  const target = containedPath(root, relative)
  const stat = containedStat(root, relative)
  if (!stat) return []
  if (!stat.isDirectory()) throw new Error(`Refusing to inspect non-directory: ${relative}`)
  return fs.readdirSync(target, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

function regularFileNames(root, relative) {
  const target = containedPath(root, relative)
  const stat = containedStat(root, relative)
  if (!stat) return []
  if (!stat.isDirectory()) throw new Error(`Refusing to inspect non-directory: ${relative}`)
  return fs.readdirSync(target, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
}

function ensureInsideDeploymentRoot(root) {
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Deployment root must be a real directory')
}

function outcomeMarker(root, runId) {
  const marker = containedPath(root, 'backups', runId, 'deploy-outcome.json')
  const value = readJson(marker)
  if (value?.runId === runId && ['success', 'failed'].includes(value.status)) {
    return { runId, ok: value.status === 'success', status: value.status }
  }
  return null
}

function writeOutcomeMarker(root, outcome) {
  const backupDir = containedPath(root, 'backups', outcome.runId)
  const backupStat = lstatOrNull(backupDir)
  if (!backupStat || !backupStat.isDirectory() || backupStat.isSymbolicLink()) return false
  const marker = containedPath(root, 'backups', outcome.runId, 'deploy-outcome.json')
  if (lstatOrNull(marker)) {
    if (outcomeMarker(root, outcome.runId)?.status !== outcome.status) {
      throw new Error(`Conflicting deployment outcome marker for ${outcome.runId}`)
    }
    return true
  }
  const temp = `${marker}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify({ runId: outcome.runId, status: outcome.status })}\n`, { flag: 'wx' })
  fs.renameSync(temp, marker)
  return true
}

function readKnownOutcome(root, runId) {
  return outcomeMarker(root, runId)
    || readOutcome(containedPath(root, 'results', runId, 'outcome.json'), runId)
}

function snapshotStatuses(root) {
  return directoryNames(root, 'backups')
    .filter(isValidRunId)
    .map((runId) => {
      const outcome = readKnownOutcome(root, runId)
      return { runId, status: outcome?.status || 'unknown' }
    })
}

function hasPendingWorkerRequests(root) {
  const directory = containedPath(root, 'incoming')
  const stat = lstatOrNull(directory)
  if (!stat) return false
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Refusing to inspect unsafe incoming directory')
  return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => entry.name.endsWith('.request.json'))
}

function removeStagedPackages(root, directory, packageNames, report) {
  const present = new Set(regularFileNames(root, directory))
  for (const name of packageNames) {
    if (!present.has(name)) continue
    if (removeContained(root, directory, name)) report.removedStagedPackages.push(`${directory}/${name}`)
  }
}

function readLocalEvidenceIds(ids, currentRunId) {
  if (!Array.isArray(ids)) throw new Error('localEvidenceRunIds must be an array')
  const result = new Set([currentRunId])
  for (const runId of ids) {
    if (!isValidRunId(runId)) throw new Error(`Invalid local evidence run ID: ${runId}`)
    result.add(runId)
  }
  return result
}

export function cleanupCompletedWindowsRun({ root, request }) {
  if (!root || !request || typeof request !== 'object') throw new Error('Cleanup root and request are required')
  ensureInsideDeploymentRoot(root)
  const { runId, outcome } = request
  if (!isValidRunId(runId)) throw new Error('Invalid cleanup run ID')
  if (!outcome || outcome.runId !== runId || typeof outcome.ok !== 'boolean') throw new Error('Cleanup outcome does not match run ID')
  if (request.suite !== undefined && !/^[a-z][a-z0-9-]{0,39}$/.test(request.suite)) throw new Error('Invalid cleanup suite ID')
  if (request.evidenceVerified !== true) throw new Error('Refusing cleanup before local evidence is verified')
  if (!Array.isArray(request.stagedPackageNames) || request.stagedPackageNames.some((name) => typeof name !== 'string' || !VERSIONED_PACKAGE_RE.test(name))) {
    throw new Error('stagedPackageNames must contain only exact versioned deployment artifact names')
  }
  let requestRelative = null
  if (request.requestFile) {
    requestRelative = path.relative(path.resolve(root), path.resolve(request.requestFile))
    if (requestRelative.startsWith('..') || path.isAbsolute(requestRelative)
      || requestRelative !== path.join('incoming', `${runId}.cleanup.json`)) {
      throw new Error('Cleanup request file must be the matching run request inside deployment incoming directory')
    }
  }
  const evidenceIds = readLocalEvidenceIds(request.localEvidenceRunIds, runId)
  const report = {
    runId,
    removedStagedPackages: [],
    removedRuns: [],
    removedResults: [],
    removedInstallRequests: [],
    removedCurrentFiles: [],
    removedSnapshots: [],
    preservedSnapshots: { success: [], failed: [], unknown: [] },
    stageCleanupDeferred: false,
  }

  const currentOutcome = { runId, ok: outcome.ok, status: outcome.ok ? 'success' : 'failed' }
  const initialSnapshots = snapshotStatuses(root)
  const currentBackup = containedStat(root, 'backups', runId)
  if (currentBackup && !currentBackup.isDirectory()) throw new Error(`Current snapshot path is not a directory: ${runId}`)
  const existingCurrent = initialSnapshots.find((entry) => entry.runId === runId)
  if (existingCurrent && existingCurrent.status !== 'unknown' && existingCurrent.status !== currentOutcome.status) {
    throw new Error(`Conflicting deployment outcome for snapshot ${runId}`)
  }
  const snapshotsForRetention = initialSnapshots.filter((entry) => entry.runId !== runId)
  if (currentBackup) snapshotsForRetention.push({ runId, status: currentOutcome.status })
  const retention = planSnapshotRetention(snapshotsForRetention)
  const stageCleanupDeferred = hasPendingWorkerRequests(root)
  const stageManifests = new Map()
  for (const directory of ['current', 'incoming']) {
    regularFileNames(root, directory)
    stageManifests.set(directory, readJson(containedPath(root, directory, 'manifest.json')))
    for (const name of request.stagedPackageNames) containedStat(root, directory, name)
  }

  if (requestRelative) containedStat(root, ...requestRelative.split(path.sep))
  if (request.suite) containedStat(root, 'current', `${request.suite}.json`)
  for (const entry of retention.remove) containedStat(root, 'backups', entry.runId)

  const knownEvidence = new Map()
  for (const runIdToClean of evidenceIds) {
    const known = runIdToClean === runId ? currentOutcome : readKnownOutcome(root, runIdToClean)
    if (!known) continue
    knownEvidence.set(runIdToClean, known)
    containedStat(root, 'runs', runIdToClean)
    containedStat(root, 'results', runIdToClean)
    containedStat(root, 'install-requests', `${runIdToClean}.json`)
    containedStat(root, 'incoming', `${runIdToClean}.request.json`)
  }

  // Record known statuses before deleting result evidence, then prune only the
  // preflighted snapshot plan. All path and metadata checks above happen first.
  if (currentBackup && !writeOutcomeMarker(root, currentOutcome)) throw new Error(`Could not record deployment outcome for ${runId}`)
  for (const entry of initialSnapshots) {
    if (entry.status === 'success' || entry.status === 'failed') {
      writeOutcomeMarker(root, { runId: entry.runId, status: entry.status, ok: entry.status === 'success' })
    }
  }
  for (const entry of retention.remove) {
    if (removeContained(root, 'backups', entry.runId)) report.removedSnapshots.push(entry.runId)
  }
  for (const entry of retention.keep) report.preservedSnapshots[entry.status].push(entry.runId)

  for (const [runIdToClean] of knownEvidence) {
    if (removeContained(root, 'runs', runIdToClean)) report.removedRuns.push(runIdToClean)
    if (removeContained(root, 'results', runIdToClean)) report.removedResults.push(runIdToClean)
    if (removeContained(root, 'install-requests', `${runIdToClean}.json`)) report.removedInstallRequests.push(runIdToClean)
    removeContained(root, 'incoming', `${runIdToClean}.request.json`)
  }

  if (stageCleanupDeferred) {
    report.stageCleanupDeferred = true
  } else {
    removeStagedPackages(root, 'current', request.stagedPackageNames, report)
    removeStagedPackages(root, 'incoming', request.stagedPackageNames, report)
    if (request.suite && removeContained(root, 'current', `${request.suite}.json`)) {
      report.removedCurrentFiles.push(`current/${request.suite}.json`)
    }
    for (const directory of ['current', 'incoming']) {
      const manifest = stageManifests.get(directory)
      if (manifest && evidenceIds.has(manifest.runId)) removeContained(root, directory, 'manifest.json')
    }
  }

  if (requestRelative) removeContained(root, requestRelative)
  return report
}

function runCli() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--request') throw new Error('Usage: deploy-cleanup.mjs --request <cleanup-request.json>')
  const root = path.join(os.homedir(), '.jeff-deploy')
  const requestFile = path.resolve(args[1])
  const request = readJson(requestFile)
  if (!request) throw new Error('Cleanup request could not be read')
  const report = cleanupCompletedWindowsRun({ root, request: { ...request, requestFile } })
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli() } catch (error) {
    console.error(`[deploy-cleanup] ${error.message}`)
    process.exitCode = 1
  }
}
