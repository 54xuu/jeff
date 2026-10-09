import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { parseArgs, parseAdbDevices, chooseAndroidDevice, chooseWindowsAndroidPath, preferConfiguredUsb, verifyArtifactManifest, windowsRunnerDestination, windowsIncomingFileDestination, evidenceTransferVerified, expectedAndroidVersionCode, validateAndroidReleaseMetadata, windowsAdbScript } from './deploy-windows.mjs'

test('deployment CLI accepts explicit target, Android fallback mode, and a named suite', () => {
  assert.deepEqual(
    parseArgs(['--target', 'win11', '--android', 'auto', '--suite', 'smoke']),
    { target: 'win11', android: 'auto', suite: 'smoke' },
  )
})

test('deployment CLI rejects missing suites and invalid device modes', () => {
  assert.throws(() => parseArgs(['--target', 'win11', '--android', 'auto']), /--suite/)
  assert.throws(() => parseArgs(['--target', 'win11', '--android', 'maybe', '--suite', 'smoke']), /--android/)
})

test('auto mode chooses the configured physical device only when it is usable', () => {
  assert.deepEqual(chooseAndroidDevice('auto', [{ serial: 'phone-1', state: 'device' }], 'phone-1'), {
    kind: 'physical', serial: 'phone-1', reason: null,
  })
  assert.deepEqual(chooseAndroidDevice('auto', [{ serial: 'phone-1', state: 'unauthorized' }], 'phone-1'), {
    kind: 'emulator', serial: null, reason: 'phone-1: unauthorized',
  })
  assert.deepEqual(chooseAndroidDevice('auto', [], 'phone-1'), {
    kind: 'emulator', serial: null, reason: 'phone-1: not connected',
  })
})

test('physical-only mode fails instead of silently downgrading', () => {
  assert.throws(() => chooseAndroidDevice('physical', [], 'phone-1'), /phone-1: not connected/)
})

test('Windows device priority is configured USB, then fixed Wi-Fi ADB, then Ubuntu AVD', () => {
  const devices = [
    { serial: '192.168.3.121:5555', state: 'device' },
    { serial: 'usb-1', state: 'device' },
  ]
  assert.equal(preferConfiguredUsb(devices, 'usb-1'), true)
  assert.deepEqual(chooseWindowsAndroidPath(devices, 'usb-1', 'auto'), {
    kind: 'physical', serial: 'usb-1', connection: 'usb', reason: null,
  })
  assert.deepEqual(chooseWindowsAndroidPath(devices, 'offline-usb', 'auto'), {
    kind: 'physical', serial: '192.168.3.121:5555', connection: 'network', reason: null,
  })
  assert.deepEqual(chooseWindowsAndroidPath([{ serial: 'attached-usb', state: 'device' }], '', 'auto'), {
    kind: 'physical', serial: 'attached-usb', connection: 'usb', reason: null,
  })
  assert.equal(chooseWindowsAndroidPath([], 'offline-usb', 'auto').kind, 'emulator')
  assert.throws(() => chooseWindowsAndroidPath([], 'offline-usb', 'physical'), /192\.168\.3\.121:5555/)
})

test('ADB parser preserves unauthorized and offline states for the configured serial', () => {
  assert.deepEqual(parseAdbDevices('List of devices attached\nphone-1 unauthorized\nemulator-5554 device\n'), [
    { serial: 'phone-1', state: 'unauthorized' },
    { serial: 'emulator-5554', state: 'device' },
  ])
})

test('artifact manifest validation rejects missing, changed, and duplicate artifacts', () => {
  const data = Buffer.from('data')
  const entries = [{ name: 'app.apk', size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }]
  assert.equal(verifyArtifactManifest(entries, new Map([['app.apk', data]])).ok, true)
  assert.equal(verifyArtifactManifest(entries, new Map([['app.apk', Buffer.from('nope')]])).ok, false)
  assert.equal(verifyArtifactManifest(entries, new Map()).ok, false)
  assert.throws(() => verifyArtifactManifest([...entries, ...entries], new Map()), /duplicate/)
})

test('Windows UI runner is synced beside the persistent worker before a suite starts', () => {
  assert.equal(windowsRunnerDestination('/C:/Users/xujia/.jeff-deploy/incoming/'), '/C:/Users/xujia/.jeff-deploy/desktop-runner.cjs')
  assert.equal(windowsRunnerDestination('C:\\Users\\xujia\\.jeff-deploy\\incoming'), 'C:/Users/xujia/.jeff-deploy/desktop-runner.cjs')
  assert.throws(() => windowsRunnerDestination('/C:/Users/xujia/.jeff-deploy/current'), /must end with \/incoming/)
  assert.equal(windowsIncomingFileDestination('/C:/Users/xujia/.jeff-deploy/incoming/', 'deploy-cleanup-run.mjs'), '/C:/Users/xujia/.jeff-deploy/incoming/deploy-cleanup-run.mjs')
  assert.throws(() => windowsIncomingFileDestination('/C:/Users/xujia/.jeff-deploy/incoming/', '../cleanup.mjs'), /file name is invalid/)
})

test('Android release acceptance checks exact package, version, versionCode, and signing tool version', () => {
  const badging = "package: name='app.jeff.mobile' versionCode='20101' versionName='2.1.1' platformBuildVersionName='15'\n"
  assert.equal(expectedAndroidVersionCode('2.1.1'), 20101)
  assert.deepEqual(validateAndroidReleaseMetadata(badging, '2.1.1'), {
    packageName: 'app.jeff.mobile', versionName: '2.1.1', versionCode: 20101,
  })
  assert.throws(() => validateAndroidReleaseMetadata(badging.replace('20101', '20100'), '2.1.1'), /metadata mismatch/)
  assert.throws(() => expectedAndroidVersionCode('2.1'), /Invalid Android release version/)
})

test('Windows ADB commands are assembled as PowerShell script for encoded SSH transport', () => {
  const config = { windowsAdb: "D:\\soft\\android\\sdk\\it's-adb.exe" }
  assert.equal(windowsAdbScript(config), "$p='D:\\soft\\android\\sdk\\it''s-adb.exe'; if(Test-Path -LiteralPath $p){ & $p devices }")
  assert.equal(windowsAdbScript(config, { connectNetworkPhone: true }), "$p='D:\\soft\\android\\sdk\\it''s-adb.exe'; if(Test-Path -LiteralPath $p){ & $p connect '192.168.3.121:5555'; & $p devices }")
  assert.match(windowsAdbScript({}), /Join-Path \$env:LOCALAPPDATA/)
})

test('Windows cleanup is allowed only after a successful, matching evidence transfer', () => {
  const remoteOutcome = { runId: '2026-10-09T120000-000Z', ok: false }
  const downloadedOutcome = { runId: remoteOutcome.runId, ok: false }
  assert.equal(evidenceTransferVerified({ pullStatus: 0, remoteOutcome, downloadedOutcome }), true)
  assert.equal(evidenceTransferVerified({ pullStatus: 1, remoteOutcome, downloadedOutcome }), false)
  assert.equal(evidenceTransferVerified({ pullStatus: 0, remoteOutcome, downloadedOutcome: { ...downloadedOutcome, runId: 'other' } }), false)
  assert.equal(evidenceTransferVerified({ pullStatus: 0, remoteOutcome, downloadedOutcome: { ...downloadedOutcome, ok: true } }), false)
})
