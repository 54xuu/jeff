# 双机自动部署、Windows 调试与验收

本文件由 [`AGENTS.md`](../../AGENTS.md) 拆出，含 Ubuntu → Windows 调试通道、三平台一次交付与 Windows 故障闭环、文件链接验收补记。

# 双机自动部署与验收

- 从 Ubuntu 开发机使用 `npm run deploy:windows -- --target win11 --android auto --suite <具名测试集>`；测试集必须存在于 `deploy/suites/`，不能以缺少测试集的部署冒充验收。
- Android 验收固定顺序：先在 Ubuntu `jeff` AVD 对本次 APK 跑 instrumentation；通过后，Windows 端优先指定 USB serial，其次连接 `192.168.3.121:5555`。`auto` 下真机不可用时结果只能写“模拟器通过，真机待验收”；真机途中失败须留证并重跑/报告，不能覆盖失败原因。
- 部署脚本不自动改版本。代码改动按 AGENTS.md 的 SemVer 规则在该任务结束阶段统一 bump 一次，再构建 Ubuntu 与 Windows 安装包及签名 APK。
- Windows 首次配置见 `deploy/windows/README.md`。密钥、relay 地址和手机 serial 只保存在忽略的 `.tmp/deploy/config.json` 或本机；不得提交凭据。
- 远程验收必须从 Windows 实际安装目录启动 Jeff，使用隔离数据目录；产物 SHA-256、安装结果、截图与测试日志回传至 `.tmp/deploy/<运行编号>/`。Windows 不可达时仅报告已完成的 Ubuntu/本地产物验收，不得声称双机验收通过。

## 从 Ubuntu 调试 Windows（已实测，默认不使用 Windows Codex）

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

## 三平台一次交付与 Windows 故障闭环（2026-10-08 复盘）

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

## 文件链接验收补记（2026-10-09）

这次右键菜单和双机验收里，下面几类失败会反复出现。下次先按这里处理，不要改断言凑绿，也不要按进程名结束 Jeff。

