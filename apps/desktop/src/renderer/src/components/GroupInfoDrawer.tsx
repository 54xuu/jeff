import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import {
  IPC, projectRoleLabel, parseProjectWorkspaceState, serializeProjectWorkspaceState,
  canStartCampaignProduction,
  type CampaignProposal, type CampaignKind, type ProjectWorkspaceState, type GroupMessage, type GroupThreadBrief, type ProjectInfo,
} from '@jeff/core'
import Avatar from './Avatar'
import { EmojiPickerButton } from './ui/EmojiPicker'
import { useDirtyClose } from './ui/useDirtyClose'
import WorkspaceFileTree from './WorkspaceFileTree'
import SessionHistoryPanel from './SessionHistoryPanel'
import { IconClose } from './ui/Icons'

type GroupDrawerTab = 'settings' | 'workspace' | 'members' | 'history' | 'files'

/** 群资料抽屉：横向 Tabs（群设置 / 群成员 / 会话记录 / 工作区文件）。busy（生成中）时禁用切换/新建/删除会话，防消息串线 */
export default function GroupInfoDrawer(props: { project: ProjectInfo; busy?: boolean; onClose: () => void }): React.JSX.Element {
  const { project, busy, onClose } = props
  const agents = useStore((s) => s.agents)
  const dataDir = useStore((s) => s.appInfo?.dataDir || '')
  const { refreshProjects, setActive, loadGroupHistory } = useStore()
  const [tab, setTab] = useState<GroupDrawerTab>('settings')
  const [members, setMembers] = useState<Array<{ agent_id: string; role: string; name: string; avatar: string }>>([])
  const [addingMember, setAddingMember] = useState(false)

  const [title, setTitle] = useState(project.title)
  const [icon, setIcon] = useState(project.icon || '👥')
  const [description, setDescription] = useState(project.description || '')
  const [workspaceDir, setWorkspaceDir] = useState(project.workspace_dir || '')
  const [workspaceState, setWorkspaceState] = useState<ProjectWorkspaceState>(() => parseProjectWorkspaceState(project.workspace_state))
  const [campaignKind, setCampaignKind] = useState<CampaignKind>('feature_video')
  const [editingCampaignId, setEditingCampaignId] = useState('')
  const [campaignTitle, setCampaignTitle] = useState('')
  const [campaignFeature, setCampaignFeature] = useState('')
  const [campaignStory, setCampaignStory] = useState('')
  const [campaignPoints, setCampaignPoints] = useState('')
  const [campaignMaterials, setCampaignMaterials] = useState('')
  const [campaignChannels, setCampaignChannels] = useState('')
  const [campaignFeedback, setCampaignFeedback] = useState<Record<string, string>>({})
  const [assetTitle, setAssetTitle] = useState('')
  const [assetPath, setAssetPath] = useState('')
  const [assetFeature, setAssetFeature] = useState('')
  const [assetKind, setAssetKind] = useState<'image' | 'video' | 'document' | 'demo_url'>('image')
  const [assetSourceNote, setAssetSourceNote] = useState('')
  const [assetSource, setAssetSource] = useState<'user_provided' | 'authorized_screenshot' | 'generated_illustration' | 'demo_material'>('user_provided')
  const [assetReal, setAssetReal] = useState(false)
  const [deliveryPaths, setDeliveryPaths] = useState<Record<string, string>>({})
  const [leaderId, setLeaderId] = useState(project.leader_agent_id || '')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)


  useEffect(() => {
    setTitle(project.title)
    setIcon(project.icon || '👥')
    setDescription(project.description || '')
    setWorkspaceDir(project.workspace_dir || '')
    setWorkspaceState(parseProjectWorkspaceState(project.workspace_state))
    setLeaderId(project.leader_agent_id || '')
  }, [project.id, project.title, project.icon, project.description, project.workspace_dir, project.workspace_state, project.leader_agent_id])

  const refreshMembers = async () => {
    const list = await api.invoke<Array<{ agent_id: string; role: string; name: string; avatar: string }>>(IPC.projectMembers, { projectId: project.id })
    setMembers(list)
  }

  useEffect(() => {
    void refreshMembers()
  }, [project.id])

  // 「工作区文件」与消息里的相对路径链接都以已保存的群工作空间为准（未配置 = Jeff 默认工作区）
  const workspaceForFiles = (project.workspace_dir || '').trim() || (dataDir ? `${dataDir}/workspace` : '')

  const candidateAgents = agents.filter((a) => !members.some((m) => m.agent_id === a.id))

  // 群设置表单脏检查：任一字段相对当前 project 有变化即视为脏（成员增删是即时保存的，不参与）
  const formDirty =
    title !== project.title ||
    icon !== (project.icon || '👥') ||
    description !== (project.description || '') ||
    workspaceDir !== (project.workspace_dir || '') ||
    leaderId !== (project.leader_agent_id || '') ||
    serializeProjectWorkspaceState(workspaceState) !== serializeProjectWorkspaceState(parseProjectWorkspaceState(project.workspace_state))
  const { requestClose, guard } = useDirtyClose({ dirty: formDirty, onClose, disabled: addingMember })

  const persistWorkspace = async (nextState: ProjectWorkspaceState): Promise<boolean> => {
    if (!title.trim() || !leaderId) return false
    setSaving(true)
    setSaveMsg(null)
    try {
      const updated = await api.invoke<ProjectInfo>(IPC.projectSave, {
        id: project.id,
        title: title.trim(),
        icon: icon.trim() || '👥',
        description: description.trim(),
        leader_agent_id: leaderId,
        workspace_dir: workspaceDir.trim(),
        workspace_state: serializeProjectWorkspaceState(nextState),
        memberAgentIds: members.map((m) => m.agent_id),
      })
      setWorkspaceState(parseProjectWorkspaceState(updated.workspace_state))
      await refreshProjects()
      await refreshMembers()
      setSaveMsg('已保存')
      return true
    } catch (err) {
      setSaveMsg(`保存失败：${String((err as Error).message).slice(0, 120)}`)
      return false
    } finally {
      setSaving(false)
    }
  }

  const saveSettings = async () => { await persistWorkspace(workspaceState) }

  const createCampaign = async () => {
    try {
      const updated = await api.invoke<ProjectInfo>(IPC.projectCampaign, {
        projectId: project.id, action: editingCampaignId ? 'update' : 'create', ...(editingCampaignId ? { campaignId: editingCampaignId } : {}), kind: campaignKind, title: campaignTitle,
        feature: campaignFeature, story: campaignStory,
        channels: campaignChannels.split('\n'), sellingPoints: campaignPoints.split('\n'), materialsNeeded: campaignMaterials.split('\n'),
      })
      setWorkspaceState(parseProjectWorkspaceState(updated.workspace_state))
      await refreshProjects()
      setSaveMsg('选题已保存，等待方向确认')
      setEditingCampaignId('')
      setCampaignTitle('')
      setCampaignFeature('')
      setCampaignStory('')
      setCampaignPoints('')
      setCampaignMaterials('')
    } catch (err) { setSaveMsg(`无法创建选题：${String((err as Error).message)}`) }
  }

  const editCampaign = (campaign: CampaignProposal) => {
    setCampaignKind(campaign.kind)
    setEditingCampaignId(campaign.id)
    setCampaignTitle(campaign.title)
    setCampaignFeature(campaign.feature)
    setCampaignStory(campaign.story)
    setCampaignPoints(campaign.sellingPoints.join('\n'))
    setCampaignMaterials(campaign.materialsNeeded.join('\n'))
    setCampaignChannels(campaign.channels.join('\n'))
  }

  const decideDirection = async (campaign: CampaignProposal, decision: 'approve' | 'changes_requested') => {
    try {
      const updated = await api.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: project.id, action: 'review_direction', campaignId: campaign.id, decision, feedback: campaignFeedback[campaign.id] || '' })
      setWorkspaceState(parseProjectWorkspaceState(updated.workspace_state))
      await refreshProjects()
    } catch (err) { setSaveMsg(`无法确认选题：${String((err as Error).message)}`) }
  }

  const makeProductionTask = async (campaign: CampaignProposal) => {
    try {
      if (!canStartCampaignProduction(campaign)) throw new Error('先确认当前版本的选题，并补齐所需素材')
      const updated = await api.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: project.id, action: 'create_task', campaignId: campaign.id })
      setWorkspaceState(parseProjectWorkspaceState(updated.workspace_state))
      await refreshProjects()
    } catch (err) { setSaveMsg(`无法创建制作任务：${String((err as Error).message)}`) }
  }

  const submitDelivery = async (campaign: CampaignProposal) => {
    try {
      const updated = await api.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: project.id, action: 'submit_delivery', campaignId: campaign.id, path: deliveryPaths[campaign.id] || '' })
      setWorkspaceState(parseProjectWorkspaceState(updated.workspace_state))
      await refreshProjects()
      setDeliveryPaths((paths) => ({ ...paths, [campaign.id]: '' }))
    } catch (err) { setSaveMsg(`无法提交成品：${String((err as Error).message)}`) }
  }

  const decideDelivery = async (campaign: CampaignProposal, deliveryId: string, decision: 'accepted' | 'changes_requested') => {
    try {
      const updated = await api.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: project.id, action: 'review_delivery', campaignId: campaign.id, deliveryId, decision, feedback: campaignFeedback[deliveryId] || '' })
      setWorkspaceState(parseProjectWorkspaceState(updated.workspace_state))
      await refreshProjects()
    } catch (err) { setSaveMsg(`无法验收成品：${String((err as Error).message)}`) }
  }
  const registerAsset = async () => {
    try {
      const updated = await api.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: project.id, action: 'register_asset', title: assetTitle, kind: assetKind, feature: assetFeature, path: assetPath, source: assetSource, sourceNote: assetSourceNote, isReal: assetReal })
      setWorkspaceState(parseProjectWorkspaceState(updated.workspace_state)); setAssetTitle(''); setAssetPath(''); setAssetFeature(''); setAssetSourceNote('')
    } catch (error) { setSaveMsg(error instanceof Error ? error.message : String(error)) }
  }
  const reviewAsset = async (assetId: string, confirmed: boolean) => {
    try {
      const updated = await api.invoke<ProjectInfo>(IPC.projectCampaign, { projectId: project.id, action: 'review_asset', assetId, confirmed })
      setWorkspaceState(parseProjectWorkspaceState(updated.workspace_state))
    } catch (error) { setSaveMsg(error instanceof Error ? error.message : String(error)) }
  }

  const pickDir = async () => {
    const dir = await api.invoke<string | null>(IPC.dialogPickDir, { title: '选择工作空间目录', defaultPath: workspaceDir || undefined })
    if (dir) setWorkspaceDir(dir)
  }

  const dissolve = async () => {
    if (!confirm(`确定解散项目群「${project.title}」？任务与群聊记录将随软删除保留，可从同步历史恢复。`)) return
    await api.invoke(IPC.projectDelete, { id: project.id })
    await refreshProjects()
    setActive(null)
    onClose()
  }

  return (
    <div className="drawer-mask" data-testid="group-info-drawer" onClick={requestClose}>
      <div className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span>群资料：{project.title}</span>
          <button className="icon-btn" title="关闭" onClick={requestClose}>
            <IconClose />
          </button>
        </div>

        <div className="drawer-tabs" data-testid="group-drawer-tabs">
          <button className={`drawer-tab ${tab === 'settings' ? 'active' : ''}`} data-testid="group-tab-settings" onClick={() => setTab('settings')}>
            群设置
          </button>
          <button className={`drawer-tab ${tab === 'workspace' ? 'active' : ''}`} data-testid="group-tab-workspace" onClick={() => setTab('workspace')}>
            项目工作台
          </button>
          <button className={`drawer-tab ${tab === 'members' ? 'active' : ''}`} data-testid="group-tab-members" onClick={() => setTab('members')}>
            群成员（{members.length}）
          </button>
          <button className={`drawer-tab ${tab === 'history' ? 'active' : ''}`} data-testid="group-tab-history" onClick={() => setTab('history')}>
            会话记录
          </button>
          <button className={`drawer-tab ${tab === 'files' ? 'active' : ''}`} data-testid="group-tab-files" onClick={() => setTab('files')}>
            工作区文件
          </button>
        </div>

        {/* 项目工作台资料：纯事实与计划，素材文件仍放在工作区目录 */}
        <div style={{ display: tab === 'workspace' ? undefined : 'none' }} data-testid="project-workspace-form">
          <div className="drawer-sec">目标与内容框架</div>
          <div className="group-settings">
            <label className="field">
              <span>阶段目标</span>
              <textarea rows={3} value={workspaceState.goal} data-testid="project-workspace-goal" onChange={(e) => setWorkspaceState((s) => ({ ...s, goal: e.target.value }))} placeholder="这个项目当前要达成什么结果？" />
            </label>
            <label className="field">
              <span>销售对象</span>
              <input value={workspaceState.salesAudience} data-testid="project-workspace-sales-audience" onChange={(e) => setWorkspaceState((s) => ({ ...s, salesAudience: e.target.value }))} placeholder="例如：渠道商与集成商" />
            </label>
            <label className="field">
              <span>内容呈现对象</span>
              <input value={workspaceState.storyAudience} data-testid="project-workspace-story-audience" onChange={(e) => setWorkspaceState((s) => ({ ...s, storyAudience: e.target.value }))} placeholder="例如：一线医护人员" />
            </label>
            <label className="field">
              <span>传播渠道（每行一个）</span>
              <textarea rows={2} value={workspaceState.channels.join('\n')} data-testid="project-workspace-channels" onChange={(e) => setWorkspaceState((s) => ({ ...s, channels: e.target.value.split('\n') }))} placeholder="微信私聊\n渠道群转发\n客户现场讲解" />
            </label>
            <label className="field">
              <span>系统介绍大纲（每行一章，作为完整 PPT 的内容框架）</span>
              <textarea rows={7} value={workspaceState.systemOutline.join('\n')} data-testid="project-workspace-outline" onChange={(e) => setWorkspaceState((s) => ({ ...s, systemOutline: e.target.value.split('\n') }))} placeholder="系统解决的问题\n整体方案\n功能与医护使用场景\n对接与部署" />
            </label>
            <label className="field">
              <span>每周推进节奏</span>
              <textarea rows={2} value={workspaceState.weeklyCadence} data-testid="project-workspace-cadence" onChange={(e) => setWorkspaceState((s) => ({ ...s, weeklyCadence: e.target.value }))} placeholder="例如：每周提交一批选题与素材缺口；时间可后续设置" />
            </label>
            <div className="settings-actions" style={{ justifyContent: 'flex-start', marginTop: 4 }}>
              <button className="btn primary" data-testid="project-workspace-save" disabled={saving || !title.trim() || !leaderId} onClick={() => void saveSettings()}>
                {saving ? '保存中…' : '保存项目资料'}
              </button>
              {saveMsg && <span className="settings-tip" data-testid="project-workspace-save-result">{saveMsg}</span>}
            </div>
          </div>
          <div className="drawer-sec">宣传选题与成品</div>
          <div className="group-settings campaign-workspace" data-testid="campaign-workspace">
            <section className="campaign-assets" data-testid="project-assets">
              <strong>项目素材库</strong>
              <p className="settings-tip">真实产品素材和生成示意图分开标记；文件需在项目工作区内，截图需来自授权演示环境且先脱敏。</p>
              <label className="field"><span>素材名称</span><input data-testid="asset-title" value={assetTitle} onChange={(e) => setAssetTitle(e.target.value)} /></label>
              <label className="field"><span>工作区相对路径</span><input data-testid="asset-path" value={assetPath} onChange={(e) => setAssetPath(e.target.value)} placeholder="产品资料/腕表正面.png" /></label>
              <label className="field"><span>所属功能</span><input data-testid="asset-feature" value={assetFeature} onChange={(e) => setAssetFeature(e.target.value)} placeholder="腕表病房呼叫" /></label>
              <label className="field"><span>素材类型</span><select data-testid="asset-kind" value={assetKind} onChange={(e) => setAssetKind(e.target.value as typeof assetKind)}><option value="image">图片</option><option value="video">视频</option><option value="document">文档</option><option value="demo_url">演示地址</option></select></label>
              <label className="field"><span>素材来源</span><select data-testid="asset-source" value={assetSource} onChange={(e) => setAssetSource(e.target.value as typeof assetSource)}><option value="user_provided">用户提供</option><option value="authorized_screenshot">授权系统截图</option><option value="generated_illustration">生成示意图</option><option value="demo_material">演示素材</option></select></label>
              <label className="field"><span>来源说明</span><input data-testid="asset-source-note" value={assetSourceNote} onChange={(e) => setAssetSourceNote(e.target.value)} placeholder="授权环境、生成工具或资料来源" /></label>
              <label><input type="checkbox" data-testid="asset-real" checked={assetReal} onChange={(e) => setAssetReal(e.target.checked)} />真实产品素材（非示意图）</label>
              <button className="btn" data-testid="asset-register" disabled={saving || !assetTitle.trim() || !assetPath.trim()} onClick={() => void registerAsset()}>登记为待确认素材</button>
              {workspaceState.assets.map((asset) => <div className="campaign-asset-row" key={asset.id} data-testid={`asset-${asset.id}`}><span><strong>{asset.title}</strong> · {{ image: '图片', video: '视频', document: '文档', demo_url: '演示地址' }[asset.kind]} · {asset.feature || '通用'} · {asset.source === 'generated_illustration' ? '生成示意图' : asset.isReal ? '真实素材' : '素材'} · {asset.path}{asset.sourceNote ? ` · 来源：${asset.sourceNote}` : ''}</span><span>{asset.confirmed ? '已确认' : <><button className="btn" onClick={() => void reviewAsset(asset.id, true)}>确认可用</button><button className="btn" onClick={() => void reviewAsset(asset.id, false)}>撤销确认</button></>}</span></div>)}
            </section>
            <p className="settings-tip">每个版本单独确认方向；只有当前选题已确认且素材缺口清零后才能创建制作任务。成品按新路径登记版本，审核记录与路径会随项目同步。</p>
            <label className="field"><span>成果线</span>
              <select data-testid="campaign-kind" value={campaignKind} onChange={(event) => setCampaignKind(event.target.value as CampaignKind)}>
                <option value="feature_video">单功能视频</option><option value="system_deck">完整系统介绍 PPT</option>
              </select>
            </label>
            <label className="field"><span>选题标题</span><input data-testid="campaign-title" value={campaignTitle} onChange={(event) => setCampaignTitle(event.target.value)} placeholder="例如：腕表让护士不错过病房呼叫" /></label>
            {campaignKind === 'feature_video' ? <label className="field"><span>具体功能</span><input data-testid="campaign-feature" value={campaignFeature} onChange={(event) => setCampaignFeature(event.target.value)} placeholder="例如：腕表病房呼叫" /></label> : null}
            <label className="field"><span>一线医护使用场景</span><textarea rows={2} data-testid="campaign-story" value={campaignStory} onChange={(event) => setCampaignStory(event.target.value)} placeholder="描述具体角色、时刻、操作与改善" /></label>
            <label className="field"><span>传播渠道（每行一个）</span><textarea rows={2} data-testid="campaign-channels" value={campaignChannels} onChange={(event) => setCampaignChannels(event.target.value)} placeholder="微信私聊\n渠道群转发\n现场讲解" /></label>
            <label className="field"><span>核心卖点（每行一个）</span><textarea rows={3} data-testid="campaign-points" value={campaignPoints} onChange={(event) => setCampaignPoints(event.target.value)} placeholder="只填写已有资料能支持的产品事实" /></label>
            <label className="field"><span>待补素材（每行一个；清空后才能创建制作任务）</span><textarea rows={2} data-testid="campaign-materials" value={campaignMaterials} onChange={(event) => setCampaignMaterials(event.target.value)} placeholder="腕表实拍 / 已脱敏界面截图 / 接口说明" /></label>
            <button className="btn primary" data-testid="campaign-create" disabled={saving} onClick={() => void createCampaign()}>{editingCampaignId ? '保存为新选题版本' : '创建待确认选题'}</button>
            {editingCampaignId ? <button className="btn" data-testid="campaign-edit-cancel" onClick={() => setEditingCampaignId('')}>取消编辑</button> : null}
            {workspaceState.campaigns.map((campaign) => (
              <article key={campaign.id} className="campaign-card" data-testid={`campaign-${campaign.id}`}>
                <div className="campaign-card-head"><strong>{campaign.kind === 'system_deck' ? '完整系统 PPT' : '单功能视频'} · {campaign.title}</strong><span>方向 v{campaign.revision}{campaign.approvedRevision === campaign.revision ? ' · 已确认' : ' · 待确认'}</span></div>
                <p>功能：{campaign.feature || '完整系统'}；场景：{campaign.story || '未填写'}</p>
                <p>核心卖点：{campaign.sellingPoints.join('；')}</p>
                <p>渠道：{campaign.channels.join('、') || '待配置'}{campaign.materialsNeeded.length ? ` · 待补素材：${campaign.materialsNeeded.join('、')}` : ' · 素材缺口已清零'}</p>
                {campaign.directionFeedback ? <p className="campaign-feedback">方向意见：{campaign.directionFeedback}</p> : null}
                <button className="btn" data-testid={`campaign-edit-${campaign.id}`} onClick={() => editCampaign(campaign)}>编辑并提交新版本</button>
                {campaign.approvedRevision !== campaign.revision ? <div className="campaign-actions">
                  <input aria-label={`${campaign.title} 审阅意见`} data-testid={`campaign-feedback-${campaign.id}`} value={campaignFeedback[campaign.id] || ''} onChange={(event) => setCampaignFeedback((current) => ({ ...current, [campaign.id]: event.target.value }))} placeholder="退回时填写修改意见" />
                  <button className="btn" data-testid={`campaign-request-changes-${campaign.id}`} onClick={() => void decideDirection(campaign, 'changes_requested')}>退回修改</button>
                  <button className="btn primary" data-testid={`campaign-approve-${campaign.id}`} onClick={() => void decideDirection(campaign, 'approve')}>确认方向</button>
                </div> : null}
                {campaign.approvedRevision === campaign.revision && !campaign.productionTaskId ? <button className="btn primary" data-testid={`campaign-task-${campaign.id}`} disabled={saving || campaign.materialsNeeded.length > 0} onClick={() => void makeProductionTask(campaign)}>创建制作任务</button> : null}
                {campaign.productionTaskId ? <p data-testid={`campaign-task-linked-${campaign.id}`}>已关联制作任务 {campaign.productionTaskId}</p> : null}
                {campaign.approvedRevision === campaign.revision ? <div className="campaign-actions">
                  <input aria-label={`${campaign.title} 成品路径`} data-testid={`campaign-path-${campaign.id}`} value={deliveryPaths[campaign.id] || ''} onChange={(event) => setDeliveryPaths((current) => ({ ...current, [campaign.id]: event.target.value }))} placeholder="项目工作区中的相对路径，例如 宣传/腕表呼叫/v1.mp4" />
                  <button className="btn" data-testid={`campaign-submit-${campaign.id}`} disabled={!canStartCampaignProduction(campaign) || !campaign.productionTaskId || saving} onClick={() => void submitDelivery(campaign)}>提交新版本验收</button>
                </div> : null}
                {campaign.deliveries.map((delivery) => <div key={delivery.id} className="campaign-delivery" data-testid={`campaign-delivery-${delivery.id}`}>
                  <span>v{delivery.revision} · {delivery.path} · {delivery.status === 'in_review' ? '待验收' : delivery.status === 'accepted' ? '已验收' : '要求修改'}</span>
                  {delivery.feedback ? <span className="campaign-feedback">意见：{delivery.feedback}</span> : null}
                  {delivery.status === 'in_review' ? <div className="campaign-actions">
                    <input aria-label={`v${delivery.revision} 验收意见`} data-testid={`delivery-feedback-${delivery.id}`} value={campaignFeedback[delivery.id] || ''} onChange={(event) => setCampaignFeedback((current) => ({ ...current, [delivery.id]: event.target.value }))} placeholder="要求修改时填写意见" />
                    <button className="btn" data-testid={`delivery-request-changes-${delivery.id}`} onClick={() => void decideDelivery(campaign, delivery.id, 'changes_requested')}>要求修改</button>
                    <button className="btn primary" data-testid={`delivery-accept-${delivery.id}`} onClick={() => void decideDelivery(campaign, delivery.id, 'accepted')}>验收通过</button>
                  </div> : null}
                </div>)}
              </article>
            ))}
          </div>
        </div>

        {/* 群设置 Tab（切 Tab 不卸载，避免表单草稿丢失） */}
        <div style={{ display: tab === 'settings' ? undefined : 'none' }}>
          <div className="drawer-sec">群设置</div>
          <div className="group-settings" data-testid="group-settings">
            <label className="field">
              <span>群名 *</span>
              <input value={title} data-testid="group-settings-title" onChange={(e) => setTitle(e.target.value)} placeholder="如：Jeff 官网开发" />
            </label>
            <label className="field" style={{ width: 110 }}>
              <span>图标</span>
              <div className="emoji-input-row">
                <input value={icon} data-testid="group-settings-icon" onChange={(e) => setIcon(e.target.value)} />
                <EmojiPickerButton value={icon} onPick={setIcon} testId="group-icon-picker" />
              </div>
            </label>
            <label className="field">
              <span>群简介 / 项目背景（注入群聊 system）</span>
              <textarea
                rows={5}
                value={description}
                data-testid="group-settings-desc"
                onChange={(e) => setDescription(e.target.value)}
                placeholder="项目背景、约束、验收口径…会作为固定上下文注入群聊"
              />
            </label>
            <label className="field">
              <span>工作空间目录（不选 = Jeff 默认工作区）</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={workspaceDir}
                  data-testid="group-settings-workspace"
                  onChange={(e) => setWorkspaceDir(e.target.value)}
                  placeholder="留空 = Jeff 默认工作区"
                  style={{ flex: 1 }}
                />
                <button className="btn" type="button" onClick={() => void pickDir()}>
                  浏览…
                </button>
              </div>
            </label>
            <label className="field">
              <span>群主（leader）*</span>
              <select value={leaderId} data-testid="group-settings-leader" onChange={(e) => setLeaderId(e.target.value)}>
                <option value="">选择智能体…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.avatar} {a.name}
                    {a.builtin ? '（内置）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-actions" style={{ justifyContent: 'flex-start', marginTop: 4 }}>
              <button className="btn primary" data-testid="group-settings-save" disabled={saving || !title.trim() || !leaderId} onClick={() => void saveSettings()}>
                {saving ? '保存中…' : '保存群设置'}
              </button>
              {saveMsg && <span className="settings-tip">{saveMsg}</span>}
            </div>
          </div>

          <div className="drawer-danger">
            <button className="btn danger" data-testid="group-dissolve" onClick={() => void dissolve()}>
              解散群
            </button>
          </div>
        </div>

        {/* 群成员 Tab */}
        <div style={{ display: tab === 'members' ? undefined : 'none' }}>
          <div className="drawer-sec">
            成员（{members.length}）
            <button className="text-btn" data-testid="group-add-member" disabled={candidateAgents.length === 0} onClick={() => setAddingMember(true)}>
              + 添加成员
            </button>
          </div>
          <div className="member-list">
            {members.map((m) => {
              const isLeader = m.agent_id === (leaderId || project.leader_agent_id)
              return (
                <div key={m.agent_id} className="member-row">
                  <Avatar emoji={m.avatar} size={30} agentId={m.agent_id} />
                  <span className="member-name">{m.name}</span>
                  <span className={`tag ${isLeader ? 'tag-green' : ''}`}>{projectRoleLabel(isLeader ? 'leader' : m.role)}</span>
                  {!isLeader && (
                    <button
                      className="text-btn danger"
                      onClick={async () => {
                        await api.invoke(IPC.projectRemoveMember, { projectId: project.id, agentId: m.agent_id })
                        setMembers((prev) => prev.filter((x) => x.agent_id !== m.agent_id))
                        await refreshProjects()
                      }}
                    >
                      移出
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* 会话记录 Tab：与私聊「资料 → 聊天记录」共用同一面板（列表 + 预览，交互一致） */}
        <div style={{ display: tab === 'history' ? undefined : 'none' }}>
          <SessionHistoryPanel
            busy={busy}
            emptyText="还没有会话"
            tip="每一段都是整个项目群的对话历史（可由不同成员执行）；可改标题、继续或新开。"
            workspaceDir={workspaceForFiles}
            testId="group-chat-history"
            newBtnTestId="group-new-thread"
            titleTestIdPrefix="thread-title-"
            loadItems={async () => (await api.invoke<{ threads: GroupThreadBrief[] }>(IPC.groupThreadsList, { projectId: project.id })).threads}
            loadPreview={async (threadId) =>
              (await api.invoke<{ messages: GroupMessage[] }>(IPC.groupThreadPreview, { projectId: project.id, threadId })).messages
            }
            rename={async (threadId, next) => {
              await api.invoke(IPC.groupThreadRename, { projectId: project.id, threadId, title: next })
            }}
            activate={async (threadId) => {
              await api.invoke(IPC.groupThreadActivate, { projectId: project.id, threadId })
              await loadGroupHistory(project.id)
              onClose()
            }}
            remove={async (threadId) => {
              await api.invoke(IPC.groupThreadDelete, { projectId: project.id, threadId })
            }}
            createNew={async () => {
              await api.invoke(IPC.groupThreadNew, { projectId: project.id })
              await loadGroupHistory(project.id)
              onClose()
            }}
          />
        </div>

        {/* 工作区文件 Tab */}
        {tab === 'files' && (
          <div className="drawer-files">
            <p className="settings-tip" style={{ marginTop: 0 }}>
              浏览当前群工作空间的所有文件与文件夹；点击 .md 用内置预览器打开，其它文件用系统程序打开。
            </p>
            <WorkspaceFileTree dir={workspaceForFiles} />
          </div>
        )}

        {addingMember && (
          <AddMemberModal
            candidates={candidateAgents}
            onClose={() => setAddingMember(false)}
            onPick={async (agentId) => {
              await api.invoke(IPC.projectAddMember, { projectId: project.id, agentId })
              setAddingMember(false)
              await refreshMembers()
              await refreshProjects()
            }}
          />
        )}
      </div>
      {guard}
    </div>
  )
}

function AddMemberModal(props: {
  candidates: Array<{ id: string; name: string; avatar: string }>
  onClose: () => void
  onPick: (agentId: string) => Promise<void>
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props.onClose])

  return (
    <div className="modal-mask" data-testid="group-add-member-modal" onClick={props.onClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">添加工作者</div>
        {props.candidates.length === 0 ? (
          <p className="settings-tip">没有可添加的智能体了。先到「通讯录」或找小杰创建。</p>
        ) : (
          <div className="member-picker">
            {props.candidates.map((a) => (
              <button key={a.id} className="member-chip" type="button" onClick={() => void props.onPick(a.id)}>
                {a.avatar} {a.name}
              </button>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
