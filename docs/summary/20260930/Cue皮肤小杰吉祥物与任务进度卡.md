# Jeff UI 品牌化改造：Cue 皮肤 / 小杰吉祥物 / 任务进度卡（1.10.0）

## 1. 目标与拍板结论

以 1.9.7 定稿的 cue 风格 logo（翡翠绿拱门小杰，`docs/assets/logo.svg`）为基准，对桌面端与移动端做一轮 UI / 交互品牌化。用户拍板：

1. **保留微信绿**，翡翠绿做成**新的默认皮肤** `cue`；从没选过皮肤的老用户（kv 未落库）也一起切过去。
2. **只改小杰的头像**为吉祥物形象，其他智能体/群 emoji 头像一律不动。
3. **增加任务进度卡**（工具调用步骤化呈现）。
4. 群聊按 `sender_id` 识别小杰——核实后**无需改契约**：`ChatMsg.agentId` 已存在且群历史已填充（`orchestrator/group.ts` history 映射），前端用起来即可。
5. 版本 **MINOR 1.10.0** 一次发（versionCode 11000）。

## 2. 主要改动

### 桌面端

- **cue 皮肤**（`styles.css` 第 3/4 节）：翡翠绿 `#10B981` 品牌色 + 墨色 `#0F172A` 文字、绿灰调底色、亮/暗两套。文字级绿色用 `#047857/#059669`（对比度安全），`#10B981` 只做填充。默认值切换四处：`ipc/contract.ts` 类型、`ipc.ts settingsGet` fallback、`store.ts applyThemePack`、`sync/engine.ts` 同步 fallback。外观页新增「翡翠小杰（推荐）」卡片，`ui.spec.ts` 主题用例补 cue 断言。**seed（e2e）仍显式写 weui**——正好每轮回归都覆盖「显式选过的用户不被切换」这条语义。
- **小杰吉祥物**：新组件 `Mascot.tsx`（与 logo 同源的 SVG，纯换五官：idle 微笑 / working 瞳孔游移+嘴部哼鸣 / done 双眨眼 / error 瘪嘴摇头）。`Avatar.tsx` 按 `agentId === XIAOJIE_ID` 渲染层特判，**DB 的 avatar 字段不动**（同步/迁移零风险）；busy 时 idle 自动升 working，吉祥物不再叠角标绿点。接线全部调用点：聊天列表、私聊头部/欢迎页/消息行、群消息行与群流式气泡（按 `msg.agentId`/`stream.agentId` 识别）、智能体页、编辑页（锁定态）、群成员抽屉。完成回合触发一次眨眼（`useDonePulse`）；流式里出现 error 工具时头部头像短暂换委屈脸。项目群头像、⏳ 占位、下拉列表文案里的 emoji 按约定保留。
- **任务进度卡**：`AssistantExtras` 工具区升级——每步带状态图标（✓/旋转圈/✗/空心点）+ 中文动作短语（`TOOL_ACTION_LABEL`，落在 **core** `tools/labels.ts`，两端共用防漂移）+ 弱化英文原名；展开时流式期间自动跟随最新一步。摘要行保留「工具调用 N」措辞（E2E 兼容），本质是「执行步骤流水」而非 plan checklist（模型不会先给计划）。
- **真 logo 归位**：空态（`App.tsx`）与关于页（`AboutSettings.tsx`）的「绿渐变方块 + J」占位换成吉祥物本体；对应 CSS 去掉渐变底。

### 移动端（apps/mobile）

- 品牌色 `#07c160/#06ad56` → `#10b981/#059669`（亮/暗两套变量）。
- `Mascot.tsx` 同款组件；`WeChatAvatar` 增加可选 `agentId`，小杰行/聊天行/流式行/长按菜单/锁屏页/绑定页全部接入；群消息行顺手修正了 dead 的 `agent_id` 判断为 `agentId`（群成员头像此前永远显示群图标）。
- 流式状态增加 `agentId`（来自 `RemoteStreamFrame.agentId`），群聊流式时也能按人渲染吉祥物。
- `ToolsView` 升级为与桌面同语义的进度卡（`TOOL_ACTION_LABEL` 从 core 引入 + StepIcon）。

## 3. 测试与验证（全绿）

- `npm test`：core 357 通过（含 `version.test.ts` 一致性）+ relay 11 通过。
- `npm run typecheck`：仅剩 3 个**存量** e2e helper 报错（改动前就有）。
- 桌面 E2E：`ui` 2 通过（含新增 cue 主题断言）、`v18` 4 通过、`cron` 11 通过。
- 移动端：vitest 12 通过；浏览器 E2E 5 通过（我页/暗色/Markdown）。
- **视觉自检**（`.tmp/visual110/`，截图在 `.tmp/ui110-shots/`）：cue 亮/暗、外观页选中态、小杰列表/头部/欢迎页/空态/关于页吉祥物均正确。
- **真模型 E2E**（`.tmp/live110/`，1 轮通过）：真 sidecar + 硅基流动模型——让小杰「查插件 + 建定时任务」，断言链路：流式中出现 working 吉祥物 → 回合结束（working 脸消失）→ 展开进度卡见「✓ 查看智能体 jeff_agent_list 完成」（中文动作 + 弱化英文名 + 状态词）→ `chat:history` 落库 tools → opencode 引擎 part 表确认本轮 jeff_* 工具全部 completed；截图留档 `.tmp/live110-shots/`。
  - 调试教训：测试签名误用 Playwright 的 `page` 夹具（空 chromium about:blank）而非 `launchJeff` 返回的 Electron 页面，造成「白屏 + 元素等不到」假象，排查一轮后修正；弱模型不保证按剧本建 cron，最终断言改为确定性（工具链路 + 引擎落库），cron 业务闭环由封闭 cron 套件（11 轮）覆盖。

## 4. 打包与产物验收

| 产物 | 校验 |
|---|---|
| `apps/desktop/release/jeff-desktop_1.10.0_amd64.deb` | 本机安装 `dpkg -l` = 1.10.0；`/opt/Jeff/resources/app.asar` 与 `linux-unpacked` md5 一致（107aeeac…）；hicolor 512 图标与 `build/icon.png` md5 一致（e5000f7f…） |
| `apps/desktop/release/Jeff-1.10.0.AppImage` | 随 package:linux 产出（278MB） |
| `apps/desktop/release/jeff-Setup-1.10.0.exe` | `file` = PE32 Nullsoft；asar 含 `theme-pack-cue` 特征串；`win-unpacked/resources/oc-bin/windows-x64/opencode.exe` 在位 |
| `apps/mobile/.../app-release.apk` | 正式签名（keystore `jeff`）；`aapt dump badging` = versionName 1.10.0 / versionCode 11000 |

注意：apk 首次构建产出 unsigned——gradle 签名口令走 `JEFF_ANDROID_STORE_PASSWORD/KEY_PASSWORD` 环境变量，重跑时带上即可。

## 5. 已知边界与后续

- 「需要你审批」表情**没有做**：权限是自动放行的（`index.ts:1327` 收到 `permission.asked` 直接回 once），不存在挂起态；表情状态只有 工作/完成/出错 三个真实信号。
- 任务进度卡每步**不做耗时**（耗时只在 debug 日志，进 UI 需改 contract + relay 增量帧 + 两端，本期不值得）。
- `seed.mjs` 显式预置 weui 属预期（老用户语义），未改。
- About 页在 dev 模式显示 v39.8.10 是 Electron 版本（dev 下 `app.getVersion()` 行为），打包后显示 1.10.0，非本次改动引入。
