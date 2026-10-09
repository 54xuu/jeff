# Jeff 协作规范（AGENTS.md）

本文件给 Cursor / 人类协作者：改代码、发版、升级本机时的约定。

## 规则文件分层

- **全局通用规则**（开发规范、笔记管理、MySQL 规范、SWR 镜像、输出规则、ZCode 记忆文件管理）：见 `/home/xujian/.agents/AGENTS.md`（唯一权威源，所有工具共用）。ZCode 会话默认加载的 `~/.zcode/AGENTS.md` 仅是指向该文件的指针。
- **本文件**：只保留每次任务都会用到的 jeff 项目硬规则（版本号、Git、三平台交付门槛、必跑测试）。篇幅大的细则拆在 [`docs/agents/`](docs/agents/)，见下方「细则索引」，**命中对应场景时必须先读再做**。
- **UI 与交互**：新增或修改界面前必须阅读 [`docs/ui-interaction-guidelines.md`](docs/ui-interaction-guidelines.md)，按其中的对象归属、状态和验收流程实施；收尾说明需记录布局、状态与真实数据验证结果。
- **领域词汇与决策**：Agent、项目群、执行引擎等术语见 [`CONTEXT.md`](CONTEXT.md)；会影响长期数据边界的决定记录在 [`docs/adr/`](docs/adr/)。

## ZCode 记忆文件

本项目记忆位于 `/home/xujian/.zcode/cli/memories/projects/jeff-1d2f0b1cdfcc2a44/memory/`。格式、索引和维护规则统一遵循 `/home/xujian/.agents/AGENTS.md` 第 6 节。

## 细则索引（按场景读取）

| 场景 | 文档 |
| --- | --- |
| 打包、清理产物与旧包保留、本机装 deb、wine/Windows 包、ASAR 校验 | [`docs/agents/release-packaging.md`](docs/agents/release-packaging.md) |
| 改动涉及聊天 / 流式 / 工具 / MCP / 权限 / 群协作（真实模型 E2E）、打包后产物验证 | [`docs/agents/testing.md`](docs/agents/testing.md) |
| 理解 Agent / 项目群 / 引擎 / 小杰 / 技能 / 定时 / 插件 / 内置浏览器；新增可备份数据 | [`docs/agents/product-model.md`](docs/agents/product-model.md) |
| 改 IPC 通道、`apps/mobile`、`apps/relay`、`packages/core/src/remote`、真机/AVD | [`docs/agents/android-remote.md`](docs/agents/android-remote.md) |
| 双机部署、Windows 安装与 GUI 验收、三平台一次交付、Windows 故障排查、文件链接验收坑 | [`docs/agents/dual-machine-deploy.md`](docs/agents/dual-machine-deploy.md) |

## 版本号（SemVer）

仓库当前版本必须一致（`packages/core/tests/version.test.ts` 会在单测里强制校验，防漂移）：

- 根目录 [`package.json`](package.json)
- [`packages/core/package.json`](packages/core/package.json)
- [`apps/desktop/package.json`](apps/desktop/package.json)
- [`apps/mobile/package.json`](apps/mobile/package.json)
- [`apps/relay/package.json`](apps/relay/package.json)
- [`package-lock.json`](package-lock.json) 里上述包的 `version` 字段
- [`packages/core/src/version.ts`](packages/core/src/version.ts) 的 `APP_VERSION`

### 核心原则：默认 PATCH，MINOR 要克制

版本号是**用户可见的发版信号**，不是每次改代码的进度条。当前版本线为 `2.1.x`，后续优先慢升。

判定顺序（从上往下，命中即停）：

| 优先级 | 变更类型 | 升哪个 | 典型例子 |
|--------|----------|--------|----------|
| 1 | **破坏性**（数据不兼容、强制迁移、删公开能力） | **MAJOR**（`x.0.0`） | 库表无法平滑升级；同步协议破坏旧客户端 |
| 2 | **独立可感知的新能力**（用户能说出「多了一个功能」） | **MINOR**（`x.y.0`，PATCH 归零） | 全新设置页分区、全新同步品类（若整块上线）、新交互入口 |
| 3 | 其余一律 | **PATCH**（`x.y.z`） | 修 bug、补同步缺口、文案、测试、CI、小重构、在已有功能上打补丁 |

**宁可 PATCH，不要轻易 MINOR。** 拿不准时：

