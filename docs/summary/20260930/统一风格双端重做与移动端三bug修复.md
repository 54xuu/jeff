# 统一风格双端重做 + 移动端三大 bug 修复（v1.11.0）

日期：2026-09-30　范围：apps/mobile（全量）、apps/desktop（视觉+行为）、packages/core（契约）、apps/desktop/remote（通知）

## 背景与决策

用户实测 Android App 反馈四件事：① 界面丑、交互差、多处溢出（发送按钮不显示等）；② 发消息后看不到自己的消息，要等电脑回复才出现；③ 对话中对方头像变成「私」字，重进才恢复；④ 自行探索其他 bug。

经 grilling 拍板：**双端按 `docs/htmls/统一风格样式/index.html` 的 cue 翡翠视觉全量重做**，交互一致但尊重移动端特殊性；助手消息去气泡通栏、用户消息保留翡翠气泡；加时间戳/日期分隔/未读红点/长按菜单/图片查看器/多行输入等；桌面端连视觉一起对齐；标准档验收；MINOR 1.11.0。

## 三大 bug 根因与修法

| 现象 | 根因 | 修法 |
|------|------|------|
| ② 发送看不到自己的消息 | `apps/mobile` 的 `send()` 无乐观回显，且 `chat:send` invoke 阻塞到整个模型回合结束 | `doSendText()` 先插入本地乐观消息（`local-<ts>`），失败标 `failedLocal` 供长按重发；成功后 `loadHistory` 对账 |
| ③ 头像变「私」 | 桌面 `gateway.ts` 通知标题硬编码「私聊/项目群」，手机 `openFromNote` 直接拿通知 title 当会话名，头像取首字 | 桌面 `peerName(kind,id)` 查真实名字；手机端 `openFromNote` 一律经 `ensureLists()` 按 id 反查名字，不信 note.title |
| ① 溢出/按钮被挤掉 | 聊天顶栏 `height:50px` 固定 + 标题无 `min-width:0`；输入区无 safe-area；wechat-tabs 54px 与 safe-bottom 冲突 | 标题 ellipsis、动作改图标按钮、safe-area token 全局化；并新增 e2e `noOverflow()` 断言所有元素不出视口 |

## 主要改动

- **apps/mobile/src/styles.css 全量重写**：cue token（亮/暗）、全部 wechat-* 类重皮，新增 `.day-sep` / `.msg-who` / `.msg-meta` / `.msg-status` / `.wechat-user-bubble` / `.wechat-ai-body(.live)` / `.jump-latest` / `.wechat-msgmenu*` / `.wechat-viewer-mask` / `.wechat-unread-badge` 等。类名保持不变，行为层零迁移。
- **apps/mobile/src/App.tsx**：草稿按会话隔离（drafts map）；loadHistory 竞态 latest-wins（seq guard）；stream merge `!ok` 时保留旧值；滚动治理（atBottomRef + 跳最新按钮）；未读红点（chat-updated/group-updated push + limit:1 摘要）；长按菜单（复制/重发/隐藏）；图片查看器；多行输入（Enter 发送、Shift+Enter 换行）；返回键栈修复（viewer→menu→drawer→plus→chat 并 `setTarget(null)`，修未读）；`openChat` 不再 sessionActivate（不再抢桌面焦点）；电池优化弹窗改为绑定后才由 JS 触发（`JeffSpikePlugin.requestBattery`）。
- **packages/core**：`chat:history` / `group:history` 增加可选 `limit`（向后兼容），`historyActive` 透传。
- **apps/desktop**：`gateway.ts` 通知推真实名字；`styles.css` 助手气泡透明通栏（`.bubble.assistant` 两处 + `.msg-row.left max-width:100%` + `.msg-extra` 弱化chip化）。
- **whitelist**：本轮未新增 IPC 通道，`whitelist.ts` 无改动（limit 为已有通道的可选参数）。

## 验收（标准档全绿）

- 单测/typecheck：core+relay vitest ✓（版本一致性校验含 1.11.0）、typecheck ✓（根 tsconfig 3 个存量 e2e helper 报错，改动前就有）
- 桌面 e2e：ui 2 ✓ / v18 4 ✓ / cron 11 ✓ / **新增 visual 1 ✓**（直插群对话，断言 `.bubble.assistant` 背景 `rgba(0,0,0,0)`，亮/暗/私聊/设置四张截图）
- 手机：vitest 12 ✓、mobile e2e 5 + **screens 8 ✓**（全屏无溢出回归，含乐观发送/流式/长按菜单/图片查看器/未读红点）
- 真模型 live（`.tmp/live19/`）：私聊发「查插件」→ working → 通栏回复 → 历史落库 text+tools(completed) ✓，59s
- **模拟器真机连线**（新增做法，见下）：全新 pair-home 桌面实例 ↔ 模拟器 App 经真实中转站配对，真机发消息 → 乐观气泡 → 流式 → 模型回复（思考过程折叠 + markdown）→ 列表实时摘要 + 时间戳，亮/暗、列表/聊天/我 全部截图目检无溢出
- 产物：deb（dpkg 本机装 1.11.0 + `/opt/Jeff` 与 linux-unpacked app.asar md5 一致）、exe（PE32 Nullsoft + oc-bin 在位）、apk（aapt `versionName 1.11.0 versionCode 11100`，release 签名）

## 真机连线验证的新做法（可复用）

`.tmp/live19-pair/pair.spec.ts`：桌面侧 playwright 起 e2e 实例（**`JEFF_E2E=1` 下远程网关默认不启动，必须 `envExtra.JEFF_RELAY_URL='wss://47.106.209.32:9443'`**）→ 设置→远程控制→绑定手机 → 读隐藏的 `remote-qr-payload` 写出绑定码 → 等手机发起后自动点 `remote-pair-accept`。手机侧：模拟器装 apk，`adb input tap` 粘贴框 + 逐字符 `adb shell input text '<char>'`（JSON 特殊字符单引号包住）输入绑定码 → 点「使用粘贴内容绑定」→ 两端安全码核对自动完成。注意：模拟器截图坐标要按 `wm size`（1080x2400）换算，弹键盘时 composer 上移、隐藏时贴底。

## 遗留

- 「上滑加载更早历史」分页 UI 本轮未做（limit 契约与列表 limit:1 摘要已就绪，后补客户端分页即可）
- 模拟器绑定的是一次性 pair-home 桌面实例，中转站侧会残留一条测试绑定关系，无碍
- exe 最终以在 Windows 机器真装一次为准（本机 wine 弹窗验收早已废除）
