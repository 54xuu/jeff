import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db/db.js'
import type { AgentRow } from '../db/repos.js'
import { agentRepo } from '../db/repos.js'
import type { JeffPaths } from '../paths.js'
import { ADMIN_TOOL_NAMES } from '../tools/adminTools.js'
import { XIAOJIE_ID } from '../ipc/contract.js'


export const XIAOJIE_SLUG = 'jeff_xiaojie'

/** agent id → opencode agent 名（slug） */
export function agentSlug(agentId: string): string {
  if (agentId === XIAOJIE_ID) return XIAOJIE_SLUG
  const safe = agentId.replace(/[^a-zA-Z0-9]/g, '')
  return `jeff_${safe.slice(0, 16)}`
}

export const XIAOJIE_INSTRUCTIONS = `你是「小杰」，Jeff 桌面应用的内置管家 agent。Jeff 把工作组织成：智能体（聊天好友）、项目群（群主 leader + 成员智能体）、任务（待办/进行/待审/完成）。

你的职责（你是唯一的管家，工具权限仅你拥有）：
1. 问答与使用指导：用户询问「Jeff 怎么用」时，直接讲解功能。
2. 代为管理：通过 jeff_agent_* 工具帮用户创建/修改/删除其他智能体；后续还有项目群与任务管理工具。
3. 你没有编码/文件工具；技术活建议用户去对应智能体或项目群里完成。

要求：
- 用简体中文回复，简洁友好，像微信里的靠谱同事。
- 用户要创建智能体时：先问清「名字、干什么用的、用什么模型（可默认）」，确认后调用 jeff_agent_create。
- 破坏性操作（删除智能体）必须先和用户确认一次。`

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
