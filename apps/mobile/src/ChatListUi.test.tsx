import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeChatAvatar, WeChatItemRow } from './App'

const roots: Root[] = []

function mount(node: ReactNode): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  roots.push(root)
  act(() => {
    root.render(node)
  })
  return el
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.replaceChildren()
})

describe('WeChatAvatar', () => {
  it('正确展示 emoji 图标并带有 emoji-avatar 类', () => {
    const el = mount(<WeChatAvatar kind="agent" name="小杰" emoji="🤖" size={48} />)
    const emojiEl = el.querySelector('.wechat-avatar-emoji')
    expect(emojiEl).toBeTruthy()
    expect(emojiEl?.textContent).toBe('🤖')
    expect(el.querySelector('.wechat-avatar')?.classList.contains('emoji-avatar')).toBe(true)
  })

  it('群图标正确展示群 emoji 并带有 group-avatar 类', () => {
    const el = mount(<WeChatAvatar kind="group" name="研发群" emoji="👥" size={48} />)
    const emojiEl = el.querySelector('.wechat-avatar-emoji')
    expect(emojiEl).toBeTruthy()
    expect(emojiEl?.textContent).toBe('👥')
    expect(el.querySelector('.wechat-avatar')?.classList.contains('group-avatar')).toBe(true)
  })

  it('无 emoji 时智能体回退至首字母字符，我回退至 svg', () => {
    const agentEl = mount(<WeChatAvatar kind="agent" name="Bob" />)
    expect(agentEl.querySelector('.wechat-avatar-char')?.textContent).toBe('B')

    const userEl = mount(<WeChatAvatar kind="user" name="我" />)
    expect(userEl.querySelector('svg')).toBeTruthy()
  })

  it('busy 为 true 时展示脉冲小绿点', () => {
    const el = mount(<WeChatAvatar kind="agent" name="小杰" emoji="🤖" busy={true} />)
    expect(el.querySelector('.wechat-avatar-busy')).toBeTruthy()
  })
})

describe('WeChatItemRow', () => {
  it('正确展示管家标签、置顶标签、群标签以及时间', () => {
    const onClick = vi.fn()
    const onLongPress = vi.fn()
    const el = mount(
      <WeChatItemRow
        title="小杰"
        sub="内置管家"
        time={1700000000000}
        avatar="🤖"
        kind="agent"
        isBuiltin={true}
        pinned={true}
        busy={true}
        onClick={onClick}
        onLongPress={onLongPress}
      />
    )

    expect(el.querySelector('.wechat-item-title')?.textContent).toBe('小杰')
    expect(el.querySelector('.wechat-tag-blue')?.textContent).toBe('管家')
    expect(el.querySelector('.wechat-tag-green')?.textContent).toBe('置顶')
    expect(el.querySelector('.wechat-item-sub')?.textContent).toBe('内置管家')
    expect(el.querySelector('.wechat-avatar-emoji')?.textContent).toBe('🤖')
    expect(el.querySelector('.wechat-avatar-busy')).toBeTruthy()

    const btn = el.querySelector('button')
    act(() => {
      btn?.click()
    })
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('群条目正确渲染群标签与群图标', () => {
    const el = mount(
      <WeChatItemRow
        title="核心项目组"
        sub="3 个成员 · 群主统筹"
        avatar="👥"
        kind="group"
        isGroup={true}
        onClick={vi.fn()}
        onLongPress={vi.fn()}
      />
    )
    expect(el.querySelector('.wechat-item-title')?.textContent).toBe('核心项目组')
    expect(el.querySelector('.wechat-tag-gray')?.textContent).toBe('群')
    expect(el.querySelector('.wechat-avatar-emoji')?.textContent).toBe('👥')
  })
})
