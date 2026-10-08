# 项目群通用任务管理与 Prompt 重整交付记录

日期：2026-10-08。版本：2.0.0。

技术方案见 [`20261008-项目群通用任务管理与Prompt重整技术方案.md`](../../notes/20261008-项目群通用任务管理与Prompt重整技术方案.md)，领域决策见 [`ADR 0002`](../../adr/0002-general-project-tasks-and-local-execution.md)。

## 实施内容

- 删除项目工作台及销售、宣传选题、素材审批、报告模板等专用流程和对应 IPC、工具与运行逻辑。用户确认没有已保存数据，因此直接删除旧 `workspace_state`，不做业务数据迁移。
- 项目任务改为通用模式，提供三个独立、可选文本域：**目标、任务描述、验收标准**。保存任务不会执行；点击「开始执行」后由指定负责人执行，未指定负责人时由群主协调。Agent 提交结果后进入待验收，用户可通过或退回。
- 桌面与移动项目群资料统一为项目管理、群资料、群成员、会话记录、工作区文件五个入口；任务运行使用独立话题。
- 将个人指令、群简介、群规则、成员职责、用户/Agent/项目记忆、AGENTS.md、任务要求按语义和作用域组装为 Prompt context。增加下一轮上下文预览、最近实际发送内容区分、发送时本机 Prompt 快照与哈希；私有正文不进入普通日志或同步。
- 任务定义与人工验收事实参与结构化同步；运行记录、运行话题和 Prompt 快照留在执行设备本机。删除能力按破坏性变更统一升至 2.0.0。
- 修正部署验收运行器同步方式，并让 Windows 安装版的 CDP 连接容忍启动时端口短暂未就绪。

## 自动测试与真实链路

- `npm test`：core 425 passed、17 skipped；Relay 11 passed；部署与 ASAR 回归 10 passed。部署运行器更新后 `npm run test:deploy` 为 11/11 通过。
- `npm run typecheck`：通过。
- 桌面 mock UI E2E：2/2；v18：4/4；cron：11/11；多引擎/群资料：3/3；配对：2/2，均通过。
- 移动端单测：29/29；移动端浏览器 E2E：24/24，通过。
- 真实模型隔离链路：完成 1 条综合任务。实际 Prompt 快照绑定任务运行、项目、群资料及三个任务字段；结果成功提交并进入待验收。方案列出的 8 类模型场景尚未全部覆盖。
- Windows 首次 GUI 验收发现远端旧版运行器，更新后复跑时同一临时目录残留旧 DevTools 端口；改用全新隔离运行目录后通过。最终验收以新运行编号 `2026-10-08T121914-000Z` 为准。

## 正式产物

所有正式包均为 2.0.0。Linux/Windows `app.asar` 逐文件校验各包含 13,802 个条目、0 失败，SHA-256 均为 `343952f66a79f9c5825945e3586f0ee26d4c3a92394a8f775ce5d8837abbe7a8`。

| 平台 | 产物 | SHA-256 | 验证 |
| --- | --- | --- | --- |
| Ubuntu | `apps/desktop/release/jeff-desktop_2.0.0_amd64.deb` | `084064bbd3a32ed77ddaab9ceb10da288b4d29d3db62a275c50cddf521ac0906` | Debian amd64 包；ASAR 完整校验 |
| Ubuntu | `apps/desktop/release/Jeff-2.0.0.AppImage` | `fc572247b855b1e51be8937abeeae9c4d30d8e14d474cc919864ce158ca68a8f` | x86-64 AppImage；来自同一 Linux 构建 |
| Windows | `apps/desktop/release/jeff-Setup-2.0.0.exe` | `043e39c77a38c424f626742dee9d9265bb2a8b1593970e21b66abc5c1640bd18` | PE32 Nullsoft；内置 OpenCode；ASAR 完整校验 |
| Android | `apps/mobile/android/release/jeff-2.0.0.apk` | `1aff9f7c4e2065844531ee50113a4dab89545bdc4dd5e1d94853b66d17df665a` | `app.jeff.mobile`、`versionName=2.0.0`、`versionCode=20000`；`apksigner` v1/v2 验证通过 |

## 安装与设备验收

- Windows 实际安装目录运行 2.0.0 的具名验收通过。证据显示版本 2.0.0、sidecar running、OpenCode 1.18.30，隔离数据目录位于 `.jeff-deploy/runs/2026-10-08T121914-000Z/desktop-home`。截图保存在被忽略的 `.tmp/deploy/2026-10-08T121914-000Z/2026-10-08T121914-000Z/windows-jeff.png`。
- Ubuntu `jeff` AVD 上 release Android instrumentation 1/1 通过；Windows USB/网络 ADB 设备不可用，实体机待验收。
- Linux `.deb` 与 AppImage 已完成产物级校验；本机 `.deb` 安装验收未完成，因为 sudo 身份验证失败后停止重试。本次未修改系统已安装版本，不宣称 Linux 安装版通过。
- 真实模型目前仅通过 1 条综合任务链路；负责人/群主分支、退回继续、停止/中断、规则冲突和多引擎/手机真实任务链路仍待补齐模型验收矩阵。

## 产物清单

本次 Windows/AVD 具名运行的材料位于忽略目录 `.tmp/deploy/2026-10-08T121914-000Z/`：清单、Windows outcome、安装信息、截图和 Android diagnostics。软件源码与本次 ASAR 校验哈希保持不变。
