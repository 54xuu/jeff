# ZCode 页面设计与交互可借鉴

- 日期：2026-09-22
- 范围：只读调研 `/home/xujian/Documents/github/ZCode` 的桌面 UI，对照 Jeff 当前渲染层（`apps/desktop/src/renderer`）与产品心智
- 目的：记下 ZCode 里值得搬到 Jeff 的页面、交互和相关功能。本文不改产品代码

ZCode 是 AI 编程工作台（Electron + 共享 UI 包 + Agent CLI）。Jeff 是微信式个人 Agent 桌面：智能体是好友，项目群是微信群，小杰是管家，中间是对话，右边是内置浏览器。两边都是「长任务、流式输出、工具调用、多会话」的桌面壳，输入区、时间线、侧栏、设置和浏览器可以互相借鉴。Git 图、LSP、分屏代码工作台这类编码 IDE 能力不搬，文中单独列出。

Jeff 已有能力的对账底稿是 [`docs/summary/20260920/Jeff全部功能清单.md`](../20260920/Jeff全部功能清单.md)。每条下面用 **Jeff** 标明：已有、弱版、没有。

源码位置：

| 层 | 路径 |
|----|------|
| 共享 UI | `packages/ui/src`（输入、`v4` 时间线、侧栏、设置、预览、浏览器） |
| 桌面壳 | `packages/desktop`（窗框、未读角标、资源管理器窗口） |
| Web | `packages/web` 只是把同一套 UI 接到浏览器，交互不另起一套 |

---

## 1. 明确不搬

这些在 ZCode 里是好功能，但和 Jeff 的心智模型不合，搬过来会把「微信」做成「IDE」。

| 能力 | ZCode 位置 | 为什么不搬 |
|------|------------|------------|
| Git 图、暂存区、按 commit 看 diff | `GitPane.tsx`、`git-graph/GitGraphDialog.tsx` | Jeff 不是代码工作台。若以后要「这轮改了哪些文件」，用会话产物列表，不接 Git |
| 工作区文件树当主导航、拖文件变成 `@文件` mention | `workspace-file-tree/` | Jeff 的主对象是会话和群，文件是资料抽屉里的附属 |
| 多分屏会话工作台（把会话拖到四边切开） | `v4/workbenchLayout.ts`、`v4/workbenchDragDrop.ts` | Jeff 已有固定三栏。对照两个话题是远期需求，不是现在的布局 |
| Computer Use / CUA 权限条 | `cua-permission/`、桌面 `windowsCuaOperationIndicator` | Jeff 用内置浏览器工具，不接管整台电脑 |
| 插件商店商业链、Coding Plan 配额 | `settings/PluginsSection.tsx` 商店流、`CodingPlanUsageRemainingPanel.tsx` | Jeff 插件是本机目录 + 小杰开发，没有商店结算 |
| 独立 PTY 终端侧栏 | `SidePaneTerminalPane.tsx`、`terminal/` | 用户不面对 shell；命令走智能体工具 |
| 白板、文件活动 treemap、Model Trajectory 全量调试台 | `WhiteboardPane.tsx`、`TreemappingPane.tsx`、`ModelTrajectoryPane.tsx` | 开发者向。Jeff 已有 debug 日志和上下文抽屉，不必再开一条侧栏 |
| 从 Claude 历史整库迁移会话 | `settings/MigrationSection.tsx` | 数据模型不同。可借鉴的只是「勾选再导入」这个交互，见第 6 章 |

可以抽象过来、但不要原样移植的模式：变更列表的「复制路径 / 在文件夹中显示」、文件预览壳、定时任务卡片上的运行四态。下文按这个边界写。

---

## 2. 输入区

ZCode 把输入拆成两层：`LexicalChatInput` / `ChatPromptEditor` 管打字、slash、mention、历史；`v4/ConversationComposer.tsx` 管发送、停止、队列、附件和草稿。Jeff 继续用 textarea + chip 即可，搬的是状态机和手感，不必上 Lexical。

### 2.1 上下键回填发送历史

- **ZCode**：输入为空（或已经在翻历史）时，↑↓ 切换最近发出去的全文；光标还在多行草稿中间时不抢方向键。翻历史带回来的文本里若含 `/`，不会同时弹出 slash 面板。
- **路径**：`packages/ui/src/lib/promptHistory.ts`、`LexicalChatInput.tsx`
- **为何好**：和终端、微信「上一条」是同一块肌肉记忆，改一句重发不用翻上面的气泡。
- **Jeff**：没有。私聊和群各自记最近若干条纯文本即可，插件 chip 可按当时的插件 id 一起回填。

### 2.2 发送失败不清空草稿

- **ZCode**：`onSubmit` 返回 false（路由不允许、附件没传完）时，输入框内容留着。
- **路径**：`prompt-editor/ChatPromptEditor.tsx`、`LexicalChatInput.tsx`
- **为何好**：长 prompt 最怕「点了发送，失败，字没了」。
- **Jeff**：弱版。草稿在 `ChatWindow` / `GroupWindow` 的 `useState` 里，发送成功才清；失败路径需要逐条核对是否提前清空。切走会话一定会丢，见 2.4。

### 2.3 忙时空草稿变停止，Esc 不误伤弹窗

- **ZCode**：模型在跑且输入为空时，主按钮是停止，Esc 等价停止；焦点在 `role=dialog` 里时 Esc 只关弹窗。有未发草稿时主按钮仍是发送（进队列，见 2.7）。
- **路径**：`v4/composer/escapeStop.ts`、`v4/ConversationComposer.tsx`
- **为何好**：一条主操作，弹窗和停止不抢同一个键。
- **Jeff**：已有停止按钮（`data-testid="chat-stop"`，空草稿时显示）。Esc 与对话框的分工没有单独做。

### 2.4 按会话记住草稿

- **ZCode**：每个会话持久化正文、编辑器状态和 mention；发送只清内容，不删这条草稿槽。附件不进持久化。切走再回来，半句话还在。
- **路径**：`v4` 下的 `composerDraftStore`（由 `ConversationComposer.tsx` 使用）
- **为何好**：微信切聊天不丢正在打的字。
- **Jeff**：没有。`draftComposer` 是窗口组件里的 `useState`（`ChatWindow.tsx`、`GroupWindow.tsx`），一切会话就没了。应按智能体会话 id / 群话题 id 存文本和插件 chip。

### 2.5 Esc 关掉 slash 后，同一段输入不再弹

