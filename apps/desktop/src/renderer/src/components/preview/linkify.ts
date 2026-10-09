/**
 * 从 React 子树里提取纯文本（rehype-highlight 会把 code 内容拆成 span，逐层拼接）。
 * 路径识别已挪到 @jeff/core，桌面和手机共用。
 */
export {
  FILE_HREF_PREFIX,
  applyResolvedLinks,
  extractFileCandidates,
  isMarkdownPath,
  joinWorkspacePath,
  segmentResolvedText,
} from '@jeff/core'

export function nodeText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  const obj = node as { props?: { children?: unknown } }
  if (typeof obj === 'object' && obj.props) return nodeText(obj.props.children)
  return ''
}
