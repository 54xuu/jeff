# Codex 消息超过 16MB

## 问题

2026-10-09 22:30:42，Windows 上项目群「宣经理」（会话 `jeff_126c0e26-24c9-43e7-80cf-f5c0c53de19c`，Codex）发送失败：`CLI 消息超过 16MB，已停止执行`。堆栈在 `JsonLines.push`，来自 Codex stdout。该会话从 16:57 起持续使用，22:27:42 之后没有新的工具调用，22:28:28 被手动停止，22:30:42 再次发送时在启动阶段失败。同一项目群的「绘小图」也在用 Codex 生成大量图片，会走到同一条路上。

## 根因

已有 Codex 会话每次发送都会 `thread/resume`。Jeff 只使用返回的线程 id，但请求没有 `excludeTurns`，Codex 0.160.1 会把整段历史放进一行 JSON。历史里的命令输出和图片结果随会话变长，单行超过 `JsonLines` 的 16MB 后整轮中止。之后这个会话每次发送都会失败。

## 修复

版本 `2.2.3`。

- `thread/resume` 带 `excludeTurns: true`，只取线程元数据。旧版 Codex 若因未知字段拒绝，去掉该字段再请求一次。线程不存在这类错误不重试。
- 超限错误写明字节数和消息开头。Codex 的普通通知（例如过大的 `item/completed`）丢弃该行并记 `cli-oversize` 日志，后续行继续解析。带 `id` 的响应，以及 `turn/completed`、`error`，仍然中止本轮。

## 验证

- `@jeff/core` 450 通过、17 跳过；`@jeff/relay` 11 通过；部署脚本测试 30 通过。`npm run typecheck` 通过。
- 新增单测：中文被拆包、超大行报错、超大通知可跳过、resume 带 `excludeTurns`、旧版拒绝后重试、`thread not found` 不重试。
- 本机已登录的 Codex CLI 真实跑了两轮：两轮都回复「好」，会话 id 同为 `01a12120-f990-73c3-8438-78e6b2b9c383`。随后对这个会话再 `thread/resume` 且 `excludeTurns: true`，响应 1828 字节，`thread.turns` 为空数组。
- 桌面 mock UI 3 项、v18 5 项、cron 11 项通过。部署入口又跑了一遍这些检查，以及多引擎、配对和手机浏览器 E2E。
- 手机单测 30 项通过。Ubuntu AVD 上 `MobileInstallSmokeTest` 3 项通过。Windows USB 和网络 ADB 真机不可用。

### 三平台

- Ubuntu：通过。已安装 `jeff-desktop 2.2.3`，`/opt/Jeff/resources/app.asar` 与 `linux-unpacked`、`win-unpacked` 的 md5 同为 `6dbcf1ec64a46dd8e83d8b39b5412983`。deb `apps/desktop/release/jeff-desktop_2.2.3_amd64.deb`，SHA-256 `2a84585430506f7d73189667fa1b75fbc58973413c684801c5e048a092d3f037`。AppImage `apps/desktop/release/Jeff-2.2.3.AppImage`，SHA-256 `2688702311d7f69bc3d9e2546461688c74f6f2d166f84d1ea001952aea4514ee`。
- Windows：通过。安装器为 PE32 Nullsoft，`apps/desktop/release/jeff-Setup-2.2.3.exe`，SHA-256 `337643b0ea431bd1108a4f4dcece504587d4add98acce4e9cabf7d9578335a76`。ASAR 逐文件校验通过（13807 项，版本 2.2.3），含 `excludeTurns`，`opencode.exe` 在位。`deploy:windows --suite smoke` 报告 Windows installed and accepted。证据在 `.tmp/deploy/2026-10-09T150048-343Z`。冒烟只确认导航轨可见，没有在 Windows 上重放那个超长 Codex 会话。
- Android：模拟器通过，真机待验收。`apps/mobile/android/release/jeff-2.2.3.apk`，`versionName=2.2.3`，`versionCode=20203`，release 签名。SHA-256 `8c2d60568ecb611b8dbcb05d0e438be914410df97cf2da4d78d891416540c2dc`。

已超限的 Codex 会话不用清理。装上 2.2.3 后下一次发送会用 `excludeTurns` 恢复，原会话仍在 Codex 本地。