- **ZCode**：用户按 Esc 关掉 `/` 或 `@` 面板后，只要还停在同一个 token 上就不再自动弹出；改了查询词才重新打开。
- **路径**：`SlashCommandPlugin.tsx`、`mentions/` 下的 `MentionPlugin.tsx`
- **为何好**：面板关得掉。否则中文输入和 Esc 会打架。
- **Jeff**：没有这层签名。Jeff 已有插件 slash 菜单和群 `@` 键盘选择，补上「关掉即记住当前 token」即可。

### 2.6 中文顿号唤起 `/`

- **ZCode**：句首的「、」映射成 `/`，中文输入法不用先切英文符号。
- **路径**：`LexicalChatInput.tsx`（LeadingChineseSlashAlias）
- **为何好**：插件指令是 Jeff 的主入口之一，中文用户每天都会撞上。
- **Jeff**：没有。在 slash 检测前把句首「、」当成 `/`。

### 2.7 忙时消息队列

- **ZCode**：生成中再发送，默认进入队列。队列面板可拖拽排序、编辑（撤回到输入框）、删除、立即发送。队列被暂停时再发送，要选「清空队列再发」或「保留队列再发」。按住 Ctrl/Cmd 再发送，可以和默认的「入队」相反（立刻发或只入队），按钮 tooltip 写明这次会怎样。
- **路径**：`v4/ConversationQueuePanel.tsx`、`v4/composer/followupModeSettings.ts`、`v4/ConversationPendingGuideList.tsx`
- **为何好**：护士长、小杰这类长任务里，人会连续想到下一句。现在只能等完再打，或者误以为发出去了。
- **Jeff**：没有。定时任务的会话隔离是另一件事。用户侧建议先做「排队下一条」，暂停确认和修饰键反转可以后做。时间线上用一行「待处理」把已经入队、还没进记录的句子显示出来。

### 2.8 空会话推荐说法

- **ZCode**：新会话输入区旁有可点的 prompt chip，可换一批、可关掉；点下去预填输入框，并能带上插件 mention。插件还在安装时有进度气泡。
- **路径**：`v4/ConversationDraftSuggestedPrompts.tsx`、`v4/ConversationDraftEmptyState.tsx`
- **为何好**：空白对话最容易让人停住。Jeff 的能力（建定时任务、开插件、问病区）适合做成一两句能点的话，而不是说明书。
- **Jeff**：没有。小杰空会话放「建一个每天 8 点的早报」「看看已装插件」这类 chip；点了只预填，不直接发送。

### 2.9 「+」聚合菜单

- **ZCode**：输入框旁的「+」打开和 slash 同一块面板：附件、开头才有效的命令、插件、文件。底部一行字教 `@` `/` `$`。打开菜单时记下光标，插入后焦点回到输入框。只在消息开头合法的命令，不会出现在句子中间。
- **路径**：`ChatPromptActionMenu.tsx`
- **为何好**：不记快捷符也能上手，和键盘流共用一套列表。
- **Jeff**：没有统一的「+」。已有图片按钮和 `/` 菜单。可以收成一个「+」：图片、插件指令、空会话推荐。选完把焦点还回输入框。

### 2.10 附件：没传完不能发，发前能看见

- **ZCode**：附件有上传中、失败重试、完成闪一下；没就绪时发送禁用，并说明原因。缩略图点开可看大图。超长粘贴文本可以变成 `.txt` 附件，避免整页 HTML 进 prompt。拖进输入区时有边框和居中提示；拖出窗口后大约 300ms 清掉高亮，避免 Electron 不发 `dragend` 时高亮粘住。
- **路径**：`v4` 的 `useComposerAttachments.ts`、`usePromptEditorDragState.ts`、`ConversationComposer.tsx`
- **为何好**：不会发出「图还没上去」的消息，拖拽状态也不会卡死。
- **Jeff**：弱版。已支持上传、粘贴、拖拽图片，发送条件是「有字、或有插件 chip、或有图片」（`ChatWindow.tsx`）。缺上传进度、失败重试，以及拖出窗口后的高亮超时清除。文本转附件可选，不优先。

### 2.11 浏览器选区、网页元素变成输入框上的药丸

- **ZCode**：代码评论、网页元素、会话里划中的一段字，都变成输入框上方的圆角 pill，悬停看详情，可以单条拿掉。正文写人话，载荷单独看。
- **路径**：`v4/composer/ContextAttachmentPill.tsx`、`WebElementContextAttachmentChip.tsx`、`ConversationSelectionReferenceChip.tsx`
- **为何好**：Jeff 已经能让智能体操作右侧网页，人却很难把「我点的这块」说清楚。
- **Jeff**：没有。和划词引用（第 3 章）是同一条产品线：浏览器里选中元素或一段文字，输入框上方出现可删除的引用，发送时带给当前智能体。

### 2.12 其余输入手感

| 模式 | ZCode | Jeff |
|------|--------|------|
| 可配置「发送 / 换行」键，改绑后裸 Enter 自动变换行 | `shortcuts/composerShortcuts.ts`、`shortcuts/bindings.ts` | 没有。现为 Enter 发送、Shift+Enter 换行。中文 IME 组合期间不发送，Jeff 已有 `isComposing` 判断 |
| 只有附件或 chip、没有字，也能发送 | `ConversationComposer.tsx` 的 `allowSubmitWhenEmpty` | 已有：无字但有 chip 或图片时发送按钮可用 |
| slash 面板浮在输入框上方，不把输入框撑高 | `ChatPromptEditor.tsx` | 已有浮层菜单。候选变多后再考虑虚拟列表 |
| `/` 下分命令、技能、子代理，默认选中最匹配项而不是永远第一项 | `slashCommandPanelSections.tsx`、`SlashCommandPlugin.tsx` | 弱版。Jeff 的 `/` 主要是插件指令。技能若要进同一面板，再分组、再按相关度高亮 |
| 选中的 slash 是结构化 chip，复制出去仍带语义 | `mentions/nodes/PromptMentionNode.ts` | 已有插件 chip。复制整段草稿时 chip 会不会变成纯文本，还没做 |
| 退格一次删掉 chip 和后面的空格 | `LexicalChatInput.tsx` | 已有，`ComposerDraft.tsx` |
| `@` 之外还有 `#` 会话、`$` 技能 | `mentionPanelRouting.ts` | 群 `@` 成员已有。`#` / `$` 不优先，避免一个输入框三种符 |
| 选完模型或模式，焦点回到输入框 | `lib/pickerFocus.js` | 没有成文规则。弹层关掉后应 `focus` 回 textarea |
| 发送中转圈，禁用时 tooltip 写原因（没配模型、附件未就绪） | `ConversationComposer.tsx` | 弱版。按钮有 `disabled`，原因不总是说给人听 |
| 窄宽度时工具条按优先级收成图标，用隐藏副本测量，避免来回抖 | `useComposerToolbarFit.ts` | 没有。Jeff 工具条较短，窗口再窄时再做 |
| 点一下循环思考档位 | `ThoughtLevelCycleControl.tsx` | 不优先。Jeff 的思考档在智能体资料里，不在每条消息上切换 |
| 从插件页「试用」插入时，不覆盖用户已经打的字 | `useComposerTextInsertApplied.ts` | 没有。和 6.3 的「试一下」一起做 |

