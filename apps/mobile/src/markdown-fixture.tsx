import { Markdown } from './Markdown'

const SAMPLE = `# 巡检结论

病房 **3** 床今日平稳，未见新发异常。

- 体温正常
- 已完成换药

| 项目 | 结果 |
| --- | --- |
| 血压 | 120/80 |
| 血氧 | 98% |

\`\`\`ts
const ok = true
\`\`\`

\`\`\`mermaid
graph TD
  A[开始] --> B{判断}
  B -->|是| C[结束]
  B -->|否| A
\`\`\`
`

/** 开发时用 `?fixture=markdown` 打开，核对对话 Markdown 与 Mermaid。 */
export function MarkdownFixture(): React.JSX.Element {
  return (
    <div className="shell" style={{ overflow: 'auto' }}>
      <header className="bar">
        <b>Markdown 预览</b>
      </header>
      <div className="wechat-bubbles">
        <div className="wechat-msg-row other">
          <div className="wechat-msg-content">
            <div className="bubble">
              <Markdown text={SAMPLE} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
