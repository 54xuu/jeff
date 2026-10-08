import { useEffect, useMemo, useRef, useState } from 'react'
import { IPC, projectRoleLabel, type GroupMessage, type GroupThreadBrief, type ProjectInfo, type ProjectMember } from '@jeff/core'
import { useStore } from '../store'
import { api } from '../api'
import Avatar from './Avatar'
import { EmojiPickerButton } from './ui/EmojiPicker'
import { useDirtyClose } from './ui/useDirtyClose'
import WorkspaceFileTree from './WorkspaceFileTree'
import SessionHistoryPanel from './SessionHistoryPanel'
import ProjectTaskBoard from './ProjectTaskBoard'
import { IconClose } from './ui/Icons'
import ModelPickerCombo from './ModelPickerCombo'

type GroupDrawerTab = 'tasks' | 'profile' | 'members' | 'history' | 'files'

/** 项目群资料：任务、群资料、成员、话题和工作区文件各自归属清晰。 */
export default function GroupInfoDrawer(props: { project: ProjectInfo; busy?: boolean; onClose: () => void }): React.JSX.Element {
  const { project, busy, onClose } = props
  const agents = useStore((s) => s.agents)
  const dataDir = useStore((s) => s.appInfo?.dataDir || '')
  const { refreshProjects, setActive, loadGroupHistory, setTab: setMainTab, setSettingsSection } = useStore()
  const [tab, setTab] = useState<GroupDrawerTab>('tasks')
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [membersLoading, setMembersLoading] = useState(true)
  const memberConfigBaseline = useRef('[]')
  const [addingMember, setAddingMember] = useState(false)
  const [selectedMemberId, setSelectedMemberId] = useState('')
  const [engineModels, setEngineModels] = useState<Array<{ id: string; label: string }>>([])
  const [title, setTitle] = useState(project.title)
  const [icon, setIcon] = useState(project.icon || '👥')
  const [description, setDescription] = useState(project.description || '')
  const [groupRules, setGroupRules] = useState(project.system_prompt || '')
  const [workspaceDir, setWorkspaceDir] = useState(project.workspace_dir || '')
  const [leaderId, setLeaderId] = useState(project.leader_agent_id || '')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  useEffect(() => {
    setTitle(project.title)
    setIcon(project.icon || '👥')
    setDescription(project.description || '')
    setGroupRules(project.system_prompt || '')
    setWorkspaceDir(project.workspace_dir || '')
    setLeaderId(project.leader_agent_id || '')
  }, [project.id, project.title, project.icon, project.description, project.system_prompt, project.workspace_dir, project.leader_agent_id])

  const refreshMembers = async () => {
    setMembersLoading(true)
    try {
      const list = await api.invoke<ProjectMember[]>(IPC.projectMembers, { projectId: project.id })
      setMembers(list)
      memberConfigBaseline.current = JSON.stringify(list.map(({ agent_id, duties, model_override, thinking_override }) => ({ agent_id, duties, model_override, thinking_override })))
      setSelectedMemberId((current) => current && list.some((member) => member.agent_id === current) ? current : list[0]?.agent_id || '')
    } finally { setMembersLoading(false) }
  }
  useEffect(() => { void refreshMembers().catch((error) => setSaveMsg('无法加载群成员：' + String(error))) }, [project.id])

  const selectedMember = members.find((member) => member.agent_id === selectedMemberId)
  useEffect(() => {
    let active = true
    setEngineModels([])
    if (selectedMember && selectedMember.execution_engine !== 'opencode') {
      void api.invoke<{ models: Array<{ id: string; label: string }> }>(IPC.enginesModels, { engine: selectedMember.execution_engine })
        .then((result) => { if (active) setEngineModels(result.models) }).catch(() => {})
    }
    return () => { active = false }
  }, [selectedMember?.agent_id, selectedMember?.execution_engine])

  const workspaceForFiles = (project.workspace_dir || '').trim() || (dataDir ? dataDir + '/workspace' : '')
  const candidateAgents = agents.filter((agent) => !members.some((member) => member.agent_id === agent.id))
  const memberDraft = JSON.stringify(members.map(({ agent_id, duties, model_override, thinking_override }) => ({ agent_id, duties, model_override, thinking_override })))
  const dirty = title !== project.title || icon !== (project.icon || '👥') || description !== (project.description || '') ||
    groupRules !== (project.system_prompt || '') || workspaceDir !== (project.workspace_dir || '') ||
    leaderId !== (project.leader_agent_id || '') || memberDraft !== memberConfigBaseline.current
  const { requestClose, guard } = useDirtyClose({ dirty, onClose, disabled: addingMember })

  const saveProfile = async (): Promise<boolean> => {
    if (!title.trim() || !leaderId) return false
    setSaving(true)
    setSaveMsg('')
    try {
      await api.invoke<ProjectInfo>(IPC.projectSave, {
        id: project.id, title: title.trim(), icon: icon.trim() || '👥', description: description.trim(),
        system_prompt: groupRules.trim(), leader_agent_id: leaderId, workspace_dir: workspaceDir.trim(),
        memberAgentIds: members.map((member) => member.agent_id),
        memberConfigs: members.map(({ agent_id, duties, model_override, thinking_override }) => ({ agent_id, duties, model_override, thinking_override })),
      })
      await refreshProjects()
      await refreshMembers()
      setSaveMsg('已保存')
      return true
    } catch (error) {
      setSaveMsg('保存失败：' + String((error as Error).message).slice(0, 140))
      return false
    } finally {
      setSaving(false)
    }
  }

  const pickDir = async () => {
    const dir = await api.invoke<string | null>(IPC.dialogPickDir, { title: '选择工作区目录', defaultPath: workspaceDir || undefined })
    if (dir) setWorkspaceDir(dir)
  }
  const dissolve = async () => {
    if (!confirm('确定解散项目群「' + project.title + '」？群聊和任务记录会保留为已解散数据。')) return
    await api.invoke(IPC.projectDelete, { id: project.id })
    await refreshProjects()
    setActive(null)
    onClose()
  }
  const openProjectMemory = () => {
    setMainTab('settings')
    setSettingsSection('memory')
    onClose()
  }

  const tabs: Array<{ id: GroupDrawerTab; label: string; count?: number }> = [
    { id: 'tasks', label: '项目管理' },
    { id: 'profile', label: '群资料' },
    { id: 'members', label: '群成员', count: members.length },
    { id: 'history', label: '会话记录' },
    { id: 'files', label: '工作区文件' },
  ]

  return (
    <div className="drawer-mask" data-testid="group-info-drawer" onClick={requestClose}>
      <section className="drawer drawer-wide project-drawer" role="dialog" aria-modal="true" aria-label={project.title + ' 项目群资料'} onClick={(event) => event.stopPropagation()}>
        <header className="project-drawer-head">
          <div className="project-drawer-identity">
            <span className="project-drawer-icon">{project.icon || '👥'}</span>
            <div><strong>{project.title}</strong><small>项目群资料 · {members.length} 位成员</small></div>
          </div>
          <button className="icon-btn" aria-label="关闭" title="关闭" onClick={requestClose}><IconClose /></button>
        </header>
        <nav className="drawer-tabs project-drawer-tabs" data-testid="group-drawer-tabs" aria-label="项目群资料分区">
          {tabs.map((item) => <button key={item.id} className={'drawer-tab' + (tab === item.id ? ' active' : '')}
            data-testid={'group-tab-' + (item.id === 'profile' ? 'settings' : item.id)} aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => setTab(item.id)}>{item.label}{item.count != null ? ' · ' + item.count : ''}</button>)}
        </nav>
        <main className="project-drawer-body">
          {tab === 'tasks' && <ProjectTaskBoard projectId={project.id} members={members} onOpenThread={async (threadId) => {
            await api.invoke(IPC.groupThreadActivate, { projectId: project.id, threadId })
            await loadGroupHistory(project.id)
            onClose()
          }} />}

          {tab === 'profile' && <div className="project-profile-view" data-testid="group-settings">
            <div className="project-section-heading"><div><h2>群资料与上下文</h2><p>这些设置只属于当前项目群，保存后才会进入群内 Agent 的上下文。</p></div></div>
            <div className="project-profile-grid">
              <label className="field"><span>群名称</span><input value={title} data-testid="group-settings-title" onChange={(event) => setTitle(event.target.value)} /></label>
              <label className="field"><span>群图标</span><div className="emoji-input-row"><input value={icon} data-testid="group-settings-icon" onChange={(event) => setIcon(event.target.value)} /><EmojiPickerButton value={icon} onPick={setIcon} testId="group-icon-picker" /></div></label>
            </div>
            <label className="field"><span>群主与协调人</span><select value={leaderId} data-testid="group-settings-leader" onChange={(event) => setLeaderId(event.target.value)}>
              <option value="">选择群主…</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.avatar} {agent.name}{agent.builtin ? '（内置）' : ''}</option>)}
            </select><small className="settings-tip">未指定任务负责人时，由群主协调。明确指定负责人时，任务会直接交给该成员。</small></label>
            <label className="field"><span>群简介 · 项目背景</span><textarea rows={4} value={description} data-testid="group-settings-desc" onChange={(event) => setDescription(event.target.value)} placeholder="当前项目的背景和事实。不要把成员职责或一次性任务写在这里。" /></label>
            <label className="field"><span>群规则 · 仅本群有效</span><textarea rows={7} value={groupRules} data-testid="group-settings-rules" onChange={(event) => setGroupRules(event.target.value)} placeholder="本群长期协作方式、质量要求和边界。" /><small className="settings-tip">群规则会作为本群约束注入；具体任务要求写在任务的三个文本域中。</small></label>
            <label className="field"><span>工作区目录</span><div className="project-path-row"><input value={workspaceDir} data-testid="group-settings-workspace" onChange={(event) => setWorkspaceDir(event.target.value)} placeholder="留空使用 Jeff 默认工作区" /><button className="btn" type="button" onClick={() => void pickDir()}>浏览…</button></div></label>
            <div className="project-context-links">
              <div><strong>项目记忆与 AGENTS.md</strong><p>记忆保存长期事实；AGENTS.md 保存只对本项目生效的持续规则。</p></div>
              <button className="btn" onClick={openProjectMemory}>打开记忆与规则设置</button>
            </div>
            <div className="project-form-footer"><span className="settings-tip" role="status">{saveMsg || (dirty ? '有未保存的修改' : '已与当前群资料同步')}</span><button className="btn primary" data-testid="group-settings-save" disabled={saving || !title.trim() || !leaderId || !dirty} onClick={() => void saveProfile()}>{saving ? '保存中…' : '保存群资料'}</button></div>
            <div className="drawer-danger"><button className="btn danger" data-testid="group-dissolve" onClick={() => void dissolve()}>解散项目群</button></div>
          </div>}

          {tab === 'members' && <div className="project-members-view">
            <div className="project-section-heading"><div><h2>群成员与职责</h2><p>职责、模型和思考覆盖只在本群生效；留空时继承 Agent 个人默认。</p></div><button className="btn" data-testid="group-add-member" disabled={!candidateAgents.length} onClick={() => setAddingMember(true)}>添加成员</button></div>
            <div className="project-member-layout">
              <div className="project-member-list" role="listbox" aria-label="群成员">
                {members.map((member) => {
                  const isLeader = member.agent_id === (leaderId || project.leader_agent_id)
                  return <button type="button" role="option" aria-selected={selectedMemberId === member.agent_id} key={member.agent_id}
                    className={'project-member-option' + (selectedMemberId === member.agent_id ? ' selected' : '')}
                    data-testid={'group-member-' + member.agent_id} onClick={() => setSelectedMemberId(member.agent_id)}>
                    <Avatar emoji={member.avatar} size={34} agentId={member.agent_id} /><span><strong>{member.name}</strong><small>{projectRoleLabel(isLeader ? 'leader' : member.role)}</small></span>
                    {!isLeader && <span className="project-member-remove" onClick={async (event) => {
                      event.stopPropagation()
                      if (!(await saveProfile())) return
                      await api.invoke(IPC.projectRemoveMember, { projectId: project.id, agentId: member.agent_id })
                      await refreshMembers(); await refreshProjects()
                    }}>移出</span>}
                  </button>
                })}
              </div>
              {selectedMember ? <section className="project-member-editor" data-testid="group-member-config">
                <div className="project-member-editor-head"><Avatar emoji={selectedMember.avatar} size={40} agentId={selectedMember.agent_id} /><div><strong>{selectedMember.name}</strong><span>{selectedMember.execution_engine} · 本群配置</span></div></div>
                <label className="field"><span>本群职责</span><textarea rows={5} data-testid="group-member-duties" value={selectedMember.duties} onChange={(event) => setMembers((list) => list.map((member) => member.agent_id === selectedMember.agent_id ? { ...member, duties: event.target.value } : member))} placeholder="描述这位成员在当前项目群中承担的责任。" /></label>
                <label className="field"><span>模型覆盖 <small>· {selectedMember.execution_engine === 'opencode' ? 'OpenCode（Jeff）' : selectedMember.execution_engine}</small></span>
                  {selectedMember.execution_engine === 'opencode'
                    ? <ModelPickerCombo value={selectedMember.model_override || ''} onChange={(value) => setMembers((list) => list.map((member) => member.agent_id === selectedMember.agent_id ? { ...member, model_override: value || null } : member))} placeholderEmpty="继承个人默认模型" />
                    : <><input data-testid="group-member-model" value={selectedMember.model_override || ''} onChange={(event) => setMembers((list) => list.map((member) => member.agent_id === selectedMember.agent_id ? { ...member, model_override: event.target.value || null } : member))} list={'group-models-' + selectedMember.agent_id} placeholder="留空继承个人默认模型" /><datalist id={'group-models-' + selectedMember.agent_id}>{engineModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist></>}
                </label>
                {selectedMember.execution_engine !== 'cursor' && <label className="field"><span>思考程度</span><select data-testid="group-member-thinking" value={selectedMember.thinking_override || ''} onChange={(event) => setMembers((list) => list.map((member) => member.agent_id === selectedMember.agent_id ? { ...member, thinking_override: event.target.value || null } : member))}><option value="">继承个人默认</option><option value="none">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="max">最大</option></select></label>}
                <div className="project-form-footer"><span className="settings-tip" role="status">{saveMsg || '当前有效设置按 Agent 默认与群内覆盖合成'}</span><button className="btn primary" data-testid="group-member-config-save" disabled={saving || !dirty} onClick={() => void saveProfile()}>{saving ? '保存中…' : '保存成员配置'}</button></div>
              </section> : <div className="empty-card">{membersLoading ? '正在读取群成员…' : saveMsg || '先添加一位成员，或从左侧选择成员查看职责与配置。'}</div>}
            </div>
          </div>}

          {tab === 'history' && <div className="project-history-view">
            <div className="project-section-heading"><div><h2>会话记录</h2><p>普通讨论与任务执行各有独立话题；选择任务话题可查看完整执行过程。</p></div></div>
            <SessionHistoryPanel busy={busy} emptyText="还没有会话" tip="任务执行使用独立话题，普通群聊不会混入任务上下文。"
              workspaceDir={workspaceForFiles} testId="group-chat-history" newBtnTestId="group-new-thread" titleTestIdPrefix="thread-title-"
              loadItems={async () => (await api.invoke<{ threads: GroupThreadBrief[] }>(IPC.groupThreadsList, { projectId: project.id })).threads}
              loadPreview={async (threadId) => (await api.invoke<{ messages: GroupMessage[] }>(IPC.groupThreadPreview, { projectId: project.id, threadId })).messages}
              rename={async (threadId, next) => { await api.invoke(IPC.groupThreadRename, { projectId: project.id, threadId, title: next }) }}
              activate={async (threadId) => { await api.invoke(IPC.groupThreadActivate, { projectId: project.id, threadId }); await loadGroupHistory(project.id); onClose() }}
              remove={async (threadId) => { await api.invoke(IPC.groupThreadDelete, { projectId: project.id, threadId }) }}
              createNew={async () => { await api.invoke(IPC.groupThreadNew, { projectId: project.id }); await loadGroupHistory(project.id); onClose() }} />
          </div>}

          {tab === 'files' && <div className="project-files-view"><div className="project-section-heading"><div><h2>工作区文件</h2><p>文件树使用已保存的工作区目录，切换临时目录不会改变当前数据源。</p></div></div><WorkspaceFileTree dir={workspaceForFiles} /></div>}
        </main>
        {addingMember && <AddMemberModal candidates={candidateAgents} onClose={() => setAddingMember(false)} onPick={async (agentId) => {
          await api.invoke(IPC.projectAddMember, { projectId: project.id, agentId })
          setAddingMember(false); await refreshMembers(); await refreshProjects()
        }} />}
      </section>
      {guard}
    </div>
  )
}

function AddMemberModal(props: { candidates: Array<{ id: string; name: string; avatar: string }>; onClose: () => void; onPick: (agentId: string) => Promise<void> }): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return <div className="modal-mask" data-testid="group-add-member-modal" onClick={props.onClose}><div className="modal form" onClick={(event) => event.stopPropagation()}>
    <div className="modal-title">添加群成员</div>
    {!props.candidates.length ? <p className="settings-tip">没有可添加的智能体，请先在通讯录中创建。</p> :
      <div className="member-picker">{props.candidates.map((agent) => <button key={agent.id} className="member-chip" type="button" onClick={() => void props.onPick(agent.id)}>{agent.avatar} {agent.name}</button>)}</div>}
  </div></div>
}