---

## 3. 对话时间线

### 3.1 谁有权把画面拉回底部

- **ZCode**：人停在底部时，新消息和流式增高自动贴底；人往上滚之后不再被拽回去，出现圆形「回到底部」。只有真实的滚轮、触摸、键盘才改变「是否跟随」；程序测高、布局变化不抢这个状态。最后一个还在跑的回合单独渲染，避免虚拟列表晚一帧把「正在输出」抖一下。
- **路径**：`v4/timelineScrollAnchor.ts`、`v4/ConversationTimeline.tsx`、`v4/conversationTimelineLiveTail.ts`
- **为何好**：长回复里往上翻，最烦的是被拉回底部。
- **Jeff**：弱版。已有贴底。缺独立的回底按钮，以及「程序化滚动不算用户意图」这层区分。Jeff 消息量还没到虚拟列表，live tail 可以后做。

### 3.2 切走会话时记住读到哪

- **ZCode**：离开时若不在底部，记下 `scrollTop`；回来等内容高度就绪再恢复，避免先被夹成错误位置。往上补载更早的消息时，当前正在读的那一行留在原地。
- **路径**：`lib/chatSessionScrollMemory.js`、`v4/timelineScrollAnchor.ts`
- **为何好**：多会话切换的预期就是「回到刚才那一行」，不是每次打开都在最新一条。
- **Jeff**：没有。现在切会话多半回到底部。按会话 id 存「是否贴底 + 滚动位置」。分页加载历史时再做前置锚定，现在不必先做分页。

### 3.3 时间戳和这一轮花了多久

- **ZCode**：今天只显示时刻，昨天带「昨天」，更早带月日或年月日。一轮助手结束后，在回合尾显示耗时（最多两段，如「2 分 10 秒」）。
- **路径**：`v4/messageTimeLabel.ts`、`v4/conversationWorkDuration.ts`、`v4/ConversationTurnGroup.tsx`
- **为何好**：Jeff 的工具链经常超过一分钟，绿点只能说明「还在忙」，看不出已经忙了多久。
- **Jeff**：弱版。气泡上有完整时间戳，流式期间也在。没有「昨天」这种相对说法，也没有回合耗时。耗时从这条用户消息到本轮停止计算，放在助手气泡尾部。

### 3.4 右侧导航按「一轮」而不是「一条消息」

- **ZCode**：窄轨上每一格是一轮：用户那句的预览 + 助手摘要或「运行中」。悬停出更完整的卡片。点某一格和会话内查找共用同一套跳转。窄窗口隐藏。
- **路径**：`v4/ConversationTurnNavigator.tsx`、`v4/conversationTurnNavigatorHelpers.ts`
- **为何好**：一轮里会有思考、多次工具和长回复。按消息划轨，轨会密成一条线。
- **Jeff**：弱版。已有 `MessageRail.tsx`，按消息，悬停有预览。可改成按用户消息起头的一轮，运行中的一轮用不同标记。

### 3.5 工具行用同一套折叠语法

- **ZCode**：所有工具共用摘要行：类型、对象、一句话、状态。展开后才是正文。展开与否跨重渲染记住。跑完可以自动收起。失败时 tooltip 里能复制错误。参数还在流式吐出时，摘要行跟着变，而不是空白等到 JSON 拼完。连续的同类调用（一串浏览、一串命令）收成一组。特别长的字段先给预览和字节数，点一下再拉全文。
- **路径**：`ToolCallBlocks/ToolLayout.tsx`、`ToolCallBlocks/ToolSummaryRow.tsx`、`ToolCallBlocks/QueuedSummaryContent.tsx`、`ToolCallBlocks/ToolSnapshotFieldNotice.tsx`、`v4/toolCallRowAdapter.ts`、`v4/conversationAssistantWorkItems.ts`
- **为何好**：人只要学会一种工具行。Jeff 的浏览器、MCP、定时任务工具会越来越多，逐条平铺会刷屏。
- **Jeff**：弱版。已有思考和工具的折叠条，逐条展示，没有「同一语法」、没有流式参数摘要、没有同类合并、没有失败一键复制、没有超长结果的按需加载。优先统一摘要行和失败可复制；合并浏览器连续调用可以第二步做。

### 3.6 一轮里更早的步骤再收一层

- **ZCode**：同一轮里，已经过去的工具和推理收成「历史步骤」，只留一行可展开；当前这一段全开。后台任务的结果单独标题。
- **路径**：`v4/ConversationTurnGroup.tsx`、`v4/conversationTurnWorkSegments.ts`
- **为何好**：人要看的是正在发生的事和最后的话，过程仍能翻出来。
- **Jeff**：弱版。折叠是按块的，没有「早期步骤打成一条历史」。

### 3.7 划词之后接着问

- **ZCode**：在可选择的消息区域里拖选文字，旁边出现菜单，把这段引用放进输入框。选区太长会提示上限。跨按钮、跨表格工具栏时不误触发。
- **路径**：`v4/ConversationSelectionTooltip.tsx`、`v4/SelectionActionMenu.tsx`、`v4/composer/ConversationSelectionReferenceChip.tsx`
- **为何好**：比复制再粘贴更像「带着上文继续说」。
- **Jeff**：弱版。气泡可以复制正文，不能把选中的一段变成引用。和 2.11 的浏览器药丸一起做。

### 3.8 会话里查找

- **ZCode**：在当前会话已加载的内容里查找，命中用高亮区分「全部」和「当前这一条」，上一条 / 下一条跳转。流式还在变的那一轮不缓存索引。从外面的搜索结果跳进来时，命中段亮几秒再消失。
- **路径**：`v4/useConversationTimelineFind.ts`、`v4/conversationFindHighlightDom.ts`、`quickpick/TaskFindDialog.tsx`
- **为何好**：群聊和长私聊靠翻和靠消息轨都找不回某句原话。
- **Jeff**：没有。先做当前会话 Ctrl/Cmd+F，工具和思考块可以不参与匹配。全局「搜所有会话再跳进来闪光」放到命令中心之后。

### 3.9 权限要让人看见「将要发生什么」

