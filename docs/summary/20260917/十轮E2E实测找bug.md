# 十轮真实模型 E2E：找到并修复「群聊撞上推迟的引擎重启」

- 日期：2026-09-17
- 范围：Jeff v1.8.15 → v1.8.16（PATCH）
- 测试模型：硅基流动 `deepseek-ai/DeepSeek-V3.2`，思考档位 `high`

## 一、任务目标与结论

跑 10 轮真实模型 E2E，覆盖单聊、群聊、插件、skill、MCP、小杰代操，自己找 bug 并修复。**10/10 全部通过**（复跑总耗时 9.7 分钟）。截图与证据在 `.tmp/live16/evidence/` 与 `.tmp/live16/live16-out/`（gitignore，不入库）。

发现并修复 1 个应用层 bug：插件启用后推迟到群流水线空闲才重启 sidecar，下一轮群发送会打到正在关闭的引擎。

## 二、10 轮清单与结果

测试台 `.tmp/live16/`（`seed16.mjs` + `live16.spec.ts` + `playwright.config.ts`），链式串行共用一份 home。

| 轮次 | 场景 | 断言要点 | 结果 |
|------|------|----------|------|
| R1 | 单聊简单对话 | 回复非空、含「2」、时间戳 | ✅ 35s |
| R2 | 单聊多轮记忆 | 助手回复同时含「青鸟-17」与「42」 | ✅ 1.2m |
| R3 | 单聊工具 read+bash+write | 产出 `统计结果.md` 含总分 255 | ✅ 53s |
| R4 | MCP mysql-test | 调用 mysql 工具，回复含真实库名 | ✅ 21s |
| R5 | skill byted-web-search | 走 skill，回复含 https 链接 | ✅ 33s |
| R6 | 插件启用 + `/` 筹码 + 真调 MCP | 服务端收到「插件集成成功」，回复 `ECHO_OK`，气泡有筹码 | ✅ 29s |
| R7 | 小杰代操建智能体/群/任务/记忆 | `jeff_agent_create` / `project_create` / `task_create` / `memory` 落库：译员小方、翻译工作室、JEF-1 校对 README | ✅ 1.7m |
| R8 | 小杰对话式开发插件 | 只走 `jeff_plugin_*`，plugin.json 落盘并注入 MCP | ✅ 1.1m |
| R9 | 群聊协作 | 指挥官派发、执行员写文件，含 255 | ✅ 2.1m |
| R10 | 群聊插件筹码调 MCP | 服务端收到「群聊插件成功」，回复 `ECHO_OK` | ✅ 34s（首跑失败，修完复跑通过） |

人工目检了 R7（小杰四连操作）、R10（群聊筹码 + ECHO_OK）截图：三栏布局、时间戳、插件筹码、暗色思考折叠条均正常。

## 三、找到的 bug 与修复

### 群聊在「推迟的 sidecar 重启」窗口里发送会丢回复

- **复现**：R8 小杰启用插件 → `markRegistryDirty`；R9 群流水线在途，重启被推迟；R9 一结束 `flushPendingRegistryRestart` 立刻 stop/start 引擎。R10 马上在同一群里用插件筹码发送。
- **现场**：用户气泡已经出现（落库成功），但 60 秒内没有 `chat-stop`，debug 日志在 sidecar-restart 之后没有新的 `send-start`。探针单独复用同一份 home 能发出去，说明不是筹码 UI 坏了，是**同一会话里撞上重启窗口**。
- **根因**：`beforeEnsure` 只调用 `restartIfRegistryDirty()`。推迟重启一旦开工就会把 `registryDirty` 清掉，但 `this.restarting` 还在跑。下一轮 send 看到 dirty=false 就直接 `getSession` / `createSession`，打到正在关闭或尚未监听的端口（日志里是 `ECONNRESET` / `ECONNREFUSED`）。
- **修复**（`packages/core/src/index.ts`）：抽出 `ensureSidecarReady()`——先 `await this.restarting`，再按 dirty 落闸，然后再等一次在途重启。私聊/群聊的 `beforeEnsure` 都走它。

## 四、收尾（按 AGENTS.md）

- 版本 bump：`1.8.15 → 1.8.16`（根 / core / desktop `package.json`、`package-lock.json` 4 处、`packages/core/src/version.ts`）。
- 第一层：
  - `npm run test -w @jeff/core`：280 passed / 17 skipped
  - 包级 `typecheck`（jeff-desktop）通过；根 tsconfig 仍有 3 个存量 e2e helper 报错，改动前就在
  - mock UI E2E：1 passed（20.7s）
  - v18 封闭：4 passed（1.1m）
- 第二层：live16 10/10 真实模型全绿（9.7m）
- Linux：`jeff-desktop_1.8.16_amd64.deb` + `Jeff-1.8.16.AppImage`
  - 本机 `dpkg -l jeff-desktop` = **1.8.16**
  - `/opt/Jeff/resources/app.asar` 与 `linux-unpacked` md5 一致：`0af78dfdb102d3635f25f34c2870d820`
- Windows：`jeff-Setup-1.8.16.exe` 为 PE32 Nullsoft；`win-unpacked` 的 `app.asar` 命中 `ensureSidecarReady` / `live16 R10` / `1.8.16`；`oc-bin/windows-x64/opencode.exe` 在位

## 五、目检截图时的非阻断观察

R1 里「文档小沃」自我介绍成「Jeff 内置管家（小杰）」——这是模型身份幻觉，断言仍按「回复含 2」通过，不是本次要修的产品 bug。插件筹码、时间戳、三栏布局、思考折叠条均正常。
