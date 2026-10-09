import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type SettingsSection } from '../store'

interface PaletteCmd {
  key: string
  group: string
  label: string
  hint?: string
  run: () => void
}

const SETTINGS_SECTIONS: Array<[SettingsSection, string]> = [
  ['mcp', 'MCP 连接器'],
  ['memory', '记忆'],
  ['engine', '引擎服务'],
  ['engine', '模型供应商（OpenCode Jeff）'],
  ['sync', '同步与备份'],
  ['siyuan', '思源知识库'],
  ['notification', '通知'],
  ['appearance', '外观'],
  ['remote', '远程控制'],
  ['secrets', '密码'],
  ['about', '关于'],
]

/**
 * 全局快速跳转指令盘（Ctrl/Cmd+K）：模糊检索智能体、项目群、设置项与各功能页，
 * 方向键选择、回车执行、Esc 关闭。挂载在 App 根部，任何页签下都能唤起。
 */
export default function CommandPalette(): React.JSX.Element | null {
  const agents = useStore((s) => s.agents)
  const projects = useStore((s) => s.projects)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
        setQ('')
        setIdx(0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    // Esc 关闭挂 document 级：input 的 rAF 聚焦偶发慢于按键，不能只靠输入框的 onKeyDown
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onEsc)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const cmds = useMemo<PaletteCmd[]>(() => {
    const out: PaletteCmd[] = []
    for (const a of agents) {
      out.push({
        key: `agent:${a.id}`,
        group: '智能体',
        label: a.name,
        hint: a.description || (a.builtin ? '内置管家' : undefined),
        run: () => {
          useStore.getState().setTab('chats')
          useStore.getState().setActive({ kind: 'agent', id: a.id })
        },
      })
    }
    for (const p of projects) {
      out.push({
        key: `group:${p.id}`,
        group: '项目群',
        label: p.title,
        hint: p.description || undefined,
        run: () => {
          useStore.getState().setTab('chats')
          useStore.getState().setActive({ kind: 'group', id: p.id })
        },
      })
    }
    out.push({
      key: 'page:contacts',
      group: '页面',
      label: '通讯录（智能体管理）',
      run: () => useStore.getState().setTab('contacts'),
    })
    out.push({
      key: 'page:schedules',
      group: '页面',
      label: '定时任务',
      run: () => useStore.getState().setTab('schedules'),
    })
    out.push({
      key: 'page:plugins',
      group: '页面',
      label: '插件',
      run: () => useStore.getState().setTab('plugins'),
    })
    for (const [section, name] of SETTINGS_SECTIONS) {
      out.push({
        key: `settings:${section}`,
        group: '设置',
        label: name,
        run: () => {
          useStore.getState().setTab('settings')
          useStore.getState().setSettingsSection(section)
        },
      })
    }
    return out
  }, [agents, projects])

  const hits = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return cmds
    return cmds.filter((c) => `${c.group} ${c.label} ${c.hint || ''}`.toLowerCase().includes(query))
  }, [cmds, q])

  useEffect(() => {
    setIdx(0)
  }, [q])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [idx, hits, open])

  if (!open) return null

  const exec = (c: PaletteCmd | undefined) => {
    if (!c) return
    setOpen(false)
    c.run()
  }

  let lastGroup = ''

  return (
    <div className="palette-mask" data-testid="command-palette" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={q}
          placeholder="跳转到智能体、项目群、设置…（Ctrl+K）"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => (hits.length ? (i + 1) % hits.length : 0))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              exec(hits[idx])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {hits.length === 0 ? <div className="palette-empty">没有匹配项</div> : null}
          {hits.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null
            lastGroup = c.group
            return (
              <div key={c.key}>
                {head ? <div className="palette-group">{head}</div> : null}
                <button
                  type="button"
                  className={`palette-item ${i === idx ? 'on' : ''}`}
                  data-testid={`palette-item-${i}`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => exec(c)}
                >
                  <span className="palette-label">{c.label}</span>
                  {c.hint ? <span className="palette-hint">{c.hint}</span> : null}
                </button>
              </div>
            )
          })}
        </div>
        <div className="palette-foot">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </div>
  )
}
