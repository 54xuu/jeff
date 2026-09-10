import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, type AgentInfo, type ModelOption } from '@jeff/core'
import AgentEditor, { type AgentEditorSave } from './AgentEditor'
import { useDirtyClose } from './ui/useDirtyClose'
import WorkspaceFileTree from './WorkspaceFileTree'

type ProfileTab = 'basic' | 'model' | 'files'

/** 私聊顶栏「资料」抽屉：横向 Tabs（基本资料 / 模型设置 / 工作区文件）；有未保存修改时关闭前先确认 */
export default function AgentProfileDrawer(props: { agent: AgentInfo; onClose: () => void }): React.JSX.Element {
  const { catalog, refreshAgents, appInfo } = useStore()
  const models: ModelOption[] = catalog.flatMap((c) => c.models)
  const [tab, setTab] = useState<ProfileTab>('basic')
  const [editorDirty, setEditorDirty] = useState(false)
  const { requestClose, guard } = useDirtyClose({ dirty: editorDirty, onClose: props.onClose })
  // 私聊智能体的「工作区文件」= Jeff 默认工作区（sidecar 的工作目录）
  const filesDir = appInfo ? `${appInfo.dataDir}/workspace` : ''

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
    <div className="drawer-mask" data-testid="agent-profile-drawer" onClick={requestClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span>智能体资料：{props.agent.name}</span>
          <button className="icon-btn" onClick={requestClose}>
            ✕
          </button>
        </div>

        <div className="drawer-tabs" data-testid="agent-drawer-tabs">
          <button className={`drawer-tab ${tab === 'basic' ? 'active' : ''}`} data-testid="agent-tab-basic" onClick={() => setTab('basic')}>
            基本资料
          </button>
          <button className={`drawer-tab ${tab === 'model' ? 'active' : ''}`} data-testid="agent-tab-model" onClick={() => setTab('model')}>
            模型设置
          </button>
          <button className={`drawer-tab ${tab === 'files' ? 'active' : ''}`} data-testid="agent-tab-files" onClick={() => setTab('files')}>
            工作区文件
          </button>
        </div>

        {/* 表单常驻（仅切换显示）：切去「工作区文件」再回来不丢草稿 */}
        <div style={{ display: tab === 'files' ? 'none' : undefined }}>
          <AgentEditor
            key={props.agent.id}
            initial={props.agent}
            models={models}
            compact
            section={tab === 'files' ? 'basic' : tab}
            onDirtyChange={setEditorDirty}
            onCancel={requestClose}
            onSave={save}
            onDelete={props.agent.builtin ? undefined : () => void remove()}
          />
        </div>

        {tab === 'files' && (
          <div className="drawer-files">
            <p className="settings-tip" style={{ marginTop: 0 }}>
              私聊会话使用 Jeff 默认工作区；点击 .md 用内置预览器打开，其它文件用系统程序打开。
            </p>
            <WorkspaceFileTree dir={filesDir} />
          </div>
        )}
      </div>
      {guard}
    </div>
  )
}
