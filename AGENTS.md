# Jeff 协作规范（AGENTS.md）

本文件给 Cursor / 人类协作者：改代码、发版、升级本机时的约定。

## 规则文件分层

- **全局通用规则**（开发规范、笔记管理、MySQL 规范、SWR 镜像、输出规则、ZCode 记忆文件管理）：见 `/home/xujian/.agents/AGENTS.md`（唯一权威源，所有工具共用）。ZCode 会话默认加载的 `~/.zcode/AGENTS.md` 仅是指向该文件的指针。
- **本文件**：只保留 jeff 项目特有的规则（版本号、三平台打包、收尾测试、产品心智模型）。
- **UI 与交互**：新增或修改界面前必须阅读 [`docs/ui-interaction-guidelines.md`](docs/ui-interaction-guidelines.md)，按其中的对象归属、状态和验收流程实施；收尾说明需记录布局、状态与真实数据验证结果。
- **领域词汇与决策**：Agent、项目群、执行引擎等术语见 [`CONTEXT.md`](CONTEXT.md)；会影响长期数据边界的决定记录在 [`docs/adr/`](docs/adr/)。

## ZCode 记忆文件

本项目记忆位于 `/home/xujian/.zcode/cli/memories/projects/jeff-1d2f0b1cdfcc2a44/memory/`。格式、索引和维护规则统一遵循 `/home/xujian/.agents/AGENTS.md` 第 6 节。

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

版本号是**用户可见的发版信号**，不是每次改代码的进度条。当前版本线为 `1.12.x`，后续优先慢升。

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

### 每个开发任务的正式交付产物（硬性门槛）

**每个包含代码、测试、资源或产品行为改动的任务，收尾都必须构建三种正式软件：Ubuntu 桌面包、Windows 桌面包、Android release APK。** 这条规则与本次改动属于 desktop、mobile 还是 relay 无关；不能只按改动目录选择产物，也不能用 debug APK 代替正式 APK。只有纯分析、纯文档（包括只改 AGENTS.md）任务不构建软件。未完成测试、版本核对、三种构建及产物校验前，任务不能报告完成。

同一任务的三个产物必须使用同一仓库版本和同一份最终源码。代码改动按本文件 SemVer 规则统一 bump 一次后再构建；纯文档或测试说明不 bump。一个任务内多次提交不重复 bump。

| 目标 | 正式产物 | 构建命令 |
| --- | --- | --- |
| Ubuntu desktop | `.deb` 与 AppImage | `npm run package:linux` |
| Windows desktop | NSIS `.exe` | `npm run package:win` |
| Android app | 用 release keystore 签名的 APK | `cd apps/mobile && npm run cap:sync && cd android && ./gradlew --no-daemon assembleRelease` |

APK 正式产物为 `apps/mobile/android/release/jeff-<version>.apk`。release keystore 在 `~/.jeff-android/release.keystore`，别名 `jeff`；口令从 ZCode 记忆 `android-release-keystore.md` 读取，通过环境变量传给 Gradle。禁止把口令写入仓库、命令记录或回复。APK 版本必须与仓库版本一致，`versionCode = major * 10000 + minor * 100 + patch`。Android SDK 工具使用 `~/Android/Sdk/build-tools/35.0.1/` 下的版本，避免 PATH 指向旧版。

```bash
npm run package:linux   # → apps/desktop/release/jeff-desktop_<version>_amd64.deb（另出 Jeff-<version>.AppImage）
npm run package:win     # → apps/desktop/release/jeff-Setup-<version>.exe
```

两条 desktop 命令各自会先跑 `electron-vite build`，不需要单独 build。先完成测试，再按上文规则 bump 版本并构建全部三种正式产物；禁止只打当前改动涉及的平台。

装本机验证（Linux 侧）：

本机 `sudo` **没有免密**。密码在 ZCode 记忆
`/home/xujian/.zcode/cli/memories/projects/jeff-1d2f0b1cdfcc2a44/memory/sudo-password.md`
（用户要求永久记住）。Agent 必须先读该文件，再用 `sudo -S` 从 stdin 传入，**禁止**把密码写进仓库或回复用户；也不要裸跑交互式 `sudo`（Cursor 没有 TTY，会卡在密码提示）。

