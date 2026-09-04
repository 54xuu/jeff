import { useStore } from '../store'
import Avatar from './Avatar'
import { api } from '../api'

export default function ChatList(): React.JSX.Element {
  const { agents, active, setActive } = useStore()
  const xiaojie = agents.find((a) => a.builtin)
  const others = agents.filter((a) => !a.builtin)

  return (
    <div className="chat-list">
      <div className="list-header">
        <span>聊天</span>
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
      {xiaojie && (
        <ChatItem
          avatar={xiaojie.avatar}
          name={xiaojie.name}
          desc="Jeff 内置管家 · 问我什么都能办"
          pinned
          selected={active?.kind === 'agent' && active.id === xiaojie.id}
          onClick={() => {
            setActive({ kind: 'agent', id: xiaojie.id })
          }}
        />
      )}
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
      <div className="list-section">项目群</div>
      <div className="list-empty">M2 上线：项目=群聊，群主统筹</div>
    </div>
  )
}

function ChatItem(props: {
  avatar: string
  name: string
  desc: string
  pinned?: boolean
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
        </div>
        <div className="chat-item-desc">{props.desc}</div>
      </div>
    </div>
  )
}
