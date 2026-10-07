import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from './Markdown'

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

describe('Markdown', () => {
  it('旧 WebView 不支持 Unicode 高亮时仍保留真实回复的中文表格、链接和 Python 代码', () => {
    const NativeRegExp = RegExp
    class LegacyRegExp extends NativeRegExp {
      constructor(pattern: string | RegExp, flags?: string) {
        if (pattern === '\\p{XID_Start}') throw new SyntaxError('Unicode properties unsupported')
        super(pattern, flags)
      }
    }
    vi.stubGlobal('RegExp', LegacyRegExp)
    try {
      const el = mount(<Markdown text={'JEFF_CODEX_OK\n\n| 项目 | 内容 |\n| --- | --- |\n| 状态 | 通过 |\n\n[说明](https://example.com)\n\n```python\nprint("JEFF_CODEX_OK")\n```'} />)
      expect(el.querySelector('table td')?.textContent).toBe('状态')
      expect(el.querySelector('a')?.href).toBe('https://example.com/')
      expect(el.querySelector('.md-code code')?.textContent).toContain('print("JEFF_CODEX_OK")')
      expect(el.querySelector('.md-code .hljs-keyword')).toBeNull()
      expect(el.querySelector('.md-copy-btn')?.textContent).toBe('复制')
    } finally { vi.unstubAllGlobals() }
  })
  it('渲染标题、列表、表格和代码块', () => {
    const el = mount(
      <Markdown
        text={'# 巡检\n\n- 体温正常\n\n| 项目 | 结果 |\n| --- | --- |\n| 血氧 | 98% |\n\n```ts\nconst ok = true\n```\n'}
      />,
    )
    expect(el.querySelector('h1')?.textContent).toBe('巡检')
    expect(el.querySelector('li')?.textContent).toBe('体温正常')
    expect(el.querySelector('table td')?.textContent).toBe('血氧')
    expect(el.querySelector('.md-code code')?.textContent).toContain('const ok = true')
    expect(el.querySelector('.md-code-bar')?.textContent).toContain('ts')
  })

  it('链接可点且不执行 javascript 协议', () => {
    const el = mount(<Markdown text={'看 [说明](https://example.com/a) 和 [坏](javascript:alert(1))'} />)
    const links = [...el.querySelectorAll('a')]
    expect(links[0]?.getAttribute('href')).toBe('https://example.com/a')
    expect(links[0]?.getAttribute('target')).toBe('_blank')
    expect(links.some((a) => (a.getAttribute('href') || '').startsWith('javascript:'))).toBe(false)
  })

  it('流式输出时 mermaid 先按代码块展示', () => {
    const el = mount(<Markdown live text={'```mermaid\ngraph TD\n  A-->B\n```\n'} />)
    expect(el.querySelector('[data-testid="md-mermaid"]')).toBeNull()
    expect(el.querySelector('.md-code code')?.textContent).toContain('graph TD')
  })

  it('完成后露出 mermaid 块，源码可以切出来', () => {
    const el = mount(<Markdown text={'```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```\n'} />)
    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="md-mermaid-toggle-src"]')
    expect(toggle).toBeTruthy()
    act(() => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(el.querySelector('.md-mermaid-src')?.textContent).toContain('A[开始]')
  })
})
