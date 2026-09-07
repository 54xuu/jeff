import { useStore } from '../store'
import { api } from '../api'
import { IPC, type AgentInfo, type ModelOption } from '@jeff/core'
import AgentEditor, { type AgentEditorSave } from './AgentEditor'

/** 私聊顶栏「资料」抽屉：编辑当前智能体（与通讯录共用 AgentEditor） */
export default function AgentProfileDrawer(props: { agent: AgentInfo; onClose: () => void }): React.JSX.Element {
  const { catalog, refreshAgents } = useStore()
  const models: ModelOption[] = catalog.flatMap((c) => c.models)

  const save = async (d: AgentEditorSave) => {
    await api.invoke<AgentInfo>(IPC.agentsUpsert, d)
    await refreshAgents()
    // 稍停让「✅ 已保存」可见，再关抽屉
    await new Promise((r) => setTimeout(r, 600))
    props.onClose()
  }

  const remove = async () => {
    if (props.agent.builtin) return
    if (!confirm(`确定删除「${props.agent.name}」？该操作可由历史记录恢复（软删除）。`)) return
    await api.invoke(IPC.agentsDelete, { id: props.agent.id })
    await refreshAgents()
    useStore.getState().setActive(null)
    props.onClose()
  }

  return (
    <div className="drawer-mask" data-testid="agent-profile-drawer" onClick={props.onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span>智能体资料：{props.agent.name}</span>
          <button className="icon-btn" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <AgentEditor
          key={props.agent.id}
          initial={props.agent}
          models={models}
          compact
          onCancel={props.onClose}
          onSave={save}
          onDelete={props.agent.builtin ? undefined : () => void remove()}
        />
      </div>
    </div>
  )
}
