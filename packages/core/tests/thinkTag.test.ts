import { describe, expect, it } from 'vitest'
import { extractThinkTags, mergeReasoning } from '../src/util/thinkTag.js'

describe('extractThinkTags', () => {
  it('无标签时原样返回', () => {
    const r = extractThinkTags('你好\n世界')
    expect(r.text).toBe('你好\n世界')
    expect(r.reasoning).toEqual([])
  })

  it('抽出已闭合的 think 块，正文不留空行', () => {
    const r = extractThinkTags('先想一下\n<think>\n推理 A\n推理 B\n</think>\n答案是 42')
    expect(r.text).toBe('先想一下\n答案是 42')
    expect(r.reasoning).toEqual(['推理 A\n推理 B'])
  })

  it('兼容 <thinking> 标签与同行混排', () => {
    const r = extractThinkTags('前缀 <THINKING>想</THINKING> 后缀')
    expect(r.text).toBe('前缀  后缀')
    expect(r.reasoning).toEqual(['想'])
  })

  it('流式中标签未闭合时，已收到的部分归入思考且不进正文', () => {
    const r = extractThinkTags('答案在下面\n<think>\n还没想完')
    expect(r.text).toBe('答案在下面')
    expect(r.reasoning).toEqual(['还没想完'])
  })

  it('多个思考块各自成条', () => {
    const r = extractThinkTags('<think>一</think>正文<think>二</think>')
    expect(r.text).toBe('正文')
    expect(r.reasoning).toEqual(['一', '二'])
  })

  it('围栏代码块内的 <think> 是文档内容，不改写', () => {
    const md = '看这个例子：\n```md\n<think>示例</think>\n```\n结束'
    const r = extractThinkTags(md)
    expect(r.text).toBe(md)
    expect(r.reasoning).toEqual([])
  })

  it('空思考块不产出条目', () => {
    const r = extractThinkTags('<think>\n\n</think>正文')
    expect(r.text).toBe('正文')
    expect(r.reasoning).toEqual([])
  })
})

describe('mergeReasoning', () => {
  it('字符串原生思考与提取结果合并', () => {
    expect(mergeReasoning('原生', ['标签'])).toEqual(['原生', '标签'])
  })

  it('都为空时返回 undefined', () => {
    expect(mergeReasoning(undefined, [])).toBeUndefined()
    expect(mergeReasoning('  ', [])).toBeUndefined()
  })
})
