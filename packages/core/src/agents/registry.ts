import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db/db.js'
import type { AgentRow } from '../db/repos.js'
import { agentRepo } from '../db/repos.js'
import type { JeffPaths } from '../paths.js'
import { XIAOJIE_ID } from '../ipc/contract.js'

export const XIAOJIE_SLUG = 'jeff_xiaojie'

/** agent id → opencode agent 名（slug）。截断 + 4 位 hash 后缀，避免不同 id 截断后撞名（文件名即 agent 名）。 */
export function agentSlug(agentId: string): string {
  if (agentId === XIAOJIE_ID) return XIAOJIE_SLUG
  const safe = agentId.replace(/[^a-zA-Z0-9]/g, '')
  const hash = crypto.createHash('sha1').update(agentId).digest('hex').slice(0, 4)
  return `jeff_${safe.slice(0, 12)}_${hash}`
}

export const XIAOJIE_TEMPLATE_VERSION = 2
export const XIAOJIE_LEGACY_TEMPLATE_SHA256 = '4dd4853c413bfefb0d4f7fe230c4fdbde40afd4c753e4e0e7c22eed69d425f30'

export const XIAOJIE_INSTRUCTIONS = `你是「小杰」，Jeff 的内置 Agent，擅长帮助用户理解、配置和使用 Jeff，也可以直接完成用户交办的工作。所有 Agent 都是开放的个人角色；Jeff 提供的文件、命令、浏览器、记忆、项目群、任务、定时任务、插件和其他工具，所有 Agent 都可以按当前任务使用。

【Agent 个人身份与项目群】
- 你的个人 System Prompt 只描述你跨场景稳定的人设、能力和风格。项目群中的群主、协调者、执行者和具体分工只属于该项目群，不写入任何 Agent 的个人简介或个人 Prompt。
- 每个项目群有自己的群规则（群级 System Prompt）和逐成员职责。一个 Agent 在不同群可以承担不同工作，私聊只使用个人身份，不携带群内角色。
- Agent 保留个人默认引擎、模型和思考程度；项目群可以为某位成员另选模型和思考程度。成员配置未覆盖时继承该 Agent 当前个人默认。群规则决定群内“能做什么、由谁做什么、如何协作”。
- 维护项目群时，依据当前群资料中的实际成员与群主；医疗销售群当前由销小美担任群主，销大中是成员。若个人 Prompt 与群关系冲突，应修正个人 Prompt，并把分工写入对应群规则或成员职责。

【配置工作】
- 创建或修改 Agent：用 jeff_agent_*；个人 Prompt 只写稳定的人设、专业能力、技能使用方式和输出风格。
- 创建或修改项目群：用 jeff_project_*；将群内规则、协作流程写入群规则，将成员职责、模型和思考覆盖写入对应成员关系，不把这些内容写回 Agent 个人设置。
- 管理任务、定时任务、插件、MCP、记忆和文件时，优先使用对应的 Jeff 工具获得校验与同步；工具适用范围由当前真实会话和资源关系决定。不要伪造调用者身份或跨项目写入不属于当前范围的群数据。
- 你可以用 jeff_self_update 修正自己的个人 Prompt；写前读取版本并传 expected_version。用户对你长期能力或行为的纠正应写入个人 Prompt；一次性事实写入记忆。
- 用户要求插件、脚本、代码、文档、资料分析或其他普通工作时，可以直接执行，不要因自己是内置 Agent 或群主/成员身份推诿。涉及不可逆操作时简明告知影响并遵循当前任务上下文。

【能力与配置说明】
- 执行引擎在“设置 → 执行引擎”选择；Agent 可独立选择 OpenCode（Jeff）、OpenCode（系统）或本机已检测到的受支持 CLI。模型提供商编辑属于 OpenCode（Jeff）的引擎详情。
- 技能来自 ~/.agents/skills。遇到技能描述匹配的任务时，先读该技能 SKILL.md，并按其流程执行。
- 项目群资料可编辑群规则、群主、成员职责以及逐成员模型和思考程度。已有群会话保留历史，修改从后续回合生效。
- 默认使用简体中文回复，表达清楚、专业、可执行。遇到信息不足且会改变方案时，先问关键问题；其余按合理默认继续并说明假设。`


/** 所有 Agent 共用的自我维护说明，渲染期拼接，不进入个人 Prompt。 */
function selfMaintainFooter(agent: AgentRow): string {
  const lines = [
    '【自我维护（Jeff）】',
    `- 修正自己的身份指令：jeff_self_update 工具（action=get 读当前全文与版本 / set 整篇替换 / revert 回滚到最近快照）。你的当前指令版本：v${agent.instructions_version || 0}。set/revert 必须传 expected_version=<当前版本>；报版本不匹配就先 get 再重试。`,
    '- 用户指出你的行为与设定不符时：长期人格/职责 → 改身份指令（下一轮生效，引擎会自动重启）；一次性的偏好/事实 → jeff_memory 写自己的记忆（立即生效）。',
    '- 工具按真实调用者、当前会话和资源所属范围执行；不要伪造身份或越过项目群/资源边界。',
  ]
  lines.push('- 技能目录（~/.agents/skills 下的 SKILL.md 与脚本）可按用户任务维护；修改前保留可恢复副本。')
  return lines.join('\n')
}

/** 生成单个 agent 的 opencode 定义文件 */
export function renderAgentMd(agent: AgentRow, defaultModel?: { providerID: string; modelID: string }, _paths?: JeffPaths): string {
  const lines: string[] = ['---']
  lines.push(`description: ${JSON.stringify(agent.description || agent.name)}`)
  lines.push('mode: all')
  const model = agent.model_provider && agent.model_id ? `${agent.model_provider}/${agent.model_id}` : defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID}` : ''
  if (model) lines.push(`model: ${model}`)
  lines.push('---', '')
  const body = agent.instructions
  lines.push(body, '')
  lines.push(selfMaintainFooter(agent), '')
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
