# 项目群通用任务管理与 Prompt 重整交付记录

日期：2026-10-08。版本：2.0.0。构建源码提交：`617cbf49c5c5908285c6f77e3a670c7c9fd21a54`。

技术方案见 [`20261008-项目群通用任务管理与Prompt重整技术方案.md`](../../notes/20261008-项目群通用任务管理与Prompt重整技术方案.md)，领域决策见 [`ADR 0002`](../../adr/0002-general-project-tasks-and-local-execution.md)。

## 实施内容

- 删除项目工作台及销售、宣传选题、素材审批、报告模板等专用流程和对应 IPC、工具与运行逻辑。用户确认没有已保存数据，因此直接删除旧 `workspace_state`，不做业务数据迁移。
- 项目任务提供三个独立、可选文本域：**目标、任务描述、验收标准**。保存任务不会执行；点击「开始执行」后由指定负责人执行，未指定负责人时由群主协调。Agent 提交结果后进入待验收，用户可通过或退回。
- 桌面与移动项目群资料统一为项目管理、群资料、群成员、会话记录、工作区文件五个入口；任务运行使用独立话题。
- 将个人指令、群简介、群规则、成员职责、用户/Agent/项目记忆、AGENTS.md、任务要求按语义和作用域组装为 Prompt context。增加下一轮上下文预览、最近实际发送内容区分、发送时本机 Prompt 快照与哈希；私有正文不进入普通日志或同步。
- 任务定义与人工验收事实参与结构化同步；运行记录、运行话题和 Prompt 快照留在执行设备本机。删除能力按破坏性变更统一升至 2.0.0。
- 修正部署验收运行器同步方式，并让 Windows 安装版的 CDP 连接容忍启动时端口短暂未就绪。

## 自动测试与真实链路

- `npm test`：core 425 项通过、17 项跳过；Relay 11 项通过；部署和 ASAR 测试 11 项通过。
- `npm run typecheck` 通过；桌面 mock UI 2/2、v18 4/4、cron 11/11、多引擎/群资料 3/3、配对 2/2 通过。
- 移动端单测 29/29、移动端浏览器 E2E 24/24 通过。
- 真实模型隔离矩阵覆盖指定负责人直跑、群主协调并委派、独立子任务、群/私聊作用域隔离、退回继续、规则冲突、停止/恢复、Prompt 快照与引擎上下文。群主协调场景在放宽对中文字段标签的格式要求、保留负责人 ID/委派工具/结果/提交等服务端断言后复跑 1/1 通过。
- OpenCode（Jeff）任务链路通过；外部 Codex 实际创建文件、读回验证并调用 `jeff_task_submit`，任务进入待验收。其他本机探测未通过：OpenCode（系统）执行失败；Cursor 不支持当前配置的独立 `thinking=low`；Claude 环境没有可用订阅。这些是本机引擎配置/权限限制，不能据此宣称这些路径已验收。

## 正式产物

Linux/Windows `app.asar` 均逐文件校验 13,802 项、0 失败，SHA-256 均为 `c8bd5261b4c7f8081f109a87395dd392e4f5799d1398869b2f3f4bff63293eb8`。所有正式产物版本为 2.0.0，来源提交为 `617cbf49c5c5908285c6f77e3a670c7c9fd21a54`。

| 平台 | 产物 | SHA-256 | 验证 |
| --- | --- | --- | --- |
| Ubuntu | `apps/desktop/release/jeff-desktop_2.0.0_amd64.deb` | `a1e206212b6f2095a8aeb934e8e7607fe4d6e0adf62e2dedfe7d1e6171461436` | Debian amd64；ASAR 完整校验 |
| Ubuntu | `apps/desktop/release/Jeff-2.0.0.AppImage` | `9cbc156e88489e7a9d4c2e41e90db4757349b58d07ebc29ec0ffe4c858f4cdaf` | x86-64 AppImage；与本任务 Linux 包同版 |
| Windows | `apps/desktop/release/jeff-Setup-2.0.0.exe` | `6f8d5109f68fda540392e1116cfffb5972571b7e13d0d77604043845582be405` | PE32 Nullsoft；内置 OpenCode；ASAR 完整校验 |
| Android | `apps/mobile/android/release/jeff-2.0.0.apk` | `1aff9f7c4e2065844531ee50113a4dab89545bdc4dd5e1d94853b66d17df665a` | `app.jeff.mobile`，`versionName=2.0.0`，`versionCode=20000`；签名验证通过 |

## 安装与设备验收

- Windows 实际安装目录启动 2.0.0 并通过 `project-tasks-context` UI 验收；sidecar running、OpenCode 1.18.30，安装数据目录隔离。运行 ID 为 `2026-10-08T130759-709Z`，截图、安装信息和 outcome 在忽略目录 `.tmp/deploy/2026-10-08T130759-709Z/`。
- Ubuntu 已安装正式 `.deb` 2.0.0；`dpkg-query` 显示 `install ok installed`，`/opt/Jeff/resources/app.asar` 与最终构建归档 md5 均为 `1b501775a31ea1a561a3ac37945dd6da`。从 `/opt/Jeff/jeff-desktop` 在全新隔离 `JEFF_HOME` 启动并通过同一具名 UI 验收；sidecar running、OpenCode 1.18.30。证据在 `.tmp/deploy/linux-installed-acceptance-final-20261008/evidence/`。
- Android release APK 在 Ubuntu `jeff` AVD 上 `MobileProjectTaskBundleTest` 1/1 通过；实体设备 `192.168.3.121:5555` 也通过该 instrumentation 1/1，随后 `MobileInstallSmokeTest` 3/3 通过。物理安装使用保留数据升级，没有清除已有本地对话缓存。
- Android 当前绑定的日常桌面 `yh-dev16-01` 离线，因此未改变日常配对去执行真实加密聊天回路；加密配对、真实回复双端落库和 Markdown 兼容仍待该桌面可连接时验证。

## 证据位置

- 最终部署 manifest、安装结果和设备日志：`.tmp/deploy/2026-10-08T130759-709Z/`。
- Ubuntu 安装版 UI 截图及 `app:info`：`.tmp/deploy/linux-installed-acceptance-final-20261008/evidence/`。
- 真实模型矩阵截图、数据和 Prompt 快照：`.tmp/live-matrix/evidence/`。

构建产物与验收材料均来自最终 2.0.0 源码。未部署 Relay；本任务没有改变 Relay 发布目标。
