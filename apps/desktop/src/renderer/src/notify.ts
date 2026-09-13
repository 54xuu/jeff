/**
 * 消息提醒：提示音播放 + 系统桌面通知。
 *
 * 声音为什么不交给系统通知：Linux（GNOME/KDE）的通知默认不带音效，Windows 的通知音又受
 * 系统「免打扰/通知声音」开关影响，同一份代码在两端表现不一致。所以原生通知一律 silent，
 * 声音由应用自己播——全平台同一枚音色，关掉开关就是彻底安静。
 *
 * 音效文件由 `.tmp/gen-notify-wav.mjs` 生成（两枚柔和钟琴音 A5→D6），已提交进仓库。
 * 若音频文件解码/播放失败，退回 Web Audio 现场合成同样的双音铃，保证任何环境下都有反馈。
 */
import notifySoundUrl from './assets/sounds/notify.wav'
import { api } from './api'
import { IPC } from '@jeff/core'

let audio: HTMLAudioElement | null = null
let synthCtx: AudioContext | null = null

/** 提示音默认音量：够清晰但不吓人 */
const NOTIFY_VOLUME = 0.5

/** 窗口是否在前台（最小化 / 被遮挡在后台 / 切到别的虚拟桌面都算不在） */
export function windowFocused(): boolean {
  try {
    return document.hasFocus() && !document.hidden
  } catch {
    return false
  }
}

/** 播放消息提示音；音频元素不可用时退回合成音 */
export function playNotifySound(volume = NOTIFY_VOLUME): void {
  try {
    if (!audio) {
      audio = new Audio(notifySoundUrl)
      audio.preload = 'auto'
    }
    audio.volume = volume
    // readyState=0 时写 currentTime 会抛 InvalidStateError（首次播放前文件还没解码）
    if (audio.readyState > 0) audio.currentTime = 0
    const p = audio.play()
    if (p && typeof p.catch === 'function') p.catch(() => synthChime())
  } catch {
    synthChime()
  }
}

/** Web Audio 兜底：A5 接 D6 两个正弦音，指数衰减成铃感 */
function synthChime(): void {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    synthCtx = synthCtx || new Ctor()
    const ctx = synthCtx
    if (ctx.state === 'suspended') void ctx.resume()
    const now = ctx.currentTime
    const notes: Array<[number, number]> = [
      [0, 880],
      [0.115, 1174.66],
    ]
    for (const [offset, freq] of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, now + offset)
      gain.gain.exponentialRampToValueAtTime(0.22, now + offset + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.55)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + offset)
      osc.stop(now + offset + 0.6)
    }
  } catch {
    /* 铃声不是关键路径，失败就静默 */
  }
}

/** 请求主进程弹系统桌面通知（失败不抛：提醒失败不该影响聊天） */
export function showDesktopNotify(p: { title: string; body?: string; kind?: 'agent' | 'group'; id?: string }): void {
  void api.invoke(IPC.notifyDesktop, p).catch(() => {})
}

/**
 * 把回复正文压成一行通知摘要：去掉代码块/图片/链接语法与多余空白，超长截断。
 * 通知里出现整段 Markdown 源码既读不懂又会被系统截得很丑。
 */
export function summarize(text: string, max = 90): string {
  const flat = (text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return ''
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
