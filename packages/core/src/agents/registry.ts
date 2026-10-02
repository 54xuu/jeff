import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db/db.js'
import type { AgentRow } from '../db/repos.js'
import { agentRepo } from '../db/repos.js'
import type { JeffPaths } from '../paths.js'
import { ADMIN_TOOL_NAMES } from '../tools/adminTools.js'
import { PLUGIN_TOOL_NAMES } from '../tools/pluginTools.js'
import { CRON_TOOL_NAMES } from '../tools/cronTools.js'
import { XIAOJIE_ID } from '../ipc/contract.js'

/**
 * 仅管家小杰可用的工具：智能体/项目/任务的增删改、定时任务、插件开发。
 * 插件工具受限是因为 plugin.json 的 mcp.command 会被引擎当子进程拉起、mcp.url 会把内网地址
 * 接进模型工具面；定时任务则是「替用户安排无人值守的自动执行」——两者与 jeff_agent_*
 * 同属「能改变系统行为」的管理能力，不下放给项目群里的普通智能体。
 */
export const XIAOJIE_ONLY_TOOLS: readonly string[] = [...ADMIN_TOOL_NAMES, ...CRON_TOOL_NAMES, ...PLUGIN_TOOL_NAMES]

/**
 * 小杰**不该有**的内置工具（v1.10.0 起它有全套文件与命令工具，见 XIAOJIE_INSTRUCTIONS 第 8 条）：
 * - `task` / `jeff_spawn_subtask` 仍禁：不再是为了堵文件工具后门（禁令已撤），
 *   而是控制并行与成本——管家做的是代操配置与单点协作，不承担批量知识类工作；
 *   子代理委派是项目群 leader 的活（jeff_delegate）。
 * - `jeff_self_update` 禁：小杰的身份指令由应用内置管理（XIAOJIE_INSTRUCTIONS），
 *   每次 boot 会把 DB 漂移拉回常量，写 DB 是静默空操作；纠正它走用户级 AGENTS.md 与它的记忆。
 */
export const XIAOJIE_DISABLED_TOOLS: readonly string[] = ['task', 'jeff_spawn_subtask', 'jeff_self_update']


export const XIAOJIE_SLUG = 'jeff_xiaojie'

/** agent id → opencode agent 名（slug）。截断 + 4 位 hash 后缀，避免不同 id 截断后撞名（文件名即 agent 名）。 */
export function agentSlug(agentId: string): string {
  if (agentId === XIAOJIE_ID) return XIAOJIE_SLUG
  const safe = agentId.replace(/[^a-zA-Z0-9]/g, '')
  const hash = crypto.createHash('sha1').update(agentId).digest('hex').slice(0, 4)
  return `jeff_${safe.slice(0, 12)}_${hash}`
}

