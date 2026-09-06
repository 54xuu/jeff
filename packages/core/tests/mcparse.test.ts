import { describe, it, expect } from 'vitest'
import { parseMcpServerJson, parseMcpServersJson } from '../src/mcp/parse.js'

describe('parseMcpServerJson（MCP JSON 编辑校验）', () => {
  it('local：合法 command 数组', () => {
    const r = parseMcpServerJson('{"type":"local","command":["npx","-y","server-xxx"]}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.cfg.type).toBe('local')
      expect(r.cfg.command).toEqual(['npx', '-y', 'server-xxx'])
      expect(r.cfg.enabled).toBe(true)
    }
  })

  it('local：enabled:false 可保留', () => {
    const r = parseMcpServerJson('{"type":"local","command":["uvx","foo"],"enabled":false}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.cfg.enabled).toBe(false)
  })

  it('remote：url + headers', () => {
    const r = parseMcpServerJson('{"type":"remote","url":"https://mcp.example.com/sse","headers":{"Authorization":"Bearer sk-test"}}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.cfg.type).toBe('remote')
      expect(r.cfg.url).toBe('https://mcp.example.com/sse')
      expect(r.cfg.headers?.Authorization).toBe('Bearer sk-test')
    }
  })

  it('非法 JSON 报错', () => {
    const r = parseMcpServerJson('{type: local}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('JSON 解析失败')
  })

  it('缺 command 报错', () => {
    const r = parseMcpServerJson('{"type":"local"}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('command')
  })

  it('command 非字符串数组报错', () => {
    const r = parseMcpServerJson('{"type":"local","command":["npx", 42]}')
    expect(r.ok).toBe(false)
  })

  it('remote 缺 url / url 非法报错', () => {
    expect(parseMcpServerJson('{"type":"remote"}').ok).toBe(false)
    expect(parseMcpServerJson('{"type":"remote","url":"ftp://x"}').ok).toBe(false)
  })

  it('type 非法报错；数组输入报错', () => {
    expect(parseMcpServerJson('{"type":"ftp","command":[]}').ok).toBe(false)
    expect(parseMcpServerJson('[1,2]').ok).toBe(false)
  })
})

describe('parseMcpServersJson（双格式兼容）', () => {
  it('mcpServers 包裹格式（Claude Desktop 风格 command+args+env）', () => {
    const r = parseMcpServersJson('{"mcpServers":{"fs":{"command":"npx","args":["-y","server-fs"],"env":{"K":"V"}}}}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.servers['fs'].type).toBe('local')
      expect(r.servers['fs'].command).toEqual(['npx', '-y', 'server-fs'])
      expect(r.servers['fs'].environment?.K).toBe('V')
    }
  })

  it('opencode 原生 map：多服务 + local/remote 混合', () => {
    const r = parseMcpServersJson('{"a":{"type":"local","command":["uvx","x"]},"b":{"type":"remote","url":"https://mcp.example.com"}}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.servers['a'].command).toEqual(['uvx', 'x'])
      expect(r.servers['b'].url).toBe('https://mcp.example.com')
    }
  })

  it('无 type 时按 command/url 推断', () => {
    const r = parseMcpServersJson('{"x":{"command":["npx","y"]},"y":{"url":"http://a"}}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.servers['x'].type).toBe('local')
      expect(r.servers['y'].type).toBe('remote')
    }
  })

  it('非法 JSON 报错并带原始原因', () => {
    const r = parseMcpServersJson('{"mcpServers": {')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('JSON 解析失败')
  })

  it('某服务缺 command/url 时报错并指名服务', () => {
    const r = parseMcpServersJson('{"mcpServers":{"good":{"command":["npx","x"]},"bad":{}}}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('bad')
  })

  it('空对象报错', () => {
    expect(parseMcpServersJson('{}').ok).toBe(false)
  })
})
