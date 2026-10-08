#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = path.join(ROOT, '.tmp/deploy/config.json')
const ANDROID_ADB = path.join(os.homedir(), 'Android/Sdk/platform-tools/adb')
const ANDROID_EMULATOR = path.join(os.homedir(), 'Android/Sdk/emulator/emulator')
let ownsAvd = false

process.on('exit', () => {
  if (ownsAvd) spawnSync(ANDROID_ADB, ['-s', 'emulator-5554', 'emu', 'kill'], { stdio: 'ignore' })
})

export function parseArgs(argv) {
  const out = { target: null, android: null, suite: null }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!['--target', '--android', '--suite'].includes(key)) throw new Error(`Unknown option: ${key}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
    out[key.slice(2)] = value
  }
  if (out.target !== 'win11') throw new Error('--target win11 is required')
  if (!['auto', 'physical', 'emulator'].includes(out.android)) throw new Error('--android must be auto, physical, or emulator')
  if (!out.suite) throw new Error('--suite is required')
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(out.suite)) throw new Error('--suite must be a lowercase suite id')
  return out
}

export function chooseAndroidDevice(mode, devices, preferredSerial) {
  const preferred = preferredSerial ? devices.find((d) => d.serial === preferredSerial) : null
  if (mode === 'emulator') return { kind: 'emulator', serial: null, reason: 'emulator requested' }
  if (preferred?.state === 'device') return { kind: 'physical', serial: preferred.serial, reason: null }
  const reason = preferred ? `${preferredSerial}: ${preferred.state}` : `${preferredSerial || 'configured phone'}: not connected`
  if (mode === 'physical') throw new Error(`Physical Android device is required (${reason})`)
  return { kind: 'emulator', serial: null, reason }
}

export function verifyArtifactManifest(entries, files) {
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`duplicate artifact: ${entry.name}`)
    seen.add(entry.name)
  }
  for (const entry of entries) {
    const file = files.get(entry.name)
    if (!file || file.length !== entry.size || crypto.createHash('sha256').update(file).digest('hex') !== entry.sha256) {
      return { ok: false, artifact: entry.name }
    }
  }
  return { ok: true }
}

export function parseAdbDevices(output) {
  const lines = output.split(/\r?\n/)
  const header = lines.findIndex((line) => line.trim() === 'List of devices attached')
  return lines.slice(header >= 0 ? header + 1 : 0).filter(Boolean).map((line) => {
    const [serial, state] = line.trim().split(/\s+/)
    return { serial, state }
  })
}

export function chooseWindowsAndroidPath(devices, usbSerial, mode) {
  if (mode === 'emulator') return { kind: 'emulator', serial: null, connection: null, reason: 'emulator requested' }
  const usb = usbSerial
    ? devices.find((d) => d.serial === usbSerial && d.state === 'device')
    : devices.find((d) => d.state === 'device' && !d.serial.startsWith('emulator-') && !d.serial.includes(':'))
  if (usb) return { kind: 'physical', serial: usb.serial, connection: 'usb', reason: null }
  const network = devices.find((d) => d.serial === '192.168.3.121:5555' && d.state === 'device')
  if (network) return { kind: 'physical', serial: network.serial, connection: 'network', reason: null }
  const reason = usbSerial
    ? `${usbSerial}: ${devices.find((d) => d.serial === usbSerial)?.state || 'not connected'}; 192.168.3.121:5555: not connected`
    : 'USB and network ADB devices are not connected'
  if (mode === 'physical') throw new Error(`A Windows Android device is required (${reason})`)
  return { kind: 'emulator', serial: null, connection: null, reason }
}

export function preferConfiguredUsb(devices, usbSerial) {
  return Boolean(usbSerial && devices.some((device) => device.serial === usbSerial && device.state === 'device'))
}

export function windowsRunnerDestination(incomingPath) {
  const normalized = incomingPath.replaceAll('\\', '/').replace(/\/+$/, '')
  if (!normalized.endsWith('/incoming')) throw new Error('Windows incoming path must end with /incoming')
  return `${normalized.slice(0, -'/incoming'.length)}/desktop-runner.cjs`
}

function run(label, command, args, options = {}) {
  console.log(`\n[deploy] ${label}`)
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? 'signal'})`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function adbDevices(adb) {
  const result = spawnSync(adb, ['devices'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`adb devices failed: ${result.stderr}`)
  return parseAdbDevices(result.stdout)
}

function startEmulator() {
  const devices = adbDevices(ANDROID_ADB)
  const present = devices.find((d) => d.serial === 'emulator-5554' && d.state === 'device')
  const knownInstance = devices.some((d) => d.serial === 'emulator-5554')
  if (!present && !knownInstance) {
    const child = spawn(ANDROID_EMULATOR, ['-avd', 'jeff', '-no-window', '-no-audio', '-gpu', 'swiftshader_indirect', '-accel', 'on', '-no-snapshot'], {
      cwd: ROOT, detached: true, stdio: 'ignore',
    })
    child.unref()
    ownsAvd = true
  }
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const device = adbDevices(ANDROID_ADB).find((d) => d.serial === 'emulator-5554' && d.state === 'device')
    if (device) {
      const boot = spawnSync(ANDROID_ADB, ['-s', device.serial, 'shell', 'getprop', 'sys.boot_completed'], { encoding: 'utf8' })
      if (boot.status === 0 && boot.stdout.trim() === '1') return device.serial
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  }
  throw new Error('Android AVD jeff did not boot within 180 seconds')
}

function installAvdApk(serial, apk, applicationId) {
  let result = spawnSync(ANDROID_ADB, ['-s', serial, 'install', '-r', apk], { encoding: 'utf8' })
  if (result.status === 0) {
    console.log(`[deploy] Updated AVD ${applicationId}`)
    return
  }
  if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`AVD install failed for ${applicationId}: ${(result.stderr || result.stdout).trim()}`)
  }
  console.log(`[deploy] AVD test profile has an older signing key; removing only ${applicationId} from AVD jeff.`)
  run(`Remove old AVD test package ${applicationId}`, ANDROID_ADB, ['-s', serial, 'uninstall', applicationId])
  run(`Install AVD package ${applicationId}`, ANDROID_ADB, ['-s', serial, 'install', apk])
}

