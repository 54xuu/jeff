/** Project-level facts shared by the desktop, phone, agent tools, and WebDAV sync. */
export interface ProjectWorkspaceState {
  schemaVersion: 4
  goal: string
  salesAudience: string
  storyAudience: string
  channels: string[]
  systemOutline: string[]
  weeklyCadence: string
  campaigns: CampaignProposal[]
  assets: ProjectAsset[]
  reportTemplates: ReportTemplate[]
  reportSources: ReportSourceRef[]
}

/** User-authored reporting outline; periodType remains open for future report cadences. */
export interface ReportTemplate {
  id: string
  name: string
  periodType: string
  sections: string[]
  outputFormat: 'markdown'
  updatedAt: number
}

/** A SiYuan document only becomes an approved report source after explicit user selection. */
export interface ReportSourceRef {
  docId: string
  title: string
  path: string
  /** Report date may differ from SiYuan's creation timestamp for late-entered daily notes. */
  reportDate: string
  confirmedAt: number
}

export type ReportTemplateInput = Omit<ReportTemplate, 'id' | 'updatedAt'>
export type ReportSourceCandidate = Pick<ReportSourceRef, 'docId' | 'title' | 'path' | 'reportDate'>

export function saveReportTemplate(state: ProjectWorkspaceState, input: ReportTemplateInput, id?: string, at = Date.now()): ProjectWorkspaceState {
  const template = normalizeReportTemplate({ ...input, id: id || newId('rpt'), updatedAt: at })
  if (!template.name || !template.periodType || !template.sections.length) throw new Error('模板名称、周期类型和至少一个栏目必填')
  const exists = state.reportTemplates.some((item) => item.id === template.id)
  if (id && !exists) throw new Error('报告模板不存在')
  if (state.reportTemplates.some((item) => item.id !== template.id && item.name === template.name)) throw new Error('模板名称已存在')
  const reportTemplates = exists ? state.reportTemplates.map((item) => item.id === template.id ? template : item) : [template, ...state.reportTemplates]
  return { ...state, schemaVersion: 4, reportTemplates }
}

export function deleteReportTemplate(state: ProjectWorkspaceState, id: string): ProjectWorkspaceState {
  if (!state.reportTemplates.some((item) => item.id === id)) throw new Error('报告模板不存在')
  return { ...state, schemaVersion: 4, reportTemplates: state.reportTemplates.filter((item) => item.id !== id) }
}

/** Persist only sources the user selected from current SiYuan search results. */
export function confirmReportSources(state: ProjectWorkspaceState, candidates: ReportSourceCandidate[], at = Date.now()): ProjectWorkspaceState {
  const known = new Map(state.reportSources.map((source) => [source.docId, source]))
  for (const candidate of candidates) {
    if (!/^\d{14}-[0-9a-z]{7}$/.test(candidate.docId)) throw new Error(`思源文档 ID 格式无效：${candidate.docId}`)
    const title = candidate.title.trim()
    const path = candidate.path.trim()
    if (!title || !path) throw new Error('来源标题与路径不能为空')
    if (!isISODate(candidate.reportDate)) throw new Error(`日报日期无效：${candidate.reportDate}`)
    known.set(candidate.docId, { docId: candidate.docId, title, path, reportDate: candidate.reportDate, confirmedAt: at })
  }
  if (!candidates.length) throw new Error('至少选择一篇日报来源')
  return { ...state, schemaVersion: 4, reportSources: [...known.values()].sort((a, b) => b.confirmedAt - a.confirmedAt) }
}

export function removeReportSource(state: ProjectWorkspaceState, docId: string): ProjectWorkspaceState {
  return { ...state, schemaVersion: 4, reportSources: state.reportSources.filter((source) => source.docId !== docId) }
}

export type ProjectAssetKind = 'image' | 'video' | 'document' | 'demo_url'
export type ProjectAssetSource = 'user_provided' | 'authorized_screenshot' | 'generated_illustration' | 'demo_material' | 'unverified_candidate'
export interface ProjectAsset {
  id: string
  title: string
  kind: ProjectAssetKind
  feature: string
  path: string
  source: ProjectAssetSource
  sourceNote: string
  isReal: boolean
  confirmed: boolean
  createdAt: number
}

export type CampaignKind = 'system_deck' | 'feature_video'
export type CampaignDeliveryStatus = 'in_review' | 'accepted' | 'changes_requested'

