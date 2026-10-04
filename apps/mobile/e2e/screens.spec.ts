import { expect, test } from '@playwright/test'

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
const PROJECTS = [
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

async function noOverflow(page, tag) {
  const r = await page.evaluate(() => {
    const out = { docW: document.documentElement.scrollWidth, innerW: window.innerWidth, offenders: [] }
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

test.describe('1.11 统一风格全屏回归', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ profile, agents, projects, chat, group, now }) => {
        localStorage.clear()
        localStorage.setItem('jeff-phone-profile', JSON.stringify(profile))
        let real
        Object.defineProperty(window, '__phone', {
          configurable: true,
          get() {
            return real
          },
          set(v) {
            real = v
            v.desktops = new Map(profile.desktops.map((d) => [d.id, { ...d }]))
            v.activeId = profile.activeId
            v.init = async () => {}
            v.invoke = async (channel, payload) => {
              const p = payload || {}
              switch (channel) {
                case 'agents:list':
                  return agents
                case 'projects:list':
                  return projects
                case 'project:save':
                  return { ...projects.find((x) => x.id === p.id), ...p, updated_at: Date.now(), memberCount: 3 }
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

  test('会话列表：无溢出 + 未读角标可见', async ({ page }) => {
    await expect(page.getByTestId('chat-agent-小杰')).toBeVisible()
    await noOverflow(page, 'list')
    await page.screenshot({ path: '../../.tmp/e2e-screens/01-list.png' })
  })

  test('私聊（超长名字）：顶栏省略号、消息新形态、无溢出', async ({ page }) => {
    await page.getByTestId('chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示').click()
    await expect(page.getByTestId('bubbles')).toBeVisible()
    // 助手消息：新形态（去气泡 + 弱化折叠条）
    await expect(page.locator('.wechat-ai-body')).toHaveCount(2)
    await expect(page.locator('.fold-chip, .wechat-reasoning, .wechat-tools').first()).toBeVisible()
    // 用户气泡：淡翡翠（m1/m3/m5 共 3 条）
    await expect(page.locator('.wechat-user-bubble')).toHaveCount(3)
    // 顶栏标题省略号不把右侧图标挤出视口
    const bar = page.locator('.wechat-chat-bar')
    await expect(bar).toBeVisible()
    await expect(page.getByTestId('session-history')).toBeVisible()
    const sesBtn = await page.getByTestId('session-history').boundingBox()
    expect(sesBtn!.x + sesBtn!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
    await noOverflow(page, 'chat-agent')
    await page.screenshot({ path: '../../.tmp/e2e-screens/02-chat-agent.png' })
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
    await page.getByTestId('chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出').click()
    await expect(page.getByTestId('bubbles')).toBeVisible()
    await expect(page.getByTestId('session-history')).toBeVisible()
    await expect(page.getByTestId('workspace')).toBeVisible()
    const ws = await page.getByTestId('workspace').boundingBox()
    expect(ws!.x + ws!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
    // 群聊助手行带成员名
    await expect(page.locator('.msg-who').filter({ hasText: '小杰' })).toBeVisible()
    await noOverflow(page, 'chat-group')
    await page.screenshot({ path: '../../.tmp/e2e-screens/04-chat-group.png' })
  })

  test('项目资料：手机修改后可重新打开读取', async ({ page }) => {
    await page.getByTestId('chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出').click()
    await page.getByTestId('project-workspace').click()
    await expect(page.getByTestId('project-workspace-screen')).toBeVisible()
    await page.getByTestId('mobile-workspace-goal').fill('完成无声智慧病房系统介绍')
    await page.getByTestId('mobile-workspace-sales-audience').fill('渠道商与集成商')
    await page.getByTestId('mobile-workspace-story-audience').fill('一线医护人员')
    await page.getByTestId('mobile-workspace-outline').fill('系统方案\n病房呼叫\n门诊叫号')
    await page.getByTestId('mobile-workspace-save').click()
    await expect(page.getByTestId('mobile-workspace-result')).toHaveText('已保存到项目资料')
    await page.locator('.project-workspace-screen .btn-nav-back').click()
    await page.getByTestId('project-workspace').click()
    await expect(page.getByTestId('mobile-workspace-goal')).toHaveValue('完成无声智慧病房系统介绍')
    await expect(page.getByTestId('mobile-workspace-outline')).toHaveValue('系统方案\n病房呼叫\n门诊叫号')
    await noOverflow(page, 'project-workspace')
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
    await page.getByTestId('chat-agent-一个名字特别特别长的智能体用来测试顶栏省略号显示').click()
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
    await page.getByTestId('chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出').click()
    await expect(page.getByTestId('bubbles')).toBeVisible()
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
    await page.getByTestId('chat-group-一个很长很长的项目群名字用来测试顶栏按钮不溢出').click()
    await expect(page.getByTestId('bubbles')).toBeVisible()
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
})
