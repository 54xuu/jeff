# Jeff 桌面应用设计与实现（总结）

> 本文档是 Jeff 桌面应用的完整总结。问题：实现个人「开发+项目管理」agent 桌面应用（win-x64 + linux-x64）。
> 仓库：https://github.com/54xuu/jeff · 发布：https://github.com/54xuu/jeff/releases/tag/v1.0.0

## 需求回顾与落地情况（10/10）

| # | 需求 | 落地 | 状态 |
|---|---|---|---|
| 1 | 记忆功能（参考 hermes-agent） | MemoryStore（§ 条目/字符预算/原子写/锁）+ 分层（全局用户画像/每 agent/每项目群）+ 每 10 轮后台自省 + 全会话 FTS5 检索 | ✅ |
| 2 | 多渠道提供商 + 会话内选择 | opencode 75+ provider；设置页配置（预设/OpenAI 兼容自定义）；聊天输入框模型下拉（会话级）+ agent 默认模型 | ✅ |
| 3 | Skill | opencode 原生（兼容 `.claude/skills` 生态）+ 内置 `/jeff-usage` 使用说明 skill | ✅ |
| 4 | MCP 连接器 | opencode 原生（local/remote）+ 设置页 MCP 管理器（增删/启停/headers） | ✅ |
| 5 | 多智能体创建（参考 multica） | agent CRUD（UI + 小杰工具）+ 群内多成员 + leader 委派编排（防重/防失控） | ✅ |
| 6 | 内置「小杰」（不可编辑） | builtin agent：全应用 admin 工具（agent/项目/任务/MCP/记忆），无编码工具；指令随代码强制对齐 | ✅ |
| 7 | 项目（可关联多智能体） | 项目群：群主 leader + 成员（角色）+ 群资料抽屉成员管理 | ✅ |
| 8 | 任务（参考 multica issues） | JEF-n 编号、状态/优先级/指派、聊天任务卡片 + 群内看板拖拽 | ✅ |
| 9 | 微信式布局与色调 + 亮/深夜 | 导航栏/会话列表/聊天窗口/群资料抽屉；微信绿 #07C160；亮/深夜/跟随系统 | ✅ |
| 10 | WebDAV 同步（除会话数据） | 实体级双向合并（agents/projects/tasks/settings/memory）+ 墓碑删除 + 冲突提示；自动（启动+防抖 30s）+ 手动 | ✅ |
| 11 | win-x64 + linux-x64 | GitHub Actions matrix 原生构建 → Releases | ✅ |

## 决策结论

| 决策 | 结论 |
|---|---|
| 基座 | opencode sidecar（隔离 `OPENCODE_CONFIG_DIR`/XDG 目录，绝不碰用户全局 opencode 配置） |
| 桌面壳 | Electron + React（electron-vite + electron-builder） |
| 群聊协作 | leader 统筹 + @成员直达 + leader 委派（multica squad 的进程内适配） |
| 记忆 | hermes 前两层移植；外部 RAG provider 留接口不做 |
| WebDAV | 实体级双向合并（updatedAt LWW + 墓碑） |
| 数据库 | **node:sqlite**（Node/Electron 原生内置、带 FTS5）——零原生依赖 |
| 构建 | GitHub Actions matrix（ubuntu-latest + windows-latest）→ Releases |
| 执行 | M1→M4 连续无人值守，每阶段自动化验收 |

调研依据见 `docs/notes/20260905-jeff选型调研.md`。

## 架构

```
Electron 主进程
 ├─ SidecarManager：spawn/守护 opencode serve（崩溃重启、健康轮询、脏标记惰性重启）
 ├─ packages/jeff-core
 │   ├─ node:sqlite：agent/project/project_agent/task/chat_message/kv + msg_fts（FTS5 external content+触发器）
 │   ├─ opencode 薄客户端（REST + 全局 SSE，不依赖 @opencode-ai/sdk）
 │   ├─ 编排：私聊路由 / 群聊 leader 路由 + Roster briefing / @直达 / jeff_delegate 委派
 │   ├─ 记忆：MemoryStore（预算自我整合）/ SessionIndex（CJK 逐字 token + phrase 查询）/ nudge 自省
 │   ├─ WebDAV 同步引擎（实体级 LWW + 墓碑 + 冲突记录）
 │   └─ 工具桥：本地 HTTP API（Bearer token）← opencode plugin 工具（ctx 透传 sessionID/agent）
 └─ IPC ↔ React 渲染进程（微信式 UI，zustand）
```

