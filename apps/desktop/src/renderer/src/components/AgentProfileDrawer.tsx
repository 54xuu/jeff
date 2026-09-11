import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, type AgentInfo, type ChatMsg, type ModelOption, type SessionBrief } from '@jeff/core'
import AgentEditor, { type AgentEditorSave } from './AgentEditor'
import { useDirtyClose } from './ui/useDirtyClose'
import WorkspaceFileTree from './WorkspaceFileTree'
import SessionHistoryPanel from './SessionHistoryPanel'
import { IconClose } from './ui/Icons'

type ProfileTab = 'basic' | 'model' | 'history' | 'files'

/**
 * 私聊顶栏「资料」抽屉：横向 Tabs（基本资料 / 模型设置 / 聊天记录 / 工作区文件）。
 * 「聊天记录」与群「群资料 → 会话记录」共用 SessionHistoryPanel，两侧交互一致；有未保存修改时关闭前先确认。
 */
export default function AgentProfileDrawer(props: { agent: AgentInfo; onClose: () => void }): React.JSX.Element {
  const { catalog, refreshAgents, appInfo, loadHistory } = useStore()
  const busy = useStore((s) => !!s.sending[`agent:${props.agent.id}`])
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
      {/* 宽度保持原 720px：表单就是按这个宽度设计的；两栏历史面板在 720px 下也能完整展开 */}
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span>智能体资料：{props.agent.name}</span>
          <button className="icon-btn" title="关闭" onClick={requestClose}>
            <IconClose />
          </button>
        </div>

        <div className="drawer-tabs" data-testid="agent-drawer-tabs">
          <button className={`drawer-tab ${tab === 'basic' ? 'active' : ''}`} data-testid="agent-tab-basic" onClick={() => setTab('basic')}>
            基本资料
          </button>
          <button className={`drawer-tab ${tab === 'model' ? 'active' : ''}`} data-testid="agent-tab-model" onClick={() => setTab('model')}>
            模型设置
          </button>
          <button className={`drawer-tab ${tab === 'history' ? 'active' : ''}`} data-testid="agent-tab-history" onClick={() => setTab('history')}>
            聊天记录
          </button>
          <button className={`drawer-tab ${tab === 'files' ? 'active' : ''}`} data-testid="agent-tab-files" onClick={() => setTab('files')}>
            工作区文件
          </button>
        </div>

        {/* 表单常驻（仅切换显示）：切去其它 Tab 再回来不丢草稿 */}
        <div style={{ display: tab === 'basic' || tab === 'model' ? undefined : 'none' }}>
          <AgentEditor
            key={props.agent.id}
            initial={props.agent}
            models={models}
            compact
            section={tab === 'model' ? 'model' : 'basic'}
            onDirtyChange={setEditorDirty}
            onCancel={requestClose}
            onSave={save}
            onDelete={props.agent.builtin ? undefined : () => void remove()}
          />
        </div>

        {tab === 'history' && (
          <SessionHistoryPanel
            busy={busy}
            emptyText="还没有会话"
            tip="每一段都是与该智能体的对话历史；可改标题、继续或新开。"
            workspaceDir={filesDir}
            testId="agent-chat-history"
            newBtnTestId="agent-new-thread"
            titleTestIdPrefix="session-title-"
            loadItems={async () => (await api.invoke<{ sessions: SessionBrief[] }>(IPC.sessionsList, { agentId: props.agent.id })).sessions}
            loadPreview={async (sessionId) => (await api.invoke<{ messages: ChatMsg[] }>(IPC.sessionPreview, { sessionId })).messages}
            rename={async (sessionId, title) => {
              await api.invoke(IPC.sessionRename, { sessionId, title })
            }}
            activate={async (sessionId) => {
              await api.invoke(IPC.sessionActivate, { scope: 'private', agentId: props.agent.id, sessionId })
              await loadHistory(`agent:${props.agent.id}`, { resetLocal: true })
              props.onClose()
            }}
            remove={async (sessionId) => {
              await api.invoke(IPC.sessionDelete, { sessionId })
            }}
            createNew={async () => {
              await useStore.getState().newAgentSession(props.agent.id)
              props.onClose()
            }}
          />
        )}

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
