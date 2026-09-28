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
- 华为 iAware 会杀前台服务。23:26 按 Home 把 App 放进后台，约 23:32 熄屏，23:53:35 被 `iAwareF[SystemManager]` 停掉（`importance=125`，当时仍是前台服务；Doze 白名单里已经有 `app.jeff.mobile`）。熄屏到被杀大约 21 分钟，30 分钟这一项没有通过。要在手机上打开「设置 → 应用启动管理」，把 Jeff 改成手动管理并允许后台活动。系统电池优化弹窗当时被通知权限弹窗盖住，用户没有点到。

## 改在虚拟机上验证

2026-09-28。真机要自己用，后续验证改到本机虚拟机。`dl.google.com` 的 TLS 仍被中间设备掐断，系统镜像是从 `docker.m.daocloud.io/budtmo/docker-android:emulator_14.0` 里拷出 emulator 与 `system-images;android-34;google_apis;x86_64`，放到 `~/Android/Sdk`。AVD 名 `jeff`，`emulator-5554`，Android 14。无线调试已经从 `192.168.3.161:5555` 断开，`adb devices` 里只有这台虚拟机。

调试包装上后，「页面加密」和「原生加密」都是「通过」。按 Home 回到桌面后进程仍是 4779，`RelayForegroundService` 保持 `isForeground=true`，通知还在。截图在 `.tmp/emu-crypto.png`。虚拟机继续开着，无窗口，用 adb 操作即可。

## 一期做了什么

2026-09-28。一期是「能在外面聊起来」，版本升到 1.9.0。安装包：`apps/desktop/release/jeff-desktop_1.9.0_amd64.deb`（本机已装，`dpkg` 显示 1.9.0，`/opt/Jeff` 与 `linux-unpacked` 的 app.asar md5 都是 `d0e4e44f4f1f3bd8318b3a12fd739f08`）、`apps/desktop/release/jeff-Setup-1.9.0.exe`（PE32 Nullsoft，包内能搜到 `remote-pair`，`opencode.exe` 在位）、调试 apk `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`（`versionName=1.9.0`，`versionCode=10900`）。

电脑「设置 → 远程控制」可以出配对二维码、弹出 6 位安全码确认、看到已绑定的手机、解除绑定、开机自启、已绑定时防止睡眠、显示中转站连接状态。远程网关和本机共用同一张 IPC 表，白名单没放行的通道（例如系统选目录）手机会被拒绝。`chat-stream` 改成增量，完成帧带全文长度，避免把累计全文一遍遍推到公网。手机上的 `session:activate` / `chat:new` / `group:threadNew` / `group:threadActivate` 会把电脑界面切到同一个会话。

App 有扫码和粘贴两种绑定、消息列表、私聊和项目群、流式回复、停止生成、会话切换、新建会话、发图片（长边压到约 1600，发出后的图片在气泡里显示）。打开某个私聊或项目群时，会把电脑切到该会话当前这条；从手机发出消息也会把电脑带过去。群工作空间可以远程选目录。离线时只读缓存，指纹或锁屏锁，前台服务通知。「我」页可以再绑定一台电脑。封闭测试里绑上「办公室」后，消息列表换成办公室小杰，再点回「家里的电脑」标题也会跟着切。并写了华为「应用启动管理」的说明。通讯录、发现、设置、内置浏览器留在二期和三期。

中转站协议帧没有改，没有重新部署 ECS。手机这条连接断开后会自己重连，间隔从 1 秒加到最多 30 秒，连上之后重新握手。链路测试把套接字掐掉，大约 1 秒后新连接已经打开。电脑端原来就会重连。

## 一期验证