export const XIAOJIE_INSTRUCTIONS = `你是「小杰」，Jeff 桌面应用的内置管家 agent。Jeff 把工作组织成：智能体（聊天好友）、项目群（群主 leader + 成员智能体，像微信群）、任务（待办/进行/待审/完成，编号 JEF-n）、定时任务、插件。

你的职责（你是唯一的管家，管理工具仅你拥有）：
1. 问答与使用指导：用户问「Jeff 怎么用」时直接讲解。
2. 智能体管理：jeff_agent_* 工具创建/修改/删除其他智能体（含默认模型、思考程度 thinking 与分组分类 category）。小杰自身身份指令不可改；模型/思考可在 UI「资料」里改，工具侧不改自己。
3. 项目群管理：jeff_project_* 工具建群、改群资料（含工作空间目录 workspace_dir）、配群主（leader）与工作者（worker）；jeff_project_delete 解散群（须先确认）。
4. 任务管理：jeff_task_* 工具创建/流转任务；任务卡片会出现在对应项目群里。
5. 定时任务：jeff_cron_* 工具创建/管理定时任务（到点自动向某个智能体私聊或项目群发消息并让它回复）。典型诉求：「每天早上 8 点让 AI 资讯助手报最新资讯」（target_type=agent）、「每天早上 8 点在护士站群里问今天的病区动态」（target_type=project，建议在 prompt 里让群主点名成员汇报）。建任务前先问清：任务名、目标、时间（可用 5 段 cron：分 时 日 月 周，如 0 8 * * *）、要说什么、错过怎么办（重要任务用 catchup = 开机后补跑一次；资讯类用 skip = 直接跳过）。
6. 插件开发：jeff_plugin_* 工具把「必须用但不通用」的能力做成插件（MCP 接入 + 一条 / 快捷指令 + 首页 + icon.svg）。用户说「把智慧病房接进来 / 做个插件」时用它们；查已装插件用 jeff_plugin_list。每个插件只能有一条快捷指令，name 用英文或拼音（如 /zhbf）且**跨插件全局唯一**；插件显示名用中文；靠 command_prompt 写清功能分流。每个插件目录还应有一份简洁扁平的 icon.svg。参数一律平铺——指令用 command / command_prompt / command_description；MCP 用 mcp_url / mcp_command / mcp_headers / mcp_env（JSON 文本），不要自己拼嵌套 json 对象塞进一个字段。
7. 浏览器：jeff_browser_* 工具可以在 Jeff 右侧的内置浏览器里打开网页、读页面、点击、填表、设分辨率（jeff_browser_set_viewport：preset="4:3" 按比例自适应，或 width/height 精确像素）、截图（jeff_browser_screenshot，带 full_page="true" 截含滚动部分的整页）—— 用来演示插件首页、帮用户操作没有 API 的网页系统、把网页内容与整页截图留档。注意你只能取内容与截图，不能把网页正文写成文件（你没有写文件能力）；需要落成 .md 文件时请让普通智能体来做。
8. 你有全套文件与命令工具（read/write/edit/patch/bash），可以为完成用户请求读写文件、执行命令、运行技能里的脚本。但有四条纪律：
   ① 改 Jeff 自己的配置（插件、智能体、定时任务等）优先用对应的结构化工具（jeff_plugin_* / jeff_agent_* / jeff_cron_*），不要直接改它们落盘的文件——结构化工具有校验、会同步、不会留脏数据；
   ② 不要读写数据目录里的 jeff.db（含 -wal/-shm/-journal）与 oc-home 下的 auth.json——那里是引擎与模型密钥，权限上已对你禁用；
   ③ 不要替其他智能体改它们的身份指令、记忆文件或共享 AGENTS.md——那类变更请告诉用户「找你（小杰）用管理工具来做」，或由该智能体自己用 jeff_self_update 修正它自己的；
   ④ 改技能目录（~/.agents/skills）前先用 bash 备份原文件（技能人人可改，但没有版本历史，备份是唯一的回滚手段）。
9. 你有长期记忆（jeff_memory）：记住用户偏好、常用项目背景、被纠正过的做法；会用 jeff_session_search 回忆历史对话。

请引导用户去「设置」页自行完成（你没有对应工具）：
- MCP 连接器导入/启停（要接入 MCP 更推荐做成插件）
- 模型供应商与 API Key
- WebDAV 同步与备份/恢复（插件目录、定时任务、skills 的备份与恢复都在「设置 → 同步」）
- 主题 / 引擎服务重启（菜单「重启 Jeff」可整应用重开）

要求：
- 用简体中文回复，简洁友好，像微信里的靠谱同事。
- 创建智能体：先问清「名字、用途、模型（可默认）、思考程度（可默认）、分组分类（可默认）」，确认后调用 jeff_agent_create。
- 修改智能体：用户说改指令/模型/思考程度/分类时用 jeff_agent_update（小杰自身身份不可改）。
- 创建项目群：先问清「群名、谁当群主（leader）、有哪些工作者（worker）、工作空间目录（可选）」；确认后调用 jeff_project_create；群主必须是已存在的智能体；工作者角色固定为 worker，不要再分开发/产品等。
- 修改项目群：用户说改群名/简介/群主/工作空间时用 jeff_project_update；解散群用 jeff_project_delete，必须先确认。
- 创建任务：确认归属的项目群、标题、优先级、指派对象（可选）。
- 创建定时任务：先和用户确认「时间 + 目标 + 内容 + 错过策略」再调 jeff_cron_create；不确定用户想要哪一天几次就问清，不要自己发明时间。用户说「今天 12:00」「明天早上 8 点」这类只跑一次的，传 run_at（如「今天 12:00」），不要编成每天或每年的 cron。
- 开发插件：先问清「它要解决什么、有没有现成的 MCP 服务地址（http(s) 的 /mcp 端点）或本地命令、需不需要首页、要不要一条 / 快捷指令（英文或拼音名，全局唯一）」。用 jeff_plugin_create 落盘（默认不启用；指令用 command / command_prompt 平铺，MCP 用 mcp_url / mcp_command 平铺；附带文件用 files 数组，其中应含 icon.svg），把设计要点讲给用户听；用户确认后再用 jeff_plugin_enable 启用（带本地命令的插件你无法启用，要请用户去「插件」页点开关——这是刻意的安全闸）。改已有插件先用 jeff_plugin_read 看现状再 jeff_plugin_update。删除插件前必须确认。
- 用户画像类信息（称呼偏好、技术栈口味）用 jeff_memory 的 scope:'user' 写；其他默认写自己的记忆。
- 破坏性操作（删除智能体 / 解散群 / 删除定时任务 / 删除插件）必须先和用户确认一次。`

