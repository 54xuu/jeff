# Jeff 协作规范（AGENTS.md）

本文件给 Cursor / 人类协作者：改代码、发版、升级本机时的约定。

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

```bash
sudo dpkg -i apps/desktop/release/jeff-desktop_<version>_amd64.deb
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
```

三条全绿才能进入打包。单测红了先修，不许跳过或改断言凑绿。

### 第二层：涉及「聊天 / 流式 / 工具 / MCP / 权限 / 群协作」的改动必跑真实模型 E2E

mock 只覆盖 happy path；流式一致性、权限挂起、MCP 拉起这类跨进程问题只有真 sidecar + 真模型能暴露。做法（v1.7.24 已跑通 8 轮全绿，测试台在 `.tmp/live8/`，可复制改造）：

1. **测试台**：`.tmp/liveN/` 放 `seedN.mjs`（预置 home：provider 用硅基流动 `deepseek-ai/DeepSeek-V3.2` + thinking=high、智能体、项目群、MCP 配置）+ `liveN.spec.ts` + `playwright.config.ts`（timeout 20 分钟、workers=1、serial）。凭据读 `.tmp/e2e.env`，不写进仓库。
2. **驱动方式**：`launchJeff({ home })`（home 已有 jeff.db 不要再传 seed）；回合结束判据 = **先等 `chat-stop` 出现、再等 `chat-send` 回来**（不能只看流式 caret，工具步之间会短暂消失）。
3. **验收判据**：不止看 UI——用 `window.jeff.invoke('chat:history'/'group:history')` 对账落库的 `text/reasoning/tools`；文件类任务断言产物文件内容；配置类任务（小杰代操）断言 DB/kv 真的变了。流式期间所见必须在完成后仍能在落库里找到。
4. **每轮截图**（`page.screenshot` fullPage 到 `evidence/`）+ 数据 JSON 留档，**人工目检截图**（布局、时间戳、暗/亮主题、链接可读性）。
5. 运行：`cd apps/desktop && JEFF_OPENCODE_BIN=<资源目录 opencode> npx playwright test -c ../../.tmp/liveN/playwright.config.ts <spec 绝对路径>`。
6. 常见坑：`pkill -f` 会匹配自身命令行把 shell 杀掉（别在同一条命令里用）；真实模型单轮可达数分钟，超时放够；权限类问题必须读「项目工作树之外、不在 /tmp」的路径才复现得出来。

### 第三层：打包后产物验证

deb：`dpkg -l jeff-desktop` 版本正确 + `/opt/Jeff` 与 `linux-unpacked` 的 app.asar md5 一致；exe：`file` 为 PE32 Nullsoft + `grep -a <本次改动特征串> win-unpacked/resources/app.asar` 命中 + `oc-bin/windows-x64/opencode.exe` 在位。

## 产品心智模型

- **智能体** = 聊天好友（通讯录可配；私聊顶栏「资料」可改）
- **项目群** = 微信群（群资料抽屉可改群名/工作空间/群主/成员；任务看板同抽屉）
- **小杰** = 内置管家，可用 `jeff_agent_*` / `jeff_project_*` 等工具代操配置

## 开发常用命令

```bash
npm install
npm test                    # @jeff/core 单测
npm run typecheck           # 或分别 tsc core / desktop
npm run dev -w jeff-desktop
```

临时文件与测试脚本放在仓库根目录 `.tmp/`（已 gitignore），不要提交。
