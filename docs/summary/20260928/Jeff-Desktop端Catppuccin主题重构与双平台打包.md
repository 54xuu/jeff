# Jeff Desktop 端 Catppuccin 主题重构与双平台打包

- **日期**：2026-09-28
- **版本**：v1.9.3（从 v1.9.2 bump，遵循默认 PATCH 原则）
- **交付产物**：
  - Linux deb 安装包：`apps/desktop/release/jeff-desktop_1.9.3_amd64.deb`（212MB）
  - Linux AppImage：`apps/desktop/release/Jeff-1.9.3.AppImage`（278MB）
  - Windows 安装包：`apps/desktop/release/jeff-Setup-1.9.3.exe`（205MB）

---

## 1. 需求背景与设计目标

继 Android 遥控器 App 成功应用 Catppuccin（Latte/Mocha）获得极佳视觉体验后，用户要求：
> “把 desktop 也用 Catppuccin 主题重构，一定是变得更好看更好用了，不能是更差了，并重新编译双系统版本。”

### 核心设计原则
1. **统一设计语言**：桌面端与移动端共享 Catppuccin 精准配色体系，形成多端一致的品牌高级感与温润护眼质感。
2. **三栏阶梯感强化**：
   - 导航轨（Rail）采用沉稳底座色（Latte `Crust #dce0e8` / Mocha `Crust #11111b`）。
   - 侧边会话/设置列表栏（List Pane）采用中层承载色（Latte `Mantle #e6e9ef` / Mocha `Mantle #181825`）。
   - 工作台与对话区（Panel）采用高对比度内容底色（Latte 纯白 `#ffffff` / Mocha `Base #1e1e2e`），阅读舒适度显著提高。
3. **气泡与文字对比度优化**：
   - 用户气泡在日间模式下使用优雅柔和的低饱和蓝粉青色调（`#dce5fa` 配合 `#1d2b4f`），告别以往刺眼生硬的纯绿/纯白；夜间模式使用精致的 `Surface0 #313244` 配合柔白 `#cdd6f4`。
   - 正文字体颜色调整为护眼铅黑（`#4c4f69`）与柔白（`#cdd6f4`），告别全黑全白的视觉刺激。
4. **代码高亮与细节打磨**：
   - 将 rehype-highlight 代码块的语法高亮映射到官方 Catppuccin 调色板（Mauve、Peach、Green、Blue、Yellow）。
   - 按钮、徽标支持蓝粉紫渐变（`#1e66f5` 至 `#7287fd`）。
   - 暗色模式下 primary 按钮文字颜色由硬编码白色改为高对比度的深色（`#11111b`），达到顶级可读性。
5. **向后兼容与平滑迁移**：
   - 保留经典的微信 WeUI 选项（`themePack: 'weui'`），用户依然可以在设置中随时切回。
   - 默认主题包设为 `catppuccin`，类型与持久化存储完全贯通。

---

## 2. 改动清单

### A. 协议与状态管理
- `packages/core/src/ipc/contract.ts`：
  - `AppSettings['themePack']` 由单值 `'weui'` 扩展为联合类型 `'catppuccin' | 'weui'`。
- `packages/core/src/sync/engine.ts`：
  - 默认 `themePack` 兜底由 `'weui'` 升级为 `'catppuccin'`。
- `apps/desktop/src/main/ipc.ts`：
  - `settings:get` 读取兜底升级为 `'catppuccin'`。
- `apps/desktop/src/renderer/src/store.ts`：
  - `applyThemePack` 更新默认值为 `'catppuccin'`。
- `apps/desktop/src/renderer/src/components/settings/AppearanceSettings.tsx`：
  - `PACK_OPTIONS` 增加 `Catppuccin（推荐）`，并调整预览卡片逻辑。

### B. 全局样式重构（`apps/desktop/src/renderer/src/styles.css`）
- 注入完整 Catppuccin 26 色基准变量：`--ctp-rosewater` 到 `--ctp-crust`。
- 定义桌面端语义变量：
  - 亮色（Latte）：`--bg: #eff1f5`, `--bg-rail: #dce0e8`, `--bg-list: #e6e9ef`, `--bg-panel: #ffffff`, `--green: #1e66f5`, `--green-gradient-end: #7287fd`, `--bubble-user: #dce5fa`, `--bubble-user-text: #1d2b4f`。
  - 暗色（Mocha）：`--bg: #1e1e2e`, `--bg-rail: #11111b`, `--bg-list: #181825`, `--bg-panel: #1e1e2e`, `--green: #89b4fa`, `--green-gradient-end: #b4befe`, `--bubble-user: #313244`, `--bubble-user-text: #cdd6f4`, `--btn-primary-text: #11111b`。
- 完善外观设置页的 5 种预览方块：`catppuccin`、`weui`、`light`、`dark`、`system`。
- 适配 rehype-highlight 代码块的双主题 Catppuccin 配色。

### C. 自动化测试与种子数据
- `apps/desktop/e2e/helpers/seed.mjs`：种子数据的 `settings:themePack` 初始化为 `catppuccin`。
- `apps/desktop/e2e/ui.spec.ts`：增加对外观点选 `theme-pack-catppuccin` 的双向断言。

---

## 3. 测试验证与打包交付

按照 `AGENTS.md` 规则执行完整回归门禁：

1. **单测套件**（`npm test`）：
   - `@jeff/core`：36 个测试文件、357 个测试全部通过（含版本号一致性校验）。
   - `@jeff/relay`：2 个测试文件、7 个测试全部通过。
2. **类型检查**（`npm run typecheck`）：
   - `core` 与 `desktop` 包级 tsc 校验 0 错误（存量 e2e helper 报错未增加）。
3. **E2E 封闭套件**：
   - `npm run test:e2e`（Mock UI）：2 passed (45.1s)，含 P0 交互与 UI 外观切换全绿。
   - `--project=v18`（v1.8.0 五大功能）：4 passed (1.1m)。
   - `--project=cron`（定时任务 10 轮隔离）：11 passed (18.4s)。
4. **编译与安装校验**：
   - **Linux**：`npm run package:linux` 产出 deb 与 AppImage；通过 `sudo -S dpkg -i` 在本机安装成功，`dpkg -l jeff-desktop` 显示 `1.9.3`，`/opt/Jeff/resources/app.asar` 与 `linux-unpacked` 的 MD5 校验码完全一致（`59e6692c9c0d371d37e83fe7b76ac37e`）。
   - **Windows**：`npm run package:win` 产出 `jeff-Setup-1.9.3.exe`，PE32 Nullsoft Installer 校验通过，`app.asar` 命中本次 Catppuccin 特征串，`opencode.exe` 在位完整。
