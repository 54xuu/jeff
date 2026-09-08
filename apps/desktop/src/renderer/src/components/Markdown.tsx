import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CopyButton } from './ui/CopyButton'

/**
 * 聊天消息的 Markdown 渲染：GFM（表格/删除线/任务列表）+ 代码高亮 + 代码块复制按钮。
 * react-markdown 默认不渲染裸 HTML，无 XSS 风险。
 */
function MarkdownInner(props: { text: string }): React.JSX.Element {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: (preProps) => <CodeBlock {...(preProps as Record<string, unknown>)} />,
          a: (aProps) => <a {...aProps} target="_blank" rel="noreferrer" />,
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock(props: Record<string, unknown>): React.JSX.Element {
  const { children, ...rest } = props
  const node = children as { props?: { className?: string; children?: unknown } } | undefined
  const raw = Array.isArray(node?.props?.children)
    ? (node?.props?.children as unknown[]).map(String).join('')
    : String(node?.props?.children ?? '')
  const lang = /language-([\w-]+)/.exec(node?.props?.className || '')?.[1]
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang || '代码'}</span>
        <CopyButton className="md-copy-btn" text={raw} label="复制代码" testId="md-copy-code" />
      </div>
      <pre {...rest}>{children as React.ReactNode}</pre>
    </div>
  )
}

export const Markdown = memo(MarkdownInner)
