/**
 * 端到端：LLM TLS 证书校验开关 + 调试日志（真实 opencode sidecar + 自签 HTTPS mock LLM）。
 * 仅在 JEFF_TLS_E2E=1 时运行（需要本机有 opencode 可执行文件与 openssl）。
 * 运行：JEFF_TLS_E2E=1 npx vitest run --no-file-parallelism tests/e2e.tls.test.ts
 * 慢 LLM 模拟：MOCK_DELAY_MS=70000 复现「生成超过 60s」（v1.7.5 曾因 POST 固定 60s 超时误报）。
 *
 * 场景：企业网络对 LLM API 做 TLS 中间人（证书装在系统库，Bun 不读 Windows/Linux 证书存储之外的
 * 自签根）时，opencode 报 unknown certificate verification error。验证：
 *  1. 默认（校验开启）→ 请求自签端点报证书错误，调试日志留下完整 assistant-error 现场；
 *  2. 开启「跳过 LLM 证书校验」（sidecar env NODE_TLS_REJECT_UNAUTHORIZED=0）→ 同端点请求成功；
 *  3. 调试模式关闭后不再写入。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { startMockLlm } from './helpers/mock-llm.mjs'
import { JeffCore, buildPaths, openDb, kvRepo, XIAOJIE_ID } from '../src/index.js'

const RUN = process.env.JEFF_TLS_E2E === '1'
const d = RUN ? describe : describe.skip
const execFileP = promisify(execFile)
const HTTP_PORT = 18085
const HTTPS_PORT = 18443
const BIN = process.env.JEFF_OPENCODE_BIN || path.join(process.env.HOME || '', '.opencode/bin/opencode')

/** 与 logger.ts 的 localDay 一致（本地时区 YYYYMMDD） */
function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

let httpsServer: https.Server
let core: JeffCore
let home: string
let workDir: string

d('E2E: LLM TLS 跳过开关 + 调试日志', () => {
  beforeAll(async () => {
    if (!fs.existsSync(BIN)) throw new Error(`找不到 opencode: ${BIN}`)
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-tls-'))
    // 自签证书：模拟企业 MITM / 自签网关（Bun 默认不信任）
    await execFileP('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(workDir, 'key.pem'),
      '-out', path.join(workDir, 'cert.pem'),
      '-days', '2', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ])
    const key = fs.readFileSync(path.join(workDir, 'key.pem'))
    const cert = fs.readFileSync(path.join(workDir, 'cert.pem'))

    await startMockLlm(HTTP_PORT)
    // 自签 HTTPS 壳：TLS 在这里终止，明文转发到 http mock —— 对 sidecar 而言就是「不被信任的 https 端点」
    httpsServer = https.createServer({ key, cert }, (req, res) => {
      const up = http.request(
        { host: '127.0.0.1', port: HTTP_PORT, method: req.method, path: req.url, headers: req.headers },
        (ur) => {
          res.writeHead(ur.statusCode || 500, ur.headers)
          ur.pipe(res)
        },
      )
      up.on('error', () => {
        res.statusCode = 502
        res.end('upstream error')
      })
      req.pipe(up)
    })
    await new Promise<void>((r) => httpsServer.listen(HTTPS_PORT, '127.0.0.1', r))

    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-tls-home-'))
    const paths = buildPaths(home)
    fs.mkdirSync(path.dirname(paths.dbFile), { recursive: true })
    const db = openDb(paths)
    kvRepo(db).setJSON('settings:providers', [
      { id: 'tls-mock', kind: 'custom', name: 'TlsMock', baseURL: `https://127.0.0.1:${HTTPS_PORT}/v1`, models: [{ id: 'mock-mini', name: 'Mock Mini' }] },
    ])
    // 预置调试模式：随应用启动即生效，才能抓到 sidecar 启动期输出
    kvRepo(db).setJSON('settings:debugLog', { enabled: true })
    db.close()

    core = new JeffCore(home)
    core.on('sidecar-log', (line: string) => {
      if (process.env.JEFF_E2E_LOGS) console.log(line)
    })
    await core.init({ binaryPath: BIN })
  }, 60000)

  afterAll(async () => {
    await core?.dispose()
    httpsServer?.close()
    for (const dir of [workDir, home]) {
      if (dir && process.env.JEFF_E2E_KEEP !== '1') fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('默认（校验开启）：请求自签端点报证书错误，调试日志留完整现场', async () => {
    core.setDebugLog(true)
    let err: unknown = null
    try {
      await core.privateChat.send(XIAOJIE_ID, '小杰', '你好')
    } catch (e) {
      err = e
    }
    expect(err).toBeTruthy()
    expect(String((err as Error)?.message)).toMatch(/certificate|ssl|tls/i)

    const logFile = path.join(core.paths.logDir, `debug-${localDay()}.log`)
    expect(fs.existsSync(logFile)).toBe(true)
    const content = fs.readFileSync(logFile, 'utf8')
    expect(content).toContain('[sidecar]') // 启动期 sidecar 全量输出（调试模式随应用启动预置）
    expect(content).toContain('assistant-error') // 完整错误 JSON
    expect(content).toContain('private-send-fail') // 失败上下文
  }, 180000)

  it('开启「跳过 LLM 证书校验」后同端点请求成功', async () => {
    await core.setLlmTlsSkip(true)
    const content = fs.readFileSync(path.join(core.paths.logDir, `debug-${localDay()}.log`), 'utf8')
    expect(content).toContain('[sidecar-status]') // 开关触发的引擎重启事件
    expect(content).toContain('跳过 LLM 证书校验 = true')
    const reply = await core.privateChat.send(XIAOJIE_ID, '小杰', '你好，请用一句话回复')
    expect(reply.id).toMatch(/^msg_/)
  }, 180000)

  it('关闭调试模式后不再写入', async () => {
    core.setDebugLog(false)
    const logFile = path.join(core.paths.logDir, `debug-${localDay()}.log`)
    const before = fs.readFileSync(logFile, 'utf8').length
    await new Promise((r) => setTimeout(r, 3000)) // 期间 sidecar 可能有输出
    const after = fs.readFileSync(logFile, 'utf8').length
    expect(after).toBe(before)
  }, 30000)
})
