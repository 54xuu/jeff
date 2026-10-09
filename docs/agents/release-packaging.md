# 发版、打包与安装验证

本文件由 [`AGENTS.md`](../../AGENTS.md) 拆出，是三平台正式交付的细则。硬性门槛（每个代码任务必须构建三种正式产物）仍以 AGENTS.md 为准。

## 构建产物清理与保留

- 正式桌面打包入口会先清理对应平台的可重建中间目录：Linux 清 `apps/desktop/out` 与 `release/linux-unpacked`；Windows 清 `apps/desktop/out` 与 `release/win-unpacked`。`apps/mobile` 的 `cap:sync` 清 `dist` 和 Android 中间目录但保留正式 APK；Android `assembleRelease` 另外裁剪旧正式包，`preBuild` 清 `android/build`、`android/app/build`。
- 清理脚本只操作上述明确路径，并拒绝路径中的符号链接；保留 `node_modules`、Gradle 依赖缓存、`.tmp` 和本机验收证据。混合用途的 `.tmp` 不自动清理；可用 `du -h -d 2 .tmp` 单独列出解包候选，再人工核验。始终保留 `.tmp/deploy` 证据和近期工作目录。不要用 `rm -rf release` 或清空 `.tmp` 代替受控清理。
- 正式包保留最近两个完整验收通过的三平台版本；新版本构建期间额外保留当前候选版本。首轮把用户指定的 2.1.0 作为已知回退基线，删除更旧的版本包。`deploy:windows` 端到端成功后写入本机验收记录并裁掉更旧包；如果没有完整验收通过的回退版本，保留现有所有正式包。手工绕过正式入口不会登记验收状态。
- Windows 部署快照保留最近 3 份成功、最近 1 份失败；结果不明的快照不自动删除。`deploy:windows` 只有在结果 run ID 匹配且验收证据成功回传到 Ubuntu 后，才清理该任务的临时包、隔离运行数据和远端证据副本；超时、仍有待处理 worker 请求或证据回传失败时保留现场。
- Windows 清理按正式包文件名、run ID 和 `results/<runId>/outcome.json` 核验，不清空 `incoming`、`current` 等目录；目录中的自建脚本与测试场景必须保留。正式部署使用 `npm run deploy:windows`，绕过该入口的手工操作不会触发回传后清理。


```bash
npm run package:linux   # → apps/desktop/release/jeff-desktop_<version>_amd64.deb（另出 Jeff-<version>.AppImage）
npm run package:win     # → apps/desktop/release/jeff-Setup-<version>.exe
```

两条 desktop 命令各自会先跑 `electron-vite build`，不需要单独 build。先完成测试，再按 [`AGENTS.md`](../../AGENTS.md) 的版本号规则 bump 版本并构建全部三种正式产物；禁止只打当前改动涉及的平台。

装本机验证（Linux 侧）：

本机 `sudo` **没有免密**。密码在 ZCode 记忆
`/home/xujian/.zcode/cli/memories/projects/jeff-1d2f0b1cdfcc2a44/memory/sudo-password.md`
（用户要求永久记住）。Agent 必须先读该文件，再用 `sudo -S` 从 stdin 传入，**禁止**把密码写进仓库或回复用户；也不要裸跑交互式 `sudo`（Cursor 没有 TTY，会卡在密码提示）。

**密码文件是 Markdown，不是纯密码文件。** 文件含说明文字，密码被 Markdown 行内反引号包住。禁止把整份文件或整行直接管道给 `sudo`；必须只解析密码标签后反引号内部的值，并在同一管道中交给 `sudo -S`，不可打印、复制到命令参数、日志或回复。Shell 命令中的反引号还会触发命令替换；构造含反引号的命令时使用单引号包住脚本或使用带引号的 heredoc，不能把它放进 Bash 双引号里。

```bash
set -o pipefail
node -e 'const fs=require("node:fs");const p="/home/xujian/.zcode/cli/memories/projects/jeff-1d2f0b1cdfcc2a44/memory/sudo-password.md";const lines=fs.readFileSync(p,"utf8").split(/\r?\n/).filter(line=>/用户本机.*sudo 密码/.test(line)&&/：\s*`[^`]+`/.test(line));const m=lines.length===1?lines[0].match(/：\s*`([^`]*)`/):null;if(!m)process.exit(2);process.stdout.write(m[1]+"\n")' | sudo -S -p '' dpkg -i apps/desktop/release/jeff-desktop_<version>_amd64.deb
dpkg -l jeff-desktop                        # 应显示新版本号
md5sum /opt/Jeff/resources/app.asar apps/desktop/release/linux-unpacked/resources/app.asar
# 两者 md5 一致，才说明装上去的确实是刚打的包（不是残留旧版）
# 然后退出并重新打开 Jeff，在「设置 → 关于」确认版本号
```

若 sudo 报认证失败，立即停止盲目重试；先检查记忆文件路径、密码标签是否唯一、解析是否去掉行内反引号及管道退出码。只验证“匹配到一行且格式正确”，不要把解析结果打印到终端。确认解析逻辑后才允许再试一次；仍失败就报告凭据/系统状态问题，不把秘密写入仓库或命令历史。

## 本机打 Windows 安装包（无需 GitHub Actions）

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

本项目的 GitHub Actions workflow 已移除。推送分支或 `v*` tag 不会自动构建或发布安装包；正式包按本文在本机完成三平台构建、校验和安装验收，再由维护者按需手动发布。旧版 Actions 的历史记录不代表当前仍会运行。
