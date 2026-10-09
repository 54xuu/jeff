# Android 遥控器协作约定

本文件由 [`AGENTS.md`](../../AGENTS.md) 拆出。方案全文见 [`docs/notes/20260927-Android遥控器方案.md`](../notes/20260927-Android遥控器方案.md)。

# Android 遥控器

方案全文在 [`docs/notes/20260927-Android遥控器方案.md`](../notes/20260927-Android遥控器方案.md)。这里只留协作时会踩的约定。

- **同一个仓库**：App 在 `apps/mobile`（React + Capacitor），中转站在 `apps/relay`，协议和加密在 `packages/core/src/remote`（无 Node 依赖，桌面端、App、中转站共用）。不要把 App 拆出去另开仓库。
- **契约先行**：新增或修改任何 IPC 通道时，同一提交里在 `packages/core/src/remote/whitelist.ts` 归类为放行、拒绝或替换。漏归类时该模块加载即失败，`packages/core/tests/remote.test.ts` 也会红。
- **一个功能两端做**：有界面的新功能，默认同一次任务里同时改桌面端和 App。只做了桌面端时，总结文档里写明 App 端待办。
- **中转站只转发密文**：不在 `apps/relay` 里解析 `e2e.body`，不落盘消息内容。绑定关系是「一台电脑一个 App，一个 App 多台电脑」，靠 `binding.desktop_id` 唯一约束。
- **真机**：`adb connect 192.168.3.161:5555`（用 `$ANDROID_HOME/platform-tools/adb`，不要用 apt 里的旧 adb）。装包 `adb install -r <apk>`，截图 `adb exec-out screencap -p > .tmp/screen.png`。本机 SDK 在 `~/Android/Sdk`（platforms android-34/35/36，build-tools 35.0.1，emulator 37.1.11）。Google 的下载域名在本机代理下经常握手失败，SDK 是从镜像拷出来的。日常验证用本机虚拟机，不要占真机：AVD 名 `jeff`（Android 14 / API 34，`emulator-5554`）。启动：`emulator -avd jeff -no-window -no-audio -gpu swiftshader_indirect -accel on -no-snapshot`。这台华为（ANA-AN00）的 iAware 会在熄屏约 20 分钟后杀掉前台服务，Doze 白名单挡不住；要在「设置 → 应用启动管理」里把 Jeff 改成手动管理，并允许后台活动。
- **签名**：release keystore 在 `~/.jeff-android/release.keystore`，口令在 ZCode 记忆 `android-release-keystore.md`，禁止进仓库。调试包用 debug 签名即可。
- **apk 版本**：`versionName` 与仓库版本号一致，`versionCode = major * 10000 + minor * 100 + patch`。
- **正式 APK 验收**：交付必须是 `assembleRelease` 生成的签名 APK，debug APK 不能替代。使用 `~/Android/Sdk/build-tools/35.0.1/aapt dump badging <apk>` 核对包名、`versionName`、`versionCode`，并用同目录的 `apksigner verify --verbose --print-certs <apk>` 确认签名有效；在总结中记录 APK 路径和 SHA-256。需要设备验收时按下文 AVD / Windows 真机顺序执行。
- **中转站部署**：只有用户要求部署 relay，或本次任务明确包含 relay 服务发布时，才部署到 ECS `47.106.209.32:9443`；证书指纹见 `packages/core/src/remote/protocol.ts` 的 `RELAY_CERT_SHA256`。构建 release APK 不代表需要部署 relay。
- **中转站镜像**：`apps/relay/Dockerfile` 把服务打成 CJS（`ws` 有动态 `require`，ESM bundle 起不来）。ECS 直连 Docker Hub 会超时，默认基础镜像是 `docker.m.daocloud.io/library/node:22-alpine`。证书和私钥在服务器 `/opt/jeff-relay/certs/`，不要进仓库。
