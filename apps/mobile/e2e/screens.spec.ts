import { expect, test, type Page } from '@playwright/test'

type MockProject = { id: string; title: string; description: string; system_prompt?: string; icon: string; status: string; leader_agent_id: string; workspace_dir: string; updated_at: number; memberCount: number }
type MockPhone = { desktops: Map<string, unknown>; activeId: string; listeners: ((event: unknown) => void)[]; init: () => Promise<void>; invoke: (channel: string, payload?: Record<string, unknown>) => Promise<any> }
declare global { interface Window { __phone: MockPhone; __push: (event: unknown) => void } }

/**
 * 1.11 统一风格回归：列表 / 聊天 / 流式 / 加号面板 / 我页
 * 每屏截图留档 + 断言无横向溢出、关键控件完整落在视口内。
 * Mock 方式：localStorage 塞 profile + 劫持 window.__phone 的 invoke（与 dev 取证脚本同思路）。
 */
const PROFILE = {
  identity: { id: 'phone-e2e-id-1234567890', signSecret: 'dGVzdA==', x25519Secret: 'dGVzdA==' },
  desktops: [
    { id: 'pc-work', name: 'xujian 的开发机', online: true, x25519: 'k' },
  ],
  activeId: 'pc-work',
}

const AGENTS = [
  { id: 'agt_xiaojie', name: '小杰', avatar: '🧑‍💻', description: 'Jeff 内置管家', instructions: '', model_provider: 'p', model_id: 'm', thinking: '', category: '', builtin: true, archived: false },
  { id: 'a1', name: '一个名字特别特别长的智能体用来测试顶栏省略号显示', avatar: '🔧', description: '验证长名字', instructions: '', model_provider: 'p', model_id: 'm', thinking: '', category: '开发工具', builtin: false, archived: false },
]
const PROJECTS: MockProject[] = [
  { id: 'p1', title: '一个很长很长的项目群名字用来测试顶栏按钮不溢出', description: '', icon: '🎬', status: 'active', leader_agent_id: 'a1', workspace_dir: '/home/x/ws', updated_at: Date.now() - 60000, memberCount: 3 },
]
const now = Date.now()
const CHAT = [
  { id: 'm1', role: 'user', text: '帮我看下今天病房的巡检结论', time: now - 3600000 },
  { id: 'm2', role: 'assistant', text: '## 巡检结论\n\n3 床今日**平稳**，未见新发异常。\n\n- 体温 36.7℃\n- 血压 120/80', reasoning: ['先核对异常项'], time: now - 3500000, tools: [{ tool: 'jeff_project_list', status: 'completed', output: 'ok' }] },
  { id: 'm3', role: 'user', text: '把结论发到群里', time: now - 300000 },
  { id: 'm4', role: 'assistant', text: '已发到「项目群」，群主已确认收到。', time: now - 240000 },
  { id: 'm5', role: 'user', text: '（图片）', time: now - 120000, images: [{ mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }] },
]
const GROUP = [
  { id: 'g1', role: 'user', text: '今天的巡检结论发一下', time: now - 5400000, sender_name: '我', sender_avatar: '🧑' },
  { id: 'g2', role: 'assistant', text: '收到，项经理汇总一下。', time: now - 5300000, sender_name: '小杰', sender_avatar: '🤖', agentId: 'agt_xiaojie' },
]

async function noOverflow(page: Page, tag: string) {
  const r = await page.evaluate(() => {
    const out: { docW: number; innerW: number; offenders: { sel: string; text: string }[] } = { docW: document.documentElement.scrollWidth, innerW: window.innerWidth, offenders: [] }
    for (const el of document.querySelectorAll('*')) {
      const box = el.getBoundingClientRect()
      if (box.width === 0 && box.height === 0) continue
      if (box.right > window.innerWidth + 1 || box.left < -1) {
        out.offenders.push({
          sel: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''),
          text: (el.textContent || '').trim().slice(0, 20),
        })
      }
    }
    out.offenders = out.offenders.slice(0, 12)
    return out
  })
  expect(r.offenders, `${tag} 出现横向溢出元素`).toEqual([])
  expect(r.docW, `${tag} 文档横向滚动宽超出视口`).toBeLessThanOrEqual(r.innerW)
}

