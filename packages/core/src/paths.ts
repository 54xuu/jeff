import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/** Jeff 数据根目录解析：优先 JEFF_HOME 环境变量（测试用），默认 ~/.jeff */
export function jeffRoot(override?: string): string {
  return override || process.env.JEFF_HOME || path.join(os.homedir(), '.jeff')
}

/** 目录布局 */
export interface JeffPaths {
  root: string
  dbFile: string
  configFile: string
  logDir: string
  memoryDir: string
  workspaceDir: string
  /** opencode sidecar 隔离 XDG 目录 */
  ocConfigHome: string
  ocDataHome: string
  /** opencode 配置目录（ocConfigHome/opencode） */
  ocConfigDir: string
  /** opencode agents 目录 */
  ocAgentsDir: string
  /** opencode plugins 目录 */
  ocPluginsDir: string
  /** opencode skills 目录 */
  ocSkillsDir: string
  /** 用户级 AGENTS.md */
  agentsMdUser: string
  /** skills 恢复暂存目录 */
  restoreStagingDir: string
  /** 本地备份根目录（skills 恢复前快照等） */
  backupsDir: string
}

export function buildPaths(root: string): JeffPaths {
  const ocConfigHome = path.join(root, 'oc-home', 'config')
  const ocConfigDir = path.join(ocConfigHome, 'opencode')
  return {
    root,
    dbFile: path.join(root, 'jeff.db'),
    configFile: path.join(root, 'config.json'),
    logDir: path.join(root, 'logs'),
    memoryDir: path.join(root, 'memory'),
    workspaceDir: path.join(root, 'workspace'),
    ocConfigHome,
    ocDataHome: path.join(root, 'oc-home', 'data'),
    ocConfigDir,
    ocAgentsDir: path.join(ocConfigDir, 'agent'),
    ocPluginsDir: path.join(ocConfigDir, 'plugin'),
    ocSkillsDir: path.join(ocConfigDir, 'skills'),
    agentsMdUser: path.join(root, 'AGENTS.md'),
    restoreStagingDir: path.join(root, 'restore-staging'),
    backupsDir: path.join(root, 'backups'),
  }
}

/** 确保全部目录存在 */
export function ensureDirs(p: JeffPaths): void {
  for (const dir of [
    p.root,
    p.logDir,
    p.memoryDir,
    p.workspaceDir,
    p.ocConfigDir,
    p.ocAgentsDir,
    p.ocPluginsDir,
    p.ocSkillsDir,
    path.join(p.ocDataHome),
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
