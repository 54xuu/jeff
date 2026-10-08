import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BrowserHandoffManager, publicBrowserHandoff, type BrowserHandoffRecord } from '../src/browser/handoff.js'
import { JeffCore } from '../src/index.js'

describe('BrowserHandoffManager', () => {
  it('persists one exclusive waiting task and survives a restart through its reader', () => {
    let persisted: BrowserHandoffRecord | null = null
    const storage = () => new BrowserHandoffManager(() => persisted, (next) => { persisted = next }, () => 1234)
    const first = storage().begin({
      sessionId: 'private-session', kind: 'private', agentId: 'agent-1', taskLabel: '采集公开资料',
      site: 'example.com', siteUrl: 'https://example.com', reason: 'login',
    })

    expect(first.status).toBe('waiting_user')
    expect(first.requestedAt).toBe(1234)
    expect(storage().current()).toEqual(first)
    expect(() => storage().begin({
      sessionId: 'other-session', kind: 'private', agentId: 'agent-2', taskLabel: '另一项采集',
      site: 'other.example', siteUrl: 'https://other.example', reason: 'other',
    })).toThrow(/另一个任务等待用户接管/)

    expect(storage().markResuming(first.id).status).toBe('resuming')
    expect(storage().markWaiting(first.id, '重试需要重新验证').error).toBe('重试需要重新验证')
    expect(storage().clear('stale-id')?.id).toBe(first.id)
    expect(storage().clear(first.id)?.id).toBe(first.id)
    expect(storage().current()).toBeNull()
  })

  it('does not expose the engine session identifier to desktop or phone UI', () => {
    const record: BrowserHandoffRecord = {
      id: 'bho_test', status: 'waiting_user', sessionId: 'secret-session', kind: 'group', agentId: 'agent-1',
      projectId: 'project-1', threadId: 'thread-1', taskLabel: '项目任务', site: 'example.com',
      siteUrl: 'https://example.com', reason: 'qr', requestedAt: 42,
    }
    const publicRecord = publicBrowserHandoff(record)
    expect(publicRecord).not.toHaveProperty('sessionId')
    expect(publicRecord).toMatchObject({ id: 'bho_test', site: 'example.com', reason: 'qr' })
  })
})

describe('打开浏览器接管的原会话', () => {
  function coreWith(record: BrowserHandoffRecord) {
    const core = Object.create(JeffCore.prototype) as JeffCore
    ;(core as unknown as { browserHandoffs: BrowserHandoffManager }).browserHandoffs = new BrowserHandoffManager(() => record, () => {})
    ;(core as unknown as { bus: EventEmitter }).bus = new EventEmitter()
    return core
  }

  it('激活精确的私聊 session，但返回值不泄漏 session ID', () => {
    const record: BrowserHandoffRecord = {
      id: 'bho_private', status: 'waiting_user', sessionId: 'private-secret-session', kind: 'private', agentId: 'agent-1',
      taskLabel: '采集任务', site: 'example.com', siteUrl: 'https://example.com', reason: 'login', requestedAt: 42,
    }
    const core = coreWith(record)
    const activate = vi.fn()
    ;(core as unknown as { activateSession: typeof activate }).activateSession = activate

    const opened = core.openBrowserHandoffConversation()

    expect(activate).toHaveBeenCalledWith('private', 'agent-1', 'private-secret-session')
    expect(opened).not.toHaveProperty('sessionId')
  })

  it('激活精确的群话题，并通知订阅方刷新', () => {
    const record: BrowserHandoffRecord = {
      id: 'bho_group', status: 'waiting_user', sessionId: 'group-secret-session', kind: 'group', agentId: 'agent-1',
      projectId: 'project-1', threadId: 'thread-original', taskLabel: '群任务', site: 'example.com',
      siteUrl: 'https://example.com', reason: 'qr', requestedAt: 42,
    }
    const core = coreWith(record)
    const activate = vi.fn()
    ;(core as unknown as { activateGroupThread: typeof activate }).activateGroupThread = activate
    const updated = vi.fn()
    core.bus.on('group-updated', updated)

    const opened = core.openBrowserHandoffConversation()

    expect(activate).toHaveBeenCalledWith('project-1', 'thread-original')
    expect(updated).toHaveBeenCalledWith({ projectId: 'project-1', threadId: 'thread-original' })
    expect(opened).not.toHaveProperty('sessionId')
  })
})
