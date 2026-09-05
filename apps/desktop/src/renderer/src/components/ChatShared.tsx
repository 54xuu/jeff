import { useCallback, useState } from 'react'
import type { ChatImage } from '@jeff/core'

/** 读取 File 为 dataURL（图片附件用） */
export function fileToDataUrl(file: File): Promise<ChatImage | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) return resolve(null)
    const reader = new FileReader()
    reader.onload = () => resolve({ mime: file.type, dataUrl: String(reader.result) })
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** composer 的图片附件状态：选择/粘贴/拖拽 → dataURL 预览 → 随消息发送 */
export function useImages(limit = 6) {
  const [images, setImages] = useState<ChatImage[]>([])

  const addFiles = useCallback(
    async (files: Iterable<File>) => {
      const picked: ChatImage[] = []
      for (const f of files) {
        if (picked.length + images.length >= limit) break
        const img = await fileToDataUrl(f)
        if (img) picked.push(img)
      }
      if (picked.length) setImages((prev) => [...prev, ...picked].slice(0, limit))
    },
    [images.length, limit],
  )

  const remove = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const clear = useCallback(() => setImages([]), [])

  return { images, addFiles, remove, clear }
}

/** composer 里的缩略图预览条 */
export function ImagePreviews(props: { images: ChatImage[]; onRemove: (idx: number) => void }): React.JSX.Element | null {
  if (props.images.length === 0) return null
  return (
    <div className="attach-previews">
      {props.images.map((img, i) => (
        <div key={i} className="attach-preview">
          <img src={img.dataUrl} alt={`附件 ${i + 1}`} />
          <button className="attach-preview-remove" onClick={() => props.onRemove(i)} title="移除">
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

/** 消息气泡里的图片（点击看大图） */
export function MsgImages(props: { images: ChatImage[] }): React.JSX.Element | null {
  const [view, setView] = useState<string | null>(null)
  if (props.images.length === 0) return null
  return (
    <>
      <div className="msg-images">
        {props.images.map((img, i) => (
          <img key={i} src={img.dataUrl} alt="图片消息" onClick={() => setView(img.dataUrl)} />
        ))}
      </div>
      {view && (
        <div className="img-viewer-mask" onClick={() => setView(null)}>
          <img src={view} alt="预览" />
        </div>
      )}
    </>
  )
}
