import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CopyButton } from './ui/CopyButton'
import { FILE_HREF_PREFIX, linkifyWorkspaceMarkdown, nodeText } from './preview/linkify'
import MermaidBlock from './preview/MermaidBlock'
import FileLink from './preview/FileLink'

/**
 * 聊天消息的 Markdown 渲染：GFM（表格/删除线/任务列表）+ 代码高亮 + 代码块复制按钮
 * + mermaid 图表（渲染/放大/源码）+ 工作空间相对路径蓝色链接（点击调用预览器）。
 * react-markdown 默认不渲染裸 HTML，无 XSS 风险。
 */
function MarkdownInner(props: { text: string; workspaceDir?: string }): React.JSX.Element {
  const text = props.workspaceDir ? linkifyWorkspaceMarkdown(props.text) : props.text
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: (preProps) => {
            const block = extractCode(preProps)
            if (block.lang === 'mermaid') return <MermaidBlock code={block.raw} />
            return <CodeBlock lang={block.lang} raw={block.raw} preProps={preProps as Record<string, unknown>} />
          },
          a: (aProps) => {
            const href = String(aProps.href || '')
            if (href.startsWith(FILE_HREF_PREFIX)) {
              const rel = decodeURIComponent(href.slice(FILE_HREF_PREFIX.length))
              return (
                <FileLink rel={rel} workspaceDir={props.workspaceDir}>
                  {aProps.children}
                </FileLink>
              )
            }
            return <a {...aProps} target="_blank" rel="noreferrer" />
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** pre → code 子节点：取语言与源码（rehype-highlight 会把内容拆成 span，nodeText 递归还原） */
function extractCode(preProps: unknown): { lang?: string; raw: string } {
  const children = (preProps as { children?: unknown } | undefined)?.children as
    | { props?: { className?: string; children?: unknown } }
    | undefined
  const lang = /language-([\w-]+)/.exec(children?.props?.className || '')?.[1]
  const raw = nodeText(children?.props?.children)
  return { lang, raw }
}

function CodeBlock(props: { lang?: string; raw: string; preProps: Record<string, unknown> }): React.JSX.Element {
  const { lang, raw, preProps } = props
  const { children: _, ...rest } = preProps
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang || '代码'}</span>
        <CopyButton className="md-copy-btn" text={raw} label="复制代码" testId="md-copy-code" />
      </div>
      <pre {...rest}>{preProps.children as React.ReactNode}</pre>
    </div>
  )
}

export const Markdown = memo(MarkdownInner)
