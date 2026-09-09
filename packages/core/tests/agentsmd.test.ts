import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/db.js'
import { buildPaths } from '../src/paths.js'
import { projectRepo } from '../src/db/repos.js'
import { composeAgentsMdBlocks } from '../src/index.js'
import type { DB } from '../src/db/db.js'

let tmp: string
let db: DB
let wsDir: string
let projectId: string
let paths: ReturnType<typeof buildPaths>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-amd-'))
  paths = buildPaths(tmp)
  db = openDb(paths)
  wsDir = path.join(tmp, 'ws-prj')
  fs.mkdirSync(wsDir, { recursive: true })
  projectId = projectRepo(db).create({ title: '官网群', workspace_dir: wsDir }).id
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

describe('composeAgentsMdBlocks（项目规则唯一来源）', () => {
  it('用户级 + 项目级权威副本同时存在时注入；工作空间旧文件不注入', () => {
    write(paths.agentsMdUser, '# 全局规则')
    const auth = path.join(paths.agentsMdDir, `${projectId}.md`)
    write(auth, '# 项目权威规则')
    const legacy = path.join(wsDir, 'AGENTS.md')
    write(legacy, '# 工作空间旧规则（不应生效）')

    const blocks = composeAgentsMdBlocks(paths, db, projectId)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toContain('用户级')
    expect(blocks[0]).toContain('# 全局规则')
    expect(blocks[1]).toContain('项目级')
    expect(blocks[1]).toContain('# 项目权威规则')
    expect(blocks.join('\n')).not.toContain('# 工作空间旧规则')
    expect(blocks[1]).toContain(auth)
  })

  it('权威副本缺失时兼容读取工作空间旧文件作为迁移来源', () => {
    write(path.join(wsDir, 'AGENTS.md'), '# 旧工作空间规则')
    const blocks = composeAgentsMdBlocks(paths, db, projectId)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('项目级')
    expect(blocks[0]).toContain('# 旧工作空间规则')
    expect(blocks[0]).toContain(path.join(wsDir, 'AGENTS.md'))
  })

  it('权威副本一旦存在，之后修改工作空间文件不影响注入', () => {
    const auth = path.join(paths.agentsMdDir, `${projectId}.md`)
    write(auth, '# 权威 v1')
    write(path.join(wsDir, 'AGENTS.md'), '# 权威 v2（工作空间改动不应生效）')
    const blocks = composeAgentsMdBlocks(paths, db, projectId)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('# 权威 v1')
    expect(blocks.join('\n')).not.toContain('不应生效')
  })

  it('无任何文件时不注入项目块', () => {
    expect(composeAgentsMdBlocks(paths, db, projectId)).toHaveLength(0)
  })

  it('workspace_dir 为空的项目回退默认工作空间目录', () => {
    const pid = projectRepo(db).create({ title: '默认空间群' }).id
    write(path.join(paths.workspaceDir, 'AGENTS.md'), '# 默认工作空间规则')
    const blocks = composeAgentsMdBlocks(paths, db, pid)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('# 默认工作空间规则')
    // 权威副本创建后即取代默认工作空间文件
    write(path.join(paths.agentsMdDir, `${pid}.md`), '# 权威规则')
    const after = composeAgentsMdBlocks(paths, db, pid)
    expect(after).toHaveLength(1)
    expect(after[0]).toContain('# 权威规则')
  })

  it('无 projectId（私聊）时仅用户级生效', () => {
    write(paths.agentsMdUser, '# 全局规则')
    const blocks = composeAgentsMdBlocks(paths, db)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('用户级')
  })
})
