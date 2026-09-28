# Jeff 默认绿色主题切换与全平台交互细节优化

**日期**：2026-09-28  
**版本**：v1.9.4  
**涉及端**：Desktop 端（Windows / Linux）、Mobile 端（Android 遥控器 App）、Core 基础库

---

## 1. 需求背景

用户明确反馈：
> “还是绿色好看，还是把 desktop / apk 默认主题换成绿色主题，然后你自己重点 E2E 测试下调整下交互和按钮等样式细节”

核心目标：
1. **默认主题换回高质感经典绿色主题**：将 Desktop 端与 Mobile 端默认主题包均设为微信绿/翡翠绿经典风格，同时在桌面端保留 Catppuccin 粉彩主题供用户自由切换。
2. **交互与按钮细节调优**：
   - 增加按压微缩（`:active` `transform: scale(0.98)`）与平滑过渡过渡效果；
   - 按钮、发送键使用绿色微投影（`box-shadow`）与悬停微浮效果；
   - 会话/联系人选中态采用 3px 翡翠绿指示条配合高透明度绿色底衬；
   - 输入框与草稿焦点采用 24% 品牌翡翠绿光晕；
   - 移动端消息气泡、发送按钮、扫码按钮、状态点等全面适配高质感微信绿体系。
3. **分层 E2E 回归测试**：重点回归桌面端主题切换、交互细节、定时任务、v1.8.0 核心能力等，确保 100% 绿灯。
4. **全平台产物构建与本地验证**：按照规范 bump 版本至 `1.9.4`，重新编译产出 Linux deb/AppImage、Windows exe 以及 Android release 签名 apk，并在本机完成安装验证。

---

## 2. 核心代码变更

### 2.1 桌面端样式重构（`apps/desktop/src/renderer/src/styles.css`）

- **亮色模式（默认 `weui` 翡翠绿风格）**：
  - 核心强调色：`--green: #07c160; --green-dark: #06ad56; --green-gradient-end: #34d399;`
  - 消息气泡：用户气泡采用柔和温润的翡翠绿底色 `--bubble-user: #d7f5e4;`，搭配护眼深绿文字 `--bubble-user-text: #0d3b24;`。
  - 背景层次：工作台白底 `--bg-panel: #ffffff;`，会话栏 `--bg-list: #f5f6f8;`，导航轨 `--bg-rail: #e9ebef;`。
- **暗色模式（夜间沉浸墨绿风格）**：
  - 强调色：`--green: #10b981; --green-dark: #059669;`
  - 消息气泡：用户气泡采用夜间墨绿 `--bubble-user: #1b4a34;`，搭配柔白文字 `--bubble-user-text: #e7fff3;`。
  - 背景层次：`--bg: #101216; --bg-rail: #0b0d10; --bg-list: #15181e; --bg-panel: #1b1e26;`。
- **按钮与控件交互细节**：
  - `.btn`：添加平滑过渡 `transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);`，激活状态微缩 `transform: scale(0.98);`。
  - `.btn.primary`：增加翡翠绿微投影 `box-shadow: 0 2px 6px color-mix(in srgb, var(--green) 28%, transparent);`，悬停上浮。
  - `.send-btn`：增加投影、悬停浮起、按压物理反馈。
  - `.chat-item.selected` / `.contact-card.selected`：添加翡翠绿侧边指示条与绿色轻透底色 `box-shadow: inset 3px 0 0 var(--green);`。
  - `.composer-input textarea:focus` / `.chip-draft:focus-within`：高亮品牌绿色光晕。
- **保留 Catppuccin**：在 `[data-theme-pack='catppuccin']` 分支下保留完整的粉彩主题，供用户随时切换。

### 2.2 默认主题配置契约恢复（`packages/core` & `apps/desktop`）

- `packages/core/src/ipc/contract.ts`：`AppSettings['themePack']` 明确为 `'weui' | 'catppuccin'`。
- `packages/core/src/sync/engine.ts` & `apps/desktop/src/main/ipc.ts`：默认主题包重置为 `'weui'`。
- `apps/desktop/src/renderer/src/store.ts`：`applyThemePack` 默认应用 `'weui'`。
- `apps/desktop/src/renderer/src/components/settings/AppearanceSettings.tsx`：默认显示「微信翡翠绿（推荐）」，其次为「Catppuccin 粉彩」。
- `apps/desktop/e2e/helpers/seed.mjs`：种子数据的 `settings:themePack` 设为 `'weui'`。
- `apps/desktop/e2e/ui.spec.ts`：更新测试用例，先验证默认 `weui`，切换至 `catppuccin`，再切回 `weui`，双向验证通过。

