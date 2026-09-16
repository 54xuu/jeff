/**
 * 渲染进程安全入口：仅纯数据 / 常量 / 无 Node 依赖的工具。
 * electron-vite 把 `@jeff/core` 指到这里，避免把 better-sqlite3 等卷进浏览器 bundle。
 */
export * from './ipc/contract.js'
export { formatModelKey, parseModelKey, modelDisplayLabel } from './util/modelKey.js'
export { normalizeProjectRole, projectRoleLabel, PROJECT_ROLES, type ProjectRole } from './util/projectRole.js'
export { extractThinkTags, mergeReasoning, type ThinkExtractResult } from './util/thinkTag.js'
export {
  encodePluginUserMessage,
  decodePluginUserMessage,
  resolveSendText,
  pluginConstraint,
  type ChatPluginInvoke,
} from './plugins/invoke.js'
// cron 表达式工具：纯函数，渲染层用于校验、人性化描述与模板（定时任务编辑弹窗）
export { isValidCron, describeCron, nextRunAt, parseCron, CRON_PRESETS, type CronFields } from './cron/expr.js'
