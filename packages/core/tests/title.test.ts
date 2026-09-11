import { describe, it, expect } from 'vitest'
import {
  NEW_SESSION_NAME,
  composeAutoTitle,
  placeholderTitle,
  stampTitle,
  summarizeTaskName,
} from '../src/util/title.js'

describe('stampTitle', () => {
  it('输出 YYYYMMDD-HHmm 且个位补零', () => {
    expect(stampTitle(new Date(2026, 8, 11, 14, 30))).toBe('20260911-1430')
    expect(stampTitle(new Date(2026, 0, 5, 9, 7))).toBe('20260105-0907')
  })
})

describe('placeholderTitle', () => {
  it('建会话时是「时间戳-新会话」', () => {
    expect(placeholderTitle(new Date(2026, 8, 11, 14, 30).getTime())).toBe('20260911-1430-新会话')
  })
})

describe('summarizeTaskName', () => {
  it('短消息原样保留', () => {
    expect(summarizeTaskName('修复登录按钮')).toBe('修复登录按钮')
  })

  it('换行与连续空白压平成单个空格', () => {
    expect(summarizeTaskName('帮我\n\n  修复   登录')).toBe('帮我 修复 登录')
  })

  it('去掉 @提及（群聊指名语法）', () => {
    expect(summarizeTaskName('@架构师 帮我修一下登录')).toBe('帮我修一下登录')
    expect(summarizeTaskName('@小杰')).toBe(NEW_SESSION_NAME)
  })

  it('去掉结尾标点', () => {
    expect(summarizeTaskName('排查同步失败问题。')).toBe('排查同步失败问题')
  })

  it('图片 markdown 不占标题，链接保留可读文字', () => {
    expect(summarizeTaskName('![截图](file:///a.png) 看这个')).toBe('看这个')
    expect(summarizeTaskName('[接口文档](https://x.com/a) 对一下')).toBe('接口文档 对一下')
  })

  it('代码块整段丢弃，行内代码保留文字', () => {
    expect(summarizeTaskName('看这段\n```ts\nconst a = 1\n```')).toBe('看这段')
    expect(summarizeTaskName('把 `fmtTime` 改成相对时间')).toBe('把 fmtTime 改成相对时间')
  })

  it('超长按码点截断并补省略号', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十'
    const out = summarizeTaskName(long)
    expect(Array.from(out)).toHaveLength(17)
    expect(out.endsWith('…')).toBe(true)
    expect(out).toBe('一二三四五六七八九十一二三四五六…')
  })

  it('截断不切断 emoji（按码点而非 UTF-16）', () => {
    const out = summarizeTaskName('😀'.repeat(20))
    expect(Array.from(out)).toHaveLength(17)
    expect(out).toBe(`${'😀'.repeat(16)}…`)
  })

  it('空消息（只发图片）回落占位名', () => {
    expect(summarizeTaskName('')).toBe(NEW_SESSION_NAME)
    expect(summarizeTaskName('   \n  ')).toBe(NEW_SESSION_NAME)
    expect(summarizeTaskName('![img](file:///a.png)')).toBe(NEW_SESSION_NAME)
  })
})

describe('composeAutoTitle', () => {
  it('用创建时间戳拼任务名，与首条消息发送时刻无关', () => {
    const createdAt = new Date(2026, 8, 11, 14, 30).getTime()
    expect(composeAutoTitle(createdAt, '修复登录按钮')).toBe('20260911-1430-修复登录按钮')
  })
})
