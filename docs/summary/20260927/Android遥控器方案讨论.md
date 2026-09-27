# Android 遥控器方案讨论

2026-09-27。先定稿「电脑为主、Android App 远程控制电脑」的方案，随后做完〇期地基。版本停在 1.8.30，没有打桌面 deb/exe。完整方案见 [`docs/notes/20260927-Android遥控器方案.md`](../../notes/20260927-Android遥控器方案.md)。

## 结论

- **不新开仓库**：App（`apps/mobile`）和中转站（`apps/relay`）放进现有 `jeff` 仓库。桌面端与 App 共用 `packages/core/src/ipc/contract.ts` 这份接口契约，一个功能两端同一提交落地，`AGENTS.md` 和版本一致性单测天然共用。
- **需要服务器，但只是中转站**：电脑在 NAT 后、手机在 4G，两端都出站连 ECS，由中转站按绑定关系转发端到端加密后的密文。业务与数据仍全部在电脑上。
- **ECS 够用**：`i-wz9dvof54j66ouau9zri`（`ecs.e-c1m1.large`，深圳）实测可用内存约 1.2 GiB、磁盘余 33 GB，只跑着约 18 MiB 的 WebDAV 容器。中转站走 9443 端口，不影响 443 上的 WebDAV。需确认的是公网带宽档位。
- **架构基础很好**：桌面端界面与核心之间只有 `invoke(channel)` 和 `jeff:push` 两个口子，主进程是一张 `handlers` 表。远程网关复用这张表，App 相当于远程界面，功能天然一致。需要替换的本机专属能力只有原生选目录、用系统程序打开文件、内置浏览器面板。

## 用户确认的决策

同一仓库；React + Capacitor + WeUI 风格；前台服务推通知；电脑离线时只读缓存；手机与电脑共享当前会话；扫码配对 + 端到端加密 + 指纹锁；继续用 IP + 自签证书并在 App 内固定指纹；分三期交付。

## 发现的待办点

- `chat-stream` 每次推送累计全文（`packages/core/src/index.ts` 约 1513 行），走公网需改为增量并节流。
- 桌面端有托盘，但没有开机自启和防睡眠，远程控制场景必须补。
- 本机原先没有 Android 构建环境，〇期已装上（见下）。

## 〇期做了什么

〇期不出能操作电脑的功能。仓库里新增 `apps/mobile`（Capacitor + React）、`apps/relay`、`packages/core/src/remote`（协议帧、端到端加密、白名单、流式增量）。`AGENTS.md` 加了遥控器约定。版本一致性单测现在同时核对 mobile 和 relay 的 `package.json`，五处仍是 1.8.30。

调试包 `app-debug.apk`：`versionName=1.8.30`，`versionCode=10830`。装到华为 ANA-AN00（`192.168.3.161:5555`）后，页面上「页面加密」和「原生加密」都是绿色「通过」，用的是同一组 X25519 + HKDF-SHA256 + AES-256-GCM 测试向量。

中转站跑在 ECS `47.106.209.32:9443`，容器 `relay-jeff-relay-1`，`restart: unless-stopped`。本机 `curl -k https://47.106.209.32:9443/health` 返回 `{"ok":true}`，证书 SHA-256 与 `RELAY_CERT_SHA256` 一致：`7E:59:C6:E3:6F:76:68:A6:58:F5:A6:25:B2:E9:F4:FD:FB:59:54:8C:10:7E:AF:05:B3:2E:05:0E:59:E7:64:45`。证书和私钥在服务器 `/opt/jeff-relay/certs/`，不进仓库。443 上的 WebDAV 没动。

单测：`packages/core` 的 remote 8 条 + 版本 1 条通过；`@jeff/relay` 5 条通过。core 与 relay 的 `tsc --noEmit` 通过。

## 〇期踩到的坑

- 本机 DNS 把 Google 解析到 `198.18.0.0/15`，`sdkmanager` 下不了清单。SDK 是从 Docker 镜像 `mobiledevops/android-sdk-image:36.1.0` 拷到 `~/Android/Sdk` 的。Gradle 走腾讯镜像，Maven 只留阿里云，并强制 `buildToolsVersion 35.0.1`，关掉 SDK 自动下载。
- apt 的 adb 28 连上手机显示未授权。改用 SDK 里的 adb 37 后，设备状态是 `device`。
- ECS 直连 Docker Hub 超时。镜像默认改为 `docker.m.daocloud.io/library/node:22-alpine`。
- `ws` 有动态 `require`，esbuild 打成 ESM 后容器起不来。生产包改成 CJS（`server.cjs`）。中转站入口不要从 `remote/index.ts` 引进白名单，否则还得把整份 IPC 契约打进镜像。
- 华为 iAware 会杀前台服务。23:26 按 Home 把 App 放进后台，约 23:32 熄屏，23:53:35 被 `iAwareF[SystemManager]` 停掉（`importance=125`，当时仍是前台服务；Doze 白名单里已经有 `app.jeff.mobile`）。熄屏到被杀大约 21 分钟，30 分钟这一项没有通过。要在手机上打开「设置 → 应用启动管理」，把 Jeff 改成手动管理并允许后台活动，然后再测一轮。系统电池优化弹窗当时被通知权限弹窗盖住，用户没有点到。