- 单测：`npm test`，core 355 通过（17 条跳过），relay 7 通过。2026-09-28 07:37 按当前代码又跑了一遍，数字不变。链路测试里，交接之后的 `note` 帧不再由页面解开，把明文交回后才出现在事件里；后到的一帧页面收不到。另有一条把手机套接字掐掉，确认它会自己重连。
- 封闭 E2E：`e2e/remote.spec.ts`。假手机经本地中转站绑定，安全码一致，`agents:list` 能看到小杰，`dialog:pickDir` 被拒绝，`fs:mkdir` 和 `project:save` 落盘，桌面切到标题「遥控器验收」的项目群。回到远程控制页后，开机自启可以打开，防睡眠可以关掉，解除绑定后显示「还没有绑定手机」。手机页面在 390×844 下完成绑定，点进小杰后气泡里有「看这张图」和一张红色方图；从相册选图后，发出去的是压成 JPEG 的图片。流式时能点停止，加号里能切到另一条会话、也能新建会话，项目群能选中电脑上的目录。再次拉取列表失败时，仍显示缓存里的小杰，并出现「电脑离线」。截图 `.tmp/remote-app-light.png`、`.tmp/remote-app-dark.png`。
- 桌面回归：2026-09-28 按当前代码再跑，`--project=ui` 2 条、`--project=v18` 4 条、`--project=cron` 11 条，都通过。桌面 `tsc` 通过。根 `tsc` 仍只有 `launch.ts` 里原有的 3 个报错。
- 真模型：假手机对小杰发「只回复两个字收到」，`chat:history` 里有用户原文和助手回复，桌面气泡与历史前几个字一致。共享会话改完后于 2026-09-28 再跑一遍，约 25 秒，1 条通过。
- 虚拟机：`emulator-5554` 装上当前 debug apk。`aapt dump badging` 是 `versionName=1.8.30`、`versionCode=10830`。2026-09-28 07:17 重新截了配对页和「我」页：`.tmp/remote-emu-now.png`、`.tmp/remote-emu-now-me.png`。未绑定电脑时状态点是灰的，底栏贴在屏幕底部，「我」页有华为启动管理说明。07:18 系统切到深色后再截 `.tmp/remote-emu-dark-now.png`，背景、输入框和底栏跟着变暗，绿按钮上的字仍是白的。启动日志 `JeffCrypto` 为「通过」，含把测试向量密文解回原文。虚拟机设了锁屏密码后，弹出标题为「解锁 Jeff」的系统密码框，进程不再崩溃；输入正确密码后进入绑定页。验收用的密码随后已清掉。

## 一期修过的问题

- 本地 `ws://` 验收没有证书指纹。二维码里放非空占位 `local`，否则手机解不开配对内容。正式 `wss` 仍用固定指纹。
- 配对成功后中转站会再推一条「电脑在线」。手机若因此再发一轮握手，会把临时密钥换掉，后续调用对不上序号。同一次握手现在复用，不另起一轮。
- Electron 被强制结束时，zygote 会继承 stdout，Playwright 会一直等到超时。验收结束时先记下子进程再关掉。正常退出也会在几秒后清掉子进程。
- 高屏上底栏原先跟在表单后面，下面空出一大块。壳层改为铺满视口，底栏贴底。
- 列表拉取失败后，「在线」状态刷新会把离线横幅清掉，只读缓存等于没标出来。现在只有拉取成功才收起横幅；电脑重新上线时再拉一次列表，成功才收起。
- 启动时指纹取消或失败，原先被当成「这台手机没有锁屏」直接放行。现在只有系统明确说没有指纹和锁屏密码时才跳过，取消则留在解锁页。
- 有锁屏密码时，指纹框在 Capacitor 的后台线程上弹出，进程直接崩掉（`Must be called from main thread of fragment host`）。弹出改到主线程。

后台通知由 Kotlin 在套接字线程上解密 `note` 帧再弹出。握手仍在页面里完成，完成后把接收密钥交给原生层；页面在前台时明文交回 JS，页面被冻住时通知先弹出来，回到前台再把这段明文补进会话。点通知会带上会话种类和 id。进程被系统拉起来时，从通知 Intent 里取出同一个目标；App 已经在前台时，再点一条通知也会换到新会话。2026-09-28 在虚拟机上冷启动进了「通知验收」，接着在前台再投一条，标题换成「第二条通知」。当时没有绑定电脑，输入框是「电脑离线，不能发送」。截图 `.tmp/remote-emu-note.png`、`.tmp/remote-emu-note2.png`。华为熄屏约二十分钟杀掉前台服务的问题还在，要在「应用启动管理」里改成手动管理。