- **ZCode**：权限对话框按工具类型嵌和对话里同一套预览（将执行的命令、将改的文件、将调用的 MCP）。选项分「这次允许 / 总是允许 / 拒绝」。子代理发起的询问带「来自某某」徽标，悬停可见类型。多道追问走向导，草稿留着，最后一分钟有倒计时，鼠标悬停或正在答题时倒计时暂停。
- **路径**：`PermissionDialog.tsx`、`WorkflowPermissionBlock.tsx`、`InteractionRequestOriginBadge.tsx`、`ElicitationDialog.tsx`
- **为何好**：裸 JSON 或静默放行，人都不知道自己同意了什么。群里要能分清是护士长还是小杰在问。
- **Jeff**：没有界面。引擎侧遇到 `permission.asked` 会自动回复允许（`packages/core/src/index.ts` 里记为 `permission-auto-allow`）。这是产品策略，不是漏了一块 UI。若以后改成询问，对话框应展示命令或工具参数，并标是哪个智能体发起的；在那之前不要先画一个空弹窗。高风险动作（启用带本地命令的插件、改群配置）即使用小杰代操，也适合在对话里留一张参数确认卡，而不是只靠模型说「已经搞好了」。

### 3.10 发出去的那句，重启后还在不在

- **ZCode**：本地账本记下尚未被服务端确认的发送。重连后对账。被重启丢掉的那句，在输入区上方用一条中性提示：「重发」或「忽略」，不是全屏警告。
- **路径**：`v4/pendingCommandRegistry.ts`、`v4/usePendingCommandRecovery.ts`、`v4/PendingCommandRecoveryBanner.tsx`
- **为何好**：Jeff 会重启 sidecar。人最怕的是不确定刚才那句算不算数。
- **Jeff**：没有这层提示。调试日志里能查，界面上不能。

### 3.11 对话里的结果卡片

- **ZCode**：创建 cron、跑完一段 workflow，不只是一行工具文本，而是对话里的卡片：状态、点进去看运行。一轮结束还有摘要条，可继续或取消。助手声称写出了文件时，先确认磁盘上真有这个文件再显示卡片，避免闪一下假文件。预览用「用浏览器打开 / 用编辑器打开」分开。
- **路径**：`ToolCallBlocks/renderers/cron-create.tsx`、`v4/ConversationWorkflowDigests.tsx`、`AssistantPreviewCards.tsx`、`lib/assistantPreviewCards.ts`
- **为何好**：Jeff 已经吃过「模型说配置好了，其实没落地」。卡片以服务端或磁盘事实为准。
- **Jeff**：弱版。群里有系统任务卡片（`📋 任务 JEF-n`），定时消息带「定时」标签。`jeff_cron_*` 成功后没有「已创建，去定时页」的卡片。文件产物没有「确认存在再展示」。

### 3.12 其余时间线

| 模式 | ZCode | Jeff |
|------|--------|------|
| 输入框上方一条渐变，最后一行不和输入框贴死 | `ConversationTimeline.tsx` 的 composer message mask | 没有 |
| 用户消息可就地改、分叉、重试 | `v4/ConversationRowView.tsx` | 没有。复制已有。分叉会话对 Jeff 价值高于「改历史并回滚文件」；文件回滚对话框不搬 |
| 模型重试时在当前轮显示第几次 | `ConversationTurnGroup.tsx`、`ChatApiRetryStatus` | 没有。限流和失败现在多半变成一条错误文本 |
| 系统事件用时间线标记，不伪装成助手气泡 | `ConversationRowView.tsx` 的 marker 行 | 弱版。群系统消息已是卡片，不是助手气泡 |
| 分享时勾选若干轮，只读页用同一套时间线渲染 | `ConversationShareSelectionPanel.tsx`、`ConversationShareReadonlyTimeline.tsx` | 没有。汇报、导出到笔记时有用，晚于查找和引用 |
| 上下文占用条、压缩 | 输入区旁的 context 面板 | 已有顶栏占用条、抽屉和手动压缩 |
| 按角色展开的原始请求时间线（调试） | `ModelTrajectoryPane.tsx` | 不搬进主界面。需要时继续看 `<home>/logs/debug-*.log` |

---

## 4. 侧栏与导航

Jeff 左栏是会话列表，按智能体分类折叠，小杰那一行写死了「置顶」标签（`ChatList.tsx` 的 `pinned`）。导航栏是聊天、智能体、定时、插件、设置。`Ctrl/Cmd+B` 收放列表，宽度可拖，双击分隔条恢复默认。

### 4.1 未读，以及可以标回未读

- **ZCode**：行首圆点按优先级：错误红点、未读蓝点、进行中转圈。菜单里可「标记未读」。选中行时用预期的未读时间戳和缓存对账，避免乐观更新和迟到事件打架。进行中只信当前这次活动，不用历史记录里的脏状态一直转圈。
- **路径**：`lib/taskListItemPresentation.ts`、`TaskListItem.tsx`、`app-shell/useWorkspaceTaskNavigation.ts`
- **为何好**：微信列表的第一眼就是「谁在等我」。Jeff 定时任务跑完、群里有新汇报，现在靠通知和绿点，离开那个会话后列表上没有未读。
- **Jeff**：没有未读模型。忙碌绿点已有（生成中）。建议：`last_read` 对最新消息，列表蓝点，右键可标未读。错误（上一轮失败、权限若将来改成询问）用红点，优先级高于未读。

### 4.2 用户自己的置顶区

- **ZCode**：工具栏下有一块「置顶」，跨分组视图都在。已经置顶的项不在下面的组里再出现一次。置顶超过约 20 条时先折叠，可展开全部。
- **路径**：`WorkspacePinnedTasksSection.tsx`、`WorkspaceSidebar.tsx`
- **为何好**：置顶是用户的，不是产品写死某一个联系人。
- **Jeff**：弱版。只有小杰那一行的绿色「置顶」字样，不能把任意私聊或群钉住。小杰可以继续默认在最上，用户置顶区放在它下面或与它并列，需要单独的 `pinned_at`。

### 4.3 列表上的第二行：这会儿在干什么

- **ZCode**：标题下再一行，写 workflow 跑到哪一段，不和未读点抢位置。权限或追问会变成胶囊，追问倒计时可以在悬停时暂停。
- **路径**：`TaskListItem.tsx`、`TaskInteractionBadge.tsx`
- **为何好**：打开列表就知道哪条会话卡住了，不用点进去。
- **Jeff**：没有。定时任务执行中、群里这一轮还在跑，适合在会话行副标题写「执行中」或「等待回复」。权限胶囊等 3.9 的策略变了再做。

