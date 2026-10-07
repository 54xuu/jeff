/** Adapt upstream's email boundary lookbehind to a consuming capture. Keep the
 * upstream URL/domain validation and preserve the consumed punctuation as text. */
export function transformLegacyGfm(code: string): string {
  const pattern = String.raw`/(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu`
  if (!code.includes(pattern)) throw new Error('GFM email parser changed; review the legacy WebView adaptation')
  return code
    .replace(pattern, String.raw`/(^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu`)
    .replace('function findEmail(_, atext, label, match) {', `function findEmail(_, prefix, atext, label, match) {
  match = {...match, index: match.index + prefix.length}`)
    .replace("url: 'mailto:' + atext + '@' + label,\n    children: [{type: 'text', value: atext + '@' + label}]\n  }", "url: 'mailto:' + atext + '@' + label,\n    children: [{type: 'text', value: atext + '@' + label}]\n  }].filter(Boolean)")
    .replace("  return {\n    type: 'link',\n    title: null,\n    url: 'mailto:'", "  return [prefix ? {type: 'text', value: prefix} : null, {\n    type: 'link',\n    title: null,\n    url: 'mailto:'")
}
