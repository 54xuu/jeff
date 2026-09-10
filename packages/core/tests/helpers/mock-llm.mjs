// E2E 用极简 OpenAI 兼容 mock：/v1/models + /v1/chat/completions（流式，含工具调用回环）
import http from 'node:http'
import fs from 'node:fs'

/**
 * @param {number} port
 * @param {object} [opts]
 * @param {(userText: string, msgs: unknown[]) => string|null} [opts.customReply] 定制文本回复；返回 null 走默认
 * @param {string} [opts.imageReply] 请求带图片时的定向回复（多模态链路验证）
 */
export function startMockLlm(port, opts = {}) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/v1/models') {
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-mini', object: 'model', owned_by: 'mock' }] }))
        return
      }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        // 可控延迟（验证 LLM 慢生成时的行为）
        if (process.env.MOCK_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS)))
        const payload = JSON.parse(body || '{}')
        const msgs = payload.messages || []
        const tools = payload.tools || []
        // 请求是否携带图片（openai 兼容：image_url / image part）
        const hasImage = body.includes('"image_url"') || body.includes('"image"')
        if (process.env.MOCK_LOG) {
          console.error(`[mock] tools=${JSON.stringify(tools.map((t) => t?.function?.name))} msgs=${msgs.length} image=${hasImage}`)
        }
        if (process.env.MOCK_DUMP) {
          fs.appendFileSync(process.env.MOCK_DUMP, `--- hasImage=${hasImage} ---\n${body.slice(0, 4000)}\n`)
        }
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
        const userText =
          typeof lastUser?.content === 'string'
            ? lastUser.content
            : (lastUser?.content || []).map((p) => p.text || '').join(' ')
        const sysText = msgs
          .filter((m) => m.role === 'system')
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join(' | ')
        const toolMsg = [...msgs].reverse().find((m) => m.role === 'tool')

        res.setHeader('content-type', 'text/event-stream')
        const chunk = (delta, finish = null) =>
          `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-mini', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        const finishLine = () =>
          `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`

        // 已有工具结果 → 总结文本
        if (toolMsg) {
          const out = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content)
          const text = `【工具结果摘要】${String(out).slice(0, 300)}`
          res.write(chunk({ role: 'assistant' }))
          for (const c of text.match(/[\s\S]{1,20}/g) || []) res.write(chunk({ content: c }))
          res.write(finishLine())
          res.end()
          return
        }
        // 带图片的请求：opts.imageReply 定向回复（多模态链路验证）
        if (hasImage && opts.imageReply) {
          res.write(chunk({ role: 'assistant' }))
          for (const c of opts.imageReply.match(/[\s\S]{1,20}/g) || []) res.write(chunk({ content: c }))
          res.write(finishLine())
          res.end()
          return
        }
        // 可控思考（reasoning_content）：验证「思考增量不得混进正文」。
        // 触发词：消息含「推理」或「思考」。
        if (opts.reasoningReply && /推理|思考/.test(userText)) {
          res.write(chunk({ role: 'assistant' }))
          for (const c of String(opts.reasoningReply).match(/[\s\S]{1,20}/g) || []) res.write(chunk({ reasoning_content: c }))
          const finalText = `【结论】${String(userText).slice(0, 20)}`
          for (const c of finalText.match(/[\s\S]{1,20}/g) || []) res.write(chunk({ content: c }))
          res.write(finishLine())
          res.end()
          return
        }
        // 可控工具调用：opts.toolCall = { trigger: 'regex 源', name: '工具名', args: {...} }
        const tc = opts.toolCall
        if (tc && new RegExp(tc.trigger, 'i').test(userText) && tools.some((t) => t?.function?.name === tc.name)) {
          res.write(chunk({ role: 'assistant' }))
          res.write(
            chunk({
              tool_calls: [{ index: 0, id: 'call_mock1', type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) } }],
            }),
          )
          res.write(
            `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-mini', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
          )
          res.end()
          return
        }
        const custom = opts.customReply ? opts.customReply(userText, msgs) : null
        const text = custom ?? `【mock 回复】收到：「${String(userText).slice(0, 120)}」`
        res.write(chunk({ role: 'assistant' }))
        for (const c of text.match(/[\s\S]{1,20}/g) || []) res.write(chunk({ content: c }))
        res.write(finishLine())
        res.end()
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

// 作为独立进程运行时读取 MOCK_PORT 环境变量；MOCK_TOOL_CALL 可注入工具调用行为（JSON: {trigger,name,args}）
if (process.argv[1] && process.argv[1].endsWith('mock-llm.mjs')) {
  const port = Number(process.env.MOCK_PORT || 18081)
  const opts = {}
  if (process.env.MOCK_TOOL_CALL) {
    try {
      opts.toolCall = JSON.parse(process.env.MOCK_TOOL_CALL)
    } catch {
      console.error('MOCK_TOOL_CALL 不是合法 JSON')
    }
  }
  if (process.env.MOCK_CUSTOM_REPLY) {
    opts.customReply = () => process.env.MOCK_CUSTOM_REPLY
  }
  if (process.env.MOCK_REASONING_REPLY) {
    opts.reasoningReply = process.env.MOCK_REASONING_REPLY
  }
  void startMockLlm(port, opts).then(() => console.log(`mock llm on :${port}`))
}