```bash
# 从 sudo-password.md 取出密码后：
printf '%s\n' "$PASS" | sudo -S dpkg -i apps/desktop/release/jeff-desktop_<version>_amd64.deb
dpkg -l jeff-desktop                        # 应显示新版本号
md5sum /opt/Jeff/resources/app.asar apps/desktop/release/linux-unpacked/resources/app.asar
# 两者 md5 一致，才说明装上去的确实是刚打的包（不是残留旧版）
# 然后退出并重新打开 Jeff，在「设置 → 关于」确认版本号
```

### 本机打 Windows 安装包（无需 GitHub Actions）

本项目没有原生 Node 模块，Windows 版 `opencode.exe` 由 `scripts/fetch-opencode.mjs` 下载官方预编译二进制（本地已缓存），因此在 Ubuntu 上打 NSIS 安装包的唯一前置是 **wine**（electron-builder 在 Linux 上用它修改 PE 资源）：

```bash
sudo apt install -y wine wine32:i386   # 仅首次需要；如索引过期先 apt-get update
npm run package:win
# 产物：apps/desktop/release/jeff-Setup-<version>.exe
```

**验收以「产物级校验」为准**（`wine` 向导弹窗冒烟自 2026-09-10 起在本机不可用，见下）：

```bash
file apps/desktop/release/jeff-Setup-<version>.exe            # 应为 PE32 executable (GUI) ... Nullsoft Installer
grep -a extra-preview apps/desktop/release/win-unpacked/resources/app.asar   # 能命中＝本次前端改动已打进包
ls apps/desktop/release/win-unpacked/resources/oc-bin/windows-x64/opencode.exe
node scripts/verify-asar.mjs apps/desktop/release/win-unpacked/resources/app.asar
```

**ASAR 必须逐文件校验，外层安装包 SHA-256 和 `asar list` 通过都不够。** `npm run package:win` 与 `npm run package:linux` 已在打包后自动运行 `scripts/verify-asar.mjs`，校验目录记录的每个文件大小、SHA-256、边界以及根目录 `package.json` 的版本和入口；任一失败就停止交付。2026-10-08 Windows 1.12.0 事故中，单个 workspace 文件实际短 13 字节，后续 13,663 个条目的 offset 整体错位，13,802 个条目中有 13,646 个哈希不匹配，`package.json` 也无法解析；安装器本身和整体产物哈希仍然正常。此类失败时禁止安装或分发该包、禁止直接改写已生成的 ASAR 后当作正式产物；保留坏包并追查构建/归档阶段，从确认过且构建期间不变的源码重建，复验归档、安装器内部文件和实际安装版。若损坏的引入原因尚未查明，明确记录；经完整校验和实际安装验收通过的重建包可以交付，不得把猜测写成根因。重装同一个损坏安装包会覆盖本机修复。部署清单里的提交号必须与实际构建源码提交一致。

⚠️ **不要再用「`wine` 弹出 Jeff Setup 向导」当验收门**：本机 wine 6.0.3 下安装包会直接以退出码 1 结束、不弹窗、也不在 prefix 留痕；历史版本（`jeff-Setup-1.7.17/1.7.18.exe`）同样如此，属**本机 wine 状态问题而非包的问题**。注意包是 **32 位 PE**（NSIS 自解压），必须用 `wine` 而不是 `wine64`（`wine64` 必退出码 1，容易误判成包坏了）。Windows 包最终以**在 Windows 机器上真装一次**为准。

推送 `v*` tag 会触发 GitHub Actions 构建 Windows / Linux 安装包并发布到 Releases。Tag 应与三处 `package.json` 版本一致（如 `v1.7.1`）。

## 任务收尾测试（硬性约定）

**每个任务完成、打包发版之前，必须先跑测试证明改动是正确的**，不许「改完就打包」。按改动类型分层，上层必跑、下层按需：

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

### 第二层：涉及「聊天 / 流式 / 工具 / MCP / 权限 / 群协作」的改动必跑真实模型 E2E

mock 只覆盖 happy path；流式一致性、权限挂起、MCP 拉起这类跨进程问题只有真 sidecar + 真模型能暴露。做法（v1.7.24 已跑通 8 轮全绿，测试台在 `.tmp/live8/`，可复制改造）：