function prepareAvd(serial) {
  run('Grant camera permission inside the dedicated AVD', ANDROID_ADB, ['-s', serial, 'shell', 'pm', 'grant', 'app.jeff.mobile', 'android.permission.CAMERA'])
  run('Grant notification permission inside the dedicated AVD', ANDROID_ADB, ['-s', serial, 'shell', 'pm', 'grant', 'app.jeff.mobile', 'android.permission.POST_NOTIFICATIONS'])
  run('Allow background service inside the dedicated AVD', ANDROID_ADB, ['-s', serial, 'shell', 'dumpsys', 'deviceidle', 'whitelist', '+app.jeff.mobile'])
}

function captureAvdDiagnostics(serial, runDir, suffix) {
  const crashLog = spawnSync(ANDROID_ADB, ['-s', serial, 'logcat', '-d', '-b', 'crash'], { encoding: 'utf8' })
  fs.writeFileSync(path.join(runDir, `android-${suffix}-crash.log`), crashLog.stdout || crashLog.stderr || '')
  const exits = spawnSync(ANDROID_ADB, ['-s', serial, 'shell', 'dumpsys', 'activity', 'exit-info', 'app.jeff.mobile'], { encoding: 'utf8' })
  fs.writeFileSync(path.join(runDir, `android-${suffix}-exit-info.txt`), exits.stdout || exits.stderr || '')
}

function shutdownOwnedAvd(serial) {
  if (!ownsAvd) return
  const result = spawnSync(ANDROID_ADB, ['-s', serial, 'emu', 'kill'], { encoding: 'utf8' })
  if (result.status !== 0) console.warn('[deploy] Could not stop the AVD started by this run.')
  ownsAvd = false
}