### 4.4 两种看法：分组，或按时间

- **ZCode**：侧栏顶部两个胶囊：「分组」和「按项目」。按时间的视图可分成今天 / 昨天 / 更早。筛选和排序进一个菜单（最近更新、创建时间），不常驻占一行。分组滚动时标题吸顶，吸顶条上仍能新建、折叠。一键全部展开或全部收起；数据还没到时用上一帧的样子，避免闪成全展开。折叠状态记住，空数据的第一帧不会把用户的折叠偏好清掉。
- **路径**：`WorkspaceSidebar.tsx`、`lib/sidebarTaskPreferences.ts`、`workspace-grouped-tasks/sticky-group-header.tsx`、`WorkspaceTimelineTasksSection.tsx`
- **为何好**：找「护士长那个群」用分组，找「刚才那条」用时间。两种都要，但不要两套页面。
- **Jeff**：弱版。已有按智能体分类折叠。没有时间线模式、没有吸顶组头、没有「全部折叠」、折叠状态未必跨重启保留。用户自建拖拽分组（QQ 分组）是另一档，可以不做；系统上把定时任务会话归进一组「定时」就够了。

### 4.5 归档是侧栏里的一种视图

- **ZCode**：点归档后，主列表换成归档列表，置顶区仍在。第一次点归档是行内确认（变红的「确认」），Esc 或点外面取消；鼠标只是移出这一行，不取消，避免手一抖确认消失。右键菜单整个列表只挂一个实例。重命名对话框里，中文输入法未上屏的 Enter 不提交。归档工具条上可以清空全部，带确认。
- **路径**：`WorkspaceArchivedTasksFlatSection.tsx`、`TaskList.tsx`、`TaskRenameDialog.tsx`、`lib/imeComposition.ts`
- **为何好**：归档不是把会话弄丢，也不是立刻弹一个大模态。
- **Jeff**：没有会话归档。删除是另一条路。若做归档：行内二次确认、输入法 Enter 不提交，这两条即使用在改标题、退群上也值得单独做。

### 4.6 新建会话先别落库

- **ZCode**：点新建只进入草稿，列表里是一条虚线「新线程」，第一条消息发出去才真正创建。关掉草稿不留下空会话。
- **路径**：`TaskList.tsx` 的 `startDraft`、`workspace-grouped-tasks/draft-task-row.tsx`
- **为何好**：空会话会把列表堆满，微信也不会先建一百个空聊天。
- **Jeff**：需要对照现有「新会话」是否立刻 insert。交互目标是：未发送就不要在列表里留一条没标题的真会话；若已落库，关闭未发言的草稿时删掉。

### 4.7 行上的操作只在悬停时出现

- **ZCode**：平时只显示时间和摘要；悬停或键盘聚焦时露出置顶、归档。触屏则常驻。只读或目录丢了时，新建按钮禁用，并且只在这时用 tooltip 解释原因，平时不拿快捷键 tooltip 吵人。
- **路径**：`TaskListItem.tsx`、`WorkspaceSidebar.tsx` 的 `WorkspaceNewTaskTooltip`
- **为何好**：列表安静，操作还在。
- **Jeff**：弱版。操作多在点进会话或资料页。会话行悬停：置顶、改标题、标未读。模型没配对时，发送或新建要说出原因。

### 4.8 命令中心

- **ZCode**：侧栏顶部一条看起来像搜索框的按钮，写着打开命令中心，尾巴是快捷键。里面搜命令、会话，分区限条数，高亮匹配的字。
- **路径**：`WorkspaceSidebar.tsx`、`command-center/`、`quickpick/`
- **为何好**：会话、智能体、定时任务、插件、设置分散在导航里，一个入口能跳。
- **Jeff**：没有。`Ctrl/Cmd+K` 搜这些对象即可，不要搜工作区文件。侧栏上放一个假搜索框，比只在文档里写快捷键容易被发现。

### 4.9 窄窗口自己把栏收起来

- **ZCode**：窗口变窄后延迟约 300ms：侧栏窄过阈值就收起，右侧栏窄过阈值也收起，中间对话留着。拖动过程中改的是 CSS 变量，面板不重挂，草稿和滚动还在。
- **路径**：`app-shell/WorkspaceShellLayout.tsx`、`v4/workbenchLayout.ts`
- **为何好**：Jeff 已有「窗口变小只把栏挤窄、不改偏好宽度」。再窄时人还是得自己按 `Ctrl+B`。自动收起不应写回偏好，变宽后按偏好恢复。
- **Jeff**：弱版。手动收放和偏好宽度已有（`layout/panes.ts`）。没有窄窗自动收起。

### 4.10 列表在流式输出时不要整表闪

- **ZCode**：生成过程中侧栏行不跟着每个 token 重绘。注释和实现都在防「稳定的工具栏回调」和「空数组每次新建导致子树重渲染」。
- **路径**：`WorkspaceSidebar.tsx`、`TaskList.tsx`
- **为何好**：流式是常态，列表一闪，人会以为会话切换了。
- **Jeff**：未对照渲染是否已隔离。原则：只有当前会话那一行的忙碌状态变，其余行不重绘。

### 4.11 其余壳层

| 模式 | ZCode | Jeff |
|------|--------|------|
| 收起后留下窄轨，悬停 Logo 变成「展开」，tooltip 带快捷键 | `WorkspaceSidebar/WorkspaceSidebarCollapsedRail.tsx` | 弱版。已能收起。可加窄轨和快捷键提示 |
| 列表可滚动时上下渐隐，滚到头渐隐消失 | `WorkspaceSidebar.tsx` 的 scroll mask | 没有 |
| 任务级后退 / 前进（聊天、设置、插件之间） | `DesktopTopOverlay.tsx`、`lib/taskNavigationHistory.js` | 没有。`Alt+←/→` 可选 |
| 侧栏底部：账户、主题、缩放、用量 | `WorkspaceSidebarFooter.tsx` | 弱版。主题在导航底部，设置是单独一页 |
| 窗口变窄时的 Linux 圆角裁剪、Windows 左上 Logo 和侧栏图标对齐 | `DesktopWindowFrame.tsx`、`WindowsTopLeftLogo.tsx` | 对照打包外观即可，不是功能缺口 |
| 行数摘要 `+n/-n` | `TaskListItem.tsx` | 不搬，那是代码 diff |

---

## 5. 设置、预览、浏览器、更新

### 5.1 设置分组和深链

