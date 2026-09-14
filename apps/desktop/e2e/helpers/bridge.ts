import fs from 'node:fs'
import path from 'node:path'

/**
 * 工具桥客户端：**不用模型**也能像 agent 一样调 Jeff 工具。
 *
 * 原理：core 启动时会把自己注册的工具渲染成一个 opencode 插件文件
 * （`<home>/oc-home/config/opencode/plugin/jeff-bridge.js`），里面写着本地 HTTP 桥的
 * 地址与 Bearer token。模型侧的工具调用就是 `POST <base>/tools/<name>`，所以测试直接照
 * 这个协议发请求，走的就是**与真实工具调用完全相同的链路**：
 * 工具参数校验 → core 实现 → （浏览器工具还会下发渲染层 webview 执行）→ 结果回传。
 *
 * 为什么要它：mock UI E2E 过去只能点界面，跨进程的工具链路（尤其内置浏览器、定时任务、
 * 插件落盘）只有真模型才能覆盖；有了这个入口，这些链路可以在 CI 里确定性地测。
 */
export interface BridgeClient {
  base: string
  token: string
  call: (name: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>
}

export function readBridge(home: string): BridgeClient {
  const file = path.join(home, 'oc-home', 'config', 'opencode', 'plugin', 'jeff-bridge.js')
  if (!fs.existsSync(file)) throw new Error(`工具桥插件文件不存在（应用还没启动过？）：${file}`)
  const src = fs.readFileSync(file, 'utf8')
  const base = /const BASE = "([^"]+)"/.exec(src)?.[1]
  const token = /const TOKEN = "([^"]+)"/.exec(src)?.[1]
  if (!base || !token) throw new Error(`工具桥文件格式变了，解析不到 BASE/TOKEN：${file}`)
  return {
    base,
    token,
    call: async (name, args = {}) => {
      const res = await fetch(`${base}/tools/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(120_000),
      })
      const body = (await res.json()) as { ok: boolean; data?: unknown; error?: string }
      return body
    },
  }
}

/** 与 readBridge 配套：调工具并在失败时直接抛出（断言里只关心成功路径时更顺手） */
export async function callToolOk<T = Record<string, unknown>>(bridge: BridgeClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await bridge.call(name, args)
  if (!r.ok) throw new Error(`${name} 调用失败：${r.error || '未知错误'}`)
  return r.data as T
}
