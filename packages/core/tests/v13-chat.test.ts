import { describe, it, expect } from 'vitest'
import { PrivateChat, type ChatMsg } from '../src/chat/private.js'
import type { OcClient, SessionMessage } from '../src/oc/client.js'
import { configuredModelOptions, type ProviderSetting } from '../src/oc/configWriter.js'

/** 构造带 reasoning/tool parts 的假 oc 客户端，验证历史映射 */
function fakeClient(msgs: SessionMessage[]): OcClient {
  return { getMessages: async () => msgs } as unknown as OcClient
}

function assistantMsg(parts: unknown[]): SessionMessage {
  return { info: { id: 'asst-1', role: 'assistant', time: { created: 100 } }, parts } as unknown as SessionMessage
}

describe('mapSessionMessages（v1.3 思考/工具提取）', () => {
  it('提取 reasoning parts 到 ChatMsg.reasoning；text 与 tool 行为不变', async () => {
    const chat = new PrivateChat({} as never, () => fakeClient([assistantMsg([
      { type: 'reasoning', text: '先分析需求' },
      { type: 'reasoning', text: '再写代码' },
      { type: 'tool', tool: 'bash', state: { status: 'completed', output: 'ok' } },
      { type: 'text', text: '完成' },
    ])]))
    const out: ChatMsg[] = await chat.mapSessionMessages('s1')
    expect(out).toHaveLength(1)
    expect(out[0].reasoning).toEqual(['先分析需求', '再写代码'])
    expect(out[0].tools).toEqual([{ tool: 'bash', status: 'completed', output: 'ok', error: undefined }])
    expect(out[0].text).toBe('完成')
  })

  it('中间工具步的正文归入 reasoning（非最后一条），最终答复仍在正文', async () => {
    // 回归：部分模型把工具调用前的推导写在正文里，只返回最后一条会导致「流式可见、历史消失」
    const msgs: SessionMessage[] = [
      { info: { id: 'u1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: '算数据' }] } as unknown as SessionMessage,
      {
        info: { id: 'a1', role: 'assistant', time: { created: 2 } },
        parts: [
          { type: 'text', text: '思路：先读 CSV 再求和' },
          { type: 'tool', tool: 'read', state: { status: 'completed', output: '88,92,75' } },
        ],
      } as unknown as SessionMessage,
      {
        info: { id: 'a2', role: 'assistant', time: { created: 3 } },
        parts: [{ type: 'text', text: '总分 255' }],
      } as unknown as SessionMessage,
    ]
    const chat = new PrivateChat({} as never, () => fakeClient(msgs))
    const out = await chat.mapSessionMessages('s1')
    const a1 = out.find((m) => m.id === 'a1')
    const a2 = out.find((m) => m.id === 'a2')
    expect(a1?.reasoning).toEqual(['思路：先读 CSV 再求和'])
    expect(a1?.text).toBe('')
    expect(a2?.text).toBe('总分 255')
    expect(a2?.reasoning).toBeUndefined()
  })

  it('没有 reasoning 时不产出 reasoning 字段；纯 reasoning assistant 消息（无文本无工具）被跳过', async () => {
    const chat = new PrivateChat({} as never, () => fakeClient([
      assistantMsg([{ type: 'text', text: 'hi' }]),
      assistantMsg([{ type: 'reasoning', text: '只有思考' }]),
    ]))
    const out = await chat.mapSessionMessages('s1')
    expect(out).toHaveLength(1)
    expect(out[0].reasoning).toBeUndefined()
  })
})

describe('configuredModelOptions（模型目录只来自供应商配置）', () => {
  it('只含启用提供商的模型，label 与档位正确', () => {
    const providers: ProviderSetting[] = [
      { id: 'on', name: '我的中转', apiFormat: 'chat', enabled: true, models: [
        { id: 'm1', attachment: true, contextLimit: 128000, thinkingTiers: ['none', 'high'] },
        { id: 'm2' },
      ] },
      { id: 'off', name: '停用', apiFormat: 'chat', enabled: false, models: [{ id: 'm3' }] },
    ]
    const opts = configuredModelOptions(providers)
    expect(opts.map((o) => o.modelID)).toEqual(['m1', 'm2']) // 禁用提供商的模型不出现
    expect(opts[0].label).toBe('我的中转 / m1')
    expect(opts[0].providerName).toBe('我的中转')
    expect(opts[0].attachment).toBe(true)
    expect(opts[0].thinkingTiers).toEqual(['none', 'high'])
  })
})
