# OpenMuse 深度分析与双平台编译（2026-09-24）

## 做了什么

对照 `~/Documents/github/openmuse` 的源码，整理出 Jeff 值得借鉴的界面与功能，写入 [调研笔记](../../notes/20260924-OpenMuse架构与功能深度分析及Jeff优化建议.md)。本次只产出文档，不改产品代码。

## 结论

OpenMuse 是 CopilotKit 的个人助理模板：一套 React Native 界面覆盖手机和网页，Hono 服务端，PGlite 存储，独立的 Playwright 浏览器进程，外加一个可选的 Docker Linux 容器。它的主线是「把任务委派出去，看计划，补信息，回来看结果」。

Jeff 已有而 OpenMuse 用另一种形态实现的：多智能体与项目群、定时任务、内置浏览器、停止生成、翻历史不抢滚动。这些不需要跟它对齐。

值得借鉴的，按笔记里的落地顺序：

1. 生成期间输入框不锁死，追加的消息进一个可见、可移除的队列，停止或失败时队列暂停。
2. 浏览器和文件的工具结果渲染成可点击卡片，原始调用记录保留在折叠块里。
3. 定时任务连续失败达到阈值后自动停用，并走现有完成提醒。
4. 定时任务上的网页监控模板：到点读页面，有变化才发消息。
5. 小杰基于运行数据给出带来源的建议，采纳即变成一条消息。
6. 项目群派发记录已完成的工具调用，恢复时不重复执行。

明确不借鉴两阶段审批（提案、哈希校验、批准门禁）。Jeff 是本机完全控制的工作台，工具直接执行，风险控制继续用现有的工具权限询问。同样不借鉴独立浏览器进程、Docker 电脑、托管会话服务和邮件日历连接。

## 版本与验证

版本 `1.8.29` → `1.8.30`（五处版本号一起改）。不打 tag，不发 GitHub Release。

- `npm test`：35 个测试文件通过，5 个跳过；343 条通过，17 条跳过。版本一致性校验包含 `1.8.30`。
- 包级 `tsc`：`packages/core` 与 `apps/desktop` 通过。根目录 `tsc` 仍是改动前就有的 3 个 e2e helper 报错（`apps/desktop/e2e/helpers/launch.ts`）。
- `npm run test:e2e`：2 条通过。`--project=v18`：4 条通过。`--project=cron`：11 条通过。
- Linux：`apps/desktop/release/jeff-desktop_1.8.30_amd64.deb`、`apps/desktop/release/Jeff-1.8.30.AppImage`。本机已安装，`dpkg -l jeff-desktop` 为 `1.8.30`。`/opt/Jeff/resources/app.asar` 与 `linux-unpacked` 的 md5 都是 `1a4a7c7620cad5469556bcc097ead28f`。
- Windows：`apps/desktop/release/jeff-Setup-1.8.30.exe`，`file` 为 PE32 GUI Nullsoft 自解压。`win-unpacked/resources/app.asar` 内能搜到 `1.8.30`。`oc-bin/windows-x64/opencode.exe` 在位。重启 Jeff 后可在「设置 → 关于」看到 `1.8.30`。
