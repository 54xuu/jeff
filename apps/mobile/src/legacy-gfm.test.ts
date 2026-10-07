import fs from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { transformLegacyGfm } from '../build/legacy-gfm'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal'

// Load the real transformed extension, with imports resolved against its source.
const require = createRequire(import.meta.url)
const entry = require.resolve('mdast-util-gfm-autolink-literal')
const source = fs.readFileSync(new URL('./lib/index.js', 'file://' + entry), 'utf8')
const patched = transformLegacyGfm(source).replace(/^(import[^\n]* from )'([^']+)'/gm, (_, prefix, name) =>
  `${prefix}'${name.startsWith('.') ? new URL(name, 'file://' + entry.replace(/index\.js$/, 'lib/index.js')).href : 'file://' + require.resolve(name)}'`)
const portable = await import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(patched).toString('base64'))

describe('legacy WebView GFM autolinks', () => {
  it('has no unsupported lookbehind in the actual transformed dependency', () => {
    expect(patched).not.toContain('(?<=')
  })
  it.each(['a@example.com', '前缀。a@example.com, b@example.com', '中文.a@example.com', 'a@example.com b@example.com', '/a@example.com', 'https://example.com/path'])('preserves email boundaries, punctuation and URL parsing: %s', text => {
    const tree = fromMarkdown(text, { extensions: [gfmAutolinkLiteral()], mdastExtensions: [portable.gfmAutolinkLiteralFromMarkdown()] })
    expect(JSON.stringify(tree)).toContain(text.startsWith('/a') ? 'text' : 'link')
    const collect = (n: any): string => n.value || (n.children || []).map(collect).join('')
    expect(collect(tree)).toBe(text)
    if (text.startsWith('/a')) expect(JSON.stringify(tree)).not.toContain('mailto:')
    if (text.startsWith('中文.')) expect(JSON.stringify(tree)).toContain('mailto:.a@example.com')
  })
  it('matches upstream postprocessing semantics when tokenization has not already linked the email', async () => {
    const originalSource = source.replace(/^(import[^\n]* from )'([^']+)'/gm, (_, prefix, name) =>
      `${prefix}'file://${require.resolve(name)}'`)
    const original = await import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(originalSource).toString('base64'))
    for (const text of ['中文.a@example.com', '(a@example.com), b@example.com', 'a@example.com b@example.com', '/a@example.com', 'foo/a@example.com', '。a@example.com']) {
      const legacy = fromMarkdown(text, { mdastExtensions: [portable.gfmAutolinkLiteralFromMarkdown()] })
      const modern = fromMarkdown(text, { mdastExtensions: [original.gfmAutolinkLiteralFromMarkdown()] })
      const links = (n: any): any[] => [...(n.type === 'link' ? [n.url] : []), ...(n.children || []).flatMap(links)]
      expect(links(legacy)).toEqual(links(modern))
      const visible = (n: any): string => n.value || (n.children || []).map(visible).join('')
      expect(visible(legacy)).toBe(visible(modern))
    }
  })

})
