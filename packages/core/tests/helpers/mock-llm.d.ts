declare module '*/mock-llm.mjs' {
  export interface MockLlmOptions {
    customReply?: (userText: string, msgs: unknown[]) => string | null
    toolCall?: { trigger: string; name: string; args?: Record<string, unknown> }
    imageReply?: string
  }
  export function startMockLlm(port: number, opts?: MockLlmOptions): Promise<import('node:http').Server>
}
