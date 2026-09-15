import { randomToken } from '../util/id.js'
import type { BrowserAction, BrowserResult } from '../ipc/contract.js'

/**
 * 内置浏览器控制接口。
 *
 * 为什么抽象成接口：webview 活在渲染进程，而工具调用发生在 core/主进程。
 * core 只声明「我要执行一个浏览器动作」，由桌面主进程注入真正的实现
 * （下发到渲染层的 webview 执行并回传结果）；无界面场景（单测/headless 脚本）
 * 自动落到 UnavailableBrowser 返回明确错误，而不是让 agent 调用时挂死。
 */
export interface BrowserControl {
  /** 执行一个动作；实现方必须自带超时，绝不无限等待 */
  request(action: BrowserAction, args: Record<string, unknown>): Promise<unknown>
  /** 当前浏览器是否可用（面板已打开、webview 就绪） */
  available(): boolean
  /** 当前状态（url/title/是否可见），供 agent 判断上下文 */
  state(): { visible: boolean; url: string; title: string; loading: boolean }
}

/** 无浏览器实现（headless / 面板未打开前） */
export class UnavailableBrowser implements BrowserControl {
  constructor(private reason = '内置浏览器未打开') {}
  async request(_action: BrowserAction, _args: Record<string, unknown>): Promise<unknown> {
    throw new Error(`${this.reason}：请先在 Jeff 顶部菜单「显示 → 内置浏览器」打开浏览器面板，再让我操作网页。`)
  }
  available(): boolean {
    return false
  }
  state(): { visible: boolean; url: string; title: string; loading: boolean } {
    return { visible: false, url: '', title: '', loading: false }
  }
}

/**
 * 基于「下发请求 → 渲染层回传结果」的浏览器控制实现（桌面主进程使用）。
 * pending 表按随机 id 关联请求与回传；每个请求都有超时，防止渲染层崩溃导致工具调用永久挂起。
 */
export class BridgeBrowserControl implements BrowserControl {
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private lastState = { visible: false, url: '', title: '', loading: false }

  constructor(
    private send: (req: { id: string; action: BrowserAction; args: Record<string, unknown> }) => void,
    private timeoutMs = 30_000,
    /** 慢动作的超时：整页截图要分片截取并等图片加载完（长文能到十几秒），30s 不够（会被判成「页面无响应」） */
    private slowTimeoutMs = 120_000,
  ) {}

  /** 按动作取超时：截图（分片 + 等图）与改视口（等页面重排）都给足时间 */
  private limitFor(action: BrowserAction): number {
    return action === 'screenshot' || action === 'set_viewport' ? this.slowTimeoutMs : this.timeoutMs
  }

  available(): boolean {
    return true
  }

  state(): { visible: boolean; url: string; title: string; loading: boolean } {
    return this.lastState
  }

  /** 渲染层回报状态（面板开着时持续同步，供 agent 读取当前页面） */
  updateState(s: Partial<{ visible: boolean; url: string; title: string; loading: boolean }>): void {
    this.lastState = { ...this.lastState, ...s }
  }

  async request(action: BrowserAction, args: Record<string, unknown>): Promise<unknown> {
    const id = randomToken(12)
    const limit = this.limitFor(action)
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`浏览器操作超时（${Math.round(limit / 1000)}s，${action}）：面板可能已关闭或页面无响应`))
      }, limit)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ id, action, args })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`浏览器操作下发失败：${String((err as Error)?.message || err)}`))
      }
    })
  }

  /** 渲染层回传结果（对应 IPC.browserResult） */
  settle(result: BrowserResult): void {
    const p = this.pending.get(result.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(result.id)
    if (result.ok) p.resolve(result.data)
    else p.reject(new Error(result.error || '浏览器操作失败'))
  }
}
