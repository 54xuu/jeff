import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { AgentInfo } from '@jeff/core'
import Avatar from './Avatar'
import CreateGroupModal from './CreateGroupModal'

const DEFAULT_GROUP = '默认'

export default function ChatList(): React.JSX.Element {
  const { agents, projects, active, setActive, sending, streaming } = useStore()
  const [creating, setCreating] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const xiaojie = agents.find((a) => a.builtin)
  const others = agents.filter((a) => !a.builtin)

  /** 智能体按分类分组（与「智能体」页同一套规则：默认分组永远排最后） */
  const groups = useMemo(() => {
    const map = new Map<string, AgentInfo[]>()
    for (const a of others) {
      const key = (a.category || '').trim() || DEFAULT_GROUP
      const arr = map.get(key)
      if (arr) arr.push(a)
      else map.set(key, [a])
    }
    return Array.from(map.entries()).sort(([x], [y]) => (x === DEFAULT_GROUP ? 1 : y === DEFAULT_GROUP ? -1 : x.localeCompare(y, 'zh-CN')))
  }, [others])

  // 应用菜单「发起群聊…」→ 打开建群弹窗
  useEffect(() => {
    const open = () => setCreating(true)
    window.addEventListener('jeff:new-group', open)
    return () => window.removeEventListener('jeff:new-group', open)
  }, [])

  return (
    <div className="chat-list">
      <div className="list-header">
        <span>聊天</span>
        <div className="plus-wrap">
          <button className="icon-btn" data-testid="chat-list-plus" title="新建会话 / 发起群聊" onClick={() => setMenuOpen((v) => !v)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          {menuOpen && (
            <div className="plus-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button
                className="plus-menu-item"
                disabled={active?.kind !== 'agent'}
                title={active?.kind === 'agent' ? '给当前聊天对象开新会话' : '先在左侧选择一个聊天对象'}
                onClick={() => {
                  if (active?.kind !== 'agent') return
                  void useStore.getState().newAgentSession(active.id)
                  setMenuOpen(false)
                }}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.2 0-2.4-.2-3.4-.7L3 21l1.7-5.1A8.5 8.5 0 1 1 21 11.5z" />
                </svg>
                新建会话
              </button>
              <button
                className="plus-menu-item"
                data-testid="create-group-btn"
                onClick={() => {
                  setCreating(true)
                  setMenuOpen(false)
                }}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.2 0-2.4-.2-3.4-.7L3 21l1.7-5.1A8.5 8.5 0 1 1 21 11.5z" />
                  <path d="M12 8v7M8.5 11.5h7" />
                </svg>
                发起群聊
              </button>
            </div>
          )}
        </div>
      </div>
      {xiaojie && (
        <ChatItem
          avatar={xiaojie.avatar}
          name={xiaojie.name}
          desc="Jeff 内置管家 · 问我什么都能办"
          pinned
          busy={!!sending[`agent:${xiaojie.id}`] || !!streaming[`agent:${xiaojie.id}`]}
          selected={active?.kind === 'agent' && active.id === xiaojie.id}
          onClick={() => setActive({ kind: 'agent', id: xiaojie.id })}
        />
      )}
      <div className="list-section">项目群</div>
      {projects.length === 0 && <div className="list-empty">还没有项目群：点右上角「发起群聊」或让小杰帮你建</div>}
      {projects.map((p) => (
        <ChatItem
          key={p.id}
          avatar={p.icon}
          name={p.title}
          desc={`${p.memberCount} 个成员 · 群主统筹`}
          isGroup
          busy={!!sending[`group:${p.id}`] || !!streaming[`group:${p.id}`]}
          selected={active?.kind === 'group' && active.id === p.id}
          onClick={() => setActive({ kind: 'group', id: p.id })}
        />
      ))}
      <div className="list-section">智能体</div>
      {others.length === 0 && <div className="list-empty">还没有其他智能体，去「智能体」页或找小杰创建</div>}
      {groups.map(([name, list]) => {
        const isCollapsed = !!collapsed[name]
        return (
          <div className="chat-group-block" key={name}>
            <button
              className="chat-group-head"
              data-testid={`chat-agent-group-${name}`}
              onClick={() => setCollapsed((c) => ({ ...c, [name]: !c[name] }))}
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={isCollapsed ? 'rot' : ''}>
                <path d="M6 9l6 6 6-6" />
              </svg>
              <span>{name}</span>
              <span className="chat-group-count">{list.length}</span>
            </button>
            {!isCollapsed &&
              list.map((a) => (
                <ChatItem
                  key={a.id}
                  avatar={a.avatar}
                  name={a.name}
                  desc={a.description || '（无简介）'}
                  busy={!!sending[`agent:${a.id}`] || !!streaming[`agent:${a.id}`]}
                  selected={active?.kind === 'agent' && active.id === a.id}
                  onClick={() => setActive({ kind: 'agent', id: a.id })}
                />
              ))}
          </div>
        )
      })}
      {creating && <CreateGroupModal onClose={() => setCreating(false)} />}
    </div>
  )
}

function ChatItem(props: {
  avatar: string
  name: string
  desc: string
  pinned?: boolean
  isGroup?: boolean
  busy?: boolean
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <div className={`chat-item ${props.selected ? 'selected' : ''}`} data-testid={props.isGroup ? `chat-group-${props.name}` : `chat-agent-${props.name}`} onClick={props.onClick}>
      <Avatar emoji={props.avatar} busy={props.busy} />
      <div className="chat-item-body">
        <div className="chat-item-top">
          <span className="chat-item-name">{props.name}</span>
          {props.pinned && <span className="tag tag-green">置顶</span>}
          {props.isGroup && <span className="tag">群</span>}
        </div>
        <div className="chat-item-desc">{props.desc}</div>
      </div>
    </div>
  )
}
