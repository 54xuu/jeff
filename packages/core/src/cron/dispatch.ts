import type { DB } from '../db/db.js'
import { agentRepo, kvRepo, type CronTaskRow } from '../db/repos.js'
import type { PrivateChat } from '../chat/private.js'
import type { GroupChat } from '../orchestrator/group.js'

/** 私聊定时任务的专属 opencode 会话指针（与用户手动聊天的 session:private:<agentId> 分开） */
export const cronPrivateSessionKey = (taskId: string) => `session:cron:${taskId}`
/** 群聊定时任务的专属 thread 指针（不抢用户当前正在看的话题） */
export const cronGroupThreadKey = (taskId: string) => `cron:thread:${taskId}`

/**
 * 真正把一条定时任务投递到聊天链路。
 *
 * 硬约定（对「多任务并行 / 同目标多会话互不影响」）：
 *  - 私聊：每个任务一条独立 opencode 会话，不碰用户正在聊的 session:private:*。
 *  - 群聊：每个任务一条独立 thread，创建时不切换 active，用户正在看的话题不被抢走。
 *  - 同一任务反复触发复用自己那条会话（早报类跨天连续）；不同任务绝不共用。
 */
export async function dispatchCronTask(deps: {
  db: DB
  privateChat: PrivateChat
  groupChat: GroupChat
  task: CronTaskRow
}): Promise<{ threadId?: string; sessionId?: string }> {
  const { db, privateChat, groupChat, task } = deps
  if (task.target_type === 'agent') {
    const agent = agentRepo(db).get(task.target_id)
    if (!agent || agent.deleted_at != null) throw new Error('目标智能体已被删除')
    const kvKey = cronPrivateSessionKey(task.id)
    await privateChat.sendDedicated(agent.id, agent.name, task.prompt, kvKey, task.name)
    return { sessionId: privateChat.getSessionIdByKey(kvKey) ?? undefined }
  }
  const threadId = ensureCronGroupThread(db, groupChat, task)
  await groupChat.send({ projectId: task.target_id, text: task.prompt, cronTaskId: task.id, threadId })
  return { threadId }
}

/** 取或新建该定时任务在目标群里的专属话题（不激活，免得抢用户当前窗口） */
export function ensureCronGroupThread(db: DB, groupChat: GroupChat, task: CronTaskRow): string {
  const kv = kvRepo(db)
  const key = cronGroupThreadKey(task.id)
  const existing = kv.get(key)
  if (existing && groupChat.threads.getMeta(task.target_id, existing)) return existing
  const t = groupChat.threads.createThread(task.target_id, task.name, { activate: false })
  kv.set(key, t.id)
  return t.id
}