- Agent / 协作者：**默认 PATCH**；若认为该升 MINOR/MAJOR，**先问用户确认**再 bump。
- 「修 bug + 顺手补一小块配置进已有同步」→ **PATCH**（例如同步刷新失败 + 把 MCP 塞进已有 settings 包）。
- 「纯文档 / 纯测试 / 只改 AGENTS.md」→ **不 bump**。
- 同一会话、同一发版意图内的多处改动 → **只 bump 一次**（按整包最高级别，不按文件数累加）。

## Git 暂存、提交与推送

- 开始和提交前都检查 `git status --short --branch`、`git diff`、未跟踪文件及目标分支；不要把当前分支相对远端的已有提交误认为本次新改动。
- 先审查每个文件，再用 `git add -- <明确路径...>` 暂存；默认不用 `git add -A`。暂存后检查 `git diff --cached --name-status`、`git diff --cached --check` 和完整 staged diff。
- 排除可执行文件、安装包、APK、数据库、日志、缓存、`.tmp/` 和凭据；`.gitignore` 不能代替 staged 文件清单复核。发现可疑敏感文件时先移出暂存并调查来源，不要提交。
- 推送前 `git fetch` 并核对目标分支、祖先关系及将发布的提交范围；只做可验证的 fast-forward push，不使用 force。若远端已分叉或前进，先重新审查提交范围。

## 每个开发任务的正式交付产物（硬性门槛）

**每个包含代码、测试、资源或产品行为改动的任务，收尾都必须构建三种正式软件：Ubuntu 桌面包、Windows 桌面包、Android release APK。** 这条规则与本次改动属于 desktop、mobile 还是 relay 无关；不能只按改动目录选择产物，也不能用 debug APK 代替正式 APK。只有纯分析、纯文档（包括只改 AGENTS.md）任务不构建软件。未完成测试、版本核对、三种构建及产物校验前，任务不能报告完成。

同一任务的三个产物必须使用同一仓库版本和同一份最终源码。代码改动按本文件 SemVer 规则统一 bump 一次后再构建；纯文档或测试说明不 bump。一个任务内多次提交不重复 bump。

| 目标 | 正式产物 | 构建命令 |
| --- | --- | --- |
| Ubuntu desktop | `.deb` 与 AppImage | `npm run package:linux` |
| Windows desktop | NSIS `.exe` | `npm run package:win` |
| Android app | 用 release keystore 签名的 APK | `cd apps/mobile && npm run cap:sync && cd android && ./gradlew --no-daemon assembleRelease` |

APK 正式产物为 `apps/mobile/android/release/jeff-<version>.apk`。release keystore 在 `~/.jeff-android/release.keystore`，别名 `jeff`；口令从 ZCode 记忆 `android-release-keystore.md` 读取，通过环境变量传给 Gradle。禁止把口令写入仓库、命令记录或回复。APK 版本必须与仓库版本一致，`versionCode = major * 10000 + minor * 100 + patch`。Android SDK 工具使用 `~/Android/Sdk/build-tools/35.0.1/` 下的版本，避免 PATH 指向旧版。

正式 deb / exe 的校验、本机 `sudo` 装 deb、Windows 打包前置（wine）、ASAR 逐文件校验、旧包保留规则见 [`docs/agents/release-packaging.md`](docs/agents/release-packaging.md)；双机部署与三平台验收见 [`docs/agents/dual-machine-deploy.md`](docs/agents/dual-machine-deploy.md)。

**最终答复和总结文档必须分别报告 Ubuntu / Windows / Android 三行结论**（通过/失败/未验证，含测试范围、产物路径与 SHA-256、证据位置）；不得用「打包成功」替代安装或功能结论。仅改文档/AGENTS.md 不升版、不重打包。

## 任务收尾测试（硬性约定）

**每个任务完成、打包发版之前，必须先跑测试证明改动是正确的**，不许「改完就打包」。

### 第一层：所有任务必跑（快速回归）

```bash
npm test                    # @jeff/core 与 @jeff/relay 单测（含版本一致性校验，bump 后跑可防漂移）
npm run typecheck           # core/desktop 包级 tsc；根 tsconfig 有 3 个存量 e2e helper 报错，改动前就在，不算新增
cd apps/desktop && npm run test:e2e   # mock UI E2E（自带 build）
npm run test -w @jeff/mobile          # App 单测
# 新增功能块的封闭 UI 测试（无需模型）：分组 / 定时任务 / 插件 / `/` 指令 / 内置浏览器
cd apps/desktop && npx playwright test -c e2e/playwright.config.ts --project=v18
# 定时任务分组下拉 / 并行 / 同目标多会话隔离（10 轮封闭，不依赖模型成功回复）
cd apps/desktop && npx playwright test -c e2e/playwright.config.ts --project=cron
```