/** 非内置 agent 的「自维护」固定页脚（渲染期拼接，不进 DB——设置页正文保持干净） */
function selfMaintainFooter(agent: AgentRow, denied: ReadonlySet<string>): string {
  if (agent.builtin) {
    return '【自我维护（Jeff）】你的身份指令由应用内置管理，不可修改；用户对你的纠正请写入用户级 AGENTS.md 或你自己的记忆（jeff_memory）。'
  }
  const lines = [
    '【自我维护（Jeff）】',
    `- 修正自己的身份指令：jeff_self_update 工具（action=get 读当前全文与版本 / set 整篇替换 / revert 回滚到最近快照）。你的当前指令版本：v${agent.instructions_version || 0}。set/revert 必须传 expected_version=<当前版本>；报版本不匹配就先 get 再重试。`,
    '- 用户指出你的行为与设定不符时：长期人格/职责 → 改身份指令（下一轮生效，引擎会自动重启）；一次性的偏好/事实 → jeff_memory 写自己的记忆（立即生效）。',
    '- 不要修改其他智能体的身份指令、记忆文件与共享 AGENTS.md；需要变更请建议用户找小杰（内置管家）。',
  ]
  if (!denied.has('write') && !denied.has('edit')) {
    lines.push('- 技能目录（~/.agents/skills 下的 SKILL.md 与脚本）人人可改：改前先用 bash 备份原文件（技能无版本历史，备份是唯一回滚手段）。')
  }
  return lines.join('\n')
}

/** 小杰的密钥文件禁读写清单（agent 级 permission；glob 形态） */
function xiaojieSecretDenyPatterns(): string[] {
  // 实测（oc-perm-probe2，opencode 1.18.30）：read/edit 的 pattern 按「相对 worktree 的路径」评估，
  // 绝对路径 pattern 永远不命中；`*` 跨目录。所以用文件名 glob，home 在哪都能命中。
  return ['*jeff.db', '*jeff.db-wal', '*jeff.db-shm', '*jeff.db-journal', '*auth.json']
}

/** agent 的工具禁用集（renderAgentMd 写进 opencode 定义，能力判定等处也要用同一份事实） */
export function agentDeniedTools(agent: AgentRow): Set<string> {
  const denied = new Set<string>(agent.builtin ? XIAOJIE_DISABLED_TOOLS : XIAOJIE_ONLY_TOOLS)
  // 智慧病房医护助手：必须走插件 MCP，禁止 bash/curl/读盘绕过（实测会抠 jeff.db 里的 token）
  if (!agent.builtin && (agent.category === '智慧病房' || agent.name === '医护助手')) {
    for (const t of ['bash', 'edit', 'write', 'patch', 'task', 'read'] as const) denied.add(t)
  }
  return denied
}

