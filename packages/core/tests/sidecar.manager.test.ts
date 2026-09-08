import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SidecarManager } from '../src/sidecar/manager.js'
import { buildPaths } from '../src/paths.js'

/**
 * 假 opencode 二进制：解析 --port 后起一个 /doc 返回 200 的 http 服务，
 * 用于验证 SidecarManager 的 start/ready/崩溃自动重启换代/stop 生命周期。
 * 仅 linux/mac 可跑（依赖 bash 脚本二进制）。
 */
describe.skipIf(process.platform === 'win32')('SidecarManager 生命周期', () => {
  let tmp = ''
  let manager: SidecarManager | null = null

  const makeManager = (): SidecarManager => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-sidecar-'))
    const paths = buildPaths(tmp)
    fs.mkdirSync(paths.workspaceDir, { recursive: true })
    const bin = path.join(tmp, 'fake-opencode')
    fs.writeFileSync(
      bin,
      `#!/bin/bash
PORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
exec env FAKE_PORT="$PORT" node -e '
const http = require("node:http");
const srv = http.createServer((req, res) => {
  if ((req.url || "").startsWith("/doc")) { res.writeHead(200, {"content-type":"application/json"}); res.end("{}"); return }
  res.writeHead(404); res.end();
});
srv.listen(Number(process.env.FAKE_PORT), "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
'
`,
    )
    fs.chmodSync(bin, 0o755)
    return new SidecarManager({ paths, binaryPath: bin, minPort: 18096, maxPort: 19096 })
  }

  afterEach(async () => {
    await manager?.stop().catch(() => {})
    manager = null
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('start：健康启动发 ready 事件（port + generation=1）', async () => {
    manager = makeManager()
    const ready: Array<{ port: number; generation: number }> = []
    manager.on('ready', (info: { port: number; generation: number }) => ready.push(info))
    const port = await manager.start()
    expect(ready).toHaveLength(1)
    expect(ready[0]).toEqual({ port, generation: 1 })
    expect(manager.status).toBe('running')
    expect(manager.port).toBe(port)
  })

  it('崩溃后自动重启换代：generation +1 且新端口可服务', async () => {
    manager = makeManager()
    const ready: Array<{ port: number; generation: number }> = []
    manager.on('ready', (info: { port: number; generation: number }) => ready.push(info))
    await manager.start()
    expect(manager.generation).toBe(1)
    // 模拟崩溃：杀掉当前进程 → exit → scheduleRestart（1s 后）
    manager['proc']?.kill('SIGKILL')
    const deadline = Date.now() + 15000
    while (manager.generation < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(manager.generation).toBe(2)
    expect(manager.status).toBe('running')
    expect(ready).toHaveLength(2)
    expect(ready[1].generation).toBe(2)
    // 新实例健康可服务
    expect(await manager.ping()).toBe(true)
  }, 20000)

  it('stop：干净退出且状态 stopped', async () => {
    manager = makeManager()
    await manager.start()
    await manager.stop()
    expect(manager.status).toBe('stopped')
    expect(await manager.ping()).toBe(false)
  }, 20000)

  it('崩溃后立刻显式 stop：已排队的自动重启被取消，不会自己复活', async () => {
    manager = makeManager()
    await manager.start()
    // 模拟崩溃：kill → exit 事件安排 1s 后自动重启
    manager['proc']?.kill('SIGKILL')
    // 在重启 timer 到期前显式 stop
    await new Promise((r) => setTimeout(r, 300))
    await manager.stop()
    expect(manager.status).toBe('stopped')
    // 等待远超原重启延迟：generation 不应增加（不会被旧 timer 拉起）
    await new Promise((r) => setTimeout(r, 4000))
    expect(manager.generation).toBe(1)
    expect(manager.status).toBe('stopped')
    expect(await manager.ping()).toBe(false)
  }, 20000)

  it('恢复运行后清空 lastError（旧崩溃错误不再挂在现时状态上）', async () => {
    manager = makeManager()
    await manager.start()
    expect(manager.lastError).toBe('')
    manager['proc']?.kill('SIGKILL')
    const deadline = Date.now() + 15000
    while (manager.generation < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(manager.generation).toBe(2)
    expect(manager.status).toBe('running')
    expect(manager.lastError).toBe('')
  }, 20000)
})
