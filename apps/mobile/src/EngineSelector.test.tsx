import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import EngineSelector from './EngineSelector'
import { IPC, type AgentInfo } from '@jeff/core'
import type { PhoneLink } from './session'

it('手机可为每个 Agent 选择已检测到的引擎并经电脑 IPC 保存', async () => {
  const agents = [{ id: 'a', name: '开发', execution_engine: 'opencode', thinking: 'high' }, { id: 'b', name: '医护助手', execution_engine: 'opencode' }] as AgentInfo[]
  const invoke = vi.fn(async (channel, args) => channel === IPC.enginesList ? [{ id: 'opencode', available: true }, { id: 'claude', version: '2.1', available: true }] : channel === IPC.enginesModels ? { models: [] } : { ...agents[0], ...args })
  const save = vi.fn(); const close = vi.fn()
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el)
  try {
    await act(async () => root.render(<EngineSelector phone={{ invoke } as unknown as PhoneLink} agents={agents} onSave={save} onClose={close} />))
    const select = el.querySelector('[data-testid=mobile-agent-engine]') as HTMLSelectElement
    await act(async () => { select.value = 'claude'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    const input = el.querySelector('input') as HTMLInputElement
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sonnet'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => (el.querySelector('button') as HTMLButtonElement).click())
    expect(invoke).toHaveBeenCalledWith(IPC.agentsUpsert, expect.objectContaining({ id: 'a', execution_engine: 'claude', engine_model: 'sonnet', thinking: '' }))
    expect(save).toHaveBeenCalled(); expect(close).toHaveBeenCalled()
    const agentSelect = el.querySelector('[aria-label=智能体]') as HTMLSelectElement
    await act(async () => { agentSelect.value = 'b'; agentSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    expect([...select.options].some(option => option.value === 'claude' && !option.disabled)).toBe(true)
  } finally { act(() => root.unmount()); el.remove() }
})