export interface CampaignDelivery {
  id: string
  revision: number
  path: string
  status: CampaignDeliveryStatus
  submittedAt: number
  reviewedAt: number | null
  feedback: string
}

/** Direction approval is tied to a proposal revision; edits invalidate it. */
export interface CampaignProposal {
  id: string
  kind: CampaignKind
  title: string
  feature: string
  story: string
  channels: string[]
  sellingPoints: string[]
  materialsNeeded: string[]
  assetIds: string[]
  revision: number
  approvedRevision: number | null
  directionFeedback: string
  directionReviews: CampaignDirectionReview[]
  productionTaskId: string
  updatedAt: number
  deliveries: CampaignDelivery[]
}

export interface CampaignProposalInput {
  kind: CampaignKind
  title: string
  feature: string
  story: string
  channels: string[]
  sellingPoints: string[]
  materialsNeeded: string[]
}

export interface CampaignDirectionReview {
  id: string
  revision: number
  decision: 'approve' | 'changes_requested'
  reviewedAt: number
  feedback: string
}

export const EMPTY_PROJECT_WORKSPACE: ProjectWorkspaceState = {
  schemaVersion: 4,
  goal: '',
  salesAudience: '',
  storyAudience: '',
  channels: [],
  systemOutline: [],
  weeklyCadence: '',
  campaigns: [],
  assets: [],
  reportTemplates: [],
  reportSources: [],
}

/** Older projects (and older remote backups) have no workspace state. */
export function parseProjectWorkspaceState(raw: string | null | undefined): ProjectWorkspaceState {
  if (!raw) return { ...EMPTY_PROJECT_WORKSPACE }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_PROJECT_WORKSPACE }
    return {
      schemaVersion: 4,
      goal: typeof value.goal === 'string' ? value.goal.trim() : '',
      salesAudience: typeof value.salesAudience === 'string' ? value.salesAudience.trim() : '',
      storyAudience: typeof value.storyAudience === 'string' ? value.storyAudience.trim() : '',
      channels: stringList(value.channels),
      systemOutline: stringList(value.systemOutline),
      weeklyCadence: typeof value.weeklyCadence === 'string' ? value.weeklyCadence.trim() : '',
      campaigns: campaignList(value.campaigns),
      assets: assetList(value.assets),
      reportTemplates: reportTemplateList(value.reportTemplates),
      reportSources: reportSourceList(value.reportSources),
    }
  } catch {
    return { ...EMPTY_PROJECT_WORKSPACE }
  }
}

export function serializeProjectWorkspaceState(state: ProjectWorkspaceState): string {
  return JSON.stringify({
    schemaVersion: 4,
    goal: state.goal.trim(),
    salesAudience: state.salesAudience.trim(),
    storyAudience: state.storyAudience.trim(),
    channels: cleanLines(state.channels),
    systemOutline: cleanLines(state.systemOutline),
    weeklyCadence: state.weeklyCadence.trim(),
    campaigns: state.campaigns.map(normalizeCampaign),
    assets: state.assets.map(normalizeAsset),
    reportTemplates: state.reportTemplates.map(normalizeReportTemplate),
    reportSources: state.reportSources.map(normalizeReportSource),
  })
}

export function registerProjectAsset(state: ProjectWorkspaceState, input: Omit<ProjectAsset, 'id' | 'createdAt' | 'confirmed'>, at = Date.now()): ProjectWorkspaceState {
  const asset = normalizeAsset({ ...input, id: '', createdAt: at, confirmed: false })
  if (!asset.title) throw new Error('素材名称不能为空')
  if (!asset.path) throw new Error('请填写工作区内的文件路径或演示地址')
  if (asset.source === 'generated_illustration' && asset.isReal) throw new Error('生成示意图不能标记为真实产品素材')
  return { ...state, schemaVersion: 4, assets: [{ ...asset, id: newId('asset'), createdAt: at }, ...state.assets] }
}

export function reviewProjectAsset(state: ProjectWorkspaceState, id: string, confirmed: boolean): ProjectWorkspaceState {
  const asset = state.assets.find((item) => item.id === id)
  if (!asset) throw new Error('找不到该素材')
  return { ...state, assets: state.assets.map((item) => item.id === id ? { ...item, confirmed } : item) }
}

