# skills 备份「无反馈」与 Windows 恢复 404 修复（v1.7.27）

## 问题现象

1. **Ubuntu 端「立即备份 skills」点了没反应**：按钮转「备份中…」一分多钟，结束后只有一行小字变化，无法确认是否真的成功。
2. **Windows 端「从备份恢复」报 404**：`检查备份失败：有 34 个备份文件下载失败（已中止恢复，本地未改动）：jeff-video-cut/SKILL.md: Invalid response: 404 Not Found；…（远端还没有备份？先点「立即备份 skills」）`。

## 根因排查（直接对真实 WebDAV 服务器取证）

用 `~/.jeff/jeff.db` 里存的 WebDAV 配置直接 PROPFIND/GET 远端，事实链如下：

1. Ubuntu 端备份**其实成功过**（kv 报告 `ok:true, 647 文件, uploaded 0, skipped 647`）——「没反应」是因为递归列远端目录是串行的（500+ 目录 × 每目录一个 PROPFIND），耗时 100 秒，且完成与否只在面板小字里体现，没有弹窗。
2. 远端 `skills/` 曾被**镜像删除步骤误删 80 个文件**：`skills-versions/jeff-video-cut/SKILL.md/1789230316027-del0` 的 `-del` 归档是铁证。误删发生在 kv 哈希落盘**之前**，进程中途被杀后造成「本地哈希说已上传、远端实际没有」的永久不一致——后续备份按哈希全部 skip，**永不自愈**。
3. Windows 恢复报的 34 个 404 = 被误删文件中真正丢失的部分（另 46 个在服务端列不出的目录里，实际还在远端）。
4. 该 sealos WebDAV 服务器还有一个怪癖：**含 `index.html` 的目录 PROPFIND 直接 405**（html-ppt 示例、dashi-ppt node_modules 共 20 个目录 46 个文件列不出），但目录内文件可以按直连路径 GET。旧版恢复端 strict 探测会把这种目录 GET 到的 index.html 当成「文件」收进列表，恢复后本地会出现名为 `demo-deck` 的假文件。

## 修复内容（packages/core/src/sync/engine.ts + SyncSettings.tsx）

| # | 修复 | 说明 |
|---|------|------|
| 1 | **备份自愈** | 跳过判定从「哈希未变」改为「哈希未变 **且** 远端列表里确实有该文件」。远端丢文件后下次备份自动补传，用已有的远端列表，零额外请求 |
| 2 | **镜像删除熔断** | 单次要删 >10 个且 > 远端文件数 30% 时中止备份并提示；再点一次「立即备份」（待删集合一致）才放行。防本地目录暂缺/误判清空远端 |
| 3 | **备份清单** | 备份完成后写 `<base>/skills-manifest.json`（全部文件相对路径）；恢复端用「目录列表 ∪ 清单」补全 405 目录下的文件直连下载 |
| 4 | **strict 探测分级** | 目录列不出时先用 PROPFIND Depth 0（stat）分级：207=目录在但列不出（清单补全+告警）；404=可能被标成目录的无扩展名文件（GET 探测收进列表）；401/405=坏条目跳过告警。不再把 index.html 当文件 |
| 5 | **并发列目录** | 递归 PROPFIND 改为有界并发（8），647 文件 / 500+ 目录的远端列举从 ~100s 降到 ~10s 级 |
| 6 | **上传阶段哈希先行落盘** | 上传完成即写 kv 哈希，删除阶段被中断也不再扩大不一致窗口 |
| 7 | **UI 反馈** | 备份完成/失败弹窗显示「共 N 文件 · 上传 X · 删除 Y · 归档 Z · 耗时 Ss」；恢复失败提示按错误类型区分（下载失败 → 提示远端备份不完整需重新备份，而不是误导性的「先点立即备份」） |

## 测试

- **mock 单测**（`skills-sync.test.ts`）：新增自愈、熔断（两段确认+状态变化后重新熔断）、清单补全（mock 服务器注入 PROPFIND 405）3 个用例；`npm test` 189 个全绿。
- **真实 WebDAV 联测 ×3 轮**（`skills-sync.live.test.ts`，新增自愈+熔断真服务器场景）：3 轮全绿，远端测试目录自动清理无残留。
- **真实数据自愈**：修复后的引擎对真实 `~/.agents/skills` + `/jeff` 基目录跑一次备份，补传 34 个文件（正是 Windows 报 404 的那 34 个）。
- **真实远端全量对账**：递归 PROPFIND + 逐文件 GET + FNV-1a 哈希比对——本地 647 = 远端列表 601 + 清单补全 46，`清单 ∪ 列表 == 本地` 成立，**647 个文件全部 200 且哈希一致，零差异**。
- typecheck 仅剩 3 个存量 e2e helper 报错（AGENTS.md 记录在案，非本次新增）；mock UI E2E 1 个全绿。

## 发版

- 版本五处一致 bump `1.7.26 → 1.7.27`，`version.test.ts` 校验通过。
- Linux：`jeff-desktop_1.7.27_amd64.deb` + `Jeff-1.7.27.AppImage`；已 `dpkg -i` 本机安装，`/opt/Jeff` 与 `linux-unpacked` app.asar md5 一致。
- Windows：`jeff-Setup-1.7.27.exe`（PE32 Nullsoft），`skills-manifest.json`/`pendingDelete` 特征串在 app.asar 中命中，`oc-bin/windows-x64/opencode.exe` 在位。

## ⚠️ Windows 端操作提示

1. **先升级 Windows 端 Jeff 到 1.7.27 再点「从备份恢复」**：旧版会把 405 目录的 index.html 当文件恢复，可能损坏本地目录；新版靠清单才能完整恢复 html-ppt / dashi-ppt 里列不出的 46 个文件。
2. 远端备份已在本机自愈补齐，升级后恢复应一次成功。
3. 以后「立即备份 skills」结束会有弹窗报告，几秒~十几秒属正常（原来是 100 秒）；如果报熔断提示，确认无误后再点一次即可执行。
