import { useEffect, useMemo, useRef, useState } from 'react'
import { formatModelKey, parseModelKey, modelDisplayLabel } from '@jeff/core'
import { useStore } from '../store'

/**
 * 可搜索的模型选择下拉（数据源 = 供应商配置里添加的模型，按提供商分组）。
 * value 为 `providerID/modelID`，空字符串 = 跟随默认。
 * Esc / 点空白关闭。
 */
export default function ModelPickerCombo(props: {
  value: string
  onChange: (key: string) => void
  placeholderEmpty?: string
}): React.JSX.Element {
  const catalog = useStore((s) => s.catalog)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return catalog
      .map((c) => ({
        ...c,
        models: c.models.filter((m) => !q || m.label.toLowerCase().includes(q) || m.modelID.toLowerCase().includes(q)),
      }))
      .filter((c) => c.models.length > 0)
  }, [catalog, filter])

  const total = catalog.reduce((n, c) => n + c.models.length, 0)

  const triggerLabel = useMemo(() => {
    if (!props.value) return props.placeholderEmpty || '跟随默认'
    const parsed = parseModelKey(props.value)
    if (!parsed) return props.value
    return modelDisplayLabel(parsed, catalog)
  }, [props.value, props.placeholderEmpty, catalog])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    let onDoc: ((e: MouseEvent) => void) | null = null
    // 仅延后 outside-click，Esc 立即生效
    const timer = window.setTimeout(() => {
      onDoc = (e: MouseEvent) => {
        if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
      }
      document.addEventListener('mousedown', onDoc)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      if (onDoc) document.removeEventListener('mousedown', onDoc)
    }
  }, [open])

  return (
    <div className="combo" ref={rootRef} data-testid="model-picker">
      <button
        type="button"
        className="combo-trigger"
        data-testid="model-picker-trigger"
        onClick={() => {
          setOpen((v) => !v)
          setFilter('')
        }}
      >
        {triggerLabel}
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="combo-menu" data-testid="model-picker-menu">
          <input
            className="model-menu-search"
            autoFocus
            placeholder="搜索模型（提供商 / 模型ID）…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            type="button"
            className={`combo-item ${props.value === '' ? 'on' : ''}`}
            onClick={() => {
              props.onChange('')
              setOpen(false)
            }}
          >
            {props.placeholderEmpty || '跟随默认'}
          </button>
          {groups.length === 0 && (
            <div className="model-menu-empty">{total === 0 ? '暂无模型：请到「设置 → 模型供应商」添加' : '没有匹配的模型'}</div>
          )}
          {groups.map((c) => (
            <div key={c.id}>
              <div className="combo-group">{c.name}</div>
              {c.models.map((m) => {
                const key = formatModelKey(m.providerID, m.modelID)
                return (
                  <button
                    key={key}
                    type="button"
                    className={`combo-item ${props.value === key ? 'on' : ''}`}
                    data-testid={`model-option-${key}`}
                    onClick={() => {
                      props.onChange(key)
                      setOpen(false)
                    }}
                  >
                    {m.label}
                    {m.thinkingTiers?.length ? <span className="tag">{m.thinkingTiers.length} 档思考</span> : null}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
