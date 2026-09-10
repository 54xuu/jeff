/**
 * 站内文件链接（蓝色）：消息正文（Markdown <a>）与工具输出（纯文本拆段）共用。
 * 点击 → previewStore.openRel：.md 进内置预览器，其它文件交系统默认程序。
 */
import { usePreviewStore } from './previewStore'

export default function FileLink(props: { rel: string; workspaceDir?: string; children?: React.ReactNode }): React.JSX.Element {
  const openRel = usePreviewStore((s) => s.openRel)
  const missing = !props.workspaceDir
  return (
    <a
      className="md-file-link"
      href={`#jeff-file:${encodeURIComponent(props.rel)}`}
      title={missing ? '当前会话没有关联的工作空间' : `打开工作区文件：${props.rel}`}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void openRel(props.rel, props.workspaceDir || '')
      }}
    >
      {props.children || `📄 ${props.rel}`}
    </a>
  )
}
