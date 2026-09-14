# mermaid 放大修复 + 工具栏图标化 + live11 二十轮全功能实测（v1.7.31 → v1.7.32）

- 日期：2026-09-13（会话跨零点至 09-14 上午收官）
- 版本：1.7.30 → **1.7.31**（两个 UI 修复 + 测试基建）→ **1.7.32**（第六节：拖拽平移 + 两个渲染层真 bug）
- 产物：`apps/desktop/release/jeff-desktop_<版本>_amd64.deb`（已装本机，md5 与 linux-unpacked 一致）、`Jeff-<版本>.AppImage`、`jeff-Setup-<版本>.exe`（PE32 Nullsoft，asar 含本次特征串，oc-bin 在位）

## 一、Bug 1：mermaid「点放大反而更小」——根因与修复

### 根因（两层叠加）

1. **收缩盒里的百分比宽度形成循环依赖**：mermaid 渲染出的 svg 是 `width="100%"` + 内联 `style="max-width: NNNpx"`（NNN = 图的原始宽度）。旧版灯箱 `.mermaid-lightbox-fig` 是 flex column 里的 shrink-to-fit 盒子——宽度由内容决定，而内容（svg）的宽度又是容器的 100%，Chromium 把这种循环解析成 SVG 默认对象尺寸（约 300px），于是灯箱里的图比聊天气泡里（撑满气泡宽度）还小。
2. **内联样式压不住**：样式表里的 `max-width: 88vw` 是普通声明，优先级低于 svg 上的内联 `style="max-width: NNNpx"`，放大上限被图的原始宽度锁死。

### 修复（`MermaidBlock.tsx` + `styles.css`）

- 灯箱宽度改由 JS 定死成 px：从 svg 字符串解析 `viewBox` 得到纵横比，`fitW = max(160, min(88vw, 78vh × aspect))`，面板宽 = `fitW × scale + 2×18px`（补回面板内边距，让 svg 内容本身精确填满约束）；没有 viewBox 时回退 `min(88vw, 900px)`。
- CSS 用 `!important` 压过 mermaid 内联上限：`.mermaid-lightbox-fig svg { width:100% !important; height:auto !important; max-width:none !important; max-height:none !important; display:block }`。
- **滚轮缩放（用户追加需求）**：滚轮向上放大、向下缩小（每档 ×1.12，范围 0.25×~6×），React 的 `onWheel` 是 passive 监听，必须 `addEventListener('wheel', h, { passive: false })` 才能 `preventDefault`；双击复位；面板 `margin:auto` + 容器 `overflow:auto`——小图居中、放大超出视口可滚动。
- 交互调整：点图片不再关闭灯箱（原「点击任意处关闭」易误触），改点空白处关闭；提示行固定视口底部 `position:fixed + pointer-events:none`。
- 验证口径（写进了 mock/live 两套 E2E）：**灯箱宽 ≥ 内联宽**（回归断言）+ **至少一维填到视口约束的 80%**。⚠️ 别用固定 px 断言「变大」——窄高图（viewBox 108×358）按高度约束填，宽度只有 140px 是正确行为；最初用 `≥480px` 断言被这张图打脸两次（0.795 vs 0.8 的差距正好是面板 padding 吃掉的份额，才定位到要把 padding 补回 JS 宽度）。

## 二、Bug 2：mermaid 工具栏图标化

- `Icons.tsx` 新增三个 lucide 风格描边图标：`IconCode`（</> 查看源码）、`IconDiagram`（图表，源码态切回图形）、`IconZoomIn`（放大镜加号）。
- 工具栏「查看源码 / 放大」文字按钮 → `.icon-btn` 图标 + `title/aria-label`；「复制源码」本就是图标 CopyButton。E2E 断言 `.md-mermaid-bar` 的 innerText 为空（无文字按钮）。

## 三、live11：二十轮真实模型全功能实测（20/20 全绿）

