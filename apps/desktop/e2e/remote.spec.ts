import { expect, test, chromium } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import WebSocket from 'ws'
import { XIAOJIE_ID } from '../../../packages/core/src/ipc/contract.js'
import { parseProjectWorkspaceState } from '../../../packages/core/src/project/workspace.js'
import {
  RelayLink,
  b64ToBytes,
  decodePairingQr,
  randomEd25519,
  randomX25519,
  safetyCode,
  type LinkEvent,
} from '../../../packages/core/src/remote/index.js'
import { startRelay, type RunningRelay } from '../../../apps/relay/src/server.js'
import { launchJeff, loadE2eEnv, REPO_ROOT } from './helpers/launch.js'

function phoneId(pub: Uint8Array): string {
  return Buffer.from(pub).toString('base64url').slice(0, 22)
}

async function connectPhone(url: string) {
  const sign = randomEd25519()
  const box = randomX25519()
  const events: LinkEvent[] = []
  const ws = new WebSocket(url)
  const link = new RelayLink({
    role: 'app',
    id: phoneId(sign.publicKey),
    signSecret: sign.secretKey,
    x25519Secret: box.secretKey,
    sendRaw: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text)
    },
    onEvent: (ev) => events.push(ev),
  })
  ws.on('message', (data) => link.handleRaw(data.toString()))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  await waitEvent(events, 'ready')
  return { link, events, close: () => ws.close(), box }
}

function collectTree(pid: number): number[] {
  const out: number[] = []
  let raw = ''
  try {
    raw = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
  } catch {
    return out
  }
  for (const part of raw.trim().split(/\s+/)) {
    const child = Number(part)
    if (!child) continue
    out.push(child, ...collectTree(child))
  }
  return out
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* 已经退出 */
  }
}

function waitEvent(events: LinkEvent[], type: string): Promise<LinkEvent> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      const found = events.find((e) => e.t === type)
      if (found) return resolve(found)
      if (Date.now() - start > 8000) return reject(new Error(`没等到 ${type}`))
      setTimeout(tick, 20)
    }
    tick()
  })
}

