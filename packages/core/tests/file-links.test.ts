import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyResolvedLinks, extractFileCandidates, FILE_HREF_PREFIX, segmentResolvedText } from '../src/files/linkify.js'
import { isBlockedExecutable, openDecision, resolveFilePaths } from '../src/files/resolve.js'

function raws(text: string): string[] {
  return extractFileCandidates(text).map((c) => c.raw)
}

describe('文件路径识别', () => {
  it('识别绝对路径、仅文件名、行内代码、带空格引号、Windows 路径和 file://', () => {
    expect(raws('已生成 /home/xujian/jeff-workspaces/a/报告.docx')).toEqual(['/home/xujian/jeff-workspaces/a/报告.docx'])
    expect(raws('文件：报告.docx')).toEqual(['报告.docx'])
    expect(raws('见 `out/报告.docx`')).toEqual(['out/报告.docx'])
    expect(raws('位置 "out/my report.pdf"')).toEqual(['out/my report.pdf'])
    expect(raws(String.raw`打开 C:\Users\x\a.pdf`)).toEqual([String.raw`C:\Users\x\a.pdf`])
    expect(raws('见 file:///home/x/a.pdf')).toEqual(['/home/x/a.pdf'])
    expect(raws('家目录 ~/docs/a.md')).toEqual(['~/docs/a.md'])
  })

  it('Markdown 链接和图片的目标是文件时整段成为候选，http 链接保持原样', () => {
    expect(raws('[报告](out/a.pdf)')).toEqual(['out/a.pdf'])
    expect(raws('![图](out/a.png)')).toEqual(['out/a.png'])
    expect(raws('[报告](file:///home/x/a.pdf)')).toEqual(['/home/x/a.pdf'])
    expect(raws('[说明](https://example.com/a.pdf)')).toEqual([])
    expect(raws('看 https://example.com/a/b.md 即可')).toEqual([])
  })

  it('围栏代码块里的路径不识别，加粗里的相对路径仍识别', () => {
    expect(raws('```\nout/a.docx\n```')).toEqual([])
    expect(raws('**out/report.pdf**')).toEqual(['out/report.pdf'])
  })

  it('只有解析命中的路径会变成站内链接', () => {
    const src = '绝对 /home/x/a.docx，代码 `missing.docx`，链接 [报告](out/a.pdf)'
    const linked = applyResolvedLinks(src, { '/home/x/a.docx': '/home/x/a.docx', 'out/a.pdf': '/ws/out/a.pdf' })
    expect(linked).toContain(`[/home/x/a.docx](${FILE_HREF_PREFIX}${encodeURIComponent('/home/x/a.docx')})`)
    expect(linked).toContain(`[报告](${FILE_HREF_PREFIX}${encodeURIComponent('/ws/out/a.pdf')})`)
    expect(linked).toContain('`missing.docx`')
    const segs = segmentResolvedText('输出 `out/a.docx` 完成', { 'out/a.docx': '/ws/out/a.docx' })
    expect(segs).toEqual([
      { type: 'text', value: '输出 ' },
      { type: 'file', value: 'out/a.docx', abs: '/ws/out/a.docx' },
      { type: 'text', value: ' 完成' },
    ])
  })
})

describe('文件路径解析', () => {
  it('精确拼接优先，仅文件名在搜索时取最近修改，并拒绝逃出工作区', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jeff-files-'))
    const session = path.join(root, 'session')
    const global = path.join(root, 'global')
    await fsp.mkdir(path.join(session, 'out'), { recursive: true })
    await fsp.mkdir(path.join(session, 'nested'), { recursive: true })
    await fsp.mkdir(path.join(global, 'nested'), { recursive: true })
    await fsp.mkdir(path.join(session, 'node_modules', 'pkg'), { recursive: true })
    const exact = path.join(session, 'out', '报告.docx')
    const older = path.join(session, 'nested', 'notes.txt')
    const newer = path.join(global, 'nested', 'notes.txt')
    const hidden = path.join(session, 'node_modules', 'pkg', 'secret.txt')
    const outside = path.join(root, 'outside.txt')
    await fsp.writeFile(exact, 'docx')
    await fsp.writeFile(older, 'old')
    await new Promise((r) => setTimeout(r, 20))
    await fsp.writeFile(newer, 'new')
    await fsp.writeFile(hidden, 'nope')
    await fsp.writeFile(outside, 'out')
    await fsp.symlink(outside, path.join(session, 'escape.txt'))

    const hits = await resolveFilePaths({
      inputs: ['out/报告.docx', 'notes.txt', 'secret.txt', '../outside.txt', 'escape.txt', exact, 'missing.docx'],
      bases: [session, global],
    })
    const byInput = Object.fromEntries(hits.map((h) => [h.input, h.abs]))
    expect(byInput['out/报告.docx']).toBe(exact)
    expect(byInput['notes.txt']).toBe(newer)
    expect(byInput['secret.txt']).toBeUndefined()
    expect(byInput['../outside.txt']).toBeUndefined()
    expect(byInput['escape.txt']).toBeUndefined()
    expect(byInput[exact]).toBe(exact)
    expect(byInput['missing.docx']).toBeUndefined()
  })

  it('可执行文件点击时改为在文件夹中显示', () => {
    expect(isBlockedExecutable('/tmp/run.sh')).toBe(true)
    expect(isBlockedExecutable('/tmp/报告.docx')).toBe(false)
    expect(openDecision('/tmp/run.sh')).toBe('block-reveal')
    expect(openDecision('/tmp/run.sh', true)).toBe('reveal')
    expect(openDecision('/tmp/报告.docx')).toBe('open')
  })
})
