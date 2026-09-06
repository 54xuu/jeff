/**
 * 渲染进程安全入口：仅纯数据 / 常量 / 无 Node 依赖的工具。
 * electron-vite 把 `@jeff/core` 指到这里，避免把 better-sqlite3 等卷进浏览器 bundle。
 */
export * from './ipc/contract.js'
export { formatModelKey, parseModelKey, modelDisplayLabel } from './util/modelKey.js'
