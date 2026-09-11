/**
 * 会话默认命名：`{YYYYMMDD-HHmm}-{任务中文名称}`。
 * 仅作为界面显示名，方便按时间 + 任务检索；不参与路由与业务判断。
 */

/** 首条消息为空（例如只发了图片）时的任务名占位 */
export const NEW_SESSION_NAME = '新会话'

/** 本地时间戳 `YYYYMMDD-HHmm` */
export function stampTitle(d: Date): string {
  const p = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** 建会话时的占位名：`20260911-1430-新会话`；首条消息落库后会替换掉任务名部分 */
export function placeholderTitle(createdAt: number): string {
  return `${stampTitle(new Date(createdAt))}-${NEW_SESSION_NAME}`
}

/**
 * 从首条用户消息提炼「任务中文名称」。
 * 去掉代码块、链接目标、@提及与 markdown 记号后压平空白，再按码点截断（避免切断 emoji）。
 */
export function summarizeTaskName(text: string, max = 16): string {
  const cleaned = String(text || '')
    // 代码块整体丢弃：内容是代码，做标题没有可读性
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    // 图片只留占位空；链接与行内代码保留可读文字
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    // @某某 是群聊指名语法，标题里没有信息量
    .replace(/@[^\s@]+/g, ' ')
    // 标题记号与引用符
    .replace(/^[#>\-*\s]+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。！？!?.,，；;：:、]+$/, '')
    .trim()
  if (!cleaned) return NEW_SESSION_NAME
  const chars = Array.from(cleaned)
  if (chars.length <= max) return cleaned
  return `${chars.slice(0, max).join('')}…`
}

/** 首条用户消息落库后的会话名：`{创建时间戳}-{任务中文名称}` */
export function composeAutoTitle(createdAt: number, text: string): string {
  return `${stampTitle(new Date(createdAt))}-${summarizeTaskName(text)}`
}
