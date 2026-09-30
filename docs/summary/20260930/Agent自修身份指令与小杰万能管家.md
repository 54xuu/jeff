# Agent 自修身份指令 + 小杰万能管家（v1.10.0）

2026-09-30。命题：每个 agent 都能在对话里修复**自己的身份指令**；小杰成为万能管家（全套文件工具），但密钥文件除外；「群主改别人指令」由工具形状永久消除。方案经 grilling 十轮问答定稿（9 项用户决定，全文见 ZCode 记忆 `jeff-agent-self-service-plan`），当日实施并发版。

## 交付内容

### 1. 新工具 `jeff_self_update`（所有非内置 agent 可用）

- `action=get|set|revert`：`get` 返回当前全文+版本号；`set` 整篇替换；`revert` 回滚最近快照。
- **没有 id 参数**：调用者身份只认 `__ctx.sessionID → resolveSession`，物理上只能改自己（「群主改别人指令」从工具形状上不存在）；不做按名字兜底（群聊会错绑同名者）。
- **写前版本校验（fail-closed）**：`set`/`revert` 必传 `expected_version`；不匹配报错并引导先 `get`（防设置页/其他设备并发修改被静默覆盖）。版本号来自固定页脚。
- **没有 name/category 字段**：医护助手的读盘封禁按 `category`/`name` 判定（registry.ts），开放等于让模型自己解锁。
- 空串=未提供、2 万字符上限、内置小杰被拒（其指令内置管理，写 DB 是静默空操作）。
- 改动经 `onChanged()` → syncRegistry + markRegistryDirty，**下一轮生效**（引擎自动重启，实测 12:23:52 改、12:24:15 的回复已按新指令执行）。
- 新增 `instructions_version` 列（仅 instructions 实变时 +1；改模型/头像不顶版本号），随同步 payload 携带；**sync/engine.ts 的 agent INSERT/UPDATE 补了该列**，否则跨机覆盖指令会留旧版本号、校验失效。

### 2. 快照回滚（三条路径共用）

`~/.jeff/backups/agent-instructions/<agentId>/<ts>.md`，保留最近 20 份；覆盖 `jeff_self_update`、小杰的 `jeff_agent_update`、设置页保存三条改指令路径；`revert` 写回前也先快照（可再撤销）。纯本地、不进同步。

### 3. 固定页脚（渲染期拼接，不进 DB）

`renderAgentMd` 在正文后追加「自我维护」段：工具用法+当前版本号、「长期人格改指令（要重启引擎）/ 一次性偏好写记忆」分界、「不得改其他智能体的身份指令、记忆文件与共享 AGENTS.md」软约定。按工具面生成（被 deny write/edit 的 agent 不提技能）；设置页指令文本框保持干净、改不掉页脚。

### 4. 小杰：万能管家 + 密钥闸门

- `XIAOJIE_DISABLED_TOOLS` 收缩为 `['task','jeff_spawn_subtask','jeff_self_update']`：`bash/edit/write/patch` 全放开（可跑技能脚本），`task`/子代理仍禁（理由改为「控制并行与成本」）；`XIAOJIE_INSTRUCTIONS` 第 8 条重写为四条纪律（配置优先结构化工具/密钥禁读/不替别人改/改技能先备份）。
- **agent 级 permission 密钥闸**：小杰 md 写 `read/edit` 对 `*jeff.db`、`*jeff.db-wal/-shm/-journal`、`*auth.json` 的 deny + `bash` 对 `*jeff.db*`、`*auth.json*` 的 deny。

## 本次抓到的真 bug（live18 第一轮 E2E 的价值）

1. **绝对路径的 permission pattern 在 opencode 1.18.30 永远不命中**：第一版 deny 写的是绝对路径，真模型 E2E 里小杰直接把 jeff.db 表结构读走了（`evaluated permission=read pattern=.tmp/.../jeff.db action.pattern=* action=allow`，规则集里只有 `*`）。探针（`.tmp/oc-perm-probe2/`）证实：pattern 按**相对 worktree 的路径**评估、`*` 跨目录、agent md frontmatter 会合并且生效、bash 规则匹配命令文本。修成 basename glob 后引擎日志 `action.pattern=*jeff.db action.action=deny`，截图里工具卡显示「失败 · 读取文件」、小杰如实报告被拒。→ 结论入 ZCode 记忆 `opencode-agent-permission-patterns`。
2. 顺带发现：live18 R2 第一版断言 `triedDb || logDeny || saidDenied` 三选一，泄露被判绿——**验收断言必须落在「内容没泄露」这种否定性事实上**，不能靠「它说了拒绝」。
3. 测试幂等：复用 home 的链式套件，轮次要重置产物文件与会话指针（R2 第一版重跑时技能文件已是目标内容，模型 read 后不再写，断言假失败）。

## 验证

- 单测：新增 `tests/self-update.test.ts` 12 条（get/set/revert、版本校验 fail-closed、快照清理、只能改自己、小杰被拒、md 断言含 glob deny）；迁移 `cron-plugin.test.ts` 小杰隔离断言、`tool-args.test.ts` 补 paths。全量 369+11 绿。
- mock E2E：ui/p0 2 过、v18 4 过、cron 11 过。
- 真模型 E2E（`.tmp/live18/`，Qwen3.5-9B，证据截图 `.tmp/live18-shots/`）：
  - R1 私聊自改：set 落库+版本 v0→v1+快照+md 重写，**重启后下一轮回复带新指令要求的「——小沃敬上」**（54.8s）；
  - R2 小杰：write 真改 skills 沙箱 SKILL.md（断言磁盘字节）；read jeff.db 被 deny 挡下、如实报告（2.6m）；
  - R3 群主自改：群会话里只改群主自己，worker 指令与 md 分毫未动（36.1s）。
- 产物：`jeff-desktop_1.10.0_amd64.deb`（本机已装，`dpkg -l` 1.10.0，`/opt/Jeff` 与 linux-unpacked md5 一致，asar 含 `jeff_self_update`）+ `Jeff-1.10.0.AppImage` + `jeff-Setup-1.10.0.exe`（验收见下）。

## 版本

1.9.7 → **1.10.0**（MINOR，用户拍板）。注：工作树里此前的 Cue 皮肤任务已把版本顶到 1.10.0，本次与之同包发布，未重复 bump。

## 已接受的残留风险（用户拍板记录）

1. 小杰有无目录约束的 bash（提示词+审计为主，live12 R7/live14 R6 的「提示词会被绕过」教训适用）；密钥文件有 glob deny 但换变量名等间接绕过堵不完。
2. 带 bash 的 agent 仍可改别人的 MEMORY.md 与 agents-md 权威副本（即时生效、无派生保护）。
3. 技能目录无锁多写者（靠 skills 备份版本归档兜底）。
4. 多机同时改同一 agent 指令仍 LWW；跨机由 `instructions_version` 随行 + `get` 重读兜底。
