import type { ReactNode } from 'react'

/** 表单字段：标签 + 控件，可选占满两列。用 div 而非 label，避免包住 button/combo 时点击被触发两次。 */
export function Field(props: { label: string; children: ReactNode; span?: boolean; hint?: string }): React.JSX.Element {
  return (
    <div className="field" style={props.span ? { gridColumn: '1 / -1' } : undefined}>
      <span>{props.label}</span>
      {props.children}
      {props.hint ? <span className="field-hint">{props.hint}</span> : null}
    </div>
  )
}
