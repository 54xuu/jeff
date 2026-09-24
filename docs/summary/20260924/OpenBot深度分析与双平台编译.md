# OpenBot 深度分析与双平台编译

- 日期：2026-09-24
- 版本：1.8.29
- 对照：`~/Documents/github/OpenBot`（CopilotKit/OpenBot `0.0.15`）

## 做了什么

通读 OpenBot 的架构文档、coworker / routine / 插件说明，以及界面里的接管屏幕、结构化卡片、转交流、流式看门狗和会话起名实现。结论写在 [调研笔记](../../notes/20260924-OpenBot架构与功能深度分析及Jeff优化建议.md)。本次只交付文档和发版，不改产品行为。

顺手清掉两份不应入库的残留：`docs/assets/_probe.png.xwd`（0 字节）、`docs/assets/Snipaste_2026-09-20_10-14-01.png`（与已入库的 `group-promo.png` 字节相同）。`.zcodeignore` 与 `.gitignore` 对齐后的排除规则一并入库。

## 建议留下的

界面：

- 内置浏览器撞上登录或验证码时进入「需要你操作」，人做完点继续，本轮再往下走。
- 上游连接还在但长时间不吐字时，由看门狗结束本轮并解锁输入框。计时只看从上游读到的下一块，不缓冲、不把界面绘制暂停算成静默。
- 现有 `{时间}-{任务名}` 保留，可用一次轻量模型调用把任务名收成几个字；失败则保持现在的截取。

功能：

- 定时任务连续失败达到阈值后自动停用，并走现有完成提醒。成功一次计数清零。不引入 OpenBot 的 15 分钟最短间隔和每人 20 条上限。
- system 固定尾部要求：用了工具或文件就指出来源，没查到就标明是推断。

新增：

- 审批卡片和选择卡片，人点完才恢复被挂起的回合。记录卡和指标卡用于结果展示。
- 私聊里的显式转交，深度有上限，成功和拒绝共用一处文案前缀。

不纳入：输入框语音听写、常驻语音通话、预置 SaaS 连接器目录、每 Bot 一台容器电脑和 CEL 策略引擎。

建议落地顺序：连续失败停用 → 流式看门狗 → 浏览器「需要你操作」→ 审批/选择卡片 → 私聊转交 → 会话名收短与来源约束。

## 发版

版本 `1.8.28` → `1.8.29`（纯文档任务仍按本仓库收尾约定升 PATCH，五处版本号一起改）。不打 tag，不发 GitHub Release。

回归（打包前）：

- `npm test`：35 个测试文件通过，5 个跳过；343 条通过，17 条跳过。版本一致性校验包含 `1.8.29`。
- `tsc`：`packages/core` 与 `apps/desktop` 均通过。根目录 `tsc -p tsconfig.base.json` 仍是原先那 3 条 e2e helper 报错，这次没有新增。
- `apps/desktop` 封闭测试：`ui` 2 条、`v18` 4 条、`cron` 11 条，全部通过。

安装包：

- Linux：`apps/desktop/release/jeff-desktop_1.8.29_amd64.deb`、`apps/desktop/release/Jeff-1.8.29.AppImage`。本机已安装，`dpkg -l jeff-desktop` 为 `1.8.29`。`/opt/Jeff/resources/app.asar` 与 `linux-unpacked` 的 md5 都是 `8d443f96ea194be0634d5d3807fabb58`。
- Windows：`apps/desktop/release/jeff-Setup-1.8.29.exe`，`file` 为 PE32 GUI Nullsoft 自解压。`win-unpacked/resources/app.asar` 内能搜到 `1.8.29`。`oc-bin/windows-x64/opencode.exe` 在位。未打 tag，未发 Release。重启 Jeff 后可在「设置 → 关于」看到 `1.8.29`。
