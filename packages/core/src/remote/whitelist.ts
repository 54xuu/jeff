import { IPC } from '../ipc/contract.js'

export type RemotePolicy = 'allow' | 'deny' | 'replace' | 'push'

export interface RemoteRule {
  policy: RemotePolicy
  /** replace：远程侧改走哪条能力；deny：为什么不能远程调 */
  note?: string
}

const DENY: Record<string, string> = {
  [IPC.notifyDesktop]: '桌面通知只在电脑本机弹',
  [IPC.debugLogOpenDir]: '打开本机日志目录，手机没有这个文件夹',
  [IPC.browserResult]: '内置浏览器渲染层回传，不是用户操作',
  [IPC.browserState]: '内置浏览器渲染层回传，不是用户操作',
  [IPC.browserPageShot]: '截图走电脑上的 webview，手机不能直接调',
  [IPC.smokeShot]: '冒烟钩子',
  [IPC.smokeDone]: '冒烟钩子',
  [IPC.remoteStatus]: '远程控制设置只在电脑上操作',
  [IPC.remotePairStart]: '配对由电脑发起',
  [IPC.remotePairConfirm]: '确认绑定只在电脑上点',
  [IPC.remoteUnbind]: '这条是电脑设置页用的，手机解绑走中转站自己的帧',
  [IPC.remoteSettings]: '开机自启和防睡眠只在电脑上改',
  [IPC.remoteFocus]: '桌面端把当前会话推给手机，不接受手机回调这一条',
  [IPC.remoteReconnect]: '重新连接中转站只在电脑上操作',
}

const REPLACE: Record<string, string> = {
  [IPC.dialogPickDir]: '改为 fs:listDirs，在手机上浏览电脑目录',
  [IPC.pluginImport]: '必须带 dir，目录由 fs:listDirs 选，不再弹电脑上的对话框',
  [IPC.fsOpenPath]: '改为手机预览或下载，不调用电脑上的系统程序',
}

const PUSH = new Set<string>([
  IPC.evStatus,
  IPC.evSidecarLog,
  IPC.evChatUpdated,
  IPC.evDataChanged,
  IPC.evGroupUpdated,
  IPC.evSync,
  IPC.evChatStream,
])

function build(): Record<string, RemoteRule> {
  const out: Record<string, RemoteRule> = {}
  for (const ch of Object.values(IPC)) {
    if (out[ch]) throw new Error(`重复通道 ${ch}`)
    if (DENY[ch]) out[ch] = { policy: 'deny', note: DENY[ch] }
    else if (REPLACE[ch]) out[ch] = { policy: 'replace', note: REPLACE[ch] }
    else if (PUSH.has(ch)) out[ch] = { policy: 'push' }
    else out[ch] = { policy: 'allow' }
  }
  return out
}

/** 每个 IPC 通道恰好一条规则。新增通道未归类时模块加载即失败。 */
export const REMOTE_POLICY: Record<string, RemoteRule> = build()

export function remoteRule(channel: string): RemoteRule {
  const rule = REMOTE_POLICY[channel]
  if (!rule) throw new Error(`远程白名单未收录通道 ${channel}`)
  return rule
}

/**
 * 桌面端实际 `jeff:push` 的 what。
 * `IPC.ev*` 是契约里的频道名（如 ev:chat-stream），主进程 broadcast 用的是另一套短名
 * （见 apps/desktop/src/main/index.ts）。一期网关要转发的是短名，不是 IPC.ev*。
 * data-changed 更特殊：what 直接是 'agents' | 'projects' 等，没有统一前缀。
 */
export const DESKTOP_PUSH_WHAT = ['chat-stream', 'chat-updated', 'group-updated', 'cron-updated', 'cron-turn-done', 'sidecar-status', 'sidecar-log'] as const