1. **测试台**：`.tmp/liveN/` 放 `seedN.mjs`（预置 home：provider 用硅基流动 `deepseek-ai/DeepSeek-V3.2` + thinking=high、智能体、项目群、MCP 配置）+ `liveN.spec.ts` + `playwright.config.ts`（timeout 20 分钟、workers=1、serial）。凭据读 `.tmp/e2e.env`，不写进仓库。
2. **驱动方式**：`launchJeff({ home })`（home 已有 jeff.db 不要再传 seed）；回合结束判据 = **先等 `chat-stop` 出现、再等 `chat-send` 回来**（不能只看流式 caret，工具步之间会短暂消失）。
3. **验收判据**：不止看 UI——用 `window.jeff.invoke('chat:history'/'group:history')` 对账落库的 `text/reasoning/tools`；文件类任务断言产物文件内容；配置类任务（小杰代操）断言 DB/kv 真的变了。流式期间所见必须在完成后仍能在落库里找到。
4. **每轮截图**（`page.screenshot` fullPage 到 `evidence/`）+ 数据 JSON 留档，**人工目检截图**（布局、时间戳、暗/亮主题、链接可读性）。
5. 运行：`cd apps/desktop && JEFF_OPENCODE_BIN=<资源目录 opencode> npx playwright test -c ../../.tmp/liveN/playwright.config.ts <spec 绝对路径>`。
6. 常见坑：`pkill -f` 会匹配自身命令行把 shell 杀掉（别在同一条命令里用）；真实模型单轮可达数分钟，超时放够；权限类问题必须读「项目工作树之外、不在 /tmp」的路径才复现得出来。
7. **工具参数形状要拿真模型验**（v1.8.2 血泪）：把某个工具参数声明成裸 `type:'object'` 时，模型侧会把整个对象丢成空串——插件就落成「没有 MCP、没有附带文件」的半成品，而模型还会在回复里言之凿凿地说配置好了。给模型的参数**只用标量 / 标量数组**（或数组里包对象，那个是好的），**嵌套对象一律拆成平铺字段**（如 `mcp_url` / `mcp_command` / `mcp_headers`），并在实现里对空串做「视为未传」的兜底，否则模型一次「全字段补空」的 update 就能把已配好的字段抹掉。
8. **agent 用哪条路完成任务，只有真模型能告诉你**：同一次 R7 里，模型先调 `jeff_plugin_*`，参数没进去之后**自己改用 `bash`/`edit`/`write` 直接改磁盘上的 `plugin.json`**——虽然结果碰巧对了，但这既绕过了工具语义，也说明「管家不该有文件工具」这条指令当时是句空话。发现这类「绕路」要当成产品 bug 修（改工具形状 + 真禁掉不该有的工具），而不是把断言改松。
9. **日志是最好的证据**：`<home>/logs/debug-<date>.log` 里 `tool-pending` / `tool-start` / `tool-done` 三行带完整 `args` 与 `output`，能直接看出「模型到底传了什么」。断言失败时先看它，别猜。
10. **没有模型也能覆盖真链路**（v1.8.3 新增）：`<home>/oc-home/config/opencode/plugin/jeff-bridge.js` 里有工具桥的 `BASE` 与 `TOKEN`，测试进程直接 `POST /tools/<name>` 就是「真工具 + 真跨进程 + 真落库」——v18 封闭套件用它覆盖了定时任务边界、插件校验、浏览器点击/填表/上传/错误分析。定时任务到点、插件 MCP 注入这类**时间与引擎**相关的能力仍必须真模型跑。
11. **验收要落在服务端事实**：表单断言**服务端收到的字段**、上传断言**服务端收到的字节**、插件断言 **MCP 服务端收到的调用与请求头**、定时任务断言 **DB 运行记录**。只看 DOM 或模型回复会漏掉「说成功了其实没落地」。
12. **「测试没通过」先分清是谁的锅**：v1.8.3 的 27 轮里，初版失败的 8 轮有 5 轮是**测试台自己的假设错了**（按旧标题查库、把 `plugin.json` 当越权靶子——它其实是 `jeff_plugin_update` 的正当对象、误判「软删要顺手改 enabled」、跨轮复用 home 导致旧 URL 残留）。改测试断言前先问一句：这是产品语义错了，还是我的预期错了？

### 第三层：打包后产物验证

deb：`dpkg -l jeff-desktop` 版本正确 + `/opt/Jeff` 与 `linux-unpacked` 的 app.asar md5 一致；exe：`file` 为 PE32 Nullsoft + `grep -a <本次改动特征串> win-unpacked/resources/app.asar` 命中 + `oc-bin/windows-x64/opencode.exe` 在位。

## 产品心智模型

