import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentWebSearchCapable, WEB_SEARCH_SKILL_NAME } from '../src/index.js'
import type { AgentRow } from '../src/db/repos.js'

function fakeAgent(partial: Partial<AgentRow>): AgentRow {
  return {
    id: 'a1',
    name: '测试助手',
    avatar: '',
    description: '',
    instructions: '',
    model_provider: '',
    model_id: '',
    thinking: '',
    category: '',
    instructions_version: 1,
    builtin: 0,
    archived: 0,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
    ...partial,
  }
}

describe('联网指南按能力注入（2.3 省 Token）', () => {
  it('联网技能未安装时不具备联网能力（指南没有指向的对象）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-skills-'))
    try {
      expect(agentWebSearchCapable(fakeAgent({}), dir)).toBe(false)
      expect(agentWebSearchCapable(null, dir)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('装了 byted-web-search 技能即具备联网能力（普通 agent / 小杰）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-skills-'))
    try {
      fs.mkdirSync(path.join(dir, WEB_SEARCH_SKILL_NAME))
      fs.writeFileSync(path.join(dir, WEB_SEARCH_SKILL_NAME, 'SKILL.md'), '# byted-web-search\n')
      expect(agentWebSearchCapable(fakeAgent({}), dir)).toBe(true)
      expect(agentWebSearchCapable(fakeAgent({ builtin: 1 }), dir)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不按 Agent 名称、分类或 builtin 限制技能能力', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-skills-'))
    try {
      fs.mkdirSync(path.join(dir, WEB_SEARCH_SKILL_NAME))
      fs.writeFileSync(path.join(dir, WEB_SEARCH_SKILL_NAME, 'SKILL.md'), '# byted-web-search\n')
      expect(agentWebSearchCapable(fakeAgent({ category: '智慧病房', name: '医护助手' }), dir)).toBe(true)
      expect(agentWebSearchCapable(fakeAgent({ builtin: 1 }), dir)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
