import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/** Jeff 数据根目录解析：优先 JEFF_HOME 环境变量（测试用），默认 ~/.jeff */
export function jeffRoot(override?: string): string {
  return override || process.env.JEFF_HOME || path.join(os.homedir(), '.jeff')
}

/**
 * agent skills 标准目录：**模型看到的技能只从这里读**（多工具共用，也是 WebDAV 整目录镜像的目标）。
 * 刻意不跟 JEFF_HOME 走——它属于用户家目录，不随 Jeff 数据目录搬。
 */
export const USER_SKILLS_MOUNT = '~/.agents/skills'

/**
 * 写进 opencode.json `skills.paths` 的挂载值。正式环境用 `~/...` 让 opencode 自己展开（跨平台一致），
 * 测试/便携模式用 JEFF_SKILLS_DIR 绝对路径覆盖。
 * ⚠️ 这是用户技能进模型的**唯一入口**：sidecar 侧设了 OPENCODE_DISABLE_EXTERNAL_SKILLS=1
 * （挡掉 opencode 对 ~/.claude/skills 等外部目录的隐式扫描），显式挂载不受它影响，但删了这行就一个技能都看不到。
 */
export function skillsMount(): string {
  return process.env.JEFF_SKILLS_DIR || USER_SKILLS_MOUNT
}

/** 同上目录的绝对路径形式（应用自己写内置技能、同步做整目录镜像时用） */
export function userSkillsDir(): string {
  return process.env.JEFF_SKILLS_DIR || path.join(os.homedir(), '.agents', 'skills')
}

/** 应用自己写进用户技能目录的内置技能（同步的「本地为空」保护要把它当空气，见 sync/engine.ts） */
export const BUILTIN_SKILL_DIR = 'jeff-usage'

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
  /** opencode 自己配置目录下的 skills（旧版内置技能落点，现在只用于清理残留） */
  ocSkillsDir: string
  /** 用户级 AGENTS.md */
  agentsMdUser: string
  /** 项目级 AGENTS.md 权威副本目录（按 projectId 存，不依赖 workspace_dir） */
  agentsMdDir: string
  /** skills 恢复暂存目录 */
  restoreStagingDir: string
  /** 本地备份根目录（skills 恢复前快照等） */
  backupsDir: string
  /** 插件根目录（每个插件一个子目录，含 plugin.json） */
  pluginsDir: string
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
    agentsMdDir: path.join(root, 'agents-md'),
    restoreStagingDir: path.join(root, 'restore-staging'),
    backupsDir: path.join(root, 'backups'),
    pluginsDir: path.join(root, 'plugins'),
  }
}

/** 确保全部目录存在 */
export function ensureDirs(p: JeffPaths): void {
  for (const dir of [
    p.root,
    p.logDir,
    p.memoryDir,
    p.workspaceDir,
    p.agentsMdDir,
    p.ocConfigDir,
    p.ocAgentsDir,
    p.ocPluginsDir,
    p.ocSkillsDir,
    p.pluginsDir,
    path.join(p.ocDataHome),
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
