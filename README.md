# Jeff

个人「开发 + 项目管理」agent 桌面应用。基于 [opencode](https://github.com/anomalyco/opencode) sidecar 引擎 + Electron，微信式界面：**一个 agent 就是一个好友，一个项目就是一个群，群主（leader）统筹一切**。

## 功能

- **智能体（好友）**：自定义身份指令、默认模型、长期记忆；带编码/MCP/技能工具；内置不可编辑的管家「小杰」，对话即可完成一切配置。
- **项目群（群）**：项目=群聊，多智能体协作，群主 leader 统筹（multica squad 模式：默认路由 leader + @成员直达 + leader 委派成员）。
- **任务**：multica issues 式（编号 JEF-n、状态/优先级/指派），聊天任务卡片 + 群内看板拖拽流转。
- **记忆**（hermes-agent 式）：分层记忆（全局用户画像 + 每 agent + 每项目群）+ 硬字符预算自我整合 + 后台定期自省 + 全部会话全文检索（FTS5）。
- **模型提供商**：75+（AI SDK 生态），支持 OpenAI 兼容自定义端点；会话内临时切换模型。
- **Skill / MCP**：opencode 原生，兼容 `.claude/skills` 生态。
- **WebDAV 同步**：智能体/项目/任务/设置/记忆实体级双向合并（墓碑删除、冲突提示），**不含会话数据**。
- **亮/深夜模式**，win-x64 + linux-x64 安装包（GitHub Actions 构建发布）。

## 开发

```bash
npm install                 # 根目录（workspaces: packages/core + apps/desktop）
npm test                    # core 单测（含 WebDAV mock 同步测试）
JEFF_E2E=1 npm test -w @jeff/core   # 端到端（需本机有 opencode，可用 JEFF_OPENCODE_BIN 指定）
npm run dev -w jeff-desktop # 桌面应用开发模式
```

## 打包

```bash
cd apps/desktop
node scripts/fetch-opencode.mjs   # 拉取 opencode 二进制（linux-x64 + windows-x64）
npm run package:linux             # AppImage + deb
npm run package:win               # NSIS（建议在 Windows 或 CI 上）
```

发布：推送 `v*` tag → GitHub Actions matrix（ubuntu-latest / windows-latest）构建并发布到 Releases。

## 架构

```
Electron 主进程
 ├─ SidecarManager：spawn/守护 opencode serve（隔离 OPENCODE_CONFIG_DIR/XDG，不碰用户全局配置）
 ├─ packages/jeff-core
 │   ├─ node:sqlite（agent/project/task/chat_message + msg_fts5）
 │   ├─ opencode 薄客户端（REST + SSE）
 │   ├─ 编排：私聊 / 群聊 leader 路由 / @直达 / 委派（防重+防失控）
 │   ├─ 记忆：MemoryStore（§ 条目+预算+原子写+锁）/ FTS5 索引 / nudge 自省
 │   ├─ WebDAV 同步引擎（实体级 LWW + 墓碑）
 │   └─ 工具桥：本地 HTTP API ← opencode plugin（小杰 admin 工具、记忆、委派）
 └─ IPC ↔ React 渲染进程（微信式 UI）
```

## 目录

- `packages/core` — 核心库（可独立测试）
- `apps/desktop` — Electron 应用
- `docs/notes` — 调研笔记；`docs/summary` — 设计与实施总结
