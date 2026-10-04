import { describe, expect, it } from 'vitest'
import {
  EMPTY_PROJECT_WORKSPACE, parseProjectWorkspaceState, serializeProjectWorkspaceState, validateProjectWorkspaceJson,
  createCampaignProposal, reviewCampaignDirection, canStartCampaignProduction, attachCampaignProductionTask,
  submitCampaignDelivery, reviewCampaignDelivery, updateCampaignProposal,
  registerProjectAsset, reviewProjectAsset,
  resolveCampaignMaterial,
  saveReportTemplate, confirmReportSources, removeReportSource,
} from '../src/project/workspace.js'

describe('project workspace profile', () => {
  it('older/invalid project state opens as an empty editable workspace', () => {
    expect(parseProjectWorkspaceState(undefined)).toEqual(EMPTY_PROJECT_WORKSPACE)
    expect(parseProjectWorkspaceState('{')).toEqual(EMPTY_PROJECT_WORKSPACE)
    expect(parseProjectWorkspaceState('[]')).toEqual(EMPTY_PROJECT_WORKSPACE)
  })

  it('keeps project asset provenance and user confirmation separate from ordinary profile edits', () => {
    expect(() => registerProjectAsset(EMPTY_PROJECT_WORKSPACE, {
      title: '示意图', kind: 'image', feature: '', path: 'assets/mock.png',
      source: 'generated_illustration', sourceNote: '', isReal: true,
    })).toThrow(/不能标记为真实/)
    let state = registerProjectAsset(EMPTY_PROJECT_WORKSPACE, {
      title: '腕表界面示意图', kind: 'image', feature: '病房呼叫', path: 'assets/watch.png',
      source: 'generated_illustration', sourceNote: '由绘图 Agent 生成', isReal: false,
    }, 42)
    expect(state.assets[0]).toMatchObject({ title: '腕表界面示意图', source: 'generated_illustration', isReal: false, confirmed: false, createdAt: 42 })
    state = reviewProjectAsset(state, state.assets[0]!.id, true)
    expect(state.assets[0]?.confirmed).toBe(true)
    expect(parseProjectWorkspaceState(serializeProjectWorkspaceState(state)).assets).toEqual(state.assets)
  })

  it('trims editable lists and migrates old profile data to the current schema', () => {
    const raw = serializeProjectWorkspaceState({
      schemaVersion: 4,
      goal: ' 宣传腕表方案 ',
      salesAudience: ' 渠道商 ',
      storyAudience: ' 一线医护 ',
      channels: ['微信', ' ', '现场'],
      systemOutline: ['整体方案', '功能介绍'],
      weeklyCadence: '每周一批',
      campaigns: [],
      assets: [],
      reportTemplates: [],
      reportSources: [],
    })
    const legacy = parseProjectWorkspaceState(JSON.stringify({ schemaVersion: 1, goal: ' 宣传腕表方案 ', channels: [' 微信 '] }))
    expect(legacy).toMatchObject({ schemaVersion: 4, goal: '宣传腕表方案', channels: ['微信'], campaigns: [], assets: [], reportTemplates: [], reportSources: [] })
    expect(parseProjectWorkspaceState(raw)).toEqual({
      schemaVersion: 4,
      goal: '宣传腕表方案',
      salesAudience: '渠道商',
      storyAudience: '一线医护',
      channels: ['微信', '现场'],
      systemOutline: ['整体方案', '功能介绍'],
      weeklyCadence: '每周一批',
      campaigns: [],
      assets: [],
      reportTemplates: [],
      reportSources: [],
    })
  })

  it('支持开放周期类型报告模板，并且只登记经过格式校验的思源文档来源', () => {
    let state = saveReportTemplate(EMPTY_PROJECT_WORKSPACE, { name: '研发月报', periodType: '月报', sections: ['完成事项', '风险'], outputFormat: 'markdown' }, undefined, 100)
    const template = state.reportTemplates[0]!
    expect(template).toMatchObject({ name: '研发月报', periodType: '月报', sections: ['完成事项', '风险'], updatedAt: 100 })
    state = saveReportTemplate(state, { name: '年度技术总结', periodType: '年度复盘', sections: ['成果'], outputFormat: 'markdown' }, undefined, 101)
    expect(state.reportTemplates).toHaveLength(2)
    state = confirmReportSources(state, [{ docId: '20261005123456-abc1234', title: '10 月 5 日日报', path: '/日报/2026/10/05', reportDate: '2026-10-04' }], 102)
    expect(state.reportSources[0]).toMatchObject({ docId: '20261005123456-abc1234', reportDate: '2026-10-04', confirmedAt: 102 })
    expect(() => confirmReportSources(state, [{ docId: 'not-a-siyuan-id', title: 'bad', path: '/bad', reportDate: '2026-10-05' }])).toThrow('格式无效')
    expect(() => confirmReportSources(state, [{ docId: '20261005123456-abc1234', title: '日报', path: '/', reportDate: '2026-13-40' }])).toThrow('日报日期无效')
    expect(removeReportSource(state, '20261005123456-abc1234').reportSources).toEqual([])
    expect(parseProjectWorkspaceState(serializeProjectWorkspaceState(state))).toEqual(state)
  })

  it('holds production until direction and materials are approved, and records output review by version', () => {
    let state = createCampaignProposal(EMPTY_PROJECT_WORKSPACE, {
      kind: 'feature_video', title: '腕表病房呼叫', feature: '病房呼叫',
      story: '护士忙碌时通过腕表接收呼叫并及时响应', channels: ['渠道群'], sellingPoints: ['降低漏接风险'], materialsNeeded: ['腕表实拍'],
    }, 10)
    const campaign = state.campaigns[0]!
    expect(canStartCampaignProduction(campaign)).toBe(false)
    state = reviewCampaignDirection(state, campaign.id, 'approve', '', 11)
    expect(canStartCampaignProduction(state.campaigns[0]!)).toBe(false)
    expect(() => attachCampaignProductionTask(state, campaign.id, 'task_1')).toThrow(/待补素材/)

    state = updateCampaignProposal(state, campaign.id, {
      kind: 'feature_video', title: campaign.title, feature: campaign.feature, story: campaign.story,
      channels: campaign.channels, sellingPoints: campaign.sellingPoints, materialsNeeded: [],
    }, 12)
    expect(state.campaigns[0]?.approvedRevision).toBeNull()
    state = reviewCampaignDirection(state, campaign.id, 'approve', '', 13)
    expect(canStartCampaignProduction(state.campaigns[0]!)).toBe(true)
    state = attachCampaignProductionTask(state, campaign.id, 'task_1')
    state = submitCampaignDelivery(state, campaign.id, '宣传/腕表病房呼叫/v1.mp4', 14)
    const delivery = state.campaigns[0]!.deliveries[0]!
    expect(delivery).toMatchObject({ revision: 1, status: 'in_review', path: '宣传/腕表病房呼叫/v1.mp4' })
    state = reviewCampaignDelivery(state, campaign.id, delivery.id, 'changes_requested', '字幕里的术语请调整', 15)
    expect(state.campaigns[0]!.deliveries[0]).toMatchObject({ status: 'changes_requested', feedback: '字幕里的术语请调整', reviewedAt: 15 })
    state = submitCampaignDelivery(state, campaign.id, '宣传/腕表病房呼叫/v2.mp4', 16)
    expect(state.campaigns[0]!.deliveries.map((item) => item.revision)).toEqual([2, 1])
    expect(() => submitCampaignDelivery(state, campaign.id, '宣传/腕表病房呼叫/v2.mp4')).toThrow(/旧版本/)
    const serialized = serializeProjectWorkspaceState(state)
    expect(parseProjectWorkspaceState(serialized).campaigns[0]!.productionTaskId).toBe('task_1')
  })

  it('only a confirmed compatible asset can resolve a campaign material gap', () => {
    let state = registerProjectAsset(EMPTY_PROJECT_WORKSPACE, {
      title: '腕表照片', kind: 'image', feature: '病房呼叫', path: 'assets/watch.png', source: 'user_provided', sourceNote: '', isReal: true,
    })
    const asset = state.assets[0]!
    state = createCampaignProposal(state, {
      kind: 'feature_video', title: '护士接收病房呼叫', feature: '病房呼叫', story: '', channels: [], sellingPoints: ['快速响应'], materialsNeeded: ['腕表实拍'],
    })
    const campaign = state.campaigns[0]!
    expect(() => resolveCampaignMaterial(state, campaign.id, '腕表实拍', asset.id)).toThrow(/已确认可用/)
    state = reviewProjectAsset(state, asset.id, true)
    state = resolveCampaignMaterial(state, campaign.id, '腕表实拍', asset.id)
    expect(state.campaigns[0]).toMatchObject({ materialsNeeded: [], assetIds: [asset.id] })
    expect(canStartCampaignProduction(state.campaigns[0]!)).toBe(false)
    state = reviewCampaignDirection(state, campaign.id, 'approve')
    expect(canStartCampaignProduction(state.campaigns[0]!)).toBe(true)
  })

  it('rejects malformed, non-object, empty, and oversized JSON', () => {
    expect(() => validateProjectWorkspaceJson('')).toThrow(/不能为空/)
    expect(() => validateProjectWorkspaceJson('{')).toThrow(/合法 JSON/)
    expect(() => validateProjectWorkspaceJson('[]')).toThrow(/顶层/)
    expect(() => validateProjectWorkspaceJson(`{"x":"${'x'.repeat(200_000)}"}`)).toThrow(/200KB/)
  })
})
