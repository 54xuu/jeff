# Jeff 协作规范（AGENTS.md）

本文件给 Cursor / 人类协作者：改代码、发版、升级本机时的约定。

## 规则文件分层

- **全局通用规则**（开发规范、笔记管理、MySQL 规范、SWR 镜像、输出规则、ZCode 记忆文件管理）：见 `/home/xujian/.agents/AGENTS.md`（唯一权威源，所有工具共用）。ZCode 会话默认加载的 `~/.zcode/AGENTS.md` 仅是指向该文件的指针。
- **本文件**：只保留 jeff 项目特有的规则（版本号、双平台打包、收尾测试、产品心智模型）。

## ZCode 记忆文件

ZCode 在本仓库的持久记忆存放在：

```
/home/xujian/.zcode/cli/memories/projects/jeff-1d2f0b1cdfcc2a44/memory/
```

`MEMORY.md` 是索引，其余每 `.md` 文件一条事实（frontmatter 含 `name` / `description` / `metadata.type`）。其他工具可直接读写实现跨工具共享；格式与写入规则详见 `/home/xujian/.agents/AGENTS.md` 第 6 节。

## 版本号（SemVer）

仓库当前版本必须**五处一致**（`packages/core/tests/version.test.ts` 会在单测里强制校验，防漂移）：

- 根目录 [`package.json`](package.json)
- [`packages/core/package.json`](packages/core/package.json)
- [`apps/desktop/package.json`](apps/desktop/package.json)
- [`package-lock.json`](package-lock.json) 里的 `version` 字段（4 处）
- [`packages/core/src/version.ts`](packages/core/src/version.ts) 的 `APP_VERSION`

### 核心原则：默认 PATCH，MINOR 要克制

版本号是**用户可见的发版信号**，不是每次改代码的进度条。近期已到 `1.7.0`，后续优先慢升。

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

### 每次任务收尾：bump + 双平台编译（硬性约定）

**每个任务完成后都要产出 Windows 与 Ubuntu 两个安装包**，不需要用户另行提醒。只交代码、或只打一个平台，都算没做完。

```bash
npm run package:linux   # → apps/desktop/release/jeff-desktop_<version>_amd64.deb（另出 Jeff-<version>.AppImage）
npm run package:win     # → apps/desktop/release/jeff-Setup-<version>.exe
```

两条命令各自会先跑 `electron-vite build`，不需要单独 build。**编译前先按上文规则 bump 版本**（否则装出来的版本号不变，无法确认装的是新包）；同一会话 / 同一发版意图**只 bump 一次**，不要在每个小提交途中反复改版本号，而是在任务收尾时一次 bump 完再打两个包。

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
```

⚠️ **不要再用「`wine` 弹出 Jeff Setup 向导」当验收门**：本机 wine 6.0.3 下安装包会直接以退出码 1 结束、不弹窗、也不在 prefix 留痕；历史版本（`jeff-Setup-1.7.17/1.7.18.exe`）同样如此，属**本机 wine 状态问题而非包的问题**。注意包是 **32 位 PE**（NSIS 自解压），必须用 `wine` 而不是 `wine64`（`wine64` 必退出码 1，容易误判成包坏了）。Windows 包最终以**在 Windows 机器上真装一次**为准。

推送 `v*` tag 会触发 GitHub Actions 构建 Windows / Linux 安装包并发布到 Releases。Tag 应与三处 `package.json` 版本一致（如 `v1.7.1`）。

## 任务收尾测试（硬性约定）

**每个任务完成、打包发版之前，必须先跑测试证明改动是正确的**，不许「改完就打包」。按改动类型分层，上层必跑、下层按需：

### 第一层：所有任务必跑（快速回归）

```bash
npm test                    # @jeff/core 单测（含版本一致性校验，bump 后跑可防漂移）
npm run typecheck           # core/desktop 包级 tsc；根 tsconfig 有 3 个存量 e2e helper 报错，改动前就在，不算新增
cd apps/desktop && npm run test:e2e   # mock UI E2E（自带 build）
# 新增功能块的封闭 UI 测试（无需模型）：分组 / 定时任务 / 插件 / `/` 指令 / 内置浏览器
cd apps/desktop && npx playwright test -c e2e/playwright.config.ts --project=v18
```

三条全绿才能进入打包。单测红了先修，不许跳过或改断言凑绿。

> `--project=v18`（`apps/desktop/e2e/v18.spec.ts`）是 v1.8.0 五大功能的封闭测试，用 `testAgent: true` 的 seed home；
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
- **智能体** = 聊天好友（通讯录与聊天列表都按「分组分类」折叠归类；私聊顶栏「资料」可改）
- **项目群** = 微信群（群资料抽屉可改群名/工作空间/群主/成员；任务看板同抽屉）
- **小杰** = 内置管家，可用 `jeff_agent_*` / `jeff_project_*` / `jeff_cron_*` / `jeff_plugin_*`（含插件开发）等工具代操配置；它**没有**文件与命令工具（`bash`/`edit`/`write`/`patch`，**以及 `task`** 在它的 agent 定义里被禁用——`task` 也禁是因为子代理带全套工具，不禁就等于把前四个全绕过去），插件只能经 `jeff_plugin_*` 结构化落盘
- **技能（skill）** = 一份 `SKILL.md`（+ 自带脚本），模型看到的技能**只从 `~/.agents/skills` 读**（应用自带的 `jeff-usage` 也写在那儿）；`opencode.json` 的 `skills.paths` 负责挂载、sidecar 的 `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` 负责挡掉 `~/.claude/skills` 等外部目录，两条缺一不可。见 `docs/skills.md`
- **定时任务** = 到点自动向某个私聊/项目群发消息（如护士长 8 点在群里问病区动态、订阅 AI 资讯早报），**小杰对话即可创建**。见 `docs/schedules.md`
- **插件** = 「必须用但不通用」的能力打包（智慧病房等）：启用即自动接入其 MCP（免手工配 MCP）+ **每插件一条**英文/拼音 `/` 快捷指令（**跨插件全局唯一**，靠 prompt 描述功能分流；显示名用中文）+ 首页用内置浏览器打开（`homepage` 写在清单里）+ **按内容设计扁平 `icon.svg`**（emoji 仅退化）。**小杰对话即可开发**（建好默认停用，你确认后再启用；带本地命令的插件只能人工在插件页启用）。见 `docs/plugins.md`，样例在 `examples/plugins/`
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

## 开发常用命令

```bash
npm install
npm test                    # @jeff/core 单测
npm run typecheck           # 或分别 tsc core / desktop
npm run dev -w jeff-desktop
```

临时文件与测试脚本放在仓库根目录 `.tmp/`（已 gitignore），不要提交。