测试台 `.tmp/live11/`（= live10 全功能巡检 + live-notify 提醒观测手法合体，同一 home 串行演进，opencode-go 三模型）：

| 段 | 轮次 | 覆盖 |
|---|---|---|
| 提醒专项 | R1-R5 | 私聊通知+提示音与落库一致；群聊多跳只提醒一次；正看着不提醒；设置页三开关落库+试听音+测试通知；「仅后台提醒」语义（前台只响不弹/后台弹通知/点通知跳转会话） |
| mermaid 专项 | R6-R7 | 预置群消息的灯箱≥原图+滚轮缩放+双击复位+图标工具栏；私聊真实模型输出 mermaid+源码切换+复制 |
| 全功能巡检 | R8-R18 | 私聊多轮上下文、MDT 全流程会诊、群协作写文件、小杰代操（建智能体/拉人进群/群简介/任务看板）、MCP 真实查询、联网搜索、写外部文件、GUI 改群名+添加成员+会话管理 |
| 备份专项 | R19-R20 | 立即备份 skills（弹窗统计+远端对账+manifest）、两段式恢复（stage→apply+快照）、会话搜索 |

**应用层 bug：本轮未发现新 bug**（R13 一次断言过严、R18 一次测试写错，均为测试侧问题）。截图证据 `.tmp/live11/evidence/`（52 个文件，人工目检通过：灯箱填满效果、图标工具栏、通知跳转、备份弹窗等）。

## 四、测试台与环境的四个重要发现（都写进了记忆）

1. **e2e.env 未 source 会把空字符串 key 写进 seed**：`launch.ts` 的 `opts.seed.apiKey ?? fileEnv.X` 用 `??`，空串不是 nullish 不兜底 → 模型 401。`ui.spec.ts` 已改为 `process.env.SILICONFLOW_API_KEY || loadE2eEnv().SILICONFLOW_API_KEY` 双兜底（此修复随本次提交入库）。
2. **zen 网关当晚不稳**：sendMessage 偶发挂死 8 分钟（无响应无报错）或直接 `unknown certificate verification error`（opencode 侧 stream error）。属外部故障，提醒类轮次加了「超时没等到就回场重发（≤3 次）」的失败感知重试。
3. **本机 WM 下伪造不了窗口失焦**：`win.blur()`/`win.minimize()` 后 `document.hasFocus()` 仍 true——通知判定正好读这两个 API，唯一可靠做法是渲染层 stub `document.hasFocus`/`hidden`（与 Notification/音效打桩同一性质，被测逻辑不动）。
4. **mermaid 灯箱断言口径**：见上文「验证口径」，固定 px 断言对窄高图必错。

## 五、测试与发版记录

- 第一层：`npm test` 189 passed（含版本五处一致校验）、typecheck 仅 3 个存量 e2e helper 报错、mock UI E2E 全绿（新增 mermaid 渲染/灯箱/滚轮断言段）。
- 第二层：live11 二十轮全绿（分 4 批跑完：R1-R4 / R5-R12 / R13-R17 / R18-R20，`--grep "\bR(N)\b"` 词边界续跑）。
- 第三层：deb 装机 1.7.31（`/opt/Jeff` 与 linux-unpacked 的 app.asar md5 一致）；exe `file` 为 PE32 Nullsoft、`grep -a mermaid-lightbox` 命中 7 处、windows-x64 opencode.exe 在位。
- 改动清单：`MermaidBlock.tsx`（灯箱重写+图标）、`Icons.tsx`（+3 图标）、`styles.css`（灯箱 CSS）、`apps/desktop/e2e/ui.spec.ts`（mermaid 断言段 + env 兜底）、五处版本号 1.7.31。测试台 `.tmp/live11/`（gitignore，不入库）。


## 六、追加：滚轮缩放后溢出看不到 → 拖拽平移（用户反馈，v1.7.32）

用户反馈「虽然能滚轮缩放，但放大后溢出的部分看不到，要实现左键拖拽移动（鼠标变手）」。实现过程中挖出两个更深的问题，都修了：

