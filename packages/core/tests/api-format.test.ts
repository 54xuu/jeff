import { describe, it, expect } from 'vitest'
import { sdkBaseURL, providerRequestURL } from '../src/providers/endpoint.js'

describe('sdkBaseURL / providerRequestURL（对齐 ZCode 的三条 API 路径）', () => {
  it('Chat：保留 /v1，剥掉用户粘贴的 /chat/completions', () => {
    expect(sdkBaseURL('chat', 'https://api.example.com/v1')).toBe('https://api.example.com/v1')
    expect(sdkBaseURL('chat', 'https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(sdkBaseURL('chat', 'https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1')
    expect(providerRequestURL('chat', 'https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    expect(sdkBaseURL('chat', '')).toBe('')
    expect(providerRequestURL('chat', '  ')).toBe('')
  })

  it('Responses：保留 /v1，只剥 /responses，不把 /v1 一起拿掉', () => {
    expect(sdkBaseURL('responses', 'https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
    expect(sdkBaseURL('responses', 'https://api.openai.com/v1/responses')).toBe('https://api.openai.com/v1')
    expect(providerRequestURL('responses', 'https://api.openai.com/v1/responses')).toBe(
      'https://api.openai.com/v1/responses',
    )
    expect(sdkBaseURL('responses', '')).toBe('')
  })

  it('Anthropic：官方根地址与网关前缀都落到 /v1，请求打 /v1/messages', () => {
    expect(sdkBaseURL('anthropic', '')).toBe('https://api.anthropic.com/v1')
    expect(sdkBaseURL('anthropic', 'https://api.anthropic.com')).toBe('https://api.anthropic.com/v1')
    expect(sdkBaseURL('anthropic', 'https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1')
    expect(sdkBaseURL('anthropic', 'https://api.anthropic.com/v1/messages')).toBe('https://api.anthropic.com/v1')
    expect(sdkBaseURL('anthropic', 'https://gateway.example/anthropic')).toBe('https://gateway.example/anthropic/v1')
    expect(providerRequestURL('anthropic', 'https://gateway.example/anthropic')).toBe(
      'https://gateway.example/anthropic/v1/messages',
    )
    expect(providerRequestURL('anthropic', 'https://api.anthropic.com/v1/messages')).toBe(
      'https://api.anthropic.com/v1/messages',
    )
  })

  it('重复拼出来的绝对地址折成一份', () => {
    expect(sdkBaseURL('chat', 'https://api.example.com/v1/https://api.example.com/v1')).toBe('https://api.example.com/v1')
  })
})