- **三栏布局** = 左「会话列表」/ 中「对话区」/ 右「内置浏览器」；左右两栏可拖拽改宽、可各自收起（hover 分栏线才浮出箭头按钮，双击分隔条恢复默认，`Ctrl/Cmd+B` 开关会话列表）。尺寸规则集中在 `apps/desktop/src/renderer/src/layout/panes.ts`：store 里存的是**用户偏好宽度**，渲染时按当前窗口夹成生效宽度——窗口临时变小只把栏挤窄，偏好值不被覆盖
- **智能体（Agent）** = 可独立对话的个人角色。个人 Prompt 只写跨场景稳定的人设、能力与风格；技能提供可加载的专业方法。个人引擎、模型和思考程度是默认配置。每个 Agent 均可选择所有受支持引擎并使用 Jeff 工具，不按 builtin、姓名或通讯录分类禁用工具。`jeff_self_update` 只修改真实调用者自身，写前校验 `instructions_version`，自动快照到 `~/.jeff/backups/agent-instructions/` 并可 revert。
- **项目群** = 微信群。群规则是该群的 System Prompt；群主、成员分工只在该群有效。每个群成员关系可以覆盖模型和思考程度，未覆盖时继承 Agent 个人默认；执行引擎仍由 Agent 个人选择。同一个 Agent 在不同群可有不同职责，私聊不注入群身份。群资料抽屉管理规则、群主、成员职责和逐成员配置；任务看板同抽屉。
- **执行引擎** = Agent 每轮运行所用 CLI/runtime。设置 → 执行引擎使用同一个下拉查看当前引擎；选项包含 OpenCode（Jeff）、检测到的 OpenCode（系统）和本机检测到且协议兼容的外部 CLI。模型提供商编辑只显示在 OpenCode（Jeff）详情内。OpenCode（系统）沿用系统模型连接和认证；运行时数据、Agent、群上下文、技能与 MCP 由 Jeff 隔离注入。
- **小杰** = 内置管家 Agent，擅长 Jeff 配置与使用指导；所有 Agent 均可使用相同工具。修改配置优先走结构化工具。小杰默认 Prompt 采用版本化初始化并保留用户修改，不得在每次启动时用常量覆盖数据库内容。
- **技能（skill）** = 一份 `SKILL.md`（+ 自带脚本），模型看到的技能**只从 `~/.agents/skills` 读**（应用自带的 `jeff-usage` 也写在那儿）；`opencode.json` 的 `skills.paths` 负责挂载、sidecar 的 `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` 负责挡掉 `~/.claude/skills` 等外部目录，两条缺一不可。见 `docs/skills.md`
- **定时任务** = 到点自动向某个私聊/项目群发消息（如护士长 8 点在群里问病区动态、订阅 AI 资讯早报），任意 Agent 可按工具定义创建。每个任务一条独立会话（私聊独立 OpenCode session，群聊独立话题），与用户手打、与其它任务互不影响；同一任务反复触发复用自己那条。见 `docs/schedules.md`
- **插件** = 「必须用但不通用」的能力打包（智慧病房等）：启用即自动接入其 MCP（免手工配 MCP）+ **每插件一条**英文/拼音 `/` 快捷指令（**跨插件全局唯一**，靠 prompt 描述功能分流；显示名用中文）+ 首页用内置浏览器打开（`homepage` 写在清单里）+ **按内容设计扁平 `icon.svg`**（emoji 仅退化）。所有 Agent 都能使用 `jeff_plugin_*` 创建和维护插件；新插件默认停用，启动本地命令前由用户在插件页确认。见 `docs/plugins.md`，样例在 `examples/plugins/`
- **内置浏览器** = 界面右侧独立面板（webview），人与 agent 操作同一个页面；agent 用 `jeff_browser_*` 工具（查看 / **读错误现场** / 点击 / **填表（含下拉框）** / **上传本机文件** / **设分辨率（4:3 或精确像素，如 1697x1063）** / 截图（含 `full_page="true"` 整页））。错误采集有两条来源：渲染层 `console-message`（Console API + 未捕获异常）与主进程该面板分区的 `webRequest`（子资源 404 / 网络失败——那类**不走** `console-message`）。截图有硬契约：**视口截图尺寸精确等于视口**（CSS 像素，跨 DPR 一致）、整页 = 视口宽 × 文档高；**截图范围不能超过 Jeff 窗口**（超过那一档 Chromium 会裁/平铺表面，工具会明确拒绝而不是给歪图），且页面截图走主进程 CDP（`capturePage` 只回已呈现的那一帧，尺寸内容都不可控）。见 `docs/built-in-browser.md`
- **工具参数的硬规矩**（被真模型咬过两次）：① 给模型的参数只用标量 / 标量数组，嵌套对象一律拆成平铺字段（`mcp_url` / `mcp_headers`…）；② 凡是 update 类工具，「没传到 / 传空串」一律当**未提供**（`'' !== undefined`，否则模型一次「全字段补空」就会静默清空名字、把任务停用）；③ 实现支持的字段**必须**在 `allToolDefs()` 里声明，否则模型永远传不进来（v1.8.3 的 `category` 就是这么漏的）。回归单测：`packages/core/tests/tool-args.test.ts`、`cron-plugin.test.ts`

