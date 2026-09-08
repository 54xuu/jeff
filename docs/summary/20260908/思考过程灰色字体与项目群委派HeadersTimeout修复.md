# 思考过程灰色字体与项目群委派 HeadersTimeout 修复

- 日期：2026-09-08
- 版本：v1.7.11（PATCH，自 v1.7.10 升级）
- 范围：`packages/core`（OcClient 传输层 + 诊断）、`apps/desktop`（思考过程样式）

## 问题一：流式思考过程希望用「稍微灰一点」的字体

### 现状分析

思考过程正文（`.extra-reasoning`，见 `ChatShared.tsx` 的 `AssistantExtras`）原本已使用次级灰 `var(--text-2)`，但该变量同时服务于「思考过程」折叠标题、工具调用状态等其他辅助文字，视觉权重没有区分。

### 修复

- `styles.css` 主题合同新增独立 token：
  - 亮色：`--text-reasoning: #a3a3a3`（`--text-2` 为 `#7a7a7a`）；
  - 暗色：`--text-reasoning: #757575`（`--text-2` 为 `#8c8c8c`）。
- 仅 `.extra-reasoning` 改用 `var(--text-reasoning)`：流式与历史消息共用该类，思考正文整体更弱一档；折叠标题、工具调用、普通说明文字颜色不变。

## 问题二：委派「文档小皮」生成 PPT 约 5 分钟后报「引擎服务连接失败…fetch failed」

### 现象（附录A debug 日志）

- leader 委派生成 HTML PPT 的 POST `/session/:id/message` 在 `elapsedMs=306337` 失败，`cause` 为 `HeadersTimeoutError`，业务超时预算是 600s；
- sidecar 曾从 14113 自动重启换到 14114（generation 18），换端口后新请求依然在约 306s 超时。

### 根因（已核实，非端口重绑遗漏）

`OcClient.req()` 使用 Node/Electron 全局 `fetch`（即内置 Undici）+ `AbortSignal.timeout(timeoutMs)`，但**没有配置 dispatcher**。Undici 默认 `headersTimeout` 为 300s：委派类 POST 会阻塞到整个 run 结束（LLM 生成 + dashi-ppt 技能执行），一旦 5 分钟内没等到响应头，Undici 运行时先把请求杀掉，报 `TypeError: fetch failed` / `HeadersTimeoutError`——比 Jeff 允许的 600s 提前了约一半。14113→14114 后仍复现，说明与 v1.7.9 修的「重启后客户端未重绑」无关，纯粹是运行时超时截断。

### 修复（`packages/core/src/oc/client.ts`）

1. `@jeff/core` 新增生产依赖 `undici@^6.28.0`，`req()` 与 SSE `runSse()` 改用 `undici.fetch` + 专用 `Agent({ headersTimeout: 0, bodyTimeout: 0 })`（模块级惰性单例，仅 OcClient 使用，不改全局 fetch）。请求总预算统一由原有 `AbortSignal.timeout` 控制：普通群/委派 600s、压缩 300s 不变。SSE 长连接同步不再受 Undici 默认超时影响。
2. `OcClient` 构造函数新增可选 `dispatcher` 参数，供测试注入。
3. **HeadersTimeout 独立分类**：识别 `cause` 链中的 `HeadersTimeoutError`，抛出可读的「引擎服务响应超时（…等待响应头 Ns，任务可能仍在执行）」，不再与「连接失败」混装；措辞避开 abort 字样，防止上层误判「已停止生成」。
4. **诊断增强**：`oc-req-fail` 日志新增 `timeoutMs`、`isHeadersTimeout`、递归 `causeChain`（name/message/code）；`statusProvider` 合同扩展 `generation`（`JeffCore` 注入处同步），可对账请求是否跨 sidecar 代际。
5. **不自动重试**：有副作用的 POST（委派/群消息）在任何传输超时后都不重放，保留现有「worker 成果保留、失败落系统消息」的部分成功语义。

## 测试

- 新增 `packages/core/tests/oc.test.ts` 用例 2 个：
  - 注入小超时 Agent（headersTimeout 300ms）+ mock server 延迟回响应头：验证超时被分类为「响应超时」、日志含 `isHeadersTimeout`/`causeChain`、不误报连接失败；
  - POST 永不回响应头 + `timeoutMs: 2000`：验证由应用总预算（而非 Undici 300s）终止、全程仅一次 POST（无重放）。
- `npm test`：116 passed（19 个测试文件）。
- `npm run typecheck`：本次改动文件无错误；`apps/desktop/e2e/helpers/launch.ts` 存在 3 个与本次无关的存量错误（`seed.mjs` 缺声明、`JEFF_OPENCODE_BIN` env 类型），干净 main 上同样复现，留待后续单独处理。

## 验证

- Linux：`npm run package:linux` 产出 `Jeff-1.7.11.AppImage` + `jeff-desktop_1.7.11_amd64.deb`；`sudo dpkg -i` 本机安装成功（`dpkg -l` 显示 `jeff-desktop 1.7.11`），安装产物 `app.asar` 内 `package.json` 版本为 `1.7.11`；重启 Jeff 后进程正常运行（若 undici 未正确打包，主进程会在导入时崩溃，可反证打包完整）。
- Windows：`npm run package:win` 产出 `jeff-Setup-1.7.11.exe`；`wine64` 冒烟弹出「Jeff Setup」安装向导（未实际安装，验证后关闭）。
- 修复代码已确认进入主进程 bundle（`out/main/index.js` 含新的「引擎服务响应超时」分类逻辑）。
- 待真实场景复验：让项目群 leader 再次委派「文档小皮」执行长耗时 PPT 生成，超过 5 分钟后应不再出现 `HeadersTimeoutError`（本次未实际构造 >5min 的真实委派任务）。

## 提交

（待提交后补全）