export function resolveCampaignMaterial(state: ProjectWorkspaceState, campaignId: string, need: string, assetId: string): ProjectWorkspaceState {
  const campaign = requireCampaign(state, campaignId)
  const normalizedNeed = need.trim()
  const asset = state.assets.find((item) => item.id === assetId)
  if (!normalizedNeed || !campaign.materialsNeeded.includes(normalizedNeed)) throw new Error('该选题没有此待补素材项')
  if (!asset || !asset.confirmed) throw new Error('只能使用已确认可用的项目素材')
  if (asset.feature && campaign.feature && asset.feature !== campaign.feature) throw new Error('素材所属功能与选题功能不一致')
  return replaceCampaign(state, campaignId, {
    ...campaign,
    materialsNeeded: campaign.materialsNeeded.filter((item) => item !== normalizedNeed),
    assetIds: [...new Set([...campaign.assetIds, asset.id])],
    updatedAt: Date.now(),
  })
}

export function validateProjectWorkspaceJson(raw: string): string {
  if (!raw.trim()) throw new Error('项目工作台配置不能为空；需要提供完整 JSON 对象')
  if (raw.length > 200_000) throw new Error('项目工作台配置超过 200KB，请移除素材正文，只保存事实与文件引用')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('项目工作台配置必须是合法 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目工作台配置顶层必须是 JSON 对象')
  return serializeProjectWorkspaceState(parseProjectWorkspaceState(JSON.stringify(value)))
}

export function createCampaignProposal(state: ProjectWorkspaceState, input: CampaignProposalInput, at = Date.now()): ProjectWorkspaceState {
  const proposal = normalizeProposalInput(input)
  if (!proposal.title) throw new Error('选题标题不能为空')
  if (proposal.kind === 'feature_video' && !proposal.feature) throw new Error('单功能视频必须填写具体功能')
  if (proposal.sellingPoints.length === 0) throw new Error('至少填写一个核心卖点')
  return { ...state, schemaVersion: 4, campaigns: [{ ...proposal, id: newId('cmp'), revision: 1, approvedRevision: null, directionFeedback: '', directionReviews: [], productionTaskId: '', updatedAt: at, deliveries: [] }, ...state.campaigns] }
}

export function updateCampaignProposal(state: ProjectWorkspaceState, id: string, input: CampaignProposalInput, at = Date.now()): ProjectWorkspaceState {
  const current = requireCampaign(state, id)
  const proposal = normalizeProposalInput(input)
  if (!proposal.title) throw new Error('选题标题不能为空')
  if (proposal.kind === 'feature_video' && !proposal.feature) throw new Error('单功能视频必须填写具体功能')
  if (proposal.sellingPoints.length === 0) throw new Error('至少填写一个核心卖点')
  return replaceCampaign(state, id, {
    ...current,
    ...proposal,
    revision: current.revision + 1,
    approvedRevision: null,
    directionFeedback: '',
    directionReviews: current.directionReviews,
    productionTaskId: '',
    updatedAt: at,
  })
}

export function attachCampaignProductionTask(state: ProjectWorkspaceState, id: string, taskId: string): ProjectWorkspaceState {
  const current = requireCampaign(state, id)
  if (!canStartCampaignProduction(current)) throw new Error('选题方向尚未确认或仍有待补素材，不能创建制作任务')
  if (!taskId.trim()) throw new Error('制作任务 ID 不能为空')
  if (current.productionTaskId && current.productionTaskId !== taskId) throw new Error('该选题已关联制作任务，不能重复创建')
  return replaceCampaign(state, id, { ...current, productionTaskId: taskId.trim(), updatedAt: Date.now() })
}

export function reviewCampaignDirection(state: ProjectWorkspaceState, id: string, decision: 'approve' | 'changes_requested', feedback = '', at = Date.now()): ProjectWorkspaceState {
  const current = requireCampaign(state, id)
  if (decision === 'changes_requested' && !feedback.trim()) throw new Error('请填写选题修改意见')
  return replaceCampaign(state, id, {
    ...current,
    approvedRevision: decision === 'approve' ? current.revision : null,
    directionFeedback: feedback.trim(),
    directionReviews: [...current.directionReviews, { id: newId('rev'), revision: current.revision, decision, feedback: feedback.trim(), reviewedAt: at }],
    updatedAt: at,
  })
}