## 备份与恢复入口（硬性约定）

**所有备份与恢复入口统一放「设置 → 同步」页，功能页只做功能本身。**

**能不能配独立入口，看数据是不是「目录型」，不是看它重不重要：**

- **目录型数据**（`~/.agents/skills`、`~/.jeff/plugins`：文件多、整目录推 WebDAV 慢）→ 才配独立的「立即备份 / 从备份恢复」（整目录镜像 + 版本归档 + 恢复前本地快照 + 两步确认）。放进每次同步会把同步拖成分钟级，体验不可接受。
- **结构化配置数据**（智能体 / 项目群 / 任务 / **定时任务定义** / 设置含 MCP：一条记录几行 JSON）→ **只走「立即同步」的双向合并，不设独立备份入口**。定时任务曾有一块独立的「立即备份 / 从备份恢复」（v1.8.1 加的），2026-09-15 已移除：它和同步写的是同一份 `<base>/cron_tasks.json`（`packages/core/src/sync/engine.ts` 的 `pushToRemote`），**构不成独立恢复点**（没有版本历史，回滚不了已经同步掉的改动），还多一个写者和一处要维护的 UI。定义与运行历史的分工：定义随同步走，`cron_run` 属本机日志，不同步也不备份。
- 现状：`Skills 目录`、`插件目录` 两块有独立按钮，在 `apps/desktop/src/renderer/src/components/settings/SyncSettings.tsx`（参考写法用 `PluginsBackup`）；定时任务随同步走，回归在 `packages/core/tests/cron-sync.test.ts`（覆盖 LWW、软删墓碑传播、`next_run_at` 按本机重算、运行历史不搬）。
- 新增任何可备份的数据类别时，**先判断是不是目录型**：是 → 在设置页加区块；不是 → 塞进同步 payload，**不要**加备份区块。任何情况下都**不要**在功能页（插件页、定时页等）放备份/恢复按钮——功能页最多放一个跳转到设置页的入口。
- 恢复类操作必须：先本地快照（`~/.jeff/backups/`）再替换、二次确认弹窗说明影响面、按钮旁展示「上次备份」时间与结果。
- 敏感值（WebDAV 密码、插件密钥等）一律不进备份。

## Android 遥控器

方案全文在 [`docs/notes/20260927-Android遥控器方案.md`](docs/notes/20260927-Android遥控器方案.md)。这里只留协作时会踩的约定。

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

## 双机自动部署与验收

- 从 Ubuntu 开发机使用 `npm run deploy:windows -- --target win11 --android auto --suite <具名测试集>`；测试集必须存在于 `deploy/suites/`，不能以缺少测试集的部署冒充验收。
- Android 验收固定顺序：先在 Ubuntu `jeff` AVD 对本次 APK 跑 instrumentation；通过后，Windows 端优先指定 USB serial，其次连接 `192.168.3.121:5555`。`auto` 下真机不可用时结果只能写“模拟器通过，真机待验收”；真机途中失败须留证并重跑/报告，不能覆盖失败原因。
- 部署脚本不自动改版本。代码改动按本文件 SemVer 规则在该任务结束阶段统一 bump 一次，再构建 Ubuntu 与 Windows 安装包及签名 APK。
- Windows 首次配置见 `deploy/windows/README.md`。密钥、relay 地址和手机 serial 只保存在忽略的 `.tmp/deploy/config.json` 或本机；不得提交凭据。
- 远程验收必须从 Windows 实际安装目录启动 Jeff，使用隔离数据目录；产物 SHA-256、安装结果、截图与测试日志回传至 `.tmp/deploy/<运行编号>/`。Windows 不可达时仅报告已完成的 Ubuntu/本地产物验收，不得声称双机验收通过。

### 从 Ubuntu 调试 Windows（已实测，默认不使用 Windows Codex）

