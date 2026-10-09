#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP_ARTIFACTS = [
  (version) => `Jeff-${version}.AppImage`,
  (version) => `jeff-desktop_${version}_amd64.deb`,
  (version) => `jeff-Setup-${version}.exe`,
]
const MOBILE_ARTIFACT = (version) => `jeff-${version}.apk`
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/
const ACCEPTED_RELEASES_FILE = '.jeff-accepted-versions.json'
const BOOTSTRAP_ACCEPTED_VERSION = '2.1.0'

function parseVersion(value) {
  const match = VERSION_RE.exec(value)
  if (!match) return null
  return match.slice(1).map(Number)
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error(`Invalid SemVer version: ${!a ? left : right}`)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function versionedArtifact(name) {
  const patterns = [
    /^Jeff-(\d+\.\d+\.\d+)\.AppImage$/,
    /^jeff-desktop_(\d+\.\d+\.\d+)_amd64\.deb$/,
    /^jeff-Setup-(\d+\.\d+\.\d+)\.exe(?:\.blockmap)?$/,
    /^jeff-(\d+\.\d+\.\d+)\.apk$/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(name)
    if (match) return match[1]
  }
  return null
}

function checkedPath(root, relativePath, { finalMustBeDirectory = false } = {}) {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, relativePath)
  const relative = path.relative(resolvedRoot, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Refusing path outside build output allowlist: ${relativePath}`)
  const rootStat = fs.lstatSync(resolvedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Refusing non-directory build root: ${resolvedRoot}`)
  const parts = relative.split(path.sep)
  let current = resolvedRoot
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index])
    let stat
    try { stat = fs.lstatSync(current) } catch (error) {
      if (error.code === 'ENOENT') return { target, stat: null }
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in build output path: ${path.relative(resolvedRoot, current)}`)
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Refusing non-directory build path component: ${path.relative(resolvedRoot, current)}`)
    if (index === parts.length - 1 && finalMustBeDirectory && !stat.isDirectory()) {
      throw new Error(`Refusing to inspect non-directory build path: ${current}`)
    }
  }
  return { target, stat: fs.lstatSync(target) }
}

function regularFiles(root, relativePath) {
  const { target, stat } = checkedPath(root, relativePath, { finalMustBeDirectory: true })
  if (!stat) return []
  return fs.readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
}

function releaseInventory(root) {
  const { target: desktopDir } = checkedPath(root, 'apps/desktop/release', { finalMustBeDirectory: true })
  const { target: mobileDir } = checkedPath(root, 'apps/mobile/android/release', { finalMustBeDirectory: true })
  const desktopNames = regularFiles(root, 'apps/desktop/release')
  const mobileNames = regularFiles(root, 'apps/mobile/android/release')
  const versions = new Set([...desktopNames, ...mobileNames].map(versionedArtifact).filter(Boolean))
  const complete = [...versions].filter((version) => {
    const hasDesktop = DESKTOP_ARTIFACTS.every((makeName) => desktopNames.includes(makeName(version)))
    return hasDesktop && mobileNames.includes(MOBILE_ARTIFACT(version))
  })
  return { desktopDir, mobileDir, desktopNames, mobileNames, versions: [...versions], complete }
}

function acceptedVersions(desktopDir) {
  const marker = path.join(desktopDir, ACCEPTED_RELEASES_FILE)
  if (!fs.existsSync(marker)) return new Set([BOOTSTRAP_ACCEPTED_VERSION])
  const stat = fs.lstatSync(marker)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to read non-file acceptance marker: ${marker}`)
  const value = JSON.parse(fs.readFileSync(marker, 'utf8'))
  if (!Array.isArray(value.acceptedVersions) || value.acceptedVersions.some((version) => !parseVersion(version))) {
    throw new Error(`Invalid accepted release versions in ${marker}`)
  }
  return new Set([BOOTSTRAP_ACCEPTED_VERSION, ...value.acceptedVersions])
}

function acceptedCompleteVersions(inventory) {
  const accepted = acceptedVersions(inventory.desktopDir)
  return inventory.complete
    .filter((version) => accepted.has(version))
    .sort(compareVersions)
}

function keptReleaseVersions(inventory, currentVersion) {
  if (!parseVersion(currentVersion)) throw new Error(`Invalid current version: ${currentVersion}`)
  const acceptedComplete = acceptedCompleteVersions(inventory)
  // Keep the release being built plus the latest two fully accepted package sets.
  // Before this feature existed, 2.1.0 was the user's confirmed rollback baseline.
  if (!acceptedComplete.length) return null
  return new Set([currentVersion, ...acceptedComplete.slice(-2)])
}

function removeExactDirectory(root, relativePath) {
  const { target, stat } = checkedPath(root, relativePath)
  if (!stat) return false
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to remove non-directory build output: ${relativePath}`)
  fs.rmSync(target, { recursive: true, force: true })
  return true
}

