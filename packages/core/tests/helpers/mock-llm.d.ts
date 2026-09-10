declare module '*/mock-llm.mjs' {
  export interface MockLlmOptions {
    customReply?: (userText: string, msgs: unknown[]) => string | null
    toolCall?: { trigger: string; name: string; args?: Record<string, unknown> }
    imageReply?: string
    /** 触发词（消息含「推理」或「思考」）时先流式输出 reasoning_content，再输出结论正文 */
    reasoningReply?: string
  }
  export function startMockLlm(port: number, opts?: MockLlmOptions): Promise<import('node:http').Server>
}
