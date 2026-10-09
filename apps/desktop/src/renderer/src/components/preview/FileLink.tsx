/**
 * 已确认存在的文件链接。点击打开；右键可打开、在文件夹中显示或复制完整路径。
 */
import { FILE_HREF_PREFIX } from '@jeff/core'
import { usePreviewStore } from './previewStore'

export default function FileLink(props: { abs: string; children?: React.ReactNode }): React.JSX.Element {
  const openAbs = usePreviewStore((s) => s.openAbs)
  const openFileMenu = usePreviewStore((s) => s.openFileMenu)
  return (
    <a
      className="md-file-link"
      data-testid="md-file-link"
      href={`${FILE_HREF_PREFIX}${encodeURIComponent(props.abs)}`}
      title={props.abs}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void openAbs(props.abs)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const x = Math.min(e.clientX, window.innerWidth - 180)
        const y = Math.min(e.clientY, window.innerHeight - 140)
        openFileMenu({ x, y, abs: props.abs })
      }}
    >
      {props.children || props.abs}
    </a>
  )
}
