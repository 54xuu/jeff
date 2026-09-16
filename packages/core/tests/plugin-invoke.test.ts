import { describe, expect, it } from 'vitest'
import { PLUGIN_MCP_PREFIX } from '../src/plugins/const.js'
import {
  decodePluginUserMessage,
  encodePluginUserMessage,
  pluginConstraint,
  resolveSendText,
} from '../src/plugins/invoke.js'

describe('插件调用编解码', () => {
  const invoke = { id: 'zhbf-night', name: '智慧病房', command: '/zhbf', at: 6, icon: '🏥' }

  it('编码后模型文本含短约束与 MCP 前缀，不含工具分流表', () => {
    const raw = encodePluginUserMessage(invoke, '帮我查一下今天入院人数')
    expect(raw).toContain('<!--jeff-plugin:')
    expect(raw).toContain(pluginConstraint(invoke))
    expect(raw).toContain(`${PLUGIN_MCP_PREFIX}zhbf-night`)
    expect(raw).toContain('帮我查一下今天入院人数')
    expect(raw).not.toContain('board_today_admissions')
    expect(raw).not.toContain('ward_labs')
  })

  it('解码还原用户原话、筹码位置与快照，气泡看不到约束', () => {
    const raw = encodePluginUserMessage(invoke, '帮我查一下今天入院人数')
    const d = decodePluginUserMessage(raw)
    expect(d.displayText).toBe('帮我查一下今天入院人数')
    expect(d.invoke).toEqual(invoke)
    expect(d.displayText).not.toContain('请使用插件')
    expect(d.displayText).not.toContain('<!--')
  })

  it('空正文（只发筹码）也能编解码', () => {
    const raw = encodePluginUserMessage({ ...invoke, at: 0 }, '')
    const d = decodePluginUserMessage(raw)
    expect(d.displayText).toBe('')
    expect(d.invoke?.id).toBe('zhbf-night')
    expect(d.invoke?.at).toBe(0)
  })

  it('普通消息原样返回', () => {
    expect(decodePluginUserMessage('今天入院多少人？')).toEqual({ displayText: '今天入院多少人？' })
    expect(resolveSendText('hello')).toBe('hello')
  })

  it('resolveSendText 有 plugin 才编码', () => {
    const out = resolveSendText('查入院', invoke)
    expect(out).toContain('<!--jeff-plugin:')
    expect(decodePluginUserMessage(out).displayText).toBe('查入院')
  })
})