- **默认通道**：Ubuntu `192.168.3.176` → OpenSSH/SFTP → Windows `192.168.3.143`。由 Ubuntu Agent 编排，Windows 执行 PowerShell、安装器、界面运行器及 SDK ADB；不需要唤起 Windows ChatGPT/Codex。只有用户明确要求或 SSH 通道无法满足任务时才考虑 Windows Agent。
- SSH 使用专用密钥、已核对的主机指纹和 `BatchMode=yes`；本机 SSH config / known_hosts 放忽略目录 `.tmp/deploy/`，不得关闭 `StrictHostKeyChecking`。登录用户名、路径、ADB 版本须从实际 Windows 状态发现，不能假设工作区已有源码。
- 命令通过 `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand <UTF-16LE base64>` 执行，设置 UTF-8 输出；分别保存 stdout、stderr、退出码。不要把口令/模型凭据放进命令、日志或报告。Windows 绝对 SFTP 路径用 `/C:/Users/...` 格式；上传后在 Windows 重新核对 SHA-256。
- **进程保护**：区分宿主 GUI（`ChatGPT.exe`、`Cursor.exe`、`Jeff.exe`）与其子 CLI/工作进程（如 `codex.exe`、`cursor-agent.exe`、`opencode.exe`）。结束某个子进程的授权不等于关闭宿主；宿主可能自动重启子进程。结束任何进程前先核实可执行路径、PID、父 PID、启动时间、所属会话/任务、数据目录及是否有活跃工作；禁止按进程名批量 `Stop-Process` / `taskkill /IM` 或结束整个进程树来省事。用户宿主进程和活跃任务默认保留，关闭 GUI 宿主须有针对该宿主的明确授权。进程保持打开通常只会继续占用内存、CPU、文件、端口或锁；活跃流和工具任务会继续运行，关闭时则可能中断回复、工具调用或未保存内容。收尾只清理本轮启动且逐项核实归属的进程、临时任务和端口转发。
- **PowerShell 变量**：不要把 `$HOME` 等内置变量名当普通变量覆写；用 `$jeffDataHome` 这类具体名称。交互式 GUI 必须从已登录用户的 `Interactive` 任务启动；任务已注册或 SSH 命令退出码为 0 都不等于应用启动成功，需核对落盘结果文件、实际 PID、页面和数据目录。
- **安装**：从注册表和实际进程发现安装目录及 per-user/all-users 范围；活跃任务时暂停部署。先正常退出 Jeff、在 Windows 本机保存日常数据快照，再用 NSIS `/S` 静默升级，沿用安装范围及目录（`/D=...` 参数最后传入）。需提权时使用已建立的安装任务或已授权的管理员 SSH 会话；普通 GUI 任务不提权。核对实际 EXE 版本、已安装 `app.asar` 哈希和内置 opencode，不能用安装器退出码单独判成功。
- **GUI**：Windows 必须保持用户登录；SSHD 会话不能直接代替交互桌面。注册当前登录用户、`Interactive` / `Limited` 的验收计划任务，启动**实际安装目录**的 `Jeff.exe`。使用独立 `JEFF_HOME`、`JEFF_SKILLS_DIR`、Electron `--user-data-dir`、`JEFF_E2E=1`；需要中转站时显式提供真实 `JEFF_RELAY_URL`，不要改日常绑定或数据。
- GUI 调试端口仅监听 Windows `127.0.0.1`，通过 `ssh -L 127.0.0.1:<local>:127.0.0.1:<remote>` 转发给 Ubuntu。Ubuntu 用 agent-browser / 现有 Playwright CDP 运行器操作界面、截图、执行具名断言；确认页面来自安装目录 `app.asar`，不能验收开发网页后声称安装版通过。
- **Android**：先 Ubuntu AVD，再 Windows USB，最后网络设备 `192.168.3.121:5555`。Windows 端显式使用 SDK `platform-tools/adb.exe`（本机已发现为 `D:\soft\android\sdk\platform-tools\adb.exe`，不要依赖 PATH 的旧 scrcpy ADB）。`adb connect` 后每个命令都带 `-s <serial>`；执行同一 release APK 的 `install -r`、版本/签名核对、instrumentation、截图和日志采集。
- Android 白屏可通过指定设备 `adb forward tcp:<port> localabstract:webview_devtools_remote_<appPid>`，再经 SSH 转发该端口，在实际 APK 的 WebView CDP 中定位 JS/资源错误。端口及进程必须从当前状态确认，不复用过期 PID。
- **成功判据与清理**：instrumentation 必须有明确的全部用例通过证据，不能把 `adb` / SSH 退出码 0 当功能通过。原始失败证据保留；验收后核对日常数据库/配置哈希，仅清理本轮启动的实例、模拟器、临时计划任务和端口转发，保留升级后的软件。证据回传 `.tmp/deploy/<运行编号>/`；区分“安装成功”“界面冒烟通过”“真实模型链路通过”，未验证项不能扩大宣称。

