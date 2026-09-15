/**
 * 技能来源契约：**模型看到的技能只从 `~/.agents/skills` 读**。
 *
 * 三个容易改坏的点，各锁一条：
 *  1. `skillsMount()` / `userSkillsDir()` 的默认值与 JEFF_SKILLS_DIR 覆盖；
 *  2. `writeSidecarConfig` 必须把该目录写进 opencode.json 的 `skills.paths`
 *     （sidecar 侧有 OPENCODE_DISABLE_EXTERNAL_SKILLS=1，关的是隐式扫描，不管显式挂载——
 *     这条挂载是唯一入口，删了就一个技能都看不到）；
 *  3. 应用自带的 `jeff-usage` 也写在这个目录下，且旧位置（opencode 配置目录）会被清掉。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JeffCore } from '../src/index.js'
import { BUILTIN_SKILL_DIR, USER_SKILLS_MOUNT, buildPaths, skillsMount, userSkillsDir } from '../src/paths.js'
import { writeSidecarConfig } from '../src/oc/configWriter.js'

let tmp: string
const savedSkillsEnv = process.env.JEFF_SKILLS_DIR

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-skills-dir-'))
  delete process.env.JEFF_SKILLS_DIR
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  if (savedSkillsEnv === undefined) delete process.env.JEFF_SKILLS_DIR
  else process.env.JEFF_SKILLS_DIR = savedSkillsEnv
})

describe('用户技能目录解析', () => {
  it('默认 = ~/.agents/skills（挂载写法与绝对路径指向同一处）', () => {
    expect(skillsMount()).toBe(USER_SKILLS_MOUNT)
    expect(USER_SKILLS_MOUNT).toBe('~/.agents/skills')
    expect(userSkillsDir()).toBe(path.join(os.homedir(), '.agents', 'skills'))
  })

  it('JEFF_SKILLS_DIR 覆盖两处（测试/便携模式）', () => {
    const custom = path.join(tmp, 'portable-skills')
    process.env.JEFF_SKILLS_DIR = custom
    expect(skillsMount()).toBe(custom)
    expect(userSkillsDir()).toBe(custom)
  })

  it('不跟 JEFF_HOME 走：数据目录换了，技能目录仍是家目录下的 ~/.agents/skills', () => {
    const paths = buildPaths(path.join(tmp, 'some-home'))
    expect(paths.root).toContain('some-home')
    expect(userSkillsDir()).toBe(path.join(os.homedir(), '.agents', 'skills'))
  })
})

describe('writeSidecarConfig 的技能挂载', () => {
  const provider = [
    {
      id: 'p1',
      name: 'P1',
      apiFormat: 'chat' as const,
      baseURL: 'http://x/v1',
      apiKey: 'k',
      enabled: true,
      models: [{ id: 'm1' }],
    },
  ]

  it('把用户技能目录写进 skills.paths，且保留 skills 的其它字段', () => {
    const paths = buildPaths(path.join(tmp, 'home'))
    fs.mkdirSync(paths.ocConfigDir, { recursive: true })
    fs.writeFileSync(
      path.join(paths.ocConfigDir, 'opencode.json'),
      JSON.stringify({ skills: { urls: ['https://example.com/skills'] } }),
      'utf8',
    )
    writeSidecarConfig(paths, provider)
    const cfg = JSON.parse(fs.readFileSync(path.join(paths.ocConfigDir, 'opencode.json'), 'utf8')) as {
      skills?: { paths?: string[]; urls?: string[] }
    }
    expect(cfg.skills?.paths).toEqual([USER_SKILLS_MOUNT])
    expect(cfg.skills?.urls).toEqual(['https://example.com/skills'])
  })

  it('重复写不会把挂载项去掉或写重（每次启动都会调用）', () => {
    const paths = buildPaths(path.join(tmp, 'home2'))
    writeSidecarConfig(paths, provider)
    writeSidecarConfig(paths, provider)
    const cfg = JSON.parse(fs.readFileSync(path.join(paths.ocConfigDir, 'opencode.json'), 'utf8')) as {
      skills?: { paths?: string[] }
    }
    expect(cfg.skills?.paths).toEqual([USER_SKILLS_MOUNT])
  })
})

describe('内置 jeff-usage 技能', () => {
  it('写在用户技能目录下，并清掉旧位置（opencode 配置目录）的残留', () => {
    const home = path.join(tmp, 'jeff-home')
    const paths = buildPaths(home)
    const skillsRoot = path.join(tmp, 'user-skills')
    process.env.JEFF_SKILLS_DIR = skillsRoot
    // 旧版本留下的副本：如果不清理，同名技能会出现两个来源
    const legacy = path.join(paths.ocSkillsDir, BUILTIN_SKILL_DIR)
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'legacy', 'utf8')

    const core = new JeffCore(home)
    core.writeUsageSkill()

    const skillFile = path.join(skillsRoot, BUILTIN_SKILL_DIR, 'SKILL.md')
    expect(fs.existsSync(skillFile)).toBe(true)
    expect(fs.readFileSync(skillFile, 'utf8')).toContain('name: jeff-usage')
    expect(fs.existsSync(legacy)).toBe(false)
  })
})
