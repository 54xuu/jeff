# Android App 对话记录界面微信样式重构与正式版打包

## 背景与需求

用户要求：
1. 深入理解微信对话界面的样式规范与桌面端（Desktop）已有的布局逻辑。
2. 重构 Android App (`apps/mobile`) 的对话记录 / 会话列表界面，参考微信经典设计风格，并与 Desktop 界面行为一致：
   - 具备「小杰（内置管家）」专属置顶展示
   - 具备「置顶」分区与置顶微标支持
   - 具备「项目群」独立分区与群图标显示
   - 具备「智能体」独立分区与分类（category）折叠分组显示，展开/收起箭头旋转与数量微标
   - 头像支持展示真实的 emoji 图标（智能体 `avatar`、群 `icon`），并在生成中带有绿色忙碌脉冲点
   - 支持移动端长按呼出微信样式操作菜单（置顶/取消置顶，本地持久化缓存）
   - 对话内部支持优雅的微信式「会话记录 / 话题记录」抽屉面板，可直接切换历史会话或新建会话
3. 保证单测全绿、无回归，并打出正式版 Release APK（`jeff-1.9.6.apk`）并核验签名与版本。

## 核心改动

### 1. 样式规范（`apps/mobile/src/styles.css`）
- **微信头像增强（`wechat-avatar`）**：
  - 微圆角规范（8px 圆角），支持 emoji 居中自适应缩放（`0.54` 字号倍率）。
  - 智能体与群头像采用淡雅柔和的微色彩背景（`emoji-avatar` 与 `group-avatar`）。
  - 增加忙碌呼吸光点（`wechat-avatar-busy`），与桌面端对齐。
- **分组与分类折叠（`wechat-section-header`, `wechat-group-block`, `wechat-group-head`）**：
  - 吸顶分区标头（项目群、智能体、置顶），浅灰底色与深浅模式适配。
  - 二级分类折叠标头按钮，支持顺滑的箭头旋转动画（`-90deg`）与组内数量徽标。
- **长按菜单（`wechat-sheet-mask`, `wechat-sheet-panel`）**：
  - 微信经典底部 ActionSheet 动画，支持平滑滑入淡出与手势取消。
- **会话记录抽屉（`wechat-drawer-panel`, `wechat-drawer-list`, `wechat-drawer-item`）**：
  - 仿微信/桌面端的「会话记录 / 群话题记录」抽屉，支持高亮展示当前会话、快捷切换与新建会话。

### 2. 界面与交互逻辑重构（`apps/mobile/src/App.tsx`）
- **数据结构与分组聚合**：
  - 分离内置管家 `xiaojie` 与其他智能体 `others`。
  - 使用 `useMemo` 对 `others` 按 `category`（分类）聚合，默认分组（`DEFAULT_GROUP = '默认'`）排序在最后，与桌面端完全一致。
  - 引入置顶状态 `pins`，从本地缓存持久化恢复；过滤未置顶项分别归位到「项目群」与「智能体各分类」中。
- **组件抽取与触控优化**：
  - 升级 `WeChatAvatar`，优先渲染 emoji 图标，无 emoji 时回退至首字母或标准微信 SVG。
  - 抽取 `WeChatItemRow`，集成 450ms 长按检测、防误触滑动阈值判断及右键菜单监听。
- **会话内部视觉打通**：
  - 消息气泡对方头像联动对应发言人的 `avatar` 或群 `icon`，消除单调首字母方块。
  - 顶部导航增加「会话 / 话题」抽屉入口，与底部「+」号面板双向互通。

### 3. 测试与正式版打包
- 新增单元测试 `apps/mobile/src/ChatListUi.test.tsx`（覆盖 emoji 头像渲染、忙碌呼吸灯、标签展示、点击交互等 6 项单测）。
- 修复 `apps/mobile/android/app/build.gradle` 中的版本号，同步升级至 `versionCode 10906`, `versionName "1.9.6"`。
- 使用 release keystore 完成正式签名打包并验证：
  - 产物路径：`apps/mobile/android/release/jeff-1.9.6.apk`
  - `aapt dump badging` 验证：`versionCode='10906' versionName='1.9.6'`
  - `apksigner verify -v` 验证：`Verified using v1 scheme: true`, `Verified using v2 scheme: true`。