- **旧 WebView 回归**：不得用主界面渲染成功代替真实回复渲染成功。移动端加密兼容须对齐桌面/Kotlin 向量，并验证真实加密配对、模型回复及两端文本落库；GFM/Markdown 必须保留链接、表格和代码能力。先跑 `MobileInstallSmokeTest`，再对已经绑定且有真实回复的隔离实例运行 `MobileMessageCompatibilityTest`，通过 instrumentation 的 `agentName` / `replyMarker` 参数指定具名测试数据。缺少真实数据必须失败，不用假消息替代。首次系统授权弹窗应正常授予并记录，保留被弹窗阻挡的原始失败证据后重跑完整用例。

### 三平台一次交付与 Windows 故障闭环（2026-10-08 复盘）

**开发任务由当前 Agent 负责完成 Ubuntu、Windows、Android 的构建、安装排障和验收，并在同一份最终答复中给出三平台结论。** 安装失败是任务内待解决的问题：修复后继续安装和验收，不能把可自行处理的打包、路径、权限任务配置、脚本或启动错误交给用户手动重装、另开 Windows ChatGPT 分析。已有安装授权沿用；正常退出空闲实例、备份、修复部署脚本和重跑验收无需重复询问。日常实例有活跃聊天时保护任务，不强杀。

**尽早预检，避免到最后才发现环境阻碍。** 开始开发时检查 Windows SSH、已核对的主机指纹、当前交互用户/会话及锁屏状态、安装位置/范围、安装任务的提权权限、GUI 任务的 Interactive/Limited 身份、磁盘空间、Node/SDK ADB 路径，以及 Android AVD/真机和相关 CLI 登录状态。SSH 可达、Jeff 进程为空或任务计划程序接受启动请求，都不能证明桌面可交互。锁屏/未登录需用户处理时尽早说明，同时继续不依赖交互桌面的工作；不能自行解锁或索取系统口令。

本次问题与下次处理方式：

| 本次暴露的问题与相关风险 | 必须执行的防错与排障步骤 |
| --- | --- |
| Windows 安装器文件一致、退出码正常，应用却立即退出；包内 ASAR 的 size/offset 与数据不一致 | 发布前校验 unpacked ASAR，再解出 NSIS 内部归档复验并核对哈希；安装后再核对真实安装文件。重复安装同一坏包无效，应保留证据、重建完整安装包。 |
| 只报 `Installed Jeff did not expose its test endpoint`，无法区分启动失败与运行器问题 | 记录实际 EXE 路径、启动参数、PID、存活/退出码、stdout/stderr、应用日志及可用的 Windows Application 事件；先查包和入口，再查启动、页面及 sidecar。进程已退出就立即诊断，不耗尽端口超时后结束任务。空日志本身不能排除故障。 |
| 将 PowerShell 放进 Bash 双引号，`$env:USERPROFILE` 被 Bash 展开成 `:USERPROFILE`；Python 普通字符串把 Windows 路径中的 `\r` 等当成转义 | PowerShell 写入 `.tmp/*.ps1`，由固定包装器读取文件、编码 UTF-16LE base64 后传给 `-EncodedCommand`。本地生成脚本用带引号的 heredoc；Python 必须内嵌脚本时用原始字符串。避免层层拼接 Bash/Python/PowerShell 引号和路径。 |
| 把 `$HOME` 当普通 PowerShell 变量覆写，脚本在执行主体前失败；把 CLI 子进程当成独立 GUI 宿主，误关宿主会打断开发且宿主还可能重启子进程 | PowerShell 脚本对内置变量改用具体名称；按本节逐 PID 核对路径、父子关系、会话和活跃任务。只清理本轮明确启动的实例，禁止进程名/整树批量终止；宿主关闭必须单独确认。 |
| PowerShell CLIXML/进度输出与 JSON 混在一起、中文变乱码；直接序列化 `Get-Content -Raw` 导致附加 PS 元数据大量输出 | 设置 `$ProgressPreference='SilentlyContinue'`、`$ErrorActionPreference='Stop'` 和 `[Console]::OutputEncoding=[Text.UTF8Encoding]::new()`；结构化结果写 UTF-8 JSON 文件，经 SFTP 拉取解析。序列化文件正文前转 `[string]`，查询只选所需字段，分别保存 stdout、stderr、退出码。旧日志乱码先查原始文件，不推断测试结果。 |
| SSH 会话与交互桌面不同；旧端口/PID/任务、页面未就绪会干扰判断 | 使用当前交互用户的 GUI 计划任务与隔离目录；每轮重新发现进程和端口，等待页面出现并确认 URL 来自真实安装目录的 `app.asar`，再运行断言。监测安装器/运行器进程和结果文件，区分任务已受理、安装完成与界面通过。 |
| 文档提交号与 manifest 不一致；同版本重建后安装器 SHA-256 变化 | 构建输入冻结，构建过程中不改源码、不替换归档内文件、不让多个任务共用并覆盖 release/current/结果目录。manifest 记录实际构建提交、版本、每个产物大小和 SHA-256；重建后更新哈希，已变更产物须重新安装核对。引用历史验收必须确认产物哈希、测试范围及环境仍适用，注明原运行编号。 |
| Android 主界面可见，真实回复却在旧 WebView 白屏 | 用同一签名 release APK 按 AVD → Windows USB/网络真机顺序验收；真实回复、加密绑定和文本落库单独验证。主界面 smoke 通过不能覆盖真实回复失败。 |

