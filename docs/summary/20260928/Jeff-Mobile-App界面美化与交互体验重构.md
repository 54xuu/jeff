# Jeff Mobile App 界面美化与交互体验重构（Catppuccin 主题与手势返回）

2026-09-28。针对用户反馈的「App 界面太丑、交互难受、没有状态栏/返回键无法返回、Android 手势返回直接退出了 App」等痛点，对 `apps/mobile` 进行了界面重构与原生交互修复。

## 改动清单

1. **界面主题重构：Catppuccin 双模式（Latte 亮色 + Mocha 暗色）**
   - 替换了原先类似微信的高饱和绿与生硬黑白配色，全面引入开源设计系统 **Catppuccin**：
     - **亮色模式 (Latte)**：温润的奶白底色（`#eff1f5`）、纯白微立体卡片（`#ffffff`）、柔和铅黑正文（`#4c4f69`）、蓝青强调色（`#1e66f5`）。
     - **暗色模式 (Mocha)**：深沉雅致的蓝紫黑底色（`#1e1e2e`）、次级容器底色（`#181825`）、舒适护眼柔白字（`#cdd6f4`）、柔蓝强调色（`#89b4fa`）。
   - 增加毛玻璃（`backdrop-filter: blur(12px)`）顶栏与底栏设计，让内容滚动更具层次感。
   - 输入框、消息气泡重绘：圆角弧度优化，增加轻微阴影与精致按压交互。

2. **状态栏适配**
   - 在 Android 原生 `AppTheme.NoActionBar` 中配置 `windowLightStatusBar = true`。
   - 亮色与暗色模式下状态栏文字与图标均清晰可辨，顶栏视觉与系统状态栏融为一体。

3. **Android 物理/手势返回键交互修复**
   - **原问题**：在聊天页、相册/新建抽屉或目录选择页使用 Android 侧滑返回或返回键时，系统默认直接销毁/退出了 App。
   - **修复实现**：
     - 在原生 `MainActivity.java` 中重写 `onBackPressed()`，优先触发 `JeffSpikePlugin` 向前端分发 `back` 事件。
     - 在 `App.tsx` 中建立分层返回路由机：
       - 若展开了加号面板（`plus`）→ 优先关闭加号面板；
       - 若处于目录选择页（`dirs`）→ 返回聊天页；
       - 若处于聊天页（`chat`）→ 返回会话列表页；
       - 若处于“我”的次级面板（如绑定第二台电脑）→ 返回“我”的主页面；若在“我”的主页面 → 返回消息列表；
       - 若已处于主列表最顶层 → 调用原生的 `minimize`（`moveTaskToBack(true)`）将 App 切入后台保活，而不是暴力退出。

4. **显式返回导航**
   - 顶栏左侧补全显式 `‹ 返回` 导航按钮，用户无需依赖盲操手势也能单手点退。

## 验证与效果

- 虚拟机真机运行验证：
  - 亮色截图：`.tmp/screen_light_final.png`
  - 暗色截图：`.tmp/screen_catppuccin_dark.png`
  - 侧滑返回与页面跳转流转验证通过。
- 构建与单测验证：
  - `npm run build -w @jeff/mobile` 编译通过；
  - `cap sync android` 与 `./gradlew assembleDebug` 构建打包成功；
  - 正式发布版签名 APK 构建通过：
    - 产物路径：`apps/mobile/android/release/jeff-1.9.2.apk`
    - 版本信息核对：`aapt dump badging` 验证 `versionName='1.9.2'`，`versionCode='10902'`
    - 签名核对：`apksigner verify` 通过（v1 + v2 方案有效签名，使用官方 release.keystore）
    - 安装与运行验证：已通过 `adb install` 在 Android 模拟器运行并通过启动自检。
