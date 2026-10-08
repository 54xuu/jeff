import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, type BrowserHandoffInfo } from '@jeff/core'

const mocks = vi.hoisted(() => ({
  listeners: new Set<(event: { what: string; p?: unknown }) => void>(),
  openHandoff: null as unknown,
  invoke: vi.fn(async (channel: string) => {
    if (channel === 'browser:handoffGet') return null
    if (channel === 'browser:handoffOpen') return mocks.openHandoff
    if (channel === 'browser:handoffCancel') return { ok: true }
    if (channel === 'group:history') return { threadId: 'thread-1', messages: [] }
    if (channel === 'context:preview') return null
    return []
  }),
}))

vi.mock('./session', () => ({
  PhoneLink: class {
    desktops = new Map()
    activeId = ''
    async init() {}
    async pullNative() {}
    async takeNote() { return {} }
    onPush(listener: (event: { what: string; p?: unknown }) => void) {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
    invoke = mocks.invoke
  },
  Native: { unlock: async () => ({ skipped: true }), notify: async () => {}, addListener: async () => ({ remove: async () => {} }) },
  mergeStream: () => ({ ok: false }),
  shrinkImage: async (value: string) => value,
}))

import { App } from './App'

const roots: Root[] = []
let handoff: BrowserHandoffInfo

function mount(node: ReactNode): HTMLDivElement {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  roots.push(root)
  act(() => root.render(node))
  return element
}

beforeEach(() => {
  mocks.listeners.clear()
  mocks.invoke.mockClear()
  handoff = {
    id: 'bho_test', status: 'waiting_user', kind: 'group', agentId: 'agt_test', projectId: 'prj_test', threadId: 'thread-1',
    taskLabel: '采集测试站（JEF-7）', site: 'login.example.test', siteUrl: 'https://login.example.test', reason: 'qr', requestedAt: 1234,
  }
  mocks.openHandoff = handoff
  vi.stubGlobal('confirm', vi.fn(() => true))
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('Android browser handoff status', () => {
  it('shows the website and task, opens the original group, and can cancel the wait', async () => {
    const element = mount(<App />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => {
      for (const listener of mocks.listeners) listener({ what: 'browser-handoff-updated', p: handoff })
    })
    expect(element.querySelector('[data-testid="browser-handoff"]')?.textContent).toContain('login.example.test')
    expect(element.querySelector('[data-testid="browser-handoff"]')?.textContent).toContain('采集测试站（JEF-7）')
    expect(element.querySelector('[data-testid="browser-handoff"]')?.textContent).toContain('手机仅显示状态')

    await act(async () => { element.querySelector<HTMLButtonElement>('[data-testid="browser-handoff-open"]')?.click(); await Promise.resolve() })
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.browserHandoffOpen)
    expect(element.querySelector('[data-testid="chat"]')).toBeTruthy()
    expect(element.querySelector('.wechat-chat-title')?.textContent).toContain('采集测试站（JEF-7）')

    await act(async () => { element.querySelector<HTMLButtonElement>('[data-testid="browser-handoff-cancel"]')?.click(); await Promise.resolve() })
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.browserHandoffCancel)
    expect(element.querySelector('[data-testid="browser-handoff"]')).toBeNull()
  })
})