### 2.3 移动端 App 绿色主题重构（`apps/mobile/src/styles.css`）

- **亮色默认**：
  - 品牌主色：`--brand: #07c160; --brand-hover: #06ad56;`
  - 我的气泡：经典微信绿 `--me: #95ec69; --me-text: #111a13;`
  - 对方气泡：纯白底搭配细腻边框与阴影 `--bubble-other: #ffffff;`
  - 全局底色：`--bg: #f4f5f7; --card: #ffffff;`
- **暗色默认**：
  - 品牌主色：`--brand: #10b981; --brand-hover: #34d399;`
  - 我的气泡：深墨绿 `--me: #1b4a34; --me-text: #e7fff3;`
  - 全局底色：`--bg: #111317; --card: #191c23;`
- **交互与按钮细节**：
  - 扫码悬浮按钮 `.btn-scan`：绿色微投影 `box-shadow: 0 4px 14px color-mix(in srgb, var(--brand) 32%, transparent);`，轻触微缩。
  - 发送按钮 `.composer button`：绿色强调背景与轻触动效。
  - 输入框 `.composer input:focus`：翡翠绿焦点外发光。
  - 会话与目录列表：点击加入平滑触感微缩。

---

## 3. 测试与验证（100% 绿灯）

严格按照仓库测试规范分层运行并全部通过：

1. **类型检查**：
   - `npx tsc -p packages/core/tsconfig.json --noEmit`：通过。
   - `npx tsc -p apps/desktop/tsconfig.node.json --noEmit`：通过。
   - `npx tsc -p apps/desktop/tsconfig.web.json --noEmit`：通过。
2. **单元测试与版本校验**：
   - `npm test`：36 个测试文件、357 个单元测试全部通过（含版本一致性校验）；relay 7 个单测全部通过。
3. **Mock UI E2E 测试**：
   - `cd apps/desktop && npm run test:e2e`：2 个 UI 测试全绿（包含主题外观切换、草稿、斜杠指令、导航切换等）。
4. **核心功能封闭测试**：
   - `cd apps/desktop && npx playwright test -c e2e/playwright.config.ts --project=v18`：4 个用例全绿通过。
5. **定时任务隔离与并发封闭测试**：
   - `cd apps/desktop && npx playwright test -c e2e/playwright.config.ts --project=cron`：11 个用例全绿通过。

---

## 4. 全平台构建与安装验收

### 4.1 Linux 安装包与本机安装

- **命令**：`npm run package:linux`
- **产物**：
  - `apps/desktop/release/jeff-desktop_1.9.4_amd64.deb`（212MB）
  - `apps/desktop/release/Jeff-1.9.4.AppImage`（278MB）
- **本机安装验收**：
  - 执行 `sudo -S dpkg -i apps/desktop/release/jeff-desktop_1.9.4_amd64.deb` 安装成功；
  - `dpkg -l jeff-desktop` 显示版本 `1.9.4`；
  - 产物校验：`/opt/Jeff/resources/app.asar` 与 `linux-unpacked/resources/app.asar` 的 MD5 完全一致（`c01af185f265f9f3ae9a916a764eb7c9`）。

### 4.2 Windows 安装包与产物检验

- **命令**：`npm run package:win`
- **产物**：
  - `apps/desktop/release/jeff-Setup-1.9.4.exe`（205MB）
- **产物校验**：
  - `file` 检查确认为 `PE32 executable (GUI) ... Nullsoft Installer`；
  - `grep -a` 成功命中本次改动特征串 `#07c160`；
  - `oc-bin/windows-x64/opencode.exe` 完整在位。

### 4.3 Android Release 签名 APK 构建

- **命令**：`cd apps/mobile && npm run build && npx cap sync android`，随后执行 Gradle `assembleRelease`
- **密钥与签名**：采用 `~/.jeff-android/release.keystore`（别名 `jeff`）进行正式 release 签名。
- **产物**：
  - `apps/mobile/android/release/jeff-1.9.4.apk`（7.08MB）
- **版本校验**：
  - `aapt dump badging` 验证输出：`package: name='app.jeff.mobile' versionCode='10904' versionName='1.9.4'`，版本完全对齐。