- **ZCode**：设置侧栏按「基础 / Agent 能力 / 数据」分组。每行是标题、一句说明、右侧控件。子页顶栏是「设置 › 插件 › 某一项」，面包屑由子页上报。从报错、空状态、用量卡可以带着「打开哪一节」跳进来，并记住上次打开的节。插件和 MCP 行上有作用域药丸：用户级、工作区、默认。点整行进入详情，点开关不触发进入。
- **路径**：`settings/settingsPageConfig.ts`、`SettingsPage.tsx`、`settings/SettingsPageParts.tsx`、`settings/SettingsHeaderBreadcrumb.tsx`、`settings/SettingsScopeBadge.tsx`、`settings/settingsResourceRowInteraction.ts`、`lib/settingsNavigation.js`
- **为何好**：Jeff 的设置会继续变多（模型、MCP、同步、外观、浏览器、通知）。报错时「去设置里修」如果要人自己找，等于没入口。
- **Jeff**：弱版。已有分区页面。没有「失败按钮直达某一节」，没有作用域药丸，列表是否整行可点不一致。插件、MCP、技能现在分散（插件页、设置里的 MCP、同步页上的技能备份）。备份入口必须留在设置 → 同步（目录型数据的约定），但设置叙事可以收成一组「扩展」：已装插件、MCP、技能路径，同步页仍负责备份。

### 5.2 插件详情里的「试一下」

- **ZCode**：商店详情页按能力分块，并有示例说法，一键把 mention 放进当前输入框，不覆盖已有草稿。
- **路径**：`settings/PluginStoreDetailView.tsx`、`settings/pluginStoreTryPrompt.ts`
- **为何好**：装完不知道说什么，是插件页最大的空窗。Jeff 没有商店，但每个插件已有一条 `/` 指令和中文名。
- **Jeff**：没有。插件详情放一两句「对小杰说……」，点了打开小杰并预填指令 chip。不自动发送。

### 5.3 第一次打开，以及勾选着导入

- **ZCode**：欢迎页两条路：开始设置，或只做迁移。向导侧栏有步骤。职业和界面模式是大卡片（偏编码 / 偏办公），办公模式默认收起一部分编码界面。API Key 可以跳过。设置里可以再跑一遍向导。从 Claude、OpenCode 等导入时，按「类别 × 来源」勾选，不是一键全盘复制。
- **路径**：`onboarding/OnboardingWelcomeView.tsx`、`onboarding/OnboardingDialog.tsx`、`onboarding/OnboardingModeSelector.tsx`、`login/LoginApiKeyForm.tsx`、`settings-sync/SettingsSyncSelectionStep.tsx`
- **为何好**：老用户不想走六步；新用户需要知道下一步是模型还是同步。
- **Jeff**：没有向导。模型页已能稍后配置。可做的轻量版：首次「先配一个模型」或「从 WebDAV 恢复」；可选两步，角色不必做职业网格，布局预设可以是「先只留会话」或「三栏都打开」。导入只做「发现本机已有的 OpenCode provider / MCP / skills 路径，勾选后写入」，不搬聊天记录。设置里留「再看一次」。

### 5.4 聊天显示密度

- **ZCode**：设置里可以关推理块、把工具按种类分组折叠、选择队列式还是引导式交互。
- **路径**：`settingsPageHelpers.tsx`（message stream、tool grouping）
- **为何好**：同一套数据，有人要像微信一样只看结果，有人要看工具。
- **Jeff**：没有开关。思考和工具的默认折叠可以先做成设置项，再考虑分组。

### 5.5 外观改完能看见样子

- **ZCode**：浅色和深色各一张预览卡，里面是真的代码块，而不是色板。另有界面字号。
- **路径**：`settingsCodePreview.tsx`、`settings/SettingsPageParts.tsx` 的 ThemePreviewCard
- **为何好**：Jeff 的主题已经会改气泡、链接、代码块，色板看不出链接在暗色下能不能读。
- **Jeff**：弱版。已有亮色、深夜、跟随系统。外观页加一小块「气泡 + 代码 + 链接」样张即可。

### 5.6 文件预览：选中一段发给当前会话

- **ZCode**：预览顶栏统一：路径面包屑、类型图标、溢出菜单（预览/源码、换行、外部打开、复制路径）。大文件先出骨架，不白屏。Markdown 里拖选文字，浮层把它引用进当前会话，并带上文件路径。外链走内置浏览器。代码、图片、音视频、PDF、Office、演示文稿走同一壳，重的用懒加载。
- **路径**：`PreviewPane.tsx`、`previewPaneMarkdownContent.tsx`、`previewPaneContent.tsx` 及各格式文件
- **为何好**：项目群的工作空间里会有说明、表格、截图。人要指着某一段问，而不是把整份文件再贴进输入框。
- **Jeff**：弱版。资料里的 `.md` 有内置预览，其它文件交给系统打开。优先补：md 选区「发给当前智能体/群」、预览里的链接进内置浏览器。PDF 和图片预览第二步。xlsx、pptx、行级代码评论不优先。右键「复制路径 / 在文件夹中显示」可以加在工作区文件行上，这是从 Git 变更卡抽象出来的，不需要 Git。

### 5.7 浏览器：人在用的时候，要看得出小杰也在用

- **ZCode**：工具栏有后退、前进、刷新（加载中转圈）、地址栏、响应式视口、元素拾取、开发者工具。加载失败和证书错误是专门的一屏，能重试，设置里可放行不安全证书。响应式框可拖边，宽高输入超出范围标红，不悄悄改成别的数。Agent 正在操作时有提示，避免人和自动化抢同一页面。
- **路径**：`EmbeddedBrowserPaneParts.tsx`、`embeddedBrowserHelpers.ts`、`browser-use/ResponsiveBrowserViewport.tsx`、`browser-use/useBrowserUseOperationActive.ts`、`settings/BrowserSettingsSection.tsx`
- **为何好**：Jeff 的约定就是人和智能体看同一个页面。缺的是「此刻是谁在操作」和证书失败时人能看懂的那一屏。
- **Jeff**：弱版，比「只有工具、没有人用栏」要完整。已有后退、前进、刷新、地址栏（`BrowserPanel.tsx` 的 `browser-address`）、分辨率菜单（自动 / 4:3 / 精确像素）。没有：证书错误专屏、Agent 操作中的顶栏提示、拖边改视口（现在是菜单和工具）。提示条优先于再做一个响应式框，因为分辨率工具已经在。

### 5.8 定时任务卡片上的四态

