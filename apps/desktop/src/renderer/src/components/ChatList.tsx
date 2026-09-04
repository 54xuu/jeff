import { useState } from 'react'
import { useStore } from '../store'
import Avatar from './Avatar'
import CreateGroupModal from './CreateGroupModal'

export default function ChatList(): React.JSX.Element {
  const { agents, projects, active, setActive } = useStore()
  const [creating, setCreating] = useState(false)
  const xiaojie = agents.find((a) => a.builtin)
  const others = agents.filter((a) => !a.builtin)

  return (
    <div className="chat-list">
      <div className="list-header">
        <span>聊天</span>
        <div style={{ display: 'flex' }}>
          <button className="icon-btn" title="发起群聊（建项目）" onClick={() => setCreating(true)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              <path d="M12 15v6M9 18h6" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="去通讯录新建智能体"
            onClick={() => useStore.getState().setTab('contacts')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>
      {xiaojie && (
        <ChatItem
          avatar={xiaojie.avatar}
          name={xiaojie.name}
          desc="Jeff 内置管家 · 问我什么都能办"
          pinned
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
          selected={active?.kind === 'group' && active.id === p.id}
          onClick={() => setActive({ kind: 'group', id: p.id })}
        />
      ))}
      <div className="list-section">智能体</div>
      {others.length === 0 && <div className="list-empty">还没有其他智能体，去「智能体」页或找小杰创建</div>}
      {others.map((a) => (
        <ChatItem
          key={a.id}
          avatar={a.avatar}
          name={a.name}
          desc={a.description || '（无简介）'}
          selected={active?.kind === 'agent' && active.id === a.id}
          onClick={() => setActive({ kind: 'agent', id: a.id })}
        />
      ))}
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
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <div className={`chat-item ${props.selected ? 'selected' : ''}`} onClick={props.onClick}>
      <Avatar emoji={props.avatar} />
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