export function canStartCampaignProduction(campaign: CampaignProposal): boolean {
  return campaign.approvedRevision === campaign.revision && campaign.materialsNeeded.length === 0
}

export function submitCampaignDelivery(state: ProjectWorkspaceState, id: string, path: string, at = Date.now()): ProjectWorkspaceState {
  const current = requireCampaign(state, id)
  const cleanPath = path.trim()
  if (!canStartCampaignProduction(current) || !current.productionTaskId) throw new Error('方向、素材或制作任务尚未就绪，暂不能提交成品')
  if (!cleanPath) throw new Error('请填写成品文件路径')
  if (current.deliveries.some((delivery) => delivery.path === cleanPath)) throw new Error('该路径已登记为旧版本，请为新版本使用新的文件路径')
  const delivery: CampaignDelivery = {
    id: newId('out'), revision: current.deliveries.length + 1, path: cleanPath,
    status: 'in_review', submittedAt: at, reviewedAt: null, feedback: '',
  }
  return replaceCampaign(state, id, { ...current, deliveries: [delivery, ...current.deliveries], updatedAt: at })
}

export function reviewCampaignDelivery(state: ProjectWorkspaceState, id: string, deliveryId: string, decision: 'accepted' | 'changes_requested', feedback = '', at = Date.now()): ProjectWorkspaceState {
  const current = requireCampaign(state, id)
  const delivery = current.deliveries.find((item) => item.id === deliveryId)
  if (!delivery) throw new Error('找不到该版本成品')
  if (delivery.status !== 'in_review') throw new Error('只有待验收版本可以审核')
  if (decision === 'changes_requested' && !feedback.trim()) throw new Error('请填写成品修改意见')
  return replaceCampaign(state, id, {
    ...current,
    deliveries: current.deliveries.map((item) => item.id === deliveryId ? { ...item, status: decision, feedback: feedback.trim(), reviewedAt: at } : item),
    updatedAt: at,
  })
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : []
}

function cleanLines(value: string[]): string[] {
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
}

function campaignList(value: unknown): CampaignProposal[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => normalizeCampaign(item))
    .filter((item) => Boolean(item.id && item.title))
}

function assetList(value: unknown): ProjectAsset[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map(normalizeAsset).filter((item) => Boolean(item.id && item.title && item.path))
}

function reportTemplateList(value: unknown): ReportTemplate[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map(normalizeReportTemplate).filter((item) => Boolean(item.id && item.name && item.periodType && item.sections.length))
}

function reportSourceList(value: unknown): ReportSourceRef[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map(normalizeReportSource).filter((item) => /^\d{14}-[0-9a-z]{7}$/.test(item.docId) && item.title && item.path && isISODate(item.reportDate))
}

function normalizeReportTemplate(value: Record<string, unknown> | ReportTemplate): ReportTemplate {
  return {
    id: typeof value.id === 'string' ? value.id : '',
    name: typeof value.name === 'string' ? value.name.trim() : '',
    periodType: typeof value.periodType === 'string' ? value.periodType.trim() : '',
    sections: stringList(value.sections),
    outputFormat: 'markdown',
    updatedAt: finiteNumber(value.updatedAt, 0),
  }
}

function normalizeReportSource(value: Record<string, unknown> | ReportSourceRef): ReportSourceRef {
  const docId = typeof value.docId === 'string' ? value.docId.trim() : ''
  const fallbackDate = /^\d{14}-[0-9a-z]{7}$/.test(docId) ? `${docId.slice(0, 4)}-${docId.slice(4, 6)}-${docId.slice(6, 8)}` : ''
  const candidateDate = typeof value.reportDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.reportDate) ? value.reportDate : fallbackDate
  return {
    docId,
    title: typeof value.title === 'string' ? value.title.trim() : '',
    path: typeof value.path === 'string' ? value.path.trim() : '',
    reportDate: isISODate(candidateDate) ? candidateDate : '',
    confirmedAt: finiteNumber(value.confirmedAt, 0),
  }
}