**安装与验收按阶段收集事实并闭环：** 本机归档/安装器校验 → 上传与远端 SHA-256 → 正常退出及本机数据快照 → NSIS 原范围/原目录安装 → 注册信息、EXE 版本、安装 ASAR/内置 OpenCode → 隔离实例实际窗口/页面及 sidecar → 本次具名功能测试及按需真实模型/手机链路 → 日常数据核对与本轮资源清理。失败时保留原始证据，定位并修复所属阶段，从受影响阶段重新验证；代码修复则按前文重跑相关回归和三平台正式构建。人工临时修复 ASAR 只能用于诊断/本机恢复，交付必须重新生成完整安装包；启用 Electron EXE 嵌入式 ASAR 校验时，由打包器同步生成匹配的 EXE 和归档。

首次 GUI 验收同时检查首页、版本和本次功能入口；`smoke` 仅证明安装启动，不能代替本次具名功能测试。命令结束后核对日常数据库/配置与本机快照；关闭数据库时可比字节哈希，运行中有正常写入则使用 SQLite 只读完整性检查与预期记录核对，不能把正常写入误报成数据损坏。敏感备份留 Windows 本机，回传验收日志与非敏感证据。

**仅外部环境确实无法自行恢复时允许留待验收：** 例如电脑离线、用户未登录/锁屏、缺少可用管理员授权、设备未连接/未授权、CLI 缺登录或订阅。先尝试已授权的可恢复措施，记录具体错误和环境事实，继续完成另外两平台及本平台可执行的检查，再准确报告所需的最小用户操作。不能把产物损坏、调试脚本错误、可修复的安装失败或尚未定位的超时直接归为环境问题。

最终答复和总结文档必须同时列出以下三行；每个平台写明“通过/失败/未验证”、测试范围、用例结果、产物路径/SHA-256 和证据位置，不得用“打包成功”替代安装或功能结论：

| 平台 | 必须报告的结论范围 |
| --- | --- |
| Ubuntu | `.deb`/AppImage 产物校验、实际安装版本/ASAR、界面与本次功能，以及相关真实模型链路。 |
| Windows | NSIS 与内部 ASAR 校验、实际安装目录/版本/哈希、界面与本次具名功能；真实模型链路按实际验证范围单列。 |
| Android | release APK 版本/签名、AVD instrumentation，以及 Windows USB/网络真机与相关真实回复验收；真机缺席明确写“模拟器通过，真机待验收”。 |

本次事故和最终安装证据见 [`docs/summary/20261007/Jeff多执行引擎支持.md`](docs/summary/20261007/Jeff多执行引擎支持.md)。上述三平台构建验收门槛适用于开发交付；仅修改文档/AGENTS.md 不升版、不重打包。

## 开发常用命令

```bash
npm install
npm run dev -w jeff-desktop
```

临时文件与测试脚本放在仓库根目录 `.tmp/`（已 gitignore），不要提交。
