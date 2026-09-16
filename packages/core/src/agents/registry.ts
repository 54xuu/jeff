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
 * 小杰**不该有**的内置工具。它的指令里写着「你没有编码/文件工具」，这里让现实与说明一致：
 * 插件开发走 jeff_plugin_*（结构化落盘），不需要管家直接改文件；管家能任意写盘/执行命令
 * 是过大的攻击面（实测 live12 R7：MCP 参数没传进去时它会自己去 edit plugin.json 打补丁）。
 * 只读的 read/glob/grep 保留，便于它查看现状。
 *
 * `task` 也必须禁：子代理带全套工具（bash/edit/write），不禁就等于把上面四个全绕过去
 * （实测 live14 R6：让小杰用思源技能读文档，它自己调不了 bash，就 task 派个子代理去跑脚本，
 * 然后把结果当成自己读到的——「管家没有命令工具」形同虚设）。子代理委派是项目群 leader 的活
 * （jeff_delegate），不是管家的。
 */
export const XIAOJIE_DISABLED_TOOLS: readonly string[] = ['bash', 'edit', 'write', 'patch', 'task']


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
8. 你确实没有编码/文件/命令工具（写、改、跑命令都不行，这是刻意的）：插件要落文件请走 jeff_plugin_*（它自己会写插件目录），别指望直接改磁盘文件。
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
- 创建定时任务：先和用户确认「时间 + 目标 + 内容 + 错过策略」再调 jeff_cron_create；不确定用户想要哪一天几次就问清，不要自己发明时间。
- 开发插件：先问清「它要解决什么、有没有现成的 MCP 服务地址（http(s) 的 /mcp 端点）或本地命令、需不需要首页、要不要一条 / 快捷指令（英文或拼音名，全局唯一）」。用 jeff_plugin_create 落盘（默认不启用；指令用 command / command_prompt 平铺，MCP 用 mcp_url / mcp_command 平铺；附带文件用 files 数组，其中应含 icon.svg），把设计要点讲给用户听；用户确认后再用 jeff_plugin_enable 启用（带本地命令的插件你无法启用，要请用户去「插件」页点开关——这是刻意的安全闸）。改已有插件先用 jeff_plugin_read 看现状再 jeff_plugin_update。删除插件前必须确认。
- 用户画像类信息（称呼偏好、技术栈口味）用 jeff_memory 的 scope:'user' 写；其他默认写自己的记忆。
- 破坏性操作（删除智能体 / 解散群 / 删除定时任务 / 删除插件）必须先和用户确认一次。`

/** 生成单个 agent 的 opencode 定义文件 */
export function renderAgentMd(agent: AgentRow, defaultModel?: { providerID: string; modelID: string }): string {
  const lines: string[] = ['---']
  lines.push(`description: ${JSON.stringify(agent.description || agent.name)}`)
  lines.push('mode: all')
  const model = agent.model_provider && agent.model_id ? `${agent.model_provider}/${agent.model_id}` : agent.builtin && defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID}` : ''
  if (model) lines.push(`model: ${model}`)
  // 非内置 agent 禁用管理工具（智能体/项目/任务/定时任务/插件开发）；内置小杰禁掉文件与命令工具
  lines.push('tools:')
  if (agent.builtin) {
    for (const t of XIAOJIE_DISABLED_TOOLS) lines.push(`  ${t}: false`)
  } else {
    for (const t of XIAOJIE_ONLY_TOOLS) lines.push(`  ${t}: false`)
    // 智慧病房医护助手：必须走插件 MCP，禁止 bash/curl/读盘绕过（实测会抠 jeff.db 里的 token）
    if (agent.category === '智慧病房' || agent.name === '医护助手') {
      for (const t of ['bash', 'edit', 'write', 'patch', 'task', 'read'] as const) {
        lines.push(`  ${t}: false`)
      }
    }
  }
  lines.push('---', '')
  const body = agent.builtin ? XIAOJIE_INSTRUCTIONS : agent.instructions
  lines.push(body, '')
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
      const content = renderAgentMd(a, defaultModel)
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