- **ZCode**：每张自动化卡片写着上次是完成、出错、进行中还是停掉，加上相对时间；参数是小芯片；可以立刻跑，详情里是运行历史，启动前有填参数的对话框。
- **路径**：`settings/saved-workflows/SavedWorkflowCard.tsx`、`SavedWorkflowRunHistoryPanel.tsx`、`SavedWorkflowLaunchDialog.tsx`
- **为何好**：和 Jeff 定时页是同一类物体。
- **Jeff**：弱版。已有上次失败红标、立即执行、展开后的运行记录（成功、失败、错过、跳过、执行中）。可以加强的是：卡片上常驻四态和相对时间，而不只在失败时出红标；「用一句临时消息试跑」和正式 cron 分开，避免试跑改掉任务正文。

### 5.9 快捷键要能看见、能改

- **ZCode**：按钮悬停是「标题 + 一句说明 + 键帽」，键帽随平台变。设置里可搜索命令，也可以按一组键反查谁占用了它；录制新键时若冲突，明确询问是否抢走；可恢复默认。
- **路径**：`ControlHintTooltip.tsx`、`settings/ShortcutSettingsSection.tsx`、`shortcuts/conflicts.ts`
- **为何好**：Jeff 的快捷键已经不少（收放列表、主题、新建群、打开小杰），人在界面上看不见。
- **Jeff**：没有设置页。第一步只做悬停提示（发送、停止、收放列表、浏览器、定时）。可录制、可冲突抢绑放到后面，隐藏开发者专用键。

### 5.10 应用里能知道有新版本

- **ZCode**：有更新时顶栏或帮助菜单变样，悬停能看发行说明。对话框分「还没下 / 下载中 / 已下好待重启」，可跳过这一版，可勾选以后自动下。说明按语言回退，日期按 UTC 格式化，避免差一天。
- **路径**：`UpdateStatusButton.tsx`、`UpdateStatusDialog.tsx`、`updateStatusModel.ts`、`updateReleaseNotes.ts`
- **为何好**：Jeff 靠 GitHub Release 和本机安装包，人打开「关于」才知道版本号，不知道有没有新的。
- **Jeff**：没有应用内状态。最小做法：关于页「检查更新」，读到新版本就展示说明并打开下载页。自动下载安装、独立更新窗口可以不做。

### 5.11 未读角标和帮助菜单

- **ZCode**：多个窗口的未读合成系统 Dock / 任务栏角标（`packages/desktop/src/main/unreadBadge.ts`）。帮助菜单把文档、社区、反馈、更新、关于、资源占用收在一处（`WorkspaceHelpMenuButton.tsx`）。反馈中心可以贴截图，后台上传时不抢焦点。资源窗口按进程组看 CPU 和内存，存储清理前二次确认并告诉人清掉了多少。
- **路径**：见上
- **为何好**：Jeff 已经有托盘和系统通知。角标是人没打开窗口时的那一眼。帮助菜单避免顶栏堆满「关于、日志、检查更新」。
- **Jeff**：没有角标聚合，没有统一帮助菜单，没有存储清理页。通知已有。角标依赖 4.1 的未读。清理页只针对日志、旧安装残留和浏览器缓存，备份目录不进「一键清理」。反馈中心不是当前优先级。

### 5.12 其余设置项

| 模式 | ZCode | Jeff |
|------|--------|------|
| 数据目录、HTTP 代理、任务自动归档天数 | `settingsPageHelpers.tsx` | 弱版。同步和 WebDAV 已有。代理和运行历史保留天数没有暴露 |
| 浏览器缓存、Cookie、证书策略 | `settings/BrowserSettingsSection.tsx` | 没有独立设置。证书策略和 5.7 一起考虑 |
| 用量热力图 | `settings/usage-stats/UsageHeatmap.tsx` | 没有。本地按日的轮次或工具次数即可，不上报 |
| 记忆设置和 Agent 能力放在同一组 | `settings/MemorySettingsSection.tsx` | 记忆走工具，设置里没有入口。不必单独做页，除非人要清空 |

---

## 6. 建议先做哪些

按「每天都会碰到」和「是否贴 Jeff 现有心智」排，不是按 ZCode 功能完整性排。同一批里也不要一次做完。

### P0

| 项 | 章节 | 一句话 |
|----|------|--------|
| 按会话记住草稿 | 2.4 | 切聊天不丢半句话 |
| 发送历史 ↑↓ | 2.1 | 改一句重发 |
| Esc 关掉 slash 后不再弹出 | 2.5 | 面板关得掉 |
| 空会话推荐说法 | 2.8 | 小杰打开就知道能说什么 |
| 滚动权 + 回底 + 记住读到哪 | 3.1、3.2 | 往上翻不被拽走 |
| 工具行同一套摘要，失败能复制 | 3.5 | 工具变多也不刷屏 |
| 划词 / 浏览器选区进输入框 | 2.11、3.7 | 带着上文继续问 |
| 未读和用户置顶 | 4.1、4.2 | 列表像聊天列表 |
| 当前会话查找 | 3.8 | 长对话找原话 |
| 插件「试一下」预填小杰 | 5.2 | 装完有一句能说的 |
| 浏览器上标明小杰正在操作 | 5.7 | 人和工具不抢页面 |
| 定时卡片常驻上次运行状态 | 5.8 | 不用展开才知道失败 |

### P1

发送失败保留草稿并写明不能发的原因；忙时消息队列；句首「、」当 `/`；回合耗时；轮内历史步骤折叠；设置失败深链；外观样张；md 选区发给当前会话；快捷键悬停提示；关于页检查更新；窄窗自动收栏但不改偏好宽度；新建未发言不留空会话；行内二次确认和输入法 Enter。

### P2

命令中心；消息轨改成按一轮；分享或导出时勾选若干轮；断线后的重发条；系统未读角标；帮助菜单；本地用量；PDF/图片预览；快捷键可录制；「+」菜单；附件进度；分组吸顶和时间线视图；会话归档。

### 先别做

第 1 章那张表。另外：思考档位循环按钮、`#` / `$` 第二套触发符、文件树当主栏、聊天内分屏、自动下载安装包、权限弹窗（在引擎仍自动放行时不要只加 UI）。

---

## 7. 文件索引

下面只列本文引用过、并在仓库里对上过名字的入口，方便以后按章回看。路径均相对于 ZCode 仓库根目录。

### 输入

- `packages/ui/src/LexicalChatInput.tsx`
- `packages/ui/src/lib/promptHistory.ts`
- `packages/ui/src/SlashCommandPlugin.tsx`
- `packages/ui/src/slashCommandPanelSections.tsx`
- `packages/ui/src/shortcuts/composerShortcuts.ts`
- `packages/ui/src/shortcuts/bindings.ts`
- `packages/ui/src/v4/ConversationComposer.tsx`
- `packages/ui/src/v4/ConversationQueuePanel.tsx`
- `packages/ui/src/v4/composer/escapeStop.ts`
- `packages/ui/src/v4/composer/followupModeSettings.ts`
- `packages/ui/src/v4/ConversationDraftSuggestedPrompts.tsx`

