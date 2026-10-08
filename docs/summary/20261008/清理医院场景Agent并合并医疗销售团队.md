# 清理医院场景 Agent 并合并医疗销售团队

日期：2026-10-08

资料范围：Windows 当前 Jeff 用户资料；配置经 Jeff 结构化接口修改，无数据库直写、API/类型或数据库结构变更。应用版本保持 `1.12.1`。

## 配置结果

- 将“医院场景”分类下的王教授、心内科周主任、内分泌科陈主任、胸外科李主任、放射科赵主任、营养科孙主任软删除；“智慧病房”分类保留 1 个 Agent。将“联合会诊”群软删除。软删除前保存了本地忽略目录回滚快照 `.tmp/agent-merge/20261008/live-snapshot.json`，只含本次涉及的配置与职责字段，不含凭据。
- 新建 Agent“销小冠”（头像 🏆，分类“医疗销售”），个人执行引擎为 Codex，模型 `gpt-6-luna`，思考等级 `high`。个人 Prompt 合并客户拓展、销售策略、痛点分析、沟通与异议处理、PoC、宣传 PPT 逐页文案及视频脚本能力；不含群内职位或汇报关系。PPTX 或视频文件仍需用户明确要求后才制作。
- “医疗销售”群现仅有销小冠（群主，Luna/high）和 GIT（群内工作者，`xiaomimimo/mimo-v2.6-flash`/high）。规则明确销小冠负责业务需求、客户方案和宣传内容，GIT 负责仓库提交，并要求提交/推送须有明确授权、只暂存本次产物且保护既有改动。GIT 的个人引擎/模型保持 OpenCode/Mimo；其在“POCT+AI项目管理”群的关系、职责及 Luna/high 覆盖保持不变。
- 将销大中名下 10 条待办只改负责人，全部转交销小冠；原任务内容、状态（均为 `todo`）和活动记录保留。完成成员与群规则读回核验后，软删除销大中和销小美。
- 读回结果：17 个有效 Agent、3 个有效群、13 条成员关系；医院分类无有效 Agent。“医疗销售”群规则及成员配置正确。医疗销售群原有 40 条消息保留，任务负责人变更追加 10 条任务卡系统消息；已软删除的“联合会诊”仍保留 11 条历史消息。旧 Agent 私聊历史在操作前均为 0 条；没有合并或改写会话历史。

## 隔离验收

在独立 Jeff 资料和本机临时 Git bare remote 中进行了真实模型验收，没有使用正式医疗销售仓库或用户当前会话：

- 销小冠完成客户方案、正好 5 页的 PPT 逐页文案及 30 秒宣传视频脚本；检查了证据边界和未生成 PPTX。
- 未获授权时，GIT 保持只读，没有创建、暂存、提交或推送文件；预存文件哈希和远端 HEAD 均不变。获得明确提交授权后，GIT 只提交测试生成的一个 Markdown 文件并推送到临时 bare remote；预存文件未进入提交，远端 HEAD 与新提交一致。
- 测试结束后，通过 Jeff 结构化设置接口清除了隔离资料中的 Mimo provider 凭据；回读 provider 数量为 0。隔离 Jeff 与 Windows 日常 Jeff 均未被关闭。

## 自动化测试

- `npm test`：Core 42 个测试文件通过（429 passed，17 skipped），Relay 2 个文件通过（11 passed），部署/归档脚本测试 10 passed。
- `npm run typecheck`：通过。
- 桌面 mock E2E：2 passed；v18 封闭 E2E：4 passed；cron 封闭 E2E：11 passed；移动端单测：8 个文件、29 passed。
- 隔离真实模型验收覆盖销小冠的销售内容能力、GIT 的授权边界，以及明确授权后的仅目标文件提交。

## 三平台构建与校验

均使用同一版本 `1.12.1`，只构建、不安装、不提交构建产物。

| 产物 | SHA-256 | 校验 |
| --- | --- | --- |
| `apps/desktop/release/jeff-desktop_1.12.1_amd64.deb` | `439edf4e2d3b3f9971a78d9678b405a85e769334538e0851f4ce19bcf4ae411f` | 包版本 `1.12.1`；包内 `app.asar` 与 `linux-unpacked` 一致 |
| `apps/desktop/release/Jeff-1.12.1.AppImage` | `a50e71fecbe1f75e0246593d31bfd878ff65c7bd4f66485b320894b0e09218c5` | 从 AppImage 提取后，`app.asar` 与 `linux-unpacked` 一致 |
| `apps/desktop/release/jeff-Setup-1.12.1.exe` | `be753d7cbcbade27a174dc93fbfc29e1461ad0f62cdc251c0116f342911e68d4` | PE32 Nullsoft 安装器；内部 ASAR 与 Windows unpacked ASAR 字节一致，内部 opencode 与 unpacked 文件字节一致 |
| `apps/mobile/android/release/jeff-1.12.1.apk` | `cc9451d55cc2f0965ea496e866d8ed93d3e39779c4348b1565c0c321873d23b3` | 包名 `app.jeff.mobile`，versionName `1.12.1`，versionCode `11201`；release v1/v2 签名验证通过 |

Linux 与 Windows `app.asar` 均通过逐条目完整性校验，SHA-256 为 `6501bfa3627f473f69a6b6e31bf4d908be0330de2ebc2bb1f11de451bbb42d4e`，共 13,802 个条目，无失败。

## Git 交付

本次没有应用源码改动。此总结作为唯一暂存文件单独提交；推送前核对远端祖先关系，只允许对 `main` 做 fast-forward 推送，不强制推送。正式医疗销售仓库未被触碰，其既有改动保持不变。