export function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function normalizeAsset(value: Record<string, unknown> | ProjectAsset): ProjectAsset {
  const source: ProjectAssetSource = value.source === 'authorized_screenshot' || value.source === 'generated_illustration' || value.source === 'demo_material' || value.source === 'unverified_candidate' ? value.source : 'user_provided'
  return {
    id: typeof value.id === 'string' ? value.id : '',
    title: typeof value.title === 'string' ? value.title.trim() : '',
    kind: value.kind === 'video' || value.kind === 'document' || value.kind === 'demo_url' ? value.kind : 'image',
    feature: typeof value.feature === 'string' ? value.feature.trim() : '',
    path: typeof value.path === 'string' ? value.path.trim() : '',
    source,
    sourceNote: typeof value.sourceNote === 'string' ? value.sourceNote.trim() : '',
    isReal: value.isReal === true,
    confirmed: value.confirmed === true,
    createdAt: finiteNumber(value.createdAt, 0),
  }
}

function normalizeCampaign(value: Record<string, unknown> | CampaignProposal): CampaignProposal {
  const kind: CampaignKind = value.kind === 'system_deck' ? 'system_deck' : 'feature_video'
  const revision = positiveInteger(value.revision, 1)
  const deliveries = Array.isArray(value.deliveries) ? value.deliveries.filter(isRecord).map((delivery, index) => ({
    id: typeof delivery.id === 'string' ? delivery.id : `out_legacy_${index + 1}`,
    revision: positiveInteger(delivery.revision, index + 1),
    path: typeof delivery.path === 'string' ? delivery.path : '',
    status: delivery.status === 'accepted' ? 'accepted' as const : delivery.status === 'changes_requested' ? 'changes_requested' as const : 'in_review' as const,
    submittedAt: finiteNumber(delivery.submittedAt, 0),
    reviewedAt: typeof delivery.reviewedAt === 'number' ? delivery.reviewedAt : null,
    feedback: typeof delivery.feedback === 'string' ? delivery.feedback : '',
  })).filter((delivery) => delivery.path) : []
  const directionReviews = Array.isArray(value.directionReviews) ? value.directionReviews.filter(isRecord).map((review, index) => ({
    id: typeof review.id === 'string' ? review.id : `rev_legacy_${index + 1}`,
    revision: positiveInteger(review.revision, 1),
    decision: review.decision === 'approve' ? 'approve' as const : 'changes_requested' as const,
    reviewedAt: finiteNumber(review.reviewedAt, 0),
    feedback: typeof review.feedback === 'string' ? review.feedback : '',
  })) : []
  return {
    id: typeof value.id === 'string' ? value.id : '',
    kind,
    title: typeof value.title === 'string' ? value.title.trim() : '',
    feature: typeof value.feature === 'string' ? value.feature.trim() : '',
    story: typeof value.story === 'string' ? value.story.trim() : '',
    channels: stringList(value.channels),
    sellingPoints: stringList(value.sellingPoints),
    materialsNeeded: stringList(value.materialsNeeded),
    assetIds: stringList(value.assetIds),
    revision,
    approvedRevision: typeof value.approvedRevision === 'number' && value.approvedRevision === revision ? revision : null,
    directionFeedback: typeof value.directionFeedback === 'string' ? value.directionFeedback : '',
    directionReviews,
    productionTaskId: typeof value.productionTaskId === 'string' ? value.productionTaskId : '',
    updatedAt: finiteNumber(value.updatedAt, 0),
    deliveries,
  }
}

function normalizeProposalInput(input: CampaignProposalInput): Omit<CampaignProposal, 'id' | 'revision' | 'approvedRevision' | 'directionFeedback' | 'directionReviews' | 'productionTaskId' | 'updatedAt' | 'deliveries'> {
  if (input.kind !== 'system_deck' && input.kind !== 'feature_video') throw new Error('成果线类型无效')
  return {
    kind: input.kind,
    title: input.title.trim(),
    feature: input.feature.trim(),
    story: input.story.trim(),
    channels: cleanLines(input.channels),
    sellingPoints: cleanLines(input.sellingPoints),
    materialsNeeded: cleanLines(input.materialsNeeded),
    assetIds: [],
  }
}

function requireCampaign(state: ProjectWorkspaceState, id: string): CampaignProposal {
  const campaign = state.campaigns.find((item) => item.id === id)
  if (!campaign) throw new Error('找不到该宣传选题')
  return campaign
}

function replaceCampaign(state: ProjectWorkspaceState, id: string, campaign: CampaignProposal): ProjectWorkspaceState {
  return { ...state, campaigns: state.campaigns.map((item) => item.id === id ? campaign : item) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}