function artifactEntries(files) {
  return files.map((file) => {
    const data = fs.readFileSync(file)
    return { name: path.basename(file), size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }
  })
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function sshOutput(config, remoteCommand) {
  const result = spawnSync('ssh', ['-F', config.sshConfig, config.sshAlias, remoteCommand], { cwd: ROOT, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Windows SSH command failed: ${result.stderr.trim()}`)
  return result.stdout
}

function windowsDevices(config) {
  const adb = config.windowsAdb
    ? `$p='${String(config.windowsAdb).replaceAll("'", "''")}'`
    : "$p=Join-Path $env:LOCALAPPDATA 'Android\\Sdk\\platform-tools\\adb.exe'"
  const command = `powershell.exe -NoProfile -Command "${adb}; if(Test-Path $p){ & $p devices }"`
  return parseAdbDevices(sshOutput(config, command))
}

function connectWindowsNetworkAdb(config) {
  const adb = config.windowsAdb
    ? `$p='${String(config.windowsAdb).replaceAll("'", "''")}'`
    : "$p=Join-Path $env:LOCALAPPDATA 'Android\\Sdk\\platform-tools\\adb.exe'"
  const command = `powershell.exe -NoProfile -Command "${adb}; if(Test-Path $p){ & $p connect 192.168.3.121:5555; & $p devices }"`
  return parseAdbDevices(sshOutput(config, command))
}

function scp(config, files, destination) {
  run('Copy artifacts to Windows', 'scp', ['-F', config.sshConfig, ...files, `${config.sshAlias}:${destination}`])
}

function performLocalChecks() {
  const checks = [
    ['npm test', 'npm', ['test']],
    ['TypeScript typecheck', 'npm', ['run', 'typecheck']],
    ['Desktop UI E2E', 'xvfb-run', ['-a', 'npm', 'run', 'test:e2e']],
    ['v18 closed E2E', 'xvfb-run', ['-a', 'npx', 'playwright', 'test', '-c', 'apps/desktop/e2e/playwright.config.ts', '--project=v18']],
    ['cron closed E2E', 'xvfb-run', ['-a', 'npx', 'playwright', 'test', '-c', 'apps/desktop/e2e/playwright.config.ts', '--project=cron']],
    ['Multi-engine E2E', 'xvfb-run', ['-a', 'npx', 'playwright', 'test', '-c', 'apps/desktop/e2e/playwright.config.ts', '--project=engines']],
    ['Pairing closed E2E', 'xvfb-run', ['-a', 'npx', 'playwright', 'test', '-c', 'apps/desktop/e2e/playwright.config.ts', '--project=remote', '-g', '假手机经本地|手机页面在']],
    ['Mobile unit tests', 'npm', ['test', '-w', '@jeff/mobile']],
    ['Mobile browser E2E', 'npm', ['run', 'test:e2e', '-w', '@jeff/mobile']],
  ]
  for (const [label, command, args] of checks) run(label, command, args)
}

function loadSigningEnvironment(environment) {
  if (environment.JEFF_ANDROID_STORE_PASSWORD) return environment
  const memory = '/home/xujian/.zcode/cli/memories/projects/jeff-1d2f0b1cdfcc2a44/memory/android-release-keystore.md'
  if (!fs.existsSync(memory)) throw new Error('Android release signing memory is unavailable; refusing to build an unsigned upgrade APK')
  const contents = fs.readFileSync(memory, 'utf8')
  const match = contents.match(/^store 口令与 key 口令相同：\s*`([^`]+)`/m)
  if (!match) throw new Error('Android release keystore password is missing from local memory')
  return { ...environment, JEFF_ANDROID_STORE_PASSWORD: match[1], JEFF_ANDROID_KEY_PASSWORD: match[1] }
}

function buildArtifacts(environment) {
  run('Build Ubuntu deb and AppImage', 'npm', ['run', 'package:linux'])
  run('Build Windows installer', 'npm', ['run', 'package:win'])
  run('Build Android web assets', 'npm', ['run', 'cap:sync', '-w', '@jeff/mobile'])
  const signedEnvironment = loadSigningEnvironment(environment)
  run('Build signed Android release and instrumentation APKs', './gradlew', ['assembleRelease', 'assembleReleaseAndroidTest'], {
    cwd: path.join(ROOT, 'apps/mobile/android'), env: signedEnvironment,
  })
}

function locateArtifacts(version) {
  const files = [
    path.join(ROOT, 'apps/desktop/release', `jeff-Setup-${version}.exe`),
    path.join(ROOT, 'apps/desktop/release', `jeff-desktop_${version}_amd64.deb`),
    path.join(ROOT, 'apps/desktop/release', `Jeff-${version}.AppImage`),
    path.join(ROOT, 'apps/mobile/android/release', `jeff-${version}.apk`),
    path.join(ROOT, 'apps/mobile/android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk'),
  ]
  for (const file of files) if (!fs.existsSync(file)) throw new Error(`Expected artifact is missing: ${file}`)
  return files
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error(`${error.message}\nUsage: npm run deploy:windows -- --target win11 --android auto|physical|emulator --suite smoke`)
    process.exitCode = 2
    return
  }
  const suiteFile = path.join(ROOT, 'deploy/suites', `${args.suite}.json`)
  if (!fs.existsSync(suiteFile)) throw new Error(`Unknown suite '${args.suite}'. Add deploy/suites/${args.suite}.json with acceptance checks first.`)
  const suite = readJson(suiteFile)
  if (!Array.isArray(suite.desktop?.visible) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(suite.androidTestClass || '')) {
    throw new Error(`Suite '${args.suite}' must declare desktop.visible selectors and a simple Android instrumentation class name.`)
  }
  if (!fs.existsSync(CONFIG)) throw new Error('Windows target is not configured. Follow deploy/windows/README.md and run Configure-Windows.ps1 once.')
  const config = readJson(CONFIG)
  if (config.host !== '192.168.3.143' || config.ubuntuHost !== '192.168.3.176' || !config.relayUrl) {
    throw new Error('Local deploy config must name Windows 192.168.3.143, Ubuntu 192.168.3.176, and the relay URL.')
  }

  const started = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
  const runDir = path.join(ROOT, '.tmp/deploy', started)
  fs.mkdirSync(runDir, { recursive: true })
  performLocalChecks()
  const env = loadSigningEnvironment(process.env)
  buildArtifacts(env)
  const version = readJson(path.join(ROOT, 'package.json')).version
  const files = locateArtifacts(version)
  const desktopAsar = path.join(ROOT, 'apps/desktop/release/win-unpacked/resources/app.asar')
  if (!fs.existsSync(desktopAsar) || !fs.existsSync(path.join(ROOT, 'apps/desktop/release/win-unpacked/resources/oc-bin/windows-x64/opencode.exe'))) {
    throw new Error('Windows unpacked app is missing app.asar or bundled opencode.exe')
  }
  const androidSerial = startEmulator()
  const apk = files.find((file) => file.endsWith('.apk') && file.includes('/release/jeff-'))
  const testApk = files.find((file) => file.endsWith('app-release-androidTest.apk'))
  installAvdApk(androidSerial, apk, 'app.jeff.mobile')
  installAvdApk(androidSerial, testApk, 'app.jeff.mobile.test')
  prepareAvd(androidSerial)
  try {
    run('Run AVD instrumentation acceptance', ANDROID_ADB, ['-s', androidSerial, 'shell', 'am', 'instrument', '-w', '-e', 'class', `app.jeff.mobile.${suite.androidTestClass}`, 'app.jeff.mobile.test/androidx.test.runner.AndroidJUnitRunner'])
  } catch (error) {
    captureAvdDiagnostics(androidSerial, runDir, 'emulator')
    throw error
  }
  captureAvdDiagnostics(androidSerial, runDir, 'emulator')
  run('Capture AVD screenshot', ANDROID_ADB, ['-s', androidSerial, 'exec-out', 'screencap', '-p'], {
    stdio: ['ignore', fs.openSync(path.join(runDir, 'android-emulator.png'), 'w'), 'inherit'],
  })
  let android = { kind: 'emulator', serial: androidSerial, connection: null, reason: null }
  if (args.android !== 'emulator') {
    let usbFirst = windowsDevices(config)
    if (config.phoneSerial && !preferConfiguredUsb(usbFirst, config.phoneSerial)) {
      const usbDeadline = Date.now() + 15_000
      while (Date.now() < usbDeadline && !preferConfiguredUsb(usbFirst, config.phoneSerial)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
        usbFirst = windowsDevices(config)
      }
    }
    android = chooseWindowsAndroidPath(usbFirst, config.phoneSerial, 'auto')
    if (android.kind !== 'physical') {
      const afterNetworkConnect = connectWindowsNetworkAdb(config)
      android = chooseWindowsAndroidPath(afterNetworkConnect, config.phoneSerial, args.android)
    } else if (args.android === 'physical') {
      // USB has higher priority than the configured network ADB target.
    }
  }
  const entries = artifactEntries(files)
  const manifest = { runId: started, version, commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(), android, artifacts: entries }
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const request = {
    runId: started, version, suite: args.suite, androidMode: android.kind,
    phoneSerial: android.connection === 'usb' ? android.serial : android.connection === 'network' ? android.serial : '',
    androidConnection: android.connection, androidPolicy: args.android,
    relayUrl: config.relayUrl, androidTestClass: suite.androidTestClass, windowsAdb: config.windowsAdb,
    desktopAsarSha256: sha256File(desktopAsar),
    artifacts: entries,
  }
  const requestFile = path.join(runDir, `${started}.request.json`)
  fs.writeFileSync(requestFile, JSON.stringify(request, null, 2))
  const desktopRunner = path.join(ROOT, 'deploy/windows/desktop-runner.cjs')
  scp(config, [desktopRunner], windowsRunnerDestination(config.incomingPath))
  // Upload the request marker last; the Windows worker only starts after every referenced file exists.
  scp(config, [...files, path.join(runDir, 'manifest.json'), suiteFile, requestFile], config.incomingPath)
  sshOutput(config, `schtasks.exe /Run /TN JeffDeployWorker`)
  const deadline = Date.now() + 20 * 60_000
  let outcome
  while (Date.now() < deadline) {
    const raw = sshOutput(config, `powershell.exe -NoProfile -Command "$p=Join-Path $env:USERPROFILE '.jeff-deploy\\results\\${started}\\outcome.json'; if(Test-Path $p){ Get-Content $p -Raw }"`)
    if (raw.trim()) { outcome = JSON.parse(raw.replace(/^\uFEFF/, '')); break }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
  }
  if (!outcome) throw new Error('Windows deployment worker did not report a result within 20 minutes')
  if (outcome.androidRetryRequired) {
    console.log('[deploy] Windows reports that the physical device disconnected mid-test; rerun the complete Android suite on Ubuntu AVD.')
    try {
      run('Rerun Android instrumentation on Ubuntu AVD after physical disconnect', ANDROID_ADB, ['-s', androidSerial, 'shell', 'am', 'instrument', '-w', '-e', 'class', `app.jeff.mobile.${suite.androidTestClass}`, 'app.jeff.mobile.test/androidx.test.runner.AndroidJUnitRunner'])
    } catch (error) {
      captureAvdDiagnostics(androidSerial, runDir, 'emulator-after-disconnect')
      throw error
    }
    captureAvdDiagnostics(androidSerial, runDir, 'emulator-after-disconnect')
    run('Capture post-disconnect AVD screenshot', ANDROID_ADB, ['-s', androidSerial, 'exec-out', 'screencap', '-p'], {
      stdio: ['ignore', fs.openSync(path.join(runDir, 'android-emulator-after-disconnect.png'), 'w'), 'inherit'],
    })
    outcome.androidResult = 'Ubuntu 模拟器通过；Windows 真机途中断连，已留证并在模拟器重跑全套通过'
  }
  shutdownOwnedAvd(androidSerial)
  const pull = spawnSync('scp', ['-r', '-F', config.sshConfig, `${config.sshAlias}:${config.resultPath}/${started}`, runDir], { cwd: ROOT, stdio: 'inherit' })
  if (pull.status !== 0) console.warn('[deploy] Windows screenshots/logs could not be copied; result is still available on Windows.')
  fs.writeFileSync(path.join(runDir, 'outcome.json'), JSON.stringify(outcome, null, 2))
  if (!outcome.ok) throw new Error(`Windows deployment or acceptance failed: ${outcome.message}`)
  const androidLabel = outcome.androidResult || (android.kind === 'emulator'
    ? `Ubuntu 模拟器通过${android.reason ? `（${android.reason}）` : ''}`
    : `Windows ${android.connection === 'usb' ? 'USB 真机' : '网络 ADB 真机'}通过`)
  console.log(`\n[deploy] Ubuntu AVD 基线通过；${androidLabel}; Windows installed and accepted; evidence: ${runDir}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[deploy] ${error.message}`); process.exitCode = 1 })
}
