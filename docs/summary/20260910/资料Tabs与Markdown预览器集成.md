# 资料 Tabs 重构与工作空间文件预览能力（v1.7.17）

## 问题

用户提出四点体验问题：

1. 「项目群」「智能体」右侧的「资料」抽屉是单页长滚动，所有信息混在一起，交互差；
2. 需要在「资料」里增加「文件」入口，浏览当前工作空间下的所有文件与文件夹（主要为了查看任务输出的 markdown）；
3. 需要一个内置的公共 Markdown 预览器：只读、支持 mermaid 渲染、支持 mermaid 放大查看与查看源码，可在任意地方调用；
4. 任务输出 markdown 内容里的相对路径（如 `docs/summary/…/xxx.md`）希望自动识别为蓝色链接，点击直接用内置预览器打开。

## 方案（grill-me 深挖后与用户确认的口径）

- Tabs 划分：项目群 = 群设置 / 群成员 / 会话记录 / 工作区文件 四个 Tab；智能体 = 基本资料 / 模型设置 / 工作区文件 三个 Tab（智能体也有文件 Tab，用全局默认工作区）。
- 文件树显示全部文件（过滤 `.git`、`node_modules` 等噪音目录）；点击 `.md` 进内置预览器，其它文件交系统默认程序打开。
- 预览器形态 = 应用内大模态层（Modal）。
- 相对路径链接识别范围 = 消息气泡正文 + 工具调用输出（ToolOutput）。

## 实现

### IPC（packages/core/src/ipc/contract.ts + apps/desktop/src/main/ipc.ts）

新增三个通道（`InvokeMap` 同步补全）：

- `fs:listFiles`：递归列出目录树（`FileNode[]`），忽略 `.git/node_modules/.tmp/.DS_Store/Thumbs.db/__pycache__/.venv/.idea/.vscode/.pytest_cache/.next/.cache/desktop.ini` 等；深度上限 12、节点上限 4000，超限标 `truncated`；目录在前、按名排序。
- `fs:readFile`：UTF-8 读取单文件，8MB 上限截断；首 8KB 含 NUL 判为二进制拒绝预览。
- `fs:openPath`：`shell.openPath` 用系统默认程序打开；`reveal: true` 时 `shell.showItemInFolder`（文件管理器中定位）。

### 抽屉横向 Tabs

- `GroupInfoDrawer.tsx`：顶部 `.drawer-tabs` 四个 Tab；三个内容区用 `display:none` 切换（**表单草稿切 Tab 不丢失**）；「解散群」并入「群设置」Tab。
- `AgentProfileDrawer.tsx`：三个 Tab；`AgentEditor` 常驻挂载，新增 `section` prop（`all/basic/model`）按 Tab 过滤字段；小杰锁定态在「基本资料」Tab 显示提示文案。
- 智能体「工作区文件」= Jeff 默认工作区（`appInfo.dataDir + '/workspace'`，即 sidecar 工作目录）；项目群 = 已保存的 `project.workspace_dir`（未配置则同默认工作区）。

### 公共 Markdown 预览器（components/preview/）

- `previewStore.ts`：zustand 全局状态，`openFile`（IPC 读文件）/ `openRel`（相对路径入口：`.md` 进预览器，其它走系统打开）/ `notify`（轻提示，4s 自动消失）/ `reload` / `close`。
- `MarkdownPreviewModal.tsx`：大模态层（`z-index:150`，920px × 86vh），标题栏带文件名、完整路径、刷新、在系统中打开、复制路径，Esc 关闭；App 顶层挂载 `<MarkdownPreviewModal />` 与 `<PreviewNotice />`，任意处一行代码调用。
- `MermaidBlock.tsx`：懒加载 `mermaid@11`（按需 `import`，不拖慢启动），按亮/暗主题初始化；工具栏支持「查看源码 / 查看图形」切换、复制源码；「放大」与点击图表弹出全屏 Lightbox（`z-index:300`，矢量无损）。
- `Markdown.tsx`：`pre` 分发 —— `language-mermaid` 代码块渲染为 `MermaidBlock`（新增 `nodeText` 递归还原被 rehype-highlight 拆开的源码文本）；其余保持原代码块（语言标签 + 复制按钮）。

### 相对路径识别为蓝色链接

- `linkify.ts`：逐行扫描 markdown（跨行维护 ``` / ~~~ 围栏状态），跳过行内代码、已有链接、URL 区域后，把「≥1 级目录 + 已知扩展名」的相对路径（支持中文文件名）替换为 `[📄 path](#jeff-file:path)` 站内 fragment 链接（react-markdown 默认 urlTransform 不会丢弃 fragment）。
- `Markdown.tsx` 的 `<a>` 渲染器识别 `#jeff-file:` 前缀 → `FileLink`（蓝色下划线链接），点击经 `previewStore.openRel`：拼工作空间绝对路径（`joinWorkspacePath` 支持 `./ ../`、Windows 盘符、绝对路径），`.md` 进预览器，不存在时轻提示「打开失败」，非 md 用系统程序打开。
- `ChatShared.tsx`：`ToolOutput`（工具输出 `<pre>`）与 `AssistantExtras` 同样支持 `workspaceDir`，纯文本按路径拆段渲染可点击链接。
- workspaceDir 贯通：ChatWindow（私聊默认工作区）/ GroupWindow（群工作空间）/ GroupInfoDrawer 历史预览 / ChatHistoryDrawer（群会话按群、私聊按默认）。

### 样式（styles.css）

新增 `.drawer-tabs/.drawer-tab`、`.file-tree*`、`.md-file-link`（亮色 #2563eb / 暗色 #7fa7ff）、`.md-mermaid*`、`.mermaid-lightbox*`、`.preview-*`（模态 + 轻提示 toast）。

## 依赖与版本

- `apps/desktop` 新增依赖 `mermaid@^11`（渲染层懒加载）。
- 版本号 1.7.16 → **1.7.17**（PATCH：在已有「资料」能力上打补丁 + 小能力增强，遵循 AGENTS.md「宁可 PATCH」），同步三处 `package.json` 与 `package-lock.json`。

## 验证

- `npm run typecheck -w jeff-desktop` 通过；`@jeff/core` 单测 146 passed / 14 skipped 全绿（根 typecheck 仅剩 main 上既有的 3 个 e2e helper 报错，与本次无关）。
- `npm run package:linux` → `jeff-desktop_1.7.17_amd64.deb`，`sudo dpkg -i` 本机安装成功（设置-关于可查 1.7.17）。
- 冒烟脚本 `node scripts/smoke.mjs`（chat/contacts/group 等 9 视图）全部截图正常、退出码 0。
- `npm run package:win` → `jeff-Setup-1.7.17.exe`，`wine64` 启动安装向导正常（仅字体 fixme 日志，无崩溃）。

## 遗留 / 注意

- 消息里识别路径的扩展名白名单见 `linkify.ts` 的 `PATH_SRC`，后续要支持新类型改这里即可。
- 文件树大小上限：深度 12 / 4000 节点，超大仓库会显示 `…` 截断标记，点「在系统中打开」可看全量。
- 预览器为只读设计，有意不提供编辑能力（后续若要编辑建议走「在系统中打开」交给外部编辑器）。
