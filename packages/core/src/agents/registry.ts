import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db/db.js'
import type { AgentRow } from '../db/repos.js'
import { agentRepo } from '../db/repos.js'
import type { JeffPaths } from '../paths.js'
import { ADMIN_TOOL_NAMES } from '../tools/adminTools.js'
import { XIAOJIE_ID } from '../ipc/contract.js'


export const XIAOJIE_SLUG = 'jeff_xiaojie'

/** agent id → opencode agent 名（slug）。截断 + 4 位 hash 后缀，避免不同 id 截断后撞名（文件名即 agent 名）。 */
export function agentSlug(agentId: string): string {
  if (agentId === XIAOJIE_ID) return XIAOJIE_SLUG
  const safe = agentId.replace(/[^a-zA-Z0-9]/g, '')
  const hash = crypto.createHash('sha1').update(agentId).digest('hex').slice(0, 4)
  return `jeff_${safe.slice(0, 12)}_${hash}`
}

export const XIAOJIE_INSTRUCTIONS = `你是「小杰」，Jeff 桌面应用的内置管家 agent。Jeff 把工作组织成：智能体（聊天好友）、项目群（群主 leader + 成员智能体，像微信群）、任务（待办/进行/待审/完成，编号 JEF-n）。

你的职责（你是唯一的管家，管理工具仅你拥有）：
1. 问答与使用指导：用户问「Jeff 怎么用」时直接讲解。
2. 智能体管理：jeff_agent_* 工具创建/修改/删除其他智能体（含默认模型与思考程度 thinking）。
3. 项目群管理：jeff_project_* 工具建群、改群资料（含工作空间目录 workspace_dir）、配群主（leader）与工作者（worker，统一角色，不做开发/产品等细分类）。
4. 任务管理：jeff_task_* 工具创建/流转任务；任务卡片会出现在对应项目群里。
5. 你没有编码/文件工具；技术活建议用户去对应智能体或项目群里完成。
6. 你有长期记忆（jeff_memory）：记住用户偏好、常用项目背景、被纠正过的做法；会用 jeff_session_search 回忆历史对话。

要求：
- 用简体中文回复，简洁友好，像微信里的靠谱同事。
- 创建智能体：先问清「名字、用途、模型（可默认）、思考程度（可默认）」，确认后调用 jeff_agent_create。
- 修改智能体：用户说改指令/模型/思考程度时用 jeff_agent_update（小杰自身身份不可改）。
- 创建项目群：先问清「群名、谁当群主（leader）、有哪些工作者（worker）、工作空间目录（可选）」；确认后调用 jeff_project_create；群主必须是已存在的智能体；工作者角色固定为 worker，不要再分开发/产品等。
- 修改项目群：用户说改群名/简介/群主/工作空间时用 jeff_project_update。
- 创建任务：确认归属的项目群、标题、优先级、指派对象（可选）。
- 用户画像类信息（称呼偏好、技术栈口味）用 jeff_memory 的 scope:'user' 写；其他默认写自己的记忆。
- 破坏性操作（删除）必须先和用户确认一次。`

/** 生成单个 agent 的 opencode 定义文件 */
function renderAgentMd(agent: AgentRow, defaultModel?: { providerID: string; modelID: string }): string {
  const lines: string[] = ['---']
  lines.push(`description: ${JSON.stringify(agent.description || agent.name)}`)
  lines.push('mode: all')
  const model = agent.model_provider && agent.model_id ? `${agent.model_provider}/${agent.model_id}` : agent.builtin && defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID}` : ''
  if (model) lines.push(`model: ${model}`)
  // 非 小杰/内置 agent 禁用管理工具
  if (!agent.builtin) {
    lines.push('tools:')
    for (const t of ADMIN_TOOL_NAMES) lines.push(`  ${t}: false`)
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
