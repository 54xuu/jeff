# Android 对话支持 Markdown 与 Mermaid

2026-09-28。手机 App 里智能体回复原来是一整段纯文本。现在按 Markdown 排版，其中的 mermaid 代码块会画成图。

## 行为

- 智能体回复（私聊和群聊里 `role === 'assistant'`）走 Markdown：标题、列表、表格、引用、链接、行内代码、代码块。链接用新窗口打开，`javascript:` 协议会被丢掉。
- 正文里的 `<think>` 仍抽进「思考过程」，不混在排好版的正文里。
- 正在往外流的回复也会排版，但 mermaid 先显示成代码。等这一轮结束、变成历史消息后再出图，避免半截源码反复画图。
- 自己发出的消息仍是纯文本，换行保持原样。
- 图下方可以看源码、复制，点「放大」打开全屏。打开时整张图放进屏幕，双指缩放、单指拖动、双击复位，点空白或「关闭」退出。Android 返回键先关灯箱，再退出会话。
- Mermaid 按需加载，不进首包。

## 验证

- `npm test -w @jeff/mobile`：6 项通过（Markdown 结构、链接、流式时 mermaid 仍是代码、源码切换、返回键栈）。
- `npm run test:e2e -w @jeff/mobile`：手机视口下标题、列表、表格、代码块和 mermaid SVG 都在；放大后整张图落在屏幕内，能看到「开始」和「结束」，关闭后灯箱消失。
- 浏览器打开开发预览 `?fixture=markdown`，核对了气泡里的标题、列表、表格、代码块，以及放大后的完整流程图。
- `npm test`：core 36 个文件通过、relay 11 项通过。
- 安装包：`apps/mobile/android/release/jeff-1.9.5.apk`（7.8MB）。`aapt dump badging` 为 `versionName=1.9.5`、`versionCode=10905`。这次只改了 App，没有改桌面端，版本号保持 1.9.5，没有打 deb/exe。
