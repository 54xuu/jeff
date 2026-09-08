import fs from 'node:fs'
import path from 'node:path'
import type { JeffPaths } from './paths.js'

/** 调试日志回调（OcClient / hooks / Delegator 等注入用，避免各自依赖 logger 实例） */
export type DebugLogFn = (tag: string, detail: unknown) => void

const MAX_LOG_BYTES = 5 * 1024 * 1024

/** 本地时区的 YYYYMMDD（日志按天分文件） */
function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** 本地时区时间戳 [YYYY-MM-DD HH:mm:ss.SSS]（无 T/Z；用户要求的日志格式） */
function formatLocalTime(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/**
 * 调试日志（默认关闭，设置 → 引擎服务 开启）：
 * 写 `<dataDir>/logs/debug-YYYYMMDD.log`，按天分文件；单文件超 5MB 轮转为 .old.log。
 * 记录 sidecar 全量输出与消息处理完整错误 —— 用于远端环境（如企业网络证书拦截）的现场分析。
 */
export class DebugLogger {
  private enabled = false

  constructor(private paths: JeffPaths) {}

  setEnabled(v: boolean): void {
    this.enabled = !!v
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** enabled=false 时 no-op；写文件失败静默忽略（不能影响主流程） */
  log(tag: string, detail: unknown): void {
    if (!this.enabled) return
    try {
      const file = path.join(this.paths.logDir, `debug-${localDay()}.log`)
      try {
        if (fs.statSync(file).size > MAX_LOG_BYTES) {
          const old = file.replace(/\.log$/, '.old.log')
          fs.rmSync(old, { force: true })
          fs.renameSync(file, old)
        }
      } catch {
        /* 文件不存在等，忽略 */
      }
      const body = typeof detail === 'string' ? detail : JSON.stringify(detail)
      fs.appendFileSync(file, `[${formatLocalTime()}] [${tag}] ${body}\n`)
    } catch {
      /* 忽略 */
    }
  }

  /** 供注入用的 DebugLogFn */
  fn(): DebugLogFn {
    return (tag, detail) => this.log(tag, detail)
  }
}
