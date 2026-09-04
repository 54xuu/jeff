# Jeff 桌面应用设计与实现（总结）

> 本文档是 Jeff 桌面应用的持续更新总结。问题：实现个人「开发+项目管理」agent 桌面应用（win-x64 + linux-x64）。

## 需求回顾

1. 记忆功能（参考 hermes-agent）
2. 多渠道提供商配置，会话窗口内选择模型
3. Skill 技能
4. MCP 连接器
5. 多智能体创建（参考 multica）
6. 内置「小杰」agent（不可编辑，纯管家）
7. 项目创建（项目关联多个智能体）
8. 任务创建（参考 multica issues）
9. 微信式界面布局与色调，亮/深夜模式
10. WebDAV 同步（除会话数据外）
11. win-x64 / linux-x64 双平台安装包

## 决策结论

| 决策 | 结论 |
|---|---|
| 基座 | opencode sidecar（隔离 XDG 目录，绝不动用户全局 opencode 配置） |
| 桌面壳 | Electron + React，electron-builder |
| 群聊协作 | leader 统筹 + @成员直达 |
| 记忆 | 分层（全局 USER.md + 每 agent + 每项目群）+ FTS5 会话搜索 |
| WebDAV | 实体级双向合并（LWW + 墓碑） |
| 构建 | GitHub Actions matrix → Releases |
| 执行 | M1→M4 连续无人值守，每阶段自动验收 |

详细调研见 `docs/notes/20260905-jeff选型调研.md`。

## 架构

```
Electron 主进程
 ├─ SidecarManager（spawn/守护 opencode serve，隔离 ~/.jeff/oc-home）
 ├─ jeff-core（packages/core）
 │   ├─ SQLite（agent/project/task/chat_message/kv + FTS5）
 │   ├─ opencode 薄客户端（REST + SSE）
 │   ├─ 编排器（私聊/群聊路由、委派、@直达）
 │   ├─ 记忆系统（MemoryStore/nudge/session search）
 │   ├─ WebDAV 同步器
 │   └─ 工具桥（本地 HTTP API ← opencode plugin 工具调用）
 └─ IPC ↔ React 渲染进程（微信式 UI）
```

## 实施进度

- [x] 选型调研（基座/记忆/多智能体三路）
- [x] opencode 1.18.26 本机验证：隔离目录、自定义 provider/agent/插件工具、消息往返
- [x] M1 基座与私聊（2026-09-05）
- [x] M2 项目群与任务（2026-09-05）
- [x] M3 记忆与群聊编排（2026-09-05）
- [ ] M4 WebDAV 与双平台发布

## 验收记录

### M3（2026-09-05）✅

- **单测**：42/42 通过（新增 memory 12 个、delegate 6 个）。
- **E2E**（真实 sidecar，`JEFF_E2E=1`）：群套件 4/4——新增：群会话写项目共享记忆（落盘校验）、`jeff_session_search` 中文检索命中、leader 委派成员（成员真实执行、结果回群、群公告）。
- **记忆系统（hermes 前两层移植）**：
  - `MemoryStore`：§ 分隔条目、硬字符预算（USER 1375 / agent/project 2200）、超限报错附带现有条目逼模型用 batch 原子腾挪、唯一子串匹配、精确去重、tmp+rename 原子写、目录锁；
  - 注入：每条消息的 system 带「agent 记忆 + 项目记忆 + 用户画像」冻结块（下一条消息自然刷新，prefix-cache 友好）；
  - nudge：每 10 轮触发后台临时会话自省（重放最近 30 条，结束后删除会话，带防并发守卫）；
  - 权限：USER.md 仅小杰可写；项目记忆要求成员身份；群会话默认写项目记忆。
- **会话搜索**：FTS5（external content + 触发器同步），CJK 逐字 token + phrase 查询支持中文子串；消息级幂等索引（私聊/群聊/启动回填）。
- **委派（multica squad 进程内适配）**：leader 调 `jeff_delegate` → 成员独立会话执行（注入指派 briefing）→ 结果回群并作为工具输出给 leader 同轮汇总；防重（同群+同成员+同指令并发去重）+ 防失控（单条消息最多 5 次委派）。
- **关键发现**：opencode 插件 `execute(args, ctx)` 的 ctx 带 `sessionID/agent/messageID`——工具桥透传后可精确定位调用者会话语义（私聊/群聊/自省会话）。

### M2（2026-09-05）✅

- **单测**：24/24 通过（新增 group：@提及解析、briefing、路由、任务卡片）。
- **端到端冒烟**（`JEFF_E2E=1`）：6/6 通过——新增：建群路由 leader、@成员直达、群内独立会话、工具桥建任务→群里出现任务卡片、任务状态流转。
- **打包冒烟**：linux-unpacked 启动，预置群数据截图验证（群聊窗口 + 任务卡片 + @提示）。
- **重大架构简化**：DB 层从 better-sqlite3 迁移到 `node:sqlite`（Node 22.22+ 与 Electron 39 均内置且带 FTS5）——零原生依赖，彻底消除 Node/Electron 双运行时 ABI 重编译问题，包体更小、CI 更稳。

### M1（2026-09-05）✅

- **单测**：19/19 通过（repos/registry/bridge/configwriter）。
- **端到端冒烟**（真实 sidecar + mock LLM，`JEFF_E2E=1`）：4/4 通过——sidecar 启动、小杰注册、私聊对话、小杰经工具桥创建智能体、内置保护。
- **打包冒烟**：electron-builder linux-unpacked 产物启动成功，微信式 UI 截图验证（导航栏/会话列表/主题）。
- **关键发现**（已修复）：
  1. opencode 会回退加载 `~/.opencode/opencode.json` 用户全局配置 → 用 `OPENCODE_CONFIG_DIR` 强制隔离目录解决。
  2. opencode 的 agent 名 = `agent/` 目录下的文件名（frontmatter 不参与命名）→ 文件名必须等于 agentSlug。
  3. opencode **不热加载** agent 定义 → 采用「脏标记 + 下次会话前惰性重启 sidecar」策略（避免杀掉在飞请求）。
  4. Electron `"type": "module"` 下 preload 须输出 `.cjs`，否则 require 报错。
  5. 插件工具的 args 用 JSON-schema 形式即可（无需 zod）。