所有必跑项通过后才能构建正式软件。单测红了先修，不许跳过或改断言凑绿。按改动范围再跑对应的 mobile、desktop、relay 与真机/真链路验收；不能用打包成功替代测试。

> `--project=v18`（`apps/desktop/e2e/v18.spec.ts`）是 v1.8.0 五大功能的封闭测试，用 `testAgent: true` 的 seed home；
> `--project=cron`（`apps/desktop/e2e/cron.spec.ts`）是定时任务 10 轮：目标下拉按智能体/项目群分组、同一智能体/项目群多任务走独立会话且不抢用户当前窗口。
> **坑**：`seedJeffHomeSync` 会先 `rmSync(home)`，所以插件目录等预置文件必须在 `launchJeff` **之后**写。

- **第二层**：涉及「聊天 / 流式 / 工具 / MCP / 权限 / 群协作」的改动，必须再跑真实模型 E2E；工具参数只用标量 / 标量数组、验收落在服务端事实。做法见 [`docs/agents/testing.md`](docs/agents/testing.md)。
- **第三层**：打包后验产物（deb 版本与 asar md5、exe 的 PE32/特征串/opencode.exe），同上文档。
- 「测试没通过」先分清是产品语义错了还是测试台预期错了；不要放宽断言凑绿。

## 产品心智模型与备份入口（摘要）

完整内容见 [`docs/agents/product-model.md`](docs/agents/product-model.md)（含 Agent、项目群、执行引擎、小杰、技能、定时任务、插件、内置浏览器的定义与硬规矩）。常踩的几条：

- **工具参数**：给模型的参数只用标量 / 标量数组，嵌套对象拆成平铺字段；update 类工具「没传到 / 传空串」一律当未提供；实现支持的字段必须在 `allToolDefs()` 里声明。回归单测：`packages/core/tests/tool-args.test.ts`、`cron-plugin.test.ts`。
- **备份与恢复入口**（硬性约定）：所有入口统一放「设置 → 同步」页，功能页（插件页、定时页等）不放备份/恢复按钮。**目录型**数据（`~/.agents/skills`、`~/.jeff/plugins`）才配独立「立即备份 / 从备份恢复」；**结构化配置**（智能体 / 项目群 / 任务 / 定时任务定义 / 设置含 MCP）只走「立即同步」双向合并。恢复必须先本地快照、二次确认；敏感值不进备份。新增可备份数据先判断是否目录型，细则见该文档。

## Android 遥控器与 Relay（摘要）

细则见 [`docs/agents/android-remote.md`](docs/agents/android-remote.md)。

- **契约先行**：新增/修改 IPC 通道，同一提交内在 `packages/core/src/remote/whitelist.ts` 归类（放行/拒绝/替换），否则 `packages/core/tests/remote.test.ts` 会红。
- **一个功能两端做**：有界面的新功能默认同时改桌面端与 App；只做桌面端须在总结里写明 App 待办。
- **中转站只转发密文**；部署 relay 仅在用户要求或任务明确包含时进行。
- 签名口令只在 ZCode 记忆，禁止进仓库；`versionCode = major * 10000 + minor * 100 + patch`。

## 双机部署与验收（摘要）

细则与 Windows 故障闭环见 [`docs/agents/dual-machine-deploy.md`](docs/agents/dual-machine-deploy.md)。

- 开发任务由当前 Agent 负责 Ubuntu / Windows / Android 构建、安装排障与验收，安装失败是任务内待解决问题；开始时就预检 Windows SSH、交互会话、磁盘、ADB、AVD。
- 部署用 `npm run deploy:windows -- --target win11 --android auto --suite <具名测试集>`；Android 顺序：Ubuntu AVD → Windows USB → 网络真机；真机缺席写「模拟器通过，真机待验收」。
- **进程保护**：禁止按进程名批量结束；宿主 GUI（`ChatGPT.exe`、`Cursor.exe`、`Jeff.exe`）与子进程分别核实，只清理本轮启动的资源。
- ASAR 必须逐文件校验（`scripts/verify-asar.mjs`），安装器 SHA-256 不够；清单提交号必须与实际构建源码一致，打包前先提交要交付的源码。

## 开发常用命令

```bash
npm install
npm run dev -w jeff-desktop
```

临时文件与测试脚本放在仓库根目录 `.tmp/`（已 gitignore），不要提交。
