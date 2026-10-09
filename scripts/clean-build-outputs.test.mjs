import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanBuildOutputs, markReleaseAccepted } from './clean-build-outputs.mjs'

function fixture(t, version = '2.1.1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-build-clean-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }))
  return root
}

function writeVersion(root, version) {
  const desktop = path.join(root, 'apps/desktop/release')
  const mobile = path.join(root, 'apps/mobile/android/release')
  fs.mkdirSync(desktop, { recursive: true })
  fs.mkdirSync(mobile, { recursive: true })
  for (const name of [
    `Jeff-${version}.AppImage`,
    `jeff-desktop_${version}_amd64.deb`,
    `jeff-Setup-${version}.exe`,
    `jeff-Setup-${version}.exe.blockmap`,
  ]) fs.writeFileSync(path.join(desktop, name), name)
  fs.writeFileSync(path.join(mobile, `jeff-${version}.apk`), version)
}

test('desktop build cleanup preserves the requested version and newest complete rollback set', (t) => {
  const root = fixture(t)
  writeVersion(root, '1.12.1')
  writeVersion(root, '2.0.0')
  writeVersion(root, '2.1.0')
  writeVersion(root, '2.1.1')
  const olderOnlyOnDesktop = path.join(root, 'apps/desktop/release/Jeff-1.11.0.AppImage')
  fs.writeFileSync(olderOnlyOnDesktop, 'old')
  for (const relative of ['apps/desktop/out', 'apps/desktop/release/linux-unpacked', 'apps/desktop/release/win-unpacked']) {
    fs.mkdirSync(path.join(root, relative), { recursive: true })
    fs.writeFileSync(path.join(root, relative, 'marker'), 'stale')
  }
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  fs.mkdirSync(path.join(root, '.tmp/deploy'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules/keep'), 'dependency')
  fs.writeFileSync(path.join(root, '.tmp/deploy/evidence.png'), 'evidence')

  const report = cleanBuildOutputs({ root, scope: 'linux' })

  assert.deepEqual(report.keepVersions, ['2.1.0', '2.1.1'])
  assert.equal(fs.existsSync(path.join(root, 'apps/desktop/release/Jeff-1.12.1.AppImage')), false)
  assert.equal(fs.existsSync(olderOnlyOnDesktop), false)
  assert.equal(fs.existsSync(path.join(root, 'apps/desktop/release/Jeff-2.1.0.AppImage')), true)
  assert.equal(fs.existsSync(path.join(root, 'apps/desktop/release/Jeff-2.1.1.AppImage')), true)
  assert.equal(fs.existsSync(path.join(root, 'apps/desktop/release/linux-unpacked')), false)
  assert.equal(fs.existsSync(path.join(root, 'apps/desktop/release/win-unpacked/marker')), true)
  assert.equal(fs.existsSync(path.join(root, 'node_modules/keep')), true)
  assert.equal(fs.existsSync(path.join(root, '.tmp/deploy/evidence.png')), true)

  const repeated = cleanBuildOutputs({ root, scope: 'linux' })
  assert.deepEqual(repeated.removedPackages, [])
  assert.deepEqual(repeated.removedDirectories, [])
})

test('retention keeps two accepted versions plus the in-progress version, then prunes after acceptance', (t) => {
  const root = fixture(t, '2.1.2')
  for (const version of ['1.8.0', '2.0.0', '2.1.0', '2.1.1', '2.1.2']) writeVersion(root, version)
  const release = path.join(root, 'apps/desktop/release')
  fs.writeFileSync(path.join(release, '.jeff-accepted-versions.json'), JSON.stringify({ acceptedVersions: ['2.1.0', '2.1.1'] }))

  const duringBuild = cleanBuildOutputs({ root, scope: 'win' })
  assert.deepEqual(duringBuild.keepVersions, ['2.1.0', '2.1.1', '2.1.2'])
  assert.equal(fs.existsSync(path.join(release, 'Jeff-2.1.0.AppImage')), true)
  assert.equal(fs.existsSync(path.join(release, 'Jeff-2.1.1.AppImage')), true)
  assert.equal(fs.existsSync(path.join(release, 'Jeff-2.1.2.AppImage')), true)

  const accepted = markReleaseAccepted({ root, version: '2.1.2', acceptedAt: '2026-10-09T12:00:00.000Z' })
  assert.deepEqual(accepted.acceptedVersions, ['2.1.1', '2.1.2'])
  assert.ok(accepted.removedPackages.includes('apps/desktop/release/Jeff-2.1.0.AppImage'))
  assert.equal(fs.existsSync(path.join(release, 'Jeff-2.1.0.AppImage')), false)

  const afterAcceptance = cleanBuildOutputs({ root, scope: 'win' })
  assert.deepEqual(afterAcceptance.keepVersions, ['2.1.1', '2.1.2'])
  assert.deepEqual(afterAcceptance.removedPackages, [])
})

test('release files are preserved when there is no complete previous package set', (t) => {
  const root = fixture(t)
  const desktop = path.join(root, 'apps/desktop/release')
  fs.mkdirSync(desktop, { recursive: true })
  fs.writeFileSync(path.join(desktop, 'Jeff-1.8.0.AppImage'), 'incomplete rollback')
  fs.mkdirSync(path.join(root, 'apps/desktop/out'), { recursive: true })

  const report = cleanBuildOutputs({ root, scope: 'linux' })

  assert.equal(report.releasePruningApplied, false)
  assert.equal(fs.existsSync(path.join(desktop, 'Jeff-1.8.0.AppImage')), true)
  assert.equal(fs.existsSync(path.join(root, 'apps/desktop/out')), false)
})

test('mobile cleanup touches only generated web and Gradle build outputs', (t) => {
  const root = fixture(t)
  for (const relative of ['apps/mobile/dist', 'apps/mobile/android/build', 'apps/mobile/android/app/build', 'apps/mobile/android/.gradle']) {
    fs.mkdirSync(path.join(root, relative), { recursive: true })
    fs.writeFileSync(path.join(root, relative, 'marker'), 'data')
  }
  const report = cleanBuildOutputs({ root, scope: 'mobile' })

  assert.equal(report.removedDirectories.length, 3)
  assert.equal(fs.existsSync(path.join(root, 'apps/mobile/android/app/build')), false)
  assert.equal(fs.existsSync(path.join(root, 'apps/mobile/android/.gradle/marker')), true)
})

test('mobile asset sync preserves versioned packages and Android release cleanup preserves build directories', (t) => {
  const root = fixture(t)
  for (const version of ['1.8.0', '2.1.0', '2.1.1']) writeVersion(root, version)
  fs.mkdirSync(path.join(root, 'apps/mobile/android/app/build'), { recursive: true })
  fs.writeFileSync(path.join(root, 'apps/mobile/android/app/build/keep'), 'intermediate')

  const sync = cleanBuildOutputs({ root, scope: 'mobile', preserveReleasePackages: true })
  assert.deepEqual(sync.removedPackages, [])
  assert.equal(fs.existsSync(path.join(root, 'apps/desktop/release/Jeff-1.8.0.AppImage')), true)
  assert.equal(fs.existsSync(path.join(root, 'apps/mobile/android/app/build')), false)

  fs.mkdirSync(path.join(root, 'apps/mobile/android/app/build'), { recursive: true })
  fs.writeFileSync(path.join(root, 'apps/mobile/android/app/build/keep'), 'intermediate')
  const release = cleanBuildOutputs({ root, scope: 'mobile', preserveBuildDirectories: true })
  assert.ok(release.removedPackages.includes('apps/desktop/release/Jeff-1.8.0.AppImage'))
  assert.equal(fs.existsSync(path.join(root, 'apps/mobile/android/app/build/keep')), true)
})

test('cleanup scope is explicit and rejects unknown scopes', (t) => {
  const root = fixture(t)
  assert.throws(() => cleanBuildOutputs({ root, scope: 'tmp' }), /Unknown build cleanup scope/)
})

test('cleanup refuses a symlink in an allowed build path', (t) => {
  const root = fixture(t)
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-build-clean-outside-'))
  t.after(() => fs.rmSync(external, { recursive: true, force: true }))
  fs.writeFileSync(path.join(external, 'keep'), 'data')
  fs.mkdirSync(path.join(root, 'apps/desktop'), { recursive: true })
  fs.symlinkSync(external, path.join(root, 'apps/desktop/out'))

  assert.throws(() => cleanBuildOutputs({ root, scope: 'linux' }), /Refusing symlink in build output path/)
  assert.equal(fs.existsSync(path.join(external, 'keep')), true)

  const secondRoot = fixture(t)
  fs.mkdirSync(path.join(secondRoot, 'apps'), { recursive: true })
  fs.symlinkSync(external, path.join(secondRoot, 'apps/desktop'))
  assert.throws(() => cleanBuildOutputs({ root: secondRoot, scope: 'linux' }), /Refusing symlink in build output path/)
  assert.equal(fs.existsSync(path.join(external, 'keep')), true)
})

test('official desktop and Android release entries invoke cleanup before building', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const desktop = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'))
  const mobile = JSON.parse(fs.readFileSync(path.join(root, 'apps/mobile/package.json'), 'utf8'))
  const gradle = fs.readFileSync(path.join(root, 'apps/mobile/android/app/build.gradle'), 'utf8')

  assert.match(desktop.scripts['package:linux'], /clean-build-outputs\.mjs --scope linux && electron-vite build/)
  assert.match(desktop.scripts['package:win'], /clean-build-outputs\.mjs --scope win && electron-vite build/)
  assert.match(mobile.scripts['cap:sync'], /clean-build-outputs\.mjs --scope mobile --outputs-only/)
  assert.match(gradle, /tasks\.register\('cleanJeffReleasePackages', Exec\)/)
  assert.match(gradle, /tasks\.matching \{ it\.name == 'assembleRelease' \}\.configureEach \{\s+dependsOn 'cleanJeffReleasePackages'/)
  assert.match(gradle, /tasks\.named\('preBuild'\)\.configure \{ dependsOn 'cleanJeffIntermediateOutputs' \}/)
})