| 现象 | 下次怎么做 |
| --- | --- |
| Windows 上文件名右键像没反应。菜单代码在，包里也能搜到「复制路径」 | 右键会在 `contextmenu` 之后再补一次 `pointerdown`。菜单若在 `useEffect` 里立刻监听 `pointerdown`，会在画出之前被关掉。跟会话列表一样：延迟到下一次 `click` 再关，并忽略菜单内部点击。样式上后写的 `.chat-row-menu { z-index: 40 }` 会盖掉单独的 `.file-link-menu`；要抬高层级就写 `.chat-row-menu.file-link-menu`。文件链接还要在主进程对含 `jeff-file:` 的 `context-menu` 调用 `preventDefault()`，否则系统菜单盖住渲染层菜单。 |
| 封闭测试里右键了，主进程 `context-menu.log` 仍是空的；`xdotool` 点了但菜单没出现 | Playwright 的右键和 `webContents.sendInputEvent` 不会触发 Electron 主进程的 `context-menu`。不要用这份日志证明合成点击。在链接包围盒上发 `mouseDown`/`mouseUp`（`button: 'right'`），再断言渲染层菜单三项。`screen.dipToScreenRect` 在这段 Electron 求值上下文里不存在。xvfb 下的 `xdotool` 会点偏。 |
| `fs-open.log` 里明明有路径，`includes(path)` 却失败 | 日志是 `JSON.stringify` 的一行。Windows 反斜杠会被转义。逐行 `JSON.parse`，比较 `target` 和 `decision`。 |
| 部署结果只有 `(node:…) ExperimentalWarning: SQLite is an experimental feature` | Windows Node 24 的 `node:sqlite` 会把这条警告打到 stderr。`Worker.ps1` 的 `$ErrorActionPreference='Stop'` 会把它当成终止错误。运行器必须用 `node --no-warnings` 启动，不要拿掉这个参数。 |
| `EncodedCommand` 报「命令行太长了」 | 长 PowerShell 写到文件，SFTP 到 `C:\Users\Public\` 再执行。不要把整段脚本塞进 base64 命令行。 |
| 发了 `WM_CLOSE` 或 Ctrl+Q，Jeff 仍在；窗口标题是 `Jeff` 但只有约 396×106 | 那是通知气球，不是主窗口。气球的 `close` 调用了 `preventDefault()`，所以关不掉，`window-all-closed` 也不会发生。主窗口可以是空标题、大约 1152×664。SSH 里的 `EnumWindows` 看不到交互会话的窗口。要操作界面时，计划任务主体复制 `JeffDeployWorker` 的 Interactive 身份，不要用 SSH 的 `$env:USERNAME`。仍禁止按进程名结束。 |
| 清单提交号是旧的 `HEAD`，包里却有后来改的菜单 | `deploy` 记录的是 `git rev-parse HEAD`，不含未提交文件。打包前先提交要交付的源码。工作区不干净时，不能把清单提交号当成包内容。源码注释会被打包器删掉；确认修复进包时，在 ASAR 里找能留下的字符串（例如 `setTimeout` 后的 `addEventListener("click"` 或 `file-link-copy`），不要用中文注释当证据。 |
| `ui` 项目把 `live-file-links.spec.ts` 也跑进去了 | `playwright.config.ts` 的 `testMatch` 必须锚到文件名结尾。`ui` 只匹配 `ui.spec.ts`、`p0-ux.spec.ts`、`file-links.spec.ts`。未锚定的 `file-links` 会把 `live-file-links.spec.ts` 一起跑掉。 |
| v18、快照「第 N 版」、布局宽度或浏览器分辨率偶发超时，下一轮又绿 | 先看是时间戳碰撞或环境抖动。断言保持原样再跑。不要放宽断言。 |
| 磁盘上已有新 `.deb`，本机 `dpkg` 仍是旧版 | 产物存在不等于已安装。用解析后的 sudo 密码安装，再核对 `dpkg -l jeff-desktop` 和 `/opt/Jeff/resources/app.asar` 与 `linux-unpacked` 的 MD5。 |
| AVD instrumentation 退出码 0，输出里却是 `RootViewWithoutFocusException` / `has-window-focus=false` | 这是模拟器焦点抖动，不是文件链接功能坏了。保留原始输出后重跑。以测试报告里的失败数为准，不以 adb 退出码为准。 |

**安装与验收按阶段收集事实并闭环：** 本机归档/安装器校验 → 上传与远端 SHA-256 → 正常退出及本机数据快照 → NSIS 原范围/原目录安装 → 注册信息、EXE 版本、安装 ASAR/内置 OpenCode → 隔离实例实际窗口/页面及 sidecar → 本次具名功能测试及按需真实模型/手机链路 → 日常数据核对与本轮资源清理。失败时保留原始证据，定位并修复所属阶段，从受影响阶段重新验证；代码修复则按前文重跑相关回归和三平台正式构建。人工临时修复 ASAR 只能用于诊断/本机恢复，交付必须重新生成完整安装包；启用 Electron EXE 嵌入式 ASAR 校验时，由打包器同步生成匹配的 EXE 和归档。

首次 GUI 验收同时检查首页、版本和本次功能入口；`smoke` 仅证明安装启动，不能代替本次具名功能测试。命令结束后核对日常数据库/配置与本机快照；关闭数据库时可比字节哈希，运行中有正常写入则使用 SQLite 只读完整性检查与预期记录核对，不能把正常写入误报成数据损坏。敏感备份留 Windows 本机，回传验收日志与非敏感证据。

**仅外部环境确实无法自行恢复时允许留待验收：** 例如电脑离线、用户未登录/锁屏、缺少可用管理员授权、设备未连接/未授权、CLI 缺登录或订阅。先尝试已授权的可恢复措施，记录具体错误和环境事实，继续完成另外两平台及本平台可执行的检查，再准确报告所需的最小用户操作。不能把产物损坏、调试脚本错误、可修复的安装失败或尚未定位的超时直接归为环境问题。

最终答复和总结文档必须同时列出以下三行；每个平台写明“通过/失败/未验证”、测试范围、用例结果、产物路径/SHA-256 和证据位置，不得用“打包成功”替代安装或功能结论：

| 平台 | 必须报告的结论范围 |
| --- | --- |
| Ubuntu | `.deb`/AppImage 产物校验、实际安装版本/ASAR、界面与本次功能，以及相关真实模型链路。 |
| Windows | NSIS 与内部 ASAR 校验、实际安装目录/版本/哈希、界面与本次具名功能；真实模型链路按实际验证范围单列。 |
| Android | release APK 版本/签名、AVD instrumentation，以及 Windows USB/网络真机与相关真实回复验收；真机缺席明确写“模拟器通过，真机待验收”。 |

本次事故和最终安装证据见 [`docs/summary/20261007/Jeff多执行引擎支持.md`](../summary/20261007/Jeff多执行引擎支持.md)。上述三平台构建验收门槛适用于开发交付；仅修改文档/AGENTS.md 不升版、不重打包。