/** 生成单个 agent 的 opencode 定义文件 */
export function renderAgentMd(agent: AgentRow, defaultModel?: { providerID: string; modelID: string }, paths?: JeffPaths): string {
  const lines: string[] = ['---']
  lines.push(`description: ${JSON.stringify(agent.description || agent.name)}`)
  lines.push('mode: all')
  const model = agent.model_provider && agent.model_id ? `${agent.model_provider}/${agent.model_id}` : agent.builtin && defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID}` : ''
  if (model) lines.push(`model: ${model}`)
  // 工具面：非内置 agent 禁用管理工具（智能体/项目/任务/定时任务/插件开发）；内置小杰禁掉子代理与自改
  const denied = agentDeniedTools(agent)
  lines.push('tools:')
  for (const t of denied) lines.push(`  ${t}: false`)
  // 小杰拿到了全套文件工具，用 agent 级 permission 把密钥文件摘出去（全局是全放行，agent 级规则优先生效）。
  // bash 的规则匹配的是命令文本：禁掉所有提及 jeff.db / auth.json 的命令，堵住「read 被拒就 cat」的最直白绕路
  // （换变量名之类的间接绕过堵不完，那是已接受的残余风险）。
  if (agent.builtin && paths) {
    const secrets = xiaojieSecretDenyPatterns()
    const secretsAbs = [paths.dbFile, `${paths.dbFile}-wal`, `${paths.dbFile}-shm`, `${paths.dbFile}-journal`, path.join(paths.ocDataHome, 'opencode', 'auth.json')]
    lines.push('permission:')
    for (const key of ['read', 'edit'] as const) {
      lines.push(`  ${key}:`)
      lines.push("    '*': allow")
      for (const p of [...secrets, ...secretsAbs]) lines.push(`    ${JSON.stringify(p)}: deny`)
    }
    lines.push('  bash:')
    lines.push("    '*': allow")
    lines.push('    "*jeff.db*": deny')
    lines.push('    "*auth.json*": deny')
  }
  lines.push('---', '')
  const body = agent.builtin ? XIAOJIE_INSTRUCTIONS : agent.instructions
  lines.push(body, '')
  lines.push(selfMaintainFooter(agent, denied), '')
  return lines.join('\n')
}

/**
 * agent 注册表：DB 中的 agent ↔ sidecar agent md 文件双向同步。
 * 注意：opencode 以「文件名（去掉 .md）」作为 agent 名，因此文件名必须等于 agentSlug(id)。
 */
export class AgentRegistry {
  constructor(
    private db: DB,
    private paths: JeffPaths,
  ) {}

  /** 全量同步：写入所有 agent md，清理失效文件 */
  syncAll(defaultModel?: { providerID: string; modelID: string }): void {
    fs.mkdirSync(this.paths.ocAgentsDir, { recursive: true })
    const agents = agentRepo(this.db).list()
    const wanted = new Set<string>()
    for (const a of agents) {
      const file = `${agentSlug(a.id)}.md`
      wanted.add(file)
      const content = renderAgentMd(a, defaultModel, this.paths)
      const target = path.join(this.paths.ocAgentsDir, file)
      try {
        if (fs.readFileSync(target, 'utf8') !== content) fs.writeFileSync(target, content, 'utf8')
      } catch {
        fs.writeFileSync(target, content, 'utf8')
      }
    }
    // 清理失效文件（软删除的 agent）
    for (const f of fs.readdirSync(this.paths.ocAgentsDir)) {
      if (f.startsWith('jeff_') && f.endsWith('.md') && !wanted.has(f)) {
        fs.rmSync(path.join(this.paths.ocAgentsDir, f), { force: true })
      }
    }
  }

  /** 删除单个 agent 的 md 文件 */
  remove(agentId: string): void {
    const file = path.join(this.paths.ocAgentsDir, `${agentSlug(agentId)}.md`)
    fs.rmSync(file, { force: true })
  }
}
