import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import MemorySettings from './MemorySettings'
import { IPC } from '@jeff/core'
import type { PhoneLink } from './session'

it('搜索大量范围并保存到选中的电脑记忆，切换前保护未保存内容', async () => {
  const invoke = vi.fn(async (channel: string) => channel === IPC.memoryScopes ? Array.from({ length: 50 }, (_, i) => ({ kind: 'agent', id: `a${i}`, label: `智能体 ${i}`, file: 'private/MEMORY.md' })) : channel === IPC.memoryGet ? { content: '[私有] 验收内容' } : { ok: true })
  const close = vi.fn(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el)
  const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  try {
    await act(async () => root.render(<MemorySettings phone={{ invoke } as unknown as PhoneLink} onClose={close} />))
    await type(el.querySelector('input')!, '智能体 49')
    expect(el.querySelectorAll('.mobile-memory-scopes button')).toHaveLength(1)
    await act(async () => (el.querySelector('.mobile-memory-scopes button') as HTMLButtonElement).click())
    await type(el.querySelector('textarea')!, '[私有] 修改后的验收内容')
    await act(async () => (el.querySelector('button:last-child') as HTMLButtonElement).click())
    expect(close).not.toHaveBeenCalled()
    await act(async () => [...el.querySelectorAll('button')].find((button) => button.textContent === '保存修改')!.click())
    expect(invoke).toHaveBeenCalledWith(IPC.memorySave, { kind: 'agent', id: 'a49', content: '[私有] 修改后的验收内容' })
    expect(el.textContent).toContain('已保存')
  } finally { act(() => root.unmount()); el.remove(); confirm.mockRestore() }
})