async function openContact(page: Page, testId: string) {
  if (!await page.getByTestId('contacts-list').isVisible().catch(() => false)) {
    await page.getByTestId('tab-contacts').click()
  }
  await page.getByTestId(testId).click()
}

test.describe('1.11 统一风格全屏回归', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ profile, agents, projects, chat, group, now }) => {
        localStorage.clear()
        localStorage.setItem('jeff-phone-profile', JSON.stringify(profile))
        const taskRows: any[] = []
        const memoryContent: Record<string, string> = {}
        let real: MockPhone
        Object.defineProperty(window, '__phone', {
          configurable: true,
          get() {
            return real
          },
          set(v) {
            real = v
            v.desktops = new Map(profile.desktops.map((d: { id: string }) => [d.id, { ...d }]))
            v.activeId = profile.activeId
            v.init = async () => {}
            v.invoke = async (channel: string, payload?: Record<string, any>) => {
              const p = payload || {}
              switch (channel) {
                case 'memory:scopes':
                  return Array.from({ length: 60 }, (_, i) => ({ kind: 'agent', id: `memory-${i}`, label: `记忆智能体 ${i}`, file: `local/memory-${i}.md` }))
                case 'memory:get': return { content: memoryContent[p.id] || '' }
                case 'memory:save': memoryContent[p.id] = p.content; return { ok: true }
                case 'agentsmd:list': return [{ kind: 'user', id: 'user', label: '全局公开规则', file: 'local/AGENTS.md', exists: true }]
                case 'agentsmd:get': return { content: '# 全局规则\n用中文', file: 'local/AGENTS.md' }
                case 'engines:list':
                  return ['opencode', 'codex', 'cursor', 'claude'].map(id => ({ id, available: true, version: '测试协议' }))
                case 'engines:models':
                  return { models: [{ id: 'test-model', label: '测试模型' }] }
                case 'agents:upsert': {
                  const agent = agents.find(item => item.id === p.id)
                  if (!agent) throw new Error('智能体不存在')
                  Object.assign(agent, p); return agent
                }
                case 'agents:list':
                  return agents
                case 'projects:list':
                  return projects
                case 'project:members':
                  return [{ agent_id: 'a1', role: 'member', name: agents.find((agent: any) => agent.id === 'a1')?.name || '成员', avatar: '🔧', duties: '负责当前群的执行与复核。', model_override: null, thinking_override: null, execution_engine: 'opencode', engine_model: 'test-model', model_provider: 'p', model_id: 'm', thinking: '' }]
                case 'tasks:list':
                  return taskRows.filter((task) => task.project_id === p.projectId)
                case 'task:save': {
                  let task = p.id ? taskRows.find((item) => item.id === p.id) : undefined
                  if (!task) {
                    task = { id: `task_mobile_${taskRows.length + 1}`, project_id: p.project_id, number: taskRows.length + 1, key: `JEF-${taskRows.length + 1}`, status: 'todo', priority: 'medium', assignee_type: 'none', assignee_id: '', parent_task_id: null, depends_on: [], evidence_paths: [], acceptance_criteria: '', goal: '', description: '', result_summary: '', submission_id: '', submitted_spec_hash: '', review_feedback: '', reviewed_submission_id: '', created_at: Date.now(), updated_at: Date.now(), due_at: null }
                    taskRows.push(task)
                  }
                  Object.assign(task, p, { depends_on: p.depends_on ?? task.depends_on, due_at: p.due_at ?? task.due_at })
                  return task
                }
                case 'project:save':
                  {
                    const project = projects.find((x: MockProject) => x.id === p.id)
                    if (project) Object.assign(project, p)
                    return { ...project, ...p, updated_at: Date.now(), memberCount: 3 }
                  }
                case 'siyuan:search':
                  return [{ docId: '20261005123456-abc1234', notebookId: '20261005111111-nb12345', title: '测试日报 2026-10-05', path: '/日报/2026/10/05', snippet: '完成接口联调' }]
                case 'siyuan:notebooks':
                  return [{ id: '20261005111111-nb12345', name: '项目知识', closed: false }]
                case 'siyuan:documents':
                  return [{ docId: '20261005123456-abc1234', notebookId: p.notebookId, title: '会议资料', path: '/项目/会议资料', snippet: '' }]
                case 'chat:history':
                  return chat[''] || []
                case 'group:history':
                  return { threadId: 'thr1', messages: [...group] }
                case 'sessions:list':
                  return { sessions: [{ id: 's1', title: '今天病房巡检', active: true }] }
                case 'group:threadsList':
                  return { threads: [{ id: 't1', title: '话题一', active: true }] }
                case 'fs:listDirs':
                  return { dir: '/home/x/ws', parent: '/home/x', entries: [{ name: 'ws2', path: '/home/x/ws2' }] }
                case 'app:info':
                  return { version: '1.11.0', sidecarStatus: 'running', dataDir: '/home/x/.jeff', opencodeBinary: null }
                case 'fs:listFiles':
                  return {
                    dir: p.dir,
                    exists: true,
                    nodes: [
                      {
                        name: '报告', rel: '报告', abs: p.dir + '/报告', dir: true, ext: '', size: 0, mtime: now,
                        children: [{ name: '巡检结论.md', rel: '报告/巡检结论.md', abs: p.dir + '/报告/巡检结论.md', dir: false, ext: 'md', size: 1234, mtime: now }],
                      },
                      { name: 'notes.txt', rel: 'notes.txt', abs: p.dir + '/notes.txt', dir: false, ext: 'txt', size: 45, mtime: now },
                      { name: '汇总.md', rel: '汇总.md', abs: p.dir + '/汇总.md', dir: false, ext: 'md', size: 2048, mtime: now },
                    ],
                  }
                case 'fs:resolvePaths': {
                  const base = String((p.bases && p.bases[0]) || '/home/x/ws').replace(/[\\/]+$/, '')
                  const hits = (p.inputs || []).flatMap((input: string) => {
                    if (input === '报告/巡检结论.md' || input.endsWith('/巡检结论.md')) {
                      return [{ input, abs: `${base}/报告/巡检结论.md`, kind: 'file' }]
                    }
                    return []
                  })
                  return { hits }
                }
                case 'fs:readFile': {
                  const content = String(p.file).endsWith('汇总.md')
                    ? '# 汇总\n\n3 床今日**平稳**，未见新发异常。\n\n明细见 报告/巡检结论.md。'
                    : '# 巡检结论\n\n- 体温 36.7℃\n- 血压 120/80'
                  return { file: p.file, content, size: 100, truncated: false }
                }
                default:
                  return { ok: true }
              }
            }
            window.__push = (ev) => {
              for (const cb of v.listeners) cb(ev)
            }
          },
        })
      },
      { profile: PROFILE, agents: AGENTS, projects: PROJECTS, chat: { '': CHAT }, group: GROUP, now },
    )
    await page.goto('/')
    await expect(page.getByTestId('msg-list')).toBeVisible()
  })

  test('执行引擎：每个 Agent 均可选择并保存，窄屏弹窗无溢出', async ({ page }) => {
    await openContact(page, 'chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示')
    await page.getByTestId('chat-more').click()
    await page.getByTestId('mobile-engine-settings').click()
    await expect(page.getByTestId('mobile-engine-selector')).toBeVisible()
    await page.getByTestId('mobile-agent-engine').selectOption('codex')
    await page.getByTestId('mobile-engine-model').fill('test-model')
    await page.getByLabel('思考档位', { exact: true }).selectOption('high')
    await noOverflow(page, 'engine-selector')
    await page.screenshot({ path: '../../.tmp/engine-evidence/mobile-engine-selector.png' })
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const stored = await page.evaluate(() => window.__phone.invoke('agents:list'))
    expect(stored.find((item: any) => item.id === 'a1')).toMatchObject({ execution_engine: 'codex', engine_model: 'test-model', thinking: 'high' })
    await expect(page.getByTestId('mobile-engine-selector')).toHaveCount(0)
    await page.getByTestId('chat-more').click(); await page.getByTestId('mobile-engine-settings').click()
    await page.getByLabel('智能体', { exact: true }).selectOption('agt_xiaojie')
    await expect(page.getByTestId('mobile-agent-engine').locator('option[value=codex]')).not.toHaveAttribute('disabled', '')
    await page.getByTestId('mobile-agent-engine').selectOption('codex')
    await page.getByTestId('mobile-engine-model').fill('gpt-6-luna')
    await page.getByLabel('思考档位', { exact: true }).selectOption('high')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const savedAgents = await page.evaluate(() => window.__phone.invoke('agents:list'))
    expect(savedAgents.find((item: any) => item.id === 'agt_xiaojie')).toMatchObject({ execution_engine: 'codex', engine_model: 'gpt-6-luna', thinking: 'high' })
  })

  test('会话列表：无溢出 + 未读角标可见', async ({ page }) => {
    await expect(page.getByTestId('chat-agent-小杰')).toBeVisible()
    await expect(page.getByTestId('chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出')).toHaveCount(0)
    await expect(page.getByTestId('chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示')).toHaveCount(0)
    await noOverflow(page, 'list')
    await page.screenshot({ path: '../../.tmp/e2e-screens/01-list.png' })
  })

  test('最近聊天按活动时间排序，置顶项目群可移到聊天首页前部', async ({ page }) => {
    await openContact(page, 'chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出')
    await page.getByTestId('chat-back').click()
    await openContact(page, 'chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示')
    await page.getByTestId('chat-back').click()

    const position = async (testId: string) => page.getByTestId(testId).evaluate((element) => Array.from(element.parentElement!.children).indexOf(element))
    const agentId = 'chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示'
    const groupId = 'chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出'
    expect(await position(agentId)).toBeLessThan(await position(groupId))

    await page.getByTestId(groupId).locator('button').click({ button: 'right' })
    await page.getByTestId('sheet-toggle-pin').click()
    await expect(page.getByTestId(groupId)).toContainText('置顶')
    expect(await position(groupId)).toBeLessThan(await position(agentId))
  })

  test('底部通讯录：项目群与智能体分组可见，搜索后能打开联系人', async ({ page }) => {
    await page.getByTestId('tab-contacts').click()
    await expect(page.getByTestId('contacts-list')).toBeVisible()
    await expect(page.getByText('项目群', { exact: true })).toBeVisible()
    await expect(page.getByTestId('chat-agent-group-开发工具')).toBeVisible()
    await page.screenshot({ path: '../../.tmp/e2e-screens/13-contacts.png' })
    await page.getByTestId('chat-list-search').fill('名字特别特别长')
    await expect(page.getByTestId('chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示')).toBeVisible()
    await openContact(page, 'chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示')
    await expect(page.getByTestId('chat')).toBeVisible()
  })

  test('核心导航与项目管理：360/390/412 宽度、亮色与暗色均无横向溢出', async ({ page }) => {
    for (const width of [360, 390, 412]) {
      await page.setViewportSize({ width, height: width === 360 ? 640 : width === 390 ? 844 : 915 })
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await page.goto('/')
        await noOverflow(page, `list-${width}-${colorScheme}`)
        await page.getByTestId('tab-contacts').click()
        await noOverflow(page, `contacts-${width}-${colorScheme}`)
        await openContact(page, 'chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出')
        await page.getByTestId('project-management').click()
        await expect(page.getByTestId('project-management-screen')).toBeVisible()
        await expect(page.getByTestId('mobile-project-task-list')).toBeVisible()
        await noOverflow(page, `project-management-${width}-${colorScheme}`)
        await page.getByTestId('mobile-project-section-profile').click()
        await noOverflow(page, `project-profile-${width}-${colorScheme}`)
      }
    }
  })

  test('私聊（超长名字）：顶栏省略号、消息新形态、无溢出', async ({ page }) => {
    await openContact(page, 'chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示')
    await expect(page.getByTestId('bubbles')).toBeVisible()
    // 助手消息：新形态（去气泡 + 弱化折叠条）
    await expect(page.locator('.wechat-ai-body')).toHaveCount(2)
    await expect(page.locator('.fold-chip, .wechat-reasoning, .wechat-tools').first()).toBeVisible()
    // 用户气泡：淡翡翠（m1/m3/m5 共 3 条）
    await expect(page.locator('.wechat-user-bubble')).toHaveCount(3)
    // 顶栏标题省略号不把右侧图标挤出视口
    const bar = page.locator('.wechat-chat-bar')
    await expect(bar).toBeVisible()
    await page.getByTestId('chat-more').click()
    await expect(page.getByTestId('session-history')).toBeVisible()
    const sesBtn = await page.getByTestId('session-history').boundingBox()
    expect(sesBtn!.x + sesBtn!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
    await noOverflow(page, 'chat-agent')
    await page.screenshot({ path: '../../.tmp/e2e-screens/02-chat-agent.png' })
  })

  test('横屏聊天：会话列表常驻侧栏，可直接切换联系人', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    await openContact(page, 'chat-agent-小杰')
    const pane = page.getByTestId('landscape-conversation-pane')
    await expect(pane).toBeVisible()
    await expect(page.getByTestId('chat')).toBeVisible()
    await expect(page.getByTestId('landscape-nav-rail')).toBeVisible()
    await expect(page.getByTestId('landscape-nav-rail').getByRole('button', { name: '聊天' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('chat-back')).toBeHidden()
    await expect(page.getByTestId('chat-agent-小杰').locator('button')).toHaveAttribute('aria-current', 'true')
    await noOverflow(page, 'landscape-chat')
    await page.screenshot({ path: '../../.tmp/e2e-screens/landscape-chat.png' })

    await page.getByTestId('landscape-nav-rail').getByRole('button', { name: '通讯录' }).click()
    await expect(page.getByTestId('chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示')).toBeVisible()
    await page.getByTestId('chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示').click()
    await expect(page.getByTestId('chat')).toContainText('一个名字特别特别长的智能体用来测试顶栏省略号显示')
    await expect(page.getByTestId('chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示').locator('button')).toHaveAttribute('aria-current', 'true')
  })

  test('私聊发送：乐观回显立刻可见（不等电脑回复）', async ({ page }) => {
    await page.getByTestId('chat-agent-小杰').click()
    await expect(page.getByTestId('bubbles')).toBeVisible()
    await page.getByTestId('chat-input').fill('帮我看下今天病房的巡检结论')
    // invoke 挂起 30s 模拟模型慢回复：用户消息必须立刻上屏
    await page.evaluate(() => {
      const phone = window.__phone
      const orig = phone.invoke.bind(phone)
      phone.invoke = (channel, payload) => {
        if (channel === 'chat:send') return new Promise(() => {})
        return orig(channel, payload)
      }
    })
    await page.getByTestId('chat-send').click()
    await expect(page.locator('.wechat-user-bubble').last()).toContainText('帮我看下今天病房的巡检结论', { timeout: 3000 })
    await expect(page.getByTestId('chat-stop')).toBeVisible()
    await page.screenshot({ path: '../../.tmp/e2e-screens/03-optimistic.png' })
  })

  test('群聊（超长群名）：顶栏图标按钮完整、群成员头像与名字', async ({ page }) => {
    await openContact(page, 'chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出')
    await expect(page.getByTestId('bubbles')).toBeVisible()
    await page.getByTestId('chat-more').click()
    await expect(page.getByTestId('session-history')).toBeVisible()
    await expect(page.getByTestId('workspace')).toBeVisible()
    const ws = await page.getByTestId('workspace').boundingBox()
    expect(ws!.x + ws!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
    // 群聊助手行带成员名
    await expect(page.locator('.msg-who').filter({ hasText: '小杰' })).toBeVisible()
    await noOverflow(page, 'chat-group')
    await page.screenshot({ path: '../../.tmp/e2e-screens/04-chat-group.png' })
  })

  test('项目管理：独立任务要求、群资料保存重开与资料分区', async ({ page }) => {
    await openContact(page, 'chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出')
    await page.getByTestId('project-management').click()
    await expect(page.getByTestId('project-management-screen')).toBeVisible()
    await expect(page.getByTestId('mobile-project-task-list')).toContainText('还没有任务')
    await page.screenshot({ path: '../../.tmp/e2e-screens/14-project-management.png' })

    await page.getByRole('button', { name: '新建任务' }).click()
    await page.getByTestId('mobile-project-task-title').fill('整理本周巡检结论')
    await page.getByTestId('mobile-project-task-goal').fill('让项目组获得一份可复核的周度结果')
    await page.getByTestId('mobile-project-task-description').fill('汇总巡检记录，标出异常、来源和待跟进事项。')
    await page.getByTestId('mobile-project-task-criteria').fill('结果文件存在，异常均附来源，待跟进项有负责人。')
    await expect(page.getByTestId('mobile-project-task-goal')).toBeVisible()
    await expect(page.getByTestId('mobile-project-task-description')).toBeVisible()
    await expect(page.getByTestId('mobile-project-task-criteria')).toBeVisible()
    await page.getByTestId('mobile-project-task-save').click()
    await expect(page.getByTestId('mobile-project-task-detail')).toContainText('任务已保存。保存不会自动开始执行。')
    await expect(page.getByTestId('mobile-project-task-detail')).toContainText('让项目组获得一份可复核的周度结果')
    await expect(page.getByTestId('mobile-project-task-detail')).toContainText('异常均附来源')
    await page.screenshot({ path: '../../.tmp/e2e-screens/15-project-task-siyuan.png' })

    await page.getByTestId('mobile-project-section-tasks').click()
    await expect(page.getByTestId('mobile-project-task-task_mobile_1')).toContainText('整理本周巡检结论')
    await expect(page.getByTestId('mobile-project-task-task_mobile_1')).toContainText('让项目组获得一份可复核的周度结果')

    await page.getByTestId('mobile-project-section-profile').click()
    await page.getByTestId('mobile-group-description').fill('仅用于验收的项目背景。')
    await page.getByTestId('mobile-group-rules').fill('本群规则只约束当前项目群。')
    await page.getByTestId('mobile-group-siyuan-notebook').selectOption('20261005111111-nb12345')
    await expect(page.getByTestId('mobile-group-siyuan-parent').locator('option', { hasText: '会议资料' })).toHaveCount(1)
    await page.getByTestId('mobile-group-siyuan-parent').selectOption('20261005123456-abc1234')
    await page.getByTestId('mobile-group-profile-save').click()
    await expect(page.getByRole('status')).toContainText('群资料已保存')
    for (const width of [360, 430]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(page.getByTestId('mobile-group-siyuan-notebook')).toHaveValue('20261005111111-nb12345')
      await noOverflow(page, `project-siyuan-target-${width}`)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: '../../.tmp/e2e-screens/16-group-profile-siyuan.png' })

    await page.getByTestId('mobile-project-section-members').click()
    await expect(page.getByTestId('mobile-group-member-duties')).toHaveValue('负责当前群的执行与复核。')
    await page.getByTestId('mobile-project-section-history').click()
    await expect(page.getByTestId('mobile-project-history')).toContainText('普通讨论和任务执行使用不同话题')
    await page.getByTestId('mobile-project-section-files').click()
    await expect(page.getByTestId('mobile-project-files')).toBeVisible()
    await noOverflow(page, 'project-management')

    await page.locator('.project-management-screen .btn-nav-back').click()
    await page.getByTestId('project-management').click()
    await page.getByTestId('mobile-project-section-profile').click()
    await expect(page.getByTestId('mobile-group-description')).toHaveValue('仅用于验收的项目背景。')
    await expect(page.getByTestId('mobile-group-rules')).toHaveValue('本群规则只约束当前项目群。')
    await expect(page.getByTestId('mobile-group-siyuan-notebook')).toHaveValue('20261005111111-nb12345')
    await expect(page.getByTestId('mobile-group-siyuan-parent')).toHaveValue('20261005123456-abc1234')
    await page.locator('.project-management-screen .btn-nav-back').click()
  })

  test('流式回复：思考中折叠条与停止按钮，无溢出', async ({ page }) => {
    await page.getByTestId('chat-agent-小杰').click()
    await expect(page.getByTestId('bubbles')).toBeVisible()
    await page.evaluate(() => {
      const liveText = '正在读取巡检记录，稍等…'
      window.__push({
        what: 'chat-stream',
        p: { kind: 'agent', agentId: 'agt_xiaojie', messageId: 'live-1', reset: true, textDelta: liveText, reasoningDelta: '先确认异常项', textLen: liveText.length, reasoningLen: 6, tools: [{ tool: 'jeff_project_list', status: 'running' }], done: false },
      })
    })
    await expect(page.getByTestId('stream')).toBeVisible()
    await expect(page.locator('.wechat-ai-body.live')).toBeVisible()
    await expect(page.getByTestId('chat-stop')).toBeVisible()
    await noOverflow(page, 'stream')
    await page.screenshot({ path: '../../.tmp/e2e-screens/05-stream.png' })
  })

  test('加号面板 + 长按菜单 + 图片查看器', async ({ page }) => {
    await page.getByTestId('chat-agent-小杰').click()
    await expect(page.getByTestId('bubbles')).toBeVisible()
    await page.getByTestId('plus').click()
    await expect(page.getByTestId('plus-panel')).toBeVisible()
    await noOverflow(page, 'plus-panel')
    await page.screenshot({ path: '../../.tmp/e2e-screens/06-plus.png' })
    await page.getByTestId('plus').click()

    // 长按消息出菜单（桌面用 contextmenu 模拟）
    await page.locator('.wechat-user-bubble').first().click({ button: 'right' })
    await expect(page.getByTestId('msg-menu')).toBeVisible()
    await page.screenshot({ path: '../../.tmp/e2e-screens/07-msg-menu.png' })
    await page.getByTestId('menu-hide').click()
    await expect(page.getByTestId('msg-menu')).toBeHidden()

    // 图片查看器：用户消息里带图 → 点击放大
    await page.evaluate(() => {
      window.__push({ what: 'chat-updated', p: { agentId: 'agt_xiaojie' } })
    })
    await page.locator('.wechat-user-bubble img').first().click()
    await expect(page.getByTestId('image-viewer')).toBeVisible()
    await page.screenshot({ path: '../../.tmp/e2e-screens/08-viewer.png' })
    await page.getByTestId('image-viewer').click()
    await expect(page.getByTestId('image-viewer')).toBeHidden()
  })

  test('未读角标：其他会话来新消息，列表行出现红点数字', async ({ page }) => {
    await openContact(page, 'chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示')
    await expect(page.getByTestId('bubbles')).toBeVisible()
    await page.getByTestId('chat-back').click()
    await expect(page.getByTestId('msg-list')).toBeVisible()
    await page.evaluate(() => {
      window.__push({ what: 'chat-updated', p: { agentId: 'a1' } })
    })
    await expect(page.locator('.wechat-unread-badge')).toBeVisible()
    await noOverflow(page, 'list-unread')
    await page.screenshot({ path: '../../.tmp/e2e-screens/09-unread.png' })
  })

  test('我页 + 目录选取：无溢出', async ({ page }) => {
    await page.getByTestId('tab-me').click()
    await expect(page.getByTestId('me')).toBeVisible()
    await noOverflow(page, 'me')
    await page.screenshot({ path: '../../.tmp/e2e-screens/10-me.png' })
  })

  test('工作区文件浏览：列目录/下钻/非 md 提示', async ({ page }) => {
    await openContact(page, 'chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出')
    await expect(page.getByTestId('bubbles')).toBeVisible()
    await page.getByTestId('chat-more').click()
    await page.getByTestId('workspace').click()
    await expect(page.getByTestId('workspace-files')).toBeVisible()
    await expect(page.getByTestId('workspace-file-path')).toContainText('/home/x/ws')
    // 目录与文件都在列表里，md 文件可点
    await expect(page.getByTestId('file-汇总.md')).toBeVisible()
    await expect(page.getByTestId('dir-报告')).toBeVisible()
    await expect(page.getByTestId('file-notes.txt')).toBeVisible()
    // 下钻进「报告」子目录再返回
    await page.getByTestId('dir-报告').click()
    await expect(page.getByTestId('file-巡检结论.md')).toBeVisible()
    await expect(page.getByTestId('workspace-file-path')).toContainText('ws / 报告')
    await page.screenshot({ path: '../../.tmp/e2e-screens/11-workspace-files.png' })
    await page.getByRole('button', { name: '.. (上级目录)' }).click()
    await expect(page.getByTestId('file-汇总.md')).toBeVisible()
    // 非 md 文件：提示不支持
    await page.getByTestId('file-notes.txt').click()
    await expect(page.getByTestId('workspace-files-tip')).toContainText('暂不支持手机预览')
    await noOverflow(page, 'workspace-files')
  })

  test('工作区 md 预览：markdown 渲染 + 站内相对路径链接跳转', async ({ page }) => {
    await openContact(page, 'chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出')
    await expect(page.getByTestId('bubbles')).toBeVisible()
    await page.getByTestId('chat-more').click()
    await page.getByTestId('workspace').click()
    await expect(page.getByTestId('workspace-files')).toBeVisible()
    await page.getByTestId('file-汇总.md').click()
    await expect(page.getByTestId('file-preview')).toBeVisible()
    await expect(page.getByTestId('file-preview-title')).toHaveText('汇总.md')
    await expect(page.getByTestId('file-preview-body')).toContainText('3 床今日平稳')
    // linkify 把正文里的 报告/巡检结论.md 转成站内链接，点击跳到那个文件
    await expect(page.locator('.md-file-link')).toHaveCount(1)
    await page.locator('.md-file-link').click()
    await expect(page.getByTestId('file-preview-title')).toHaveText('巡检结论.md')
    await expect(page.getByTestId('file-preview-body')).toContainText('体温 36.7℃')
    await noOverflow(page, 'file-preview')
    await page.screenshot({ path: '../../.tmp/e2e-screens/12-file-preview.png' })
  })

  test('手机记忆范围搜索和保存，长列表不撑大弹窗', async ({ page }) => {
    await page.getByTestId('tab-me').click()
    await page.getByTestId('mobile-memory-settings').click()
    const dialog = page.getByRole('dialog', { name: '记忆与规则' })
    await expect(dialog.getByRole('button', { name: '记忆智能体 59', exact: true })).toBeAttached()
    const size = await page.locator('.mobile-memory-scopes').evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }))
    expect(size.client).toBeLessThanOrEqual(180); expect(size.scroll).toBeGreaterThan(size.client)
    await dialog.getByRole('textbox', { name: '搜索记忆范围' }).fill('记忆智能体 59')
    await dialog.getByRole('button', { name: '记忆智能体 59', exact: true }).click()
    await dialog.getByRole('textbox', { name: '记忆内容' }).fill('[私有] 手机验收条目')
    await dialog.getByRole('button', { name: '保存修改' }).click()
    await expect(dialog.getByRole('button', { name: '已保存' })).toBeDisabled()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByTestId('mobile-memory-settings').click()
    await dialog.getByRole('textbox', { name: '搜索记忆范围' }).fill('记忆智能体 59')
    await dialog.getByRole('button', { name: '记忆智能体 59', exact: true }).click()
    await expect(dialog.getByRole('textbox', { name: '记忆内容' })).toHaveValue('[私有] 手机验收条目')
    await noOverflow(page, '记忆管理')
    await page.screenshot({ path: '../../.tmp/engine-evidence/mobile-memory-search.png', fullPage: true })
  })
})