test('假手机经本地中转站绑定，并让桌面切到新项目群', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-remote-e2e-'))
  const relay: RunningRelay = await startRelay({ dataFile: path.join(dir, 'relay.db'), port: 0 })
  const home = path.join(REPO_ROOT, '.tmp/jeff-remote-e2e')
  fs.rmSync(home, { recursive: true, force: true })
  let launched: Awaited<ReturnType<typeof launchJeff>> | undefined
  let phone: Awaited<ReturnType<typeof connectPhone>> | undefined
  try {
    launched = await launchJeff({ home, envExtra: { JEFF_RELAY_URL: relay.url, JEFF_RELAY_CERT: '' } })
    phone = await connectPhone(relay.url)
    const page = launched.page
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-nav-remote').click()
    await expect(page.getByTestId('remote-connection')).toHaveText('中转站已连接', { timeout: 15000 })
    await expect(page.getByTestId('remote-status-card')).toBeVisible()
    await expect(page.getByTestId('remote-reconnect')).toBeEnabled()
    await page.getByTestId('remote-pair').click()
    const payload = await page.getByTestId('remote-qr-payload').innerText()
    const qr = decodePairingQr(payload)
    expect(qr.relay).toBe(relay.url)
    phone.link.setPeerKey(qr.desktopId, qr.desktopX25519Pub)
    phone.link.pairRequest(qr.token, '验收手机')
    await expect(page.getByTestId('remote-pair-dialog')).toBeVisible()
    const shown = (await page.getByTestId('remote-safety').innerText()).trim()
    expect(shown).toBe(safetyCode(b64ToBytes(qr.desktopX25519Pub), b64ToBytes(phone.link.x25519Pub)))
    await page.getByTestId('remote-pair-accept').click()
    await waitEvent(phone.events, 'pair-result')
    await phone.link.hello(qr.desktopId)
    await expect(page.getByTestId('remote-bound')).toContainText('验收手机')

    const agents = await phone.link.request(qr.desktopId, 'agents:list')
    expect(JSON.stringify(agents)).toContain('小杰')
    const dirs = (await phone.link.request(qr.desktopId, 'fs:listDirs')) as { entries: Array<{ path: string }> }
    expect(dirs.entries.some((e) => e.path === '/' || e.path.endsWith('\\'))).toBe(true)
    await expect(phone.link.request(qr.desktopId, 'dialog:pickDir')).rejects.toThrow(/fs:listDirs/)
    const made = path.join(dir, 'from-phone')
    await phone.link.request(qr.desktopId, 'fs:mkdir', { dir: made })
    expect(fs.statSync(made).isDirectory()).toBe(true)

    const project = (await phone.link.request(qr.desktopId, 'project:save', {
      title: '遥控器验收',
      leader_agent_id: XIAOJIE_ID,
      memberAgentIds: [XIAOJIE_ID],
      workspace_dir: dir,
    })) as { id: string; workspace_dir: string }
    expect(project.workspace_dir).toBe(dir)
    await phone.link.request(qr.desktopId, 'group:threadNew', { projectId: project.id, title: '来自手机' })
    await expect(page.getByTestId('chat-window').or(page.locator('.chat-header-name'))).toContainText('遥控器验收', { timeout: 15000 })

    // 手机通过真实密文中转调用桌面宣传状态机；方向审核、制作任务和成品版本都由主进程落库。
    const created = await phone.link.request(qr.desktopId, 'project:campaign', {
      projectId: project.id, action: 'create', kind: 'feature_video', title: '腕表病房呼叫',
      feature: '腕表病房呼叫', story: '护士通过腕表接收病房呼叫', channels: ['渠道群'],
      sellingPoints: ['减少漏接'], materialsNeeded: [],
    }) as { workspace_state: string }
    const campaign = parseProjectWorkspaceState(created.workspace_state).campaigns[0]!
    expect(campaign.approvedRevision).toBeNull()
    const approved = await phone.link.request(qr.desktopId, 'project:campaign', {
      projectId: project.id, action: 'review_direction', campaignId: campaign.id, decision: 'approve',
    }) as { workspace_state: string }
    expect(parseProjectWorkspaceState(approved.workspace_state).campaigns[0]).toMatchObject({ approvedRevision: 1, directionReviews: [{ decision: 'approve', revision: 1 }] })
    const taskLinked = await phone.link.request(qr.desktopId, 'project:campaign', {
      projectId: project.id, action: 'create_task', campaignId: campaign.id,
    }) as { workspace_state: string }
    const linked = parseProjectWorkspaceState(taskLinked.workspace_state).campaigns[0]!
    expect(linked.productionTaskId).toMatch(/^task_/)
    fs.writeFileSync(path.join(dir, 'campaign-v1.mp4'), Buffer.from('e2e media placeholder'))
    const submitted = await phone.link.request(qr.desktopId, 'project:campaign', {
      projectId: project.id, action: 'submit_delivery', campaignId: campaign.id, path: 'campaign-v1.mp4',
    }) as { workspace_state: string }
    const delivery = parseProjectWorkspaceState(submitted.workspace_state).campaigns[0]!.deliveries[0]!
    expect(delivery).toMatchObject({ status: 'in_review', path: 'campaign-v1.mp4', revision: 1 })
    const accepted = await phone.link.request(qr.desktopId, 'project:campaign', {
      projectId: project.id, action: 'review_delivery', campaignId: campaign.id, deliveryId: delivery.id, decision: 'accepted',
    }) as { workspace_state: string }
    expect(parseProjectWorkspaceState(accepted.workspace_state).campaigns[0]!.deliveries[0]).toMatchObject({ status: 'accepted' })

    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-nav-remote').click()
    await expect(page.getByTestId('remote-bound')).toContainText('验收手机')
    await expect(page.getByTestId('remote-login')).not.toBeChecked()
    await expect(page.getByTestId('remote-sleep')).toBeChecked()
    await page.getByTestId('remote-login').click()
    await expect(page.getByTestId('remote-login')).toBeChecked()
    await page.getByTestId('remote-sleep').click()
    await expect(page.getByTestId('remote-sleep')).not.toBeChecked()
    await page.getByTestId('remote-unbind').click()
    await expect(page.getByTestId('remote-bound')).toHaveText('还没有绑定手机')
  } finally {
    phone?.close()
    const pid = launched?.app.process()?.pid
    const victims = pid ? collectTree(pid) : []
    if (launched) {
      await Promise.race([
        launched.app.close(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ])
    }
    for (const child of victims) killPid(child)
    if (pid) killPid(pid)
    await relay.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('手机页面在 390×844 里完成绑定并列出会话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-remote-ui-'))
  const relay = await startRelay({ dataFile: path.join(dir, 'relay.db'), port: 0 })
  const sign = randomEd25519()
  const box = randomX25519()
  const events: LinkEvent[] = []
  const calls: string[] = []
  let agentLists = 0
  const ws = new WebSocket(relay.url)
  let ws2: WebSocket | undefined
  const desk = new RelayLink({
    role: 'desktop',
    id: phoneId(sign.publicKey),
    signSecret: sign.secretKey,
    x25519Secret: box.secretKey,
    sendRaw: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text)
    },
    onEvent: (ev) => {
      events.push(ev)
      if (ev.t === 'pair-ask') desk.setPeerKey(ev.appId, ev.x25519Pub)
      if (ev.t === 'req') {
        if (ev.ch === 'agents:list') {
          agentLists += 1
          if (agentLists > 1) desk.respond(ev.from, ev.id, false, undefined, '电脑离线')
          else desk.respond(ev.from, ev.id, true, [{ id: 'agt_xiaojie', name: '小杰', avatar: '🤖', description: '管家', instructions: '', model_provider: '', model_id: '', thinking: '', category: '', builtin: true, archived: false }])
        } else if (ev.ch === 'projects:list') {
          desk.respond(ev.from, ev.id, true, [{ id: 'p1', title: '验收群', description: '', icon: '', status: 'active', leader_agent_id: 'agt_xiaojie', workspace_dir: '' }])
        } else if (ev.ch === 'chat:history') {
          desk.respond(ev.from, ev.id, true, [
            {
              id: 'm1',
              role: 'user',
              text: '看这张图',
              time: Date.now() - 60000,
              images: [{ mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOklEQVR42u3OMQ0AAAgDsEnix78ucEE4mlRAM12vREhISEhISEhISEhISEhISEhISEhISEhISEjozgL2L7q1TMsYewAAAABJRU5ErkJggg==' }],
            },
            {
              id: 'm2',
              role: 'assistant',
              text: '收到，这是一张测试图片，已完成分析。',
              time: Date.now(),
              reasoning: ['正在分析图片特征...', '检测到这是一个 48x48 纯色测试图像。'],
              tools: [{ tool: 'jeff_browser_snapshot', status: 'done', output: 'ok' }],
            },
          ])
        } else if (ev.ch === 'sessions:list') desk.respond(ev.from, ev.id, true, { sessions: [{ id: 's1', title: '当前', active: true }] })
        else if (ev.ch === 'chat:stop' || ev.ch === 'chat:new' || ev.ch === 'session:activate') {
          calls.push(ev.ch)
          desk.respond(ev.from, ev.id, true, { ok: true })
        } else if (ev.ch === 'chat:send' || ev.ch === 'group:send') {
          const body = (ev.p || {}) as { images?: Array<{ dataUrl?: string }> }
          const url = body.images?.[0]?.dataUrl || ''
          if (url) calls.push(url)
          desk.respond(ev.from, ev.id, true, { ok: true })
        } else if (ev.ch === 'fs:listDirs') {
          desk.respond(ev.from, ev.id, true, { dir: '/tmp/ws', parent: '/tmp', entries: [{ name: 'notes', path: '/tmp/ws/notes' }] })
        } else if (ev.ch === 'fs:listFiles') {
          const body = (ev.p || {}) as { dir?: string }
          desk.respond(ev.from, ev.id, true, { dir: body.dir || '/tmp/ws', exists: true, nodes: [] })
        } else if (ev.ch === 'project:save') {
          calls.push(ev.ch)
          const body = (ev.p || {}) as { workspace_dir?: string }
          calls.push(body.workspace_dir || '')
          desk.respond(ev.from, ev.id, true, { id: 'p1', title: '验收群', workspace_dir: body.workspace_dir })
        } else desk.respond(ev.from, ev.id, false, undefined, '这个验收里没实现')
      }
    },
  })
  ws.on('message', (data) => desk.handleRaw(data.toString()))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  await waitEvent(events, 'ready')
  const tokenWait = waitEvent(events, 'pair-token')
  desk.pairOpen('家里的电脑')
  const tokenEv = await tokenWait
  if (tokenEv.t !== 'pair-token') throw new Error('配对码类型不对')
  const { encodePairingQr } = await import('../../../packages/core/src/remote/index.js')
  const payload = encodePairingQr({
    relay: relay.url,
    certSha256: 'TEST',
    desktopId: desk.id,
    desktopName: '家里的电脑',
    desktopX25519Pub: desk.x25519Pub,
    token: tokenEv.token,
  })
  const confirm = (async () => {
    const ask = await waitEvent(events, 'pair-ask')
    if (ask.t === 'pair-ask') desk.pairConfirm(ask.token, true)
  })()

  const mobileRoot = path.join(REPO_ROOT, 'apps/mobile')
  const server = await createServer({
    configFile: path.join(mobileRoot, 'vite.config.ts'),
    root: mobileRoot,
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const addr = server.httpServer?.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' })
  try {
    await page.goto(`http://127.0.0.1:${port}`)
    await page.getByTestId('pair-paste').fill(payload)
    await page.getByTestId('pair-go').click()
    await confirm
    await expect(page.getByTestId('msg-list')).toContainText('小杰', { timeout: 15000 })
    await page.screenshot({ path: path.join(REPO_ROOT, '.tmp/remote-list-light.png'), fullPage: true })
    await page.getByTestId('msg-list').getByRole('button', { name: /小杰/ }).click()
    await expect(page.getByTestId('bubbles')).toContainText('看这张图')
    await expect(page.getByTestId('bubbles').locator('img')).toHaveAttribute('src', /^data:image\/png/)
    await expect(page.getByText('思考过程')).toBeVisible()
    await expect(page.getByText(/工具调用/)).toBeVisible()
    await page.screenshot({ path: path.join(REPO_ROOT, '.tmp/remote-chat-light.png'), fullPage: true })
    await page.getByTestId('plus').click()
    const png = path.join(dir, 'shot.png')
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOklEQVR42u3OMQ0AAAgDsEnix78ucEE4mlRAM12vREhISEhISEhISEhISEhISEhISEhISEhISEjozgL2L7q1TMsYewAAAABJRU5ErkJggg==', 'base64'))
    await page.getByTestId('file-image').setInputFiles(png)
    await expect.poll(() => calls.some((item) => item.startsWith('data:image/jpeg'))).toBe(true)
    const ask = events.find((e) => e.t === 'pair-ask')
    if (!ask || ask.t !== 'pair-ask') throw new Error('没有配对请求')
    desk.sendPlain(ask.appId, {
      t: 'push',
      what: 'chat-stream',
      p: { kind: 'private', agentId: 'agt_xiaojie', messageId: 'm-stream', reset: true, textDelta: '正在写', textLen: 3, reasoningDelta: '', reasoningLen: 0, done: false },
    })
    await expect(page.getByTestId('stream')).toContainText('正在写')
    await page.getByTestId('chat-stop').click()
    await expect.poll(() => calls.includes('chat:stop')).toBe(true)
    await page.getByTestId('plus').click()
    const activated = calls.filter((c) => c === 'session:activate').length
    await page.getByRole('button', { name: '当前' }).click()
    await expect.poll(() => calls.filter((c) => c === 'session:activate').length).toBeGreaterThan(activated)
    await page.getByTestId('plus').click()
    await page.getByTestId('new-session').click()
    await expect.poll(() => calls.includes('chat:new')).toBe(true)
    await page.getByTestId('chat-back').click()
    await page.getByTestId('msg-list').getByRole('button', { name: /验收群/ }).click()
    await page.getByTestId('workspace').click()
    await page.getByTestId('workspace-change-dir').click()
    await expect(page.getByTestId('dir-picker')).toContainText('notes')
    await page.getByTestId('use-notes').click()
    await expect.poll(() => calls.includes('/tmp/ws/notes')).toBe(true)
    await expect(page.getByTestId('workspace-files')).toBeVisible()
    await page.getByTestId('workspace-files').locator('.bar .btn-nav-back').click()
    await page.getByTestId('chat-back').click()
    await page.getByTestId('tab-me').click()
    await page.getByRole('button', { name: /家里的电脑/ }).click()
    await expect(page.getByText(/电脑离线/)).toBeVisible()
    await expect(page.getByTestId('msg-list')).toContainText('小杰')
    await page.getByTestId('tab-me').click()
    await page.getByTestId('pair-another').click()
    await expect(page.getByTestId('pair-paste')).toBeVisible()
    const sign2 = randomEd25519()
    const box2 = randomX25519()
    const events2: LinkEvent[] = []
    ws2 = new WebSocket(relay.url)
    const desk2 = new RelayLink({
      role: 'desktop',
      id: phoneId(sign2.publicKey),
      signSecret: sign2.secretKey,
      x25519Secret: box2.secretKey,
      sendRaw: (text) => {
        if (ws2 && ws2.readyState === WebSocket.OPEN) ws2.send(text)
      },
      onEvent: (ev) => {
        events2.push(ev)
        if (ev.t === 'pair-ask') {
          desk2.setPeerKey(ev.appId, ev.x25519Pub)
          desk2.pairConfirm(ev.token, true)
        }
        if (ev.t === 'req') {
          if (ev.ch === 'agents:list') {
            desk2.respond(ev.from, ev.id, true, [{ id: 'agt_office', name: '办公室小杰', avatar: '🤖', description: '', instructions: '', model_provider: '', model_id: '', thinking: '', category: '', builtin: false, archived: false }])
          } else if (ev.ch === 'projects:list') desk2.respond(ev.from, ev.id, true, [])
          else desk2.respond(ev.from, ev.id, true, { ok: true })
        }
      },
    })
    ws2.on('message', (data) => desk2.handleRaw(data.toString()))
    await new Promise<void>((resolve, reject) => {
      ws2!.once('open', () => resolve())
      ws2!.once('error', reject)
    })
    await waitEvent(events2, 'ready')
    const token2 = waitEvent(events2, 'pair-token')
    desk2.pairOpen('办公室')
    const tokenEv2 = await token2
    if (tokenEv2.t !== 'pair-token') throw new Error('第二台配对码类型不对')
    const payload2 = encodePairingQr({
      relay: relay.url,
      certSha256: 'TEST',
      desktopId: desk2.id,
      desktopName: '办公室',
      desktopX25519Pub: desk2.x25519Pub,
      token: tokenEv2.token,
    })
    await page.getByTestId('pair-paste').fill(payload2)
    await page.getByTestId('pair-go').click()
    await expect(page.getByTestId('computer-switch')).toContainText('办公室', { timeout: 15000 })
    await expect(page.getByTestId('msg-list')).toContainText('办公室小杰')
    await page.getByTestId('tab-me').click()
    await expect(page.getByTestId('me')).toContainText('家里的电脑')
    await expect(page.getByTestId('me')).toContainText('办公室')
    await page.getByRole('button', { name: /家里的电脑/ }).click()
    await expect(page.getByTestId('computer-switch')).toContainText('家里的电脑')
    await page.getByTestId('tab-me').click()
    const shot = path.join(REPO_ROOT, '.tmp/remote-app-light.png')
    await page.screenshot({ path: shot, fullPage: true })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: path.join(REPO_ROOT, '.tmp/remote-app-dark.png'), fullPage: true })
  } finally {
    await browser.close()
    await server.close()
    ws.close()
    ws2?.close()
    await relay.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('假手机让小杰回复，桌面气泡和历史一致', async () => {
  const env = loadE2eEnv()
  test.skip(!env.SILICONFLOW_API_KEY, '没有硅基流动凭据')
  test.setTimeout(300_000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-remote-live-'))
  const relay: RunningRelay = await startRelay({ dataFile: path.join(dir, 'relay.db'), port: 0 })
  const home = path.join(REPO_ROOT, '.tmp/jeff-remote-live')
  fs.rmSync(home, { recursive: true, force: true })
  let launched: Awaited<ReturnType<typeof launchJeff>> | undefined
  let phone: Awaited<ReturnType<typeof connectPhone>> | undefined
  try {
    launched = await launchJeff({
      home,
      seed: {
        apiKey: env.SILICONFLOW_API_KEY,
        baseURL: env.SILICONFLOW_BASE_URL,
        modelId: env.SILICONFLOW_MODEL,
      },
      envExtra: { JEFF_RELAY_URL: relay.url, JEFF_RELAY_CERT: '' },
    })
    phone = await connectPhone(relay.url)
    const page = launched.page
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-nav-remote').click()
    await expect(page.getByTestId('remote-connection')).toHaveText('中转站已连接', { timeout: 15000 })
    await expect(page.getByTestId('remote-status-card')).toBeVisible()
    await page.getByTestId('remote-pair').click()
    const qr = decodePairingQr(await page.getByTestId('remote-qr-payload').innerText())
    phone.link.setPeerKey(qr.desktopId, qr.desktopX25519Pub)
    phone.link.pairRequest(qr.token, '验收手机')
    await expect(page.getByTestId('remote-pair-dialog')).toBeVisible()
    await page.getByTestId('remote-pair-accept').click()
    await waitEvent(phone.events, 'pair-result')
    await phone.link.hello(qr.desktopId)

    await phone.link.request(qr.desktopId, 'chat:new', { agentId: XIAOJIE_ID })
    await expect(page.locator('.chat-header-name')).toContainText('小杰', { timeout: 15000 })
    const sent = '远程验收：只回复两个字收到，不要调用工具'
    await phone.link.request(qr.desktopId, 'chat:send', { agentId: XIAOJIE_ID, text: sent })
    const history = (await phone.link.request(qr.desktopId, 'chat:history', { agentId: XIAOJIE_ID })) as Array<{ role: string; text: string }>
    expect(history.some((m) => m.role === 'user' && m.text.includes('远程验收'))).toBe(true)
    const assistant = [...history].reverse().find((m) => m.role === 'assistant' && m.text.trim())
    expect(assistant?.text.trim().length).toBeGreaterThan(0)
    await expect(page.locator('.bubble.assistant').last()).toContainText(assistant!.text.trim().slice(0, 8))
  } finally {
    phone?.close()
    const pid = launched?.app.process()?.pid
    const victims = pid ? collectTree(pid) : []
    if (launched) {
      await Promise.race([launched.app.close(), new Promise((resolve) => setTimeout(resolve, 3000))])
    }
    for (const child of victims) killPid(child)
    if (pid) killPid(pid)
    await relay.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