### 6.1 拖拽平移（本次需求）

- 左键按住拖动：内容跟手走（改灯箱容器的 `scrollLeft/scrollTop`），光标 `grab` → 按住时 `grabbing`；拖动位移 < 4px 仍按点击处理。
- 指针捕获只在**真正开始拖**（超过阈值）时才 `setPointerCapture`，拖出面板也不丢事件。
- `user-select: none` 防止拖拽时选中图内文字；提示行改为「滚轮缩放 · 按住拖动平移 · 双击复位 · 点击空白处关闭」。

### 6.2 灯箱会「自己关掉」——根因是 Markdown 子树被整棵重挂载（真 bug，非本次引入）

- 现象：打开灯箱后 0.5~1 秒内它自己消失（零交互、零报错），表现为「双击复位/点击关闭全都不好使」。
- 定位手法：探针里轮询灯箱 DOM 状态，发现 svg 的 id 从 `mmd-g3sd2cce2rj` 变成了 `mmd-sr8imw2znd` —— id 来自 `useRef(Math.random())`，**id 变了就意味着组件被重新挂载**，state（zoom）随之清零。
- 根因：`Markdown.tsx` 里 `components={{ pre: 内联函数, a: 内联函数 }}` 每次渲染都新建函数，ReactMarkdown 把这些函数当「组件类型」用 → 元素类型身份变化 → `pre` 子树（含 MermaidBlock）整棵重挂载。只要 MarkdownInner 因任何原因重渲染（例如 workspaceDir 从空串变为真实路径这类一次性数据落位），灯箱就被掀掉。
- 修法：`components` 用 `useMemo(() => ..., [])` 固定引用，`live`/`workspaceDir` 用 ref 读取最新值 → 元素类型永远稳定，不再重挂载。**副作用是正向的**：以前每次重渲染都会重跑 `mermaid.render`（mermaid 全量解析排版，正是 v1.7.18 查卡顿时的大头），现在不会了。

### 6.3 「双击复位」不生效——Chromium 在这个灯箱上不合成 click/dblclick（真 bug）

- 修完 6.2 后双击复位仍不生效。探针在 document 捕获层记录完整事件序列，结论很反直觉：**`pointerdown/pointerup/mousedown/mouseup` 都有，但一个 `click`/`dblclick` 都没有**。按下时 `setPointerCapture` 与不捕获两种情况都试过，click 始终不合成（Playwright 的 `mouse.dblclick` 与单点遮罩关闭都受影响）。
- 修法：点击语义不再依赖浏览器合成的 click —— 在 `pointerup` 上自己判定：位移 < 4px 记一次「点击手势」，320ms 内同位置再来一次算双击（复位）；`e.target === currentTarget`（点的是遮罩本身，不是图）才算点空白关闭。
- 附带修正：`as` 的 `mousedown` 目标与 `pointerdown` 目标不一致（一个是 SVG 图形、一个是 fig 容器），所以别指望用 mousedown/mouseup 目标做判定。

### 6.4 本轮验证

- mock UI E2E 全绿（mermaid 段改为**确定性**：测试进程直连 jeff.db 往群里插一条带 mermaid 的 `chat_message` 再重开群，不再赌模型按格式输出——上一版就因为模型这轮没吐 ```mermaid 围栏而失败）；断言含：放大后溢出可平移（scrollLeft/Top 真的动了）、光标 grab/grabbing、拖拽不关闭灯箱、双击复位回基准宽。
- 真实模型 E2E 回归 R5-R10（提醒语义 / mermaid 预置图 / 真实模型输出 mermaid / 私聊多轮 / MDT 全会诊 / 群协作写文件）6/6 全绿，截图 `.tmp/live11/evidence/R6-拖拽平移后.png` 目检确认平移生效。
- bump **1.7.32**（五处一致）；npm test 189 passed；双平台打包与产物校验同第五节口径。