## 实施进度（全部完成）

- [x] 选型调研（opencode/pi/AI SDK；hermes 记忆；multica 智能体/项目/任务）
- [x] M1 基座与私聊：sidecar 隔离集成、微信式 UI、小杰 admin 工具、Provider 设置
- [x] M2 项目群与任务：群聊路由/@直达、看板、任务卡片、DB 迁移 node:sqlite
- [x] M3 记忆与群聊编排：MemoryStore/nudge/FTS5 检索、leader 委派、记忆管理 UI
- [x] M4 WebDAV 同步、MCP 管理、托盘/图标/使用 skill、CI 发布
- [x] **v1.0.0 发布**：[Releases](https://github.com/54xuu/jeff/releases/tag/v1.0.0) — `jeff-Setup-1.0.0.exe`（win-x64 131MB）、`Jeff-1.0.0.AppImage`（171MB）、`jeff-desktop_1.0.0_amd64.deb`（132MB）

## 验收记录

- **单测 47/47**：repos / registry / bridge / configwriter / group / memory / delegate / sync（WebDAV mock 全场景：双向传播、墓碑、冲突 LWW）
- **E2E 8/8**（真实 sidecar + mock LLM，`JEFF_E2E=1`）：sidecar 启动、小杰注册、私聊往返、小杰工具创建智能体、惰性重启、建群路由、@直达、任务卡片、项目记忆落盘、会话搜索命中、leader 委派真实执行
- **打包冒烟**：linux-unpacked/AppImage 启动截图验证（聊天页/群聊+看板/设置页三视图）；CI 发布的 AppImage 下载后本机启动复验
- **CI**：test job（ubuntu）+ release matrix 全绿；双平台产物已上 Releases

## 关键踩坑记录（对二次开发最有价值）

1. **opencode 会回退加载 `~/.opencode/opencode.json`**（用户全局配置）→ 设 `OPENCODE_CONFIG_DIR` 强制隔离目录。
2. **opencode 的 agent 名 = `agent/` 目录下的文件名**（frontmatter 不参与命名）→ Jeff 的 agent md 文件名必须等于 agentSlug。
3. **opencode 不热加载 agent 定义** → 脏标记 + 下次会话前惰性重启 sidecar（避免杀掉在飞请求）。
4. **opencode 会扫描 `~/.claude`、`~/.agents` 的 skills** → `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` 隔离。
5. **opencode 插件工具 `execute(args, ctx)` 的 ctx 带 `sessionID/agent/messageID`** → 工具桥透传后可定位调用者（记忆/委派的权限基石）。
6. **插件工具 args 用 JSON-schema 形式即可**，无需 zod。
7. **Electron `"type": "module"` 的坑**：preload 必须输出 `.cjs`；main 里 `__dirname` 未定义 → 用 `import.meta.dirname`。
8. **better-sqlite3 双运行时 ABI 地狱** → 迁移 node:sqlite（Node 22.13+/Electron 39 内置，FTS5 可用）后彻底消失。
9. **opencode session search 的中文检索**：trigram 对 2 字中文失效 → 索引时 CJK 逐字切分 + 查询转 phrase，中文子串可命中。
10. **CI 连环坑**：workspace 依赖版本写死导致 npm ci 404（改 `*`）；softprops 上传缺 GITHUB_TOKEN；`fail_on_unmatched_files` 跨平台误报（按平台拆发布步骤）；windows bash 里 GNU tar 不能解 zip（纯 Node unzip 实现）。

## 遗留事项（建议后续迭代）

- 私聊历史会话切换 UI（当前每 agent 一条持续会话，「新会话」按钮已留）
- 会话搜索 UI 入口（能力已具备：`jeff_session_search`，agent 可用；用户侧搜索框未加）
- 小杰使用说明 skill 可扩展更多示例对话
- opencode 版本升级评估（当前锁定 1.18.26）
- Windows 包的启动冒烟自动化（CI 上未做 GUI 截图验证，产物由原生环境构建保证）