### 时间线与工具

- `packages/ui/src/v4/ConversationTimeline.tsx`
- `packages/ui/src/v4/timelineScrollAnchor.ts`
- `packages/ui/src/v4/ConversationTurnNavigator.tsx`
- `packages/ui/src/v4/useConversationTimelineFind.ts`
- `packages/ui/src/v4/ConversationTurnGroup.tsx`
- `packages/ui/src/v4/PendingCommandRecoveryBanner.tsx`
- `packages/ui/src/ToolCallBlocks/ToolLayout.tsx`
- `packages/ui/src/PermissionDialog.tsx`
- `packages/ui/src/ElicitationDialog.tsx`
- `packages/ui/src/InteractionRequestOriginBadge.tsx`
- `packages/ui/src/AssistantPreviewCards.tsx`

### 侧栏

- `packages/ui/src/WorkspaceSidebar.tsx`
- `packages/ui/src/TaskList.tsx`
- `packages/ui/src/TaskListItem.tsx`
- `packages/ui/src/TaskInteractionBadge.tsx`
- `packages/ui/src/WorkspacePinnedTasksSection.tsx`
- `packages/ui/src/WorkspaceArchivedTasksFlatSection.tsx`
- `packages/ui/src/TaskRenameDialog.tsx`
- `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`

### 设置、预览、浏览器、更新

- `packages/ui/src/SettingsPage.tsx`
- `packages/ui/src/settings/settingsPageConfig.ts`
- `packages/ui/src/settings/PluginStoreDetailView.tsx`
- `packages/ui/src/onboarding/OnboardingWelcomeView.tsx`
- `packages/ui/src/settings-sync/SettingsSyncSelectionStep.tsx`
- `packages/ui/src/PreviewPane.tsx`
- `packages/ui/src/previewPaneMarkdownContent.tsx`
- `packages/ui/src/EmbeddedBrowserPaneParts.tsx`
- `packages/ui/src/settings/saved-workflows/SavedWorkflowCard.tsx`
- `packages/ui/src/ControlHintTooltip.tsx`
- `packages/ui/src/settings/ShortcutSettingsSection.tsx`
- `packages/ui/src/UpdateStatusDialog.tsx`
- `packages/desktop/src/main/unreadBadge.ts`

### Jeff 对照

- `apps/desktop/src/renderer/src/components/ChatWindow.tsx`（草稿、发送、停止）
- `apps/desktop/src/renderer/src/components/GroupWindow.tsx`
- `apps/desktop/src/renderer/src/components/ComposerDraft.tsx`
- `apps/desktop/src/renderer/src/components/MessageRail.tsx`
- `apps/desktop/src/renderer/src/components/ChatList.tsx`（小杰置顶标签）
- `apps/desktop/src/renderer/src/components/BrowserPanel.tsx`（地址栏、前进后退、分辨率）
- `apps/desktop/src/renderer/src/components/SchedulesPage.tsx`（上次失败、立即执行、运行记录）
- `packages/core/src/index.ts`（权限询问自动允许）

---

## 8. 落地（1.8.23）

第 6 章 P0 的 12 项已做进现有聊天、插件、浏览器和定时页。版本 `1.8.22` → `1.8.23`（PATCH）。P1、P2 和「先别做」未动。未读、置顶、草稿、发送历史、滚动位置都在本机 `localStorage`，不进 `jeff.db`，也不进 WebDAV。

| 项 | 落点 |
|----|------|
| 草稿 | 私聊键 `jeff:draft:agent:<sessionId>`，群键 `jeff:draft:group:<projectId>:<threadId>`。会话 id 还没到时不覆盖已存草稿；离开会话时立刻落盘；发送成功才删 |
| 发送历史 | 同一键下最近 30 条。输入为空或正在回翻时 ↑↓ 回填，光标在多行中间不抢方向键，回填不重新打开斜杠 |
| Esc 关斜杠 | 记下字段、`/` 位置和查询串。查询没变就不再弹出 |
| 小杰空会话 | 历史为空时输入区上方 3 条固定说法，点击只写入草稿 |
| 引用 | 气泡划词出现「引用」；浏览器栏「引用选中文字」。药丸可单条删除，发送时拼进用户消息 |
| 插件试一下 | 详情里每个指令一个按钮，切到小杰并预填筹码，不覆盖已有正文 |
| 滚动 | 上次贴底则仍贴底，否则恢复 `scrollTop`。程序滚动不记成用户贴底。离开底部显示「回到底部」 |
| 查找 | `Ctrl/Cmd+F`，只搜已加载消息正文，上一条/下一条，当前命中高亮 |
| 工具失败 | 折叠条写出失败的工具名；展开后错误旁可复制 |
| 未读与置顶 | 非当前会话的新消息记未读（蓝点）。右键置顶/标为未读。置顶区在小杰下面、项目群上面。小杰仍固定最上，不进用户置顶。生成中的绿点保留 |
| 浏览器忙 | 工具调用期间顶栏浮层「小杰正在操作这个页面」，不挡住点击，也不改变页面视口尺寸 |
| 定时卡片 | 始终显示上次执行中/成功/失败/已错过/已跳过和相对时间；从未跑过写「尚未运行」。失败仍用红色 |

封闭测试在 `apps/desktop/e2e/p0-ux.spec.ts`（并入 `ui` 项目）：Esc 后斜杠不复弹、切会话草稿还在、回底、查找下一条、插件试一下预填小杰、定时五态文案、浏览器忙时顶栏出现。纯函数在 `packages/core/src/util/chatUi.ts`，单测 `packages/core/tests/chat-ui.test.ts`。

## 9. 界面风格（1.8.24）

对照 ZCode 的中性表面、细边和浅色导航，把 Jeff 从微信灰底黑栏收成工作台。信息架构没动：仍是三栏，智能体是好友，项目群是群，小杰固定在最上。

- 亮色底改为 `#f3f4f6` / `#f7f8fa` / 白面板，导航栏改浅底并露出图标下的二字标签。选中用细绿条，不再铺一整块微信绿。
- 深夜改为蓝灰中性色，不再是纯黑。
- 用户气泡改成浅绿色块、四角一致；对方气泡是白底细边。输入框和发送按钮用 12px / 10px 圆角。品牌色仍是微信绿 `#07c160`，只做强调。
- 导航宽度仍是 64px，分栏计算不用改。