function pruneVersionedPackages(root, inventory, keepVersions) {
  if (!keepVersions) return []
  const removed = []
  for (const [directory, names] of [[inventory.desktopDir, inventory.desktopNames], [inventory.mobileDir, inventory.mobileNames]]) {
    for (const name of names) {
      const version = versionedArtifact(name)
      if (!version || keepVersions.has(version)) continue
      const target = path.join(directory, name)
      if (!fs.lstatSync(target).isFile()) continue
      fs.unlinkSync(target)
      removed.push(path.relative(root, target))
    }
  }
  return removed
}

export function cleanBuildOutputs({ root = ROOT, scope, currentVersion, preserveReleasePackages = false, preserveBuildDirectories = false } = {}) {
  const scopes = {
    linux: ['apps/desktop/out', 'apps/desktop/release/linux-unpacked'],
    win: ['apps/desktop/out', 'apps/desktop/release/win-unpacked'],
    mobile: ['apps/mobile/dist', 'apps/mobile/android/build', 'apps/mobile/android/app/build'],
    all: [
      'apps/desktop/out', 'apps/desktop/release/linux-unpacked', 'apps/desktop/release/win-unpacked',
      'apps/mobile/dist', 'apps/mobile/android/build', 'apps/mobile/android/app/build',
    ],
  }
  if (!Object.hasOwn(scopes, scope)) throw new Error(`Unknown build cleanup scope: ${scope}`)
  const resolvedRoot = path.resolve(root)
  const version = currentVersion || JSON.parse(fs.readFileSync(path.join(resolvedRoot, 'package.json'), 'utf8')).version
  const inventory = preserveReleasePackages ? null : releaseInventory(resolvedRoot)
  const keepVersions = inventory ? keptReleaseVersions(inventory, version) : null
  const removedPackages = inventory ? pruneVersionedPackages(resolvedRoot, inventory, keepVersions) : []
  const removedDirectories = preserveBuildDirectories ? [] : scopes[scope].filter((relativePath) => removeExactDirectory(resolvedRoot, relativePath))
  return {
    scope,
    currentVersion: version,
    keepVersions: keepVersions
      ? [...keepVersions].sort(compareVersions)
      : inventory ? inventory.versions.sort(compareVersions) : [],
    releasePruningApplied: Boolean(keepVersions),
    removedPackages,
    removedDirectories,
  }
}

export function markReleaseAccepted({ root = ROOT, version, acceptedAt = new Date().toISOString() } = {}) {
  const resolvedRoot = path.resolve(root)
  const inventory = releaseInventory(resolvedRoot)
  if (!parseVersion(version) || !inventory.complete.includes(version)) {
    throw new Error(`Cannot accept incomplete release ${version || '(missing version)'}`)
  }
  const markerPath = path.join(inventory.desktopDir, ACCEPTED_RELEASES_FILE)
  const versions = new Set([...acceptedVersions(inventory.desktopDir), version])
  const accepted = [...versions].filter((candidate) => inventory.complete.includes(candidate)).sort(compareVersions).slice(-2)
  const temp = `${markerPath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify({ acceptedVersions: accepted, updatedAt: acceptedAt }, null, 2)}\n`, { flag: 'wx' })
  fs.renameSync(temp, markerPath)

  // Once the new version has passed end-to-end acceptance, prune down to the
  // newest two accepted versions. The next build's candidate remains protected.
  const updatedInventory = releaseInventory(resolvedRoot)
  const keepVersions = new Set(acceptedCompleteVersions(updatedInventory).slice(-2))
  const removedPackages = pruneVersionedPackages(resolvedRoot, updatedInventory, keepVersions)
  return { version, acceptedVersions: [...keepVersions].sort(compareVersions), removedPackages }
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--outputs-only') {
      options.preserveReleasePackages = true
      continue
    }
    if (argv[i] === '--packages-only') {
      options.preserveBuildDirectories = true
      continue
    }
    if (argv[i] !== '--scope' || !argv[i + 1]) throw new Error('Usage: clean-build-outputs.mjs --scope linux|win|mobile|all [--outputs-only|--packages-only]')
    options.scope = argv[++i]
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = cleanBuildOutputs(parseArgs(process.argv.slice(2)))
    console.log(`[build-clean] scope=${report.scope}; cleared ${report.removedDirectories.length} build directories; pruned ${report.removedPackages.length} old release files; retained ${report.keepVersions.join(', ') || 'all existing versions'}`)
  } catch (error) {
    console.error(`[build-clean] ${error.message}`)
    process.exitCode = 1
  }
}
