# Jeff 扁平化 Logo 重构与三端打包交付（1.9.7）

## 1. 迭代背景与最终定稿

用户选定 `.tmp/cue_v2.svg` 作为 Jeff 的正式主 Logo。
该方案完全对齐 **Manus / Cue Agent** 角色图标的核心视觉哲学：
1. **纯几何色块外形**：翡翠绿（`#10B981`）平滑圆角拱门半圆体（宽底圆弧拱顶，带有圆角过渡）。
2. **极简拟人五官系统（Cue 风格）**：
   - 纯圆大白眼底（`#FFFFFF`）+ 纯黑偏心大瞳孔（`#0F172A`），神态专注呆萌、俏皮可爱；
   - 极简小黑线条弧线微笑嘴（`stroke="#0F172A" stroke-width="3"`）。
3. **白底居中规范**：
   - Desktop 端：白底圆角矩形背景（`#FFFFFF`），主角色光学居中缩放；
   - Android 端：自适应图标系统（Adaptive Icon）背景采用纯白 `#FFFFFF`，前景图透明底角色居中，并提供圆形与方形白底 fallback。

---

## 2. 资源生成与更新

开发了自动化脚本 `scripts/update-icons.mjs`，一键生成桌面端与移动端全套资源：

1. **主 Logo 矢量与预览**：
   - `docs/assets/logo.svg`：官方主 Logo 矢量代码（纯净 10 行）。
   - `docs/assets/logo.png`：512×512 渲染大图。
2. **桌面端（`apps/desktop/build/`）**：
   - `icon.png` (512×512)、`icon-512.png`、`icon-256.png`、`icon-128.png`、`icon-64.png`、`icon-32.png`。
   - `tray.png` (32×32)。
3. **移动端（`apps/mobile/android/app/src/main/res/`）**：
   - 更新 `values/ic_launcher_background.xml` 背景色为 `#FFFFFF`。
   - 全套 Mipmap（mdpi、hdpi、xhdpi、xxhdpi、xxxhdpi）：
     - `ic_launcher.png`（白底圆角方形）
     - `ic_launcher_round.png`（白底纯圆形）
     - `ic_launcher_foreground.png`（透明底前景图）

---

## 3. 版本号递增（SemVer 一致性）

按照 `AGENTS.md` 规范，改动包含桌面端 UI 资产更新与全端打包，按 **PATCH** 慢升原则从 `1.9.6` 递增至 `1.9.7`，严格保持各端一致：
- 根目录 `package.json` (`1.9.7`)
- `packages/core/package.json` (`1.9.7`)
- `apps/desktop/package.json` (`1.9.7`)
- `apps/mobile/package.json` (`1.9.7`)
- `apps/relay/package.json` (`1.9.7`)
- `packages/core/src/version.ts` (`APP_VERSION = '1.9.7'`)
- `package-lock.json`（根与各工作空间包统一升级）
- `apps/mobile/android/app/build.gradle` (`versionCode 10907`, `versionName "1.9.7"`)

---

## 4. 测试与验证门禁

在打包前跑通全部测试：
1. `npm test`：`@jeff/core` 与 `@jeff/relay` 全部通过（包含 `version.test.ts` 强制一致性校验）。
2. `tsc` 类型检查：
   - `packages/core`：0 错误。
   - `apps/desktop`：0 错误。
   - `apps/mobile`：0 错误。
3. `apps/desktop` E2E 封闭测试：`p0-ux.spec.ts` 与 `ui.spec.ts` 全部绿灯。

---

## 5. 三平台打包与产物验收

### (1) Linux 桌面端
- **命令**：`npm run package:linux`
- **产物**：
  - `apps/desktop/release/jeff-desktop_1.9.7_amd64.deb` (212MB)
  - `apps/desktop/release/Jeff-1.9.7.AppImage` (278MB)
- **本地安装核验**：
  - 执行 `sudo -S dpkg -i jeff-desktop_1.9.7_amd64.deb` 成功安装到本机。
  - `dpkg -l jeff-desktop` 验证版本号为 `1.9.7`。
  - MD5 一致性核验：
    - `/opt/Jeff/resources/app.asar` 与 `release/linux-unpacked/resources/app.asar` 均为 `dcc45738d0e781b9def1692b5b4cbae3`。
    - `/usr/share/icons/hicolor/512x512/apps/jeff-desktop.png` 与 `apps/desktop/build/icon.png` 均为 `e5000f7f2f7f755ed07480067c1c4008`。

### (2) Windows 桌面端
- **命令**：`npm run package:win`（通过本机 wine + makensis 编译）
- **产物**：
  - `apps/desktop/release/jeff-Setup-1.9.7.exe` (205MB)
- **产物级校验**：
  - `file` 校验：`PE32 executable (GUI) Intel 80386, for MS Windows, Nullsoft Installer self-extracting archive`。
  - 核心依赖与 OpenCode 二进制存在：`apps/desktop/release/win-unpacked/resources/oc-bin/windows-x64/opencode.exe`。

### (3) Android 移动端
- **命令**：`cd apps/mobile && npm run cap:sync && cd android && ./gradlew assembleRelease`
- **签名**：使用 `~/.jeff-android/release.keystore`（别名 `jeff`）正式签名。
- **产物**：
  - `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` (8.3MB)
- **aapt badging 校验**：
  - `package: name='app.jeff.mobile' versionCode='10907' versionName='1.9.7'`
  - Application icon 与自适应背景正确挂载。
