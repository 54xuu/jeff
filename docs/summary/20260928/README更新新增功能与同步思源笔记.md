# README 更新新增功能与同步思源笔记

**日期**：2026-09-28  
**涉及范围**：`README.md`、`docs/assets/mobile-remote.png`、思源笔记（文档 ID：`20260928220736-9fjtvd4`）

---

## 1. 任务背景

用户要求：
1. 把 Jeff 项目近期新增的功能写入到 `README.md` 里，重新整理对项目的介绍，如需要图片自行截图；
2. 把 `README.md` 写入思源笔记文档 ID 是 `20260928220736-9fjtvd4` 的文档里。

---

## 2. README 重构与新增功能梳理

在保留核心心智模型（**Jeff = 你的 AI 团队；私聊干一件事，群聊干一件复杂的事——像微信一样工作**）的前提下，系统性补充与重构了近期的核心能力：

1. **移动端遥控器（Jeff Mobile App - Android）**：
   - 手机端 React + Capacitor 架构，端到端加密（E2EE）安全协议直连桌面端，中转站只转密文，数据不落云端；
   - 微信式高质感交互视觉，支持会话漫游、思考过程折叠展开、工具调用跟踪；
   - 移动端原生 Markdown 渲染与 Mermaid 流程图/时序图全屏交互灯箱。
2. **定时任务自动化（Schedules & Cron）**：
   - 支持 5 段标准 Cron 表达式与单次执行定时器；
   - 独立会话隔离：每个定时任务在后台独立 opencode 会话或群话题中静默运行，产出自动回群汇报，不干扰主窗口；
   - 小杰管家自然语言随时调度，支持开机补偿（catchup）与 WebDAV 同步。
3. **插件扩展体系与 `/` 快捷指令**：
   - 目录即插件，快速接入垂直领域 MCP（如智慧病房业务等）；
   - 跨插件全局唯一 `/` 快捷指令体系，快速分流唤起专业能力；
   - 首页联动内置浏览器，小杰管家对话即可快速开发插件。
4. **子任务独立派发（`jeff_spawn_subtask`）**：
   - 面对批量、并行或探索性子任务，可各自开辟独立空白上下文会话，避免长流程上下文污染主线。
5. **内置浏览器人机协同**：
   - 右侧独立面板，人机同屏；智能体支持自主导航、点击、填表、传文件、像素级 CSS 视口/整页截图与实时网络/控制台异常捕获。
6. **跨设备同步与备份**：
   - 实体级 WebDAV 双向同步（LWW + 墓碑机制），Skills 与 Plugins 目录镜像备份与快照恢复。
7. **全平台设计与极致细节**：
   - 经典微信翡翠绿 + Catppuccin 优雅粉彩双主题随心切换；
   - 会话草稿暂存、SQLite FTS5 中文全文检索、未读置顶、长任务贴底导航、Windows 自绘通知气泡。

---

## 3. 图片截图与素材生成

针对新增的「移动端遥控器」，采用 Playwright 驱动移动端视口（390×844），模拟真实数据与小杰管家对话流程：
- 包含了微信式气泡、思考过程折叠条、工具调用徽标（`jeff_cron_list` / `jeff_session_search`）、正文说明以及 Mermaid 策划流转图；
- 产出高清晰度产品配图：`docs/assets/mobile-remote.png`，并编排进 `README.md` 的「移动端遥控器 · 随时随地掌控进展」小节。

---

## 4. 思源笔记同步

1. **静态资源内嵌**：
   - 通过 SiYuan Kernel API `/api/asset/upload`，将 `README.md` 中引用的 6 张关键配图（含新截取的移动端遥控器图及联系二维码）完整上传至思源笔记的 `/assets/` 资源库，建立映射：
     - `docs/assets/group-promo.png` → `assets/group-promo-20260928221541-kbsrek7.png`
     - `docs/assets/agents.png` → `assets/agents-20260928221559-bhaehky.png`
     - `docs/assets/xiaojie.png` → `assets/xiaojie-20260928221559-0o832ex.png`
     - `docs/assets/browser-weixin.png` → `assets/browser-weixin-20260928221559-kh4lbkz.png`
     - `docs/assets/mobile-remote.png` → `assets/mobile-remote-20260928221559-22shfm4.png`
     - `docs/assets/20260920105423_26_93.png` → `assets/20260920105423_26_93-20260928221559-v9e8vai.png`
2. **正文同步与写入**：
   - 将替换为思源内部资源路径后的 Markdown 正文通过 `/api/block/appendBlock` 写入文档 `20260928220736-9fjtvd4`（标题：《Jeff AI Agent 智能体介绍》）；
   - 清理初始的空占位段落块（`20260928220736-u6cums3`）。
3. **闭环校验**：
   - 调用 `export_md.py` 重新导出并验证文档内容，确认层级标题、表格、引用及所有配图均已在思源笔记中完整解析与渲染。
