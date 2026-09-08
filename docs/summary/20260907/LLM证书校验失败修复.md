# LLM 证书校验失败修复（v1.7.4 / v1.7.5 / v1.7.6）

## 问题现象

在项目群「POCT+AI项目管理」发送消息，群主「项经理」处理时报错：

```
⚠️ 项经理 处理消息失败：assistant 消息出错: {"name":"UnknownError","data":{"message":"unknown certificate verification error"}}
```

- 出现在 **Windows 版** Jeff 上；同一群里绑定了 `opencode-go/glm-5.2` 的 agent 均正常，只有未绑模型、走全局默认 `siliconflow/Qwen/Qwen3.5-9B`（`https://api.siliconflow.cn/v1`）的成员失败。

## 根因

错误链路：`group.ts`（包装「处理消息失败」）← `oc/client.ts:106`（轮询到 assistant 消息的 `error` 字段）← **opencode sidecar 内嵌的 Bun 运行时**请求 siliconflow HTTPS API 时 TLS 证书校验失败。

- 本机（Ubuntu）验证：siliconflow 证书链完整（DigiCert 签发）、无代理劫持、系统时间正常 → 问题在 Windows 测试机的**网络环境对特定域名做了 TLS 中间人拦截**（企业网/安全软件）。
- 拦截证书装在 Windows 系统证书库里，浏览器/curl 走系统库所以正常；**Bun 不读 Windows 系统证书存储**，于是校验失败，包装成 `UnknownError`。

## 修复（两个开关，均在 设置 → 引擎服务）

### 1. 跳过 LLM 证书校验（默认关）

- 开启后 sidecar 环境变量注入 `NODE_TLS_REJECT_UNAUTHORIZED=0`（Bun 官方支持，禁用证书校验），并自动重启引擎生效。
- 实现：`SidecarOptions.extraEnv`（每次 spawn 时求值，`sidecar/manager.ts`）+ kv `settings:llmTls` + `JeffCore.setLlmTlsSkip()`（写 kv → `restartSidecar()`）+ IPC `llmTlsGet/llmTlsSet`。
- 报错文案检测 `certificate` 关键词，自动追加「可在 设置→引擎服务 开启『跳过 LLM 证书校验』」引导。
- 该设置绑定机器网络环境，**不参与 WebDAV 同步**。

### 2. 调试模式（默认关）

- 开启后写 `~/.jeff/logs/debug-YYYYMMDD.log`（本地时区按天分文件，单文件 5MB 轮转 `.old.log`）：
  - sidecar stdout/stderr 全量输出（原先只存 300 条内存缓冲，进程退出即丢）；
  - **完整** assistant 错误 JSON（原先 `client.ts` 被 `slice(0,300)` 丢弃）；
  - 消息处理失败上下文（群聊/私聊/委派的 projectId、agentId、sessionId、错误与堆栈）；
  - sidecar 启动/崩溃/重启事件与设置变更。
- 实现：新增 `packages/core/src/logger.ts`（`DebugLogger`，写失败静默不影响主流程）+ kv `settings:debugLog` + IPC `debugLogGet/debugLogSet`（即时生效，无需重启）。
- 注意：日志可能包含聊天内容片段，仅排查问题时临时开启。

## 验证

- `npm test` 96 通过；`npm run typecheck` 仅存量 3 个 e2e helper 错误（HEAD 上同样存在，与本次无关）。
- 新增 `packages/core/tests/e2e.tls.test.ts`（`JEFF_TLS_E2E=1` 门控）：openssl 自签证书 + HTTPS mock LLM + 真实 sidecar，3 用例全过：
  1. 默认状态请求自签端点 → 复现 `UnknownError: self signed certificate`，调试日志留下完整 `assistant-error` 现场；
  2. 开启跳过开关（自动重启引擎）→ 同一端点请求成功（证明 env 真正传到 Bun）；
  3. 关闭调试模式 → 日志停止写入。
- 发版 1.7.4（三处 `package.json` + lock）：`npm run package:linux` → deb 安装本机，「设置→关于」1.7.4，sidecar 正常启动且默认未注入 TLS 变量；`npm run package:win` → `jeff-Setup-1.7.4.exe`，wine 冒烟通过。

## 追加排查：v1.7.5（Windows 上改报「⏹️ 已停止生成」）

### 现象与日志盲区

用户 Windows 机器装上 1.7.4、开启「跳过 LLM 证书校验」后，群消息报 `⏹️ 已停止生成`，且调试日志里**只有 sidecar 重启事件、没有任何失败现场**。原因：

1. v1.7.4 的停止判定 `/abort/i.test(msg)` 过宽——provider 请求超时/被中断等错误的文案里也含 "abort"，被误判成「用户手动停止」，于是显示「已停止生成」且**跳过了失败日志**（v1.7.4 对 stop 类不落日志，是本次日志盲区的直接原因）。

### 修复

1. **停止判定收紧**：`OcClient` 记录用户主动 `abortSession` 的会话与时间戳（新增 `isAbortRequested(sessionId, windowMs=120s)`）；群聊/私聊 catch 改为 `/abort/i` 且 `isAbortRequested` 双条件才算「已停止生成」，否则展示真实错误。
2. **失败全量落日志**：`group-send-stop` / `group-send-fail`、`private-send-stop` / `private-send-fail` 全部落调试日志（含堆栈）；`OcClient.sendMessage` 增加 `send-start` 现场行（sessionId/agent/model/variant/文本长度/图片数/超时，不含消息内容）。
3. **群主简报强化**：leader 角色行明确「拆分任务后必须逐个调用 jeff_delegate 委派工具派活；只回复文本 @ 成员不会触发执行」。

### 群消息路由机制核实（与用户预期一致，无需改动）

用户预期「非 @ 消息默认给群主 → 群主拆分任务按类型 @ 分配给 worker」。现状即如此：`group.ts` 路由 `targetId = parseMention(text) ?? project.leader_agent_id`；派活走 `jeff_delegate` 工具（leader 执行、成员独立会话、结果回群）。之前「机制像坏了」实际是群主一直处理失败（证书错误 → 疑似 provider 超时被误判为停止），消息从未被成功处理。

### 对 Windows 机器的下一步建议

1. 安装 `jeff-Setup-1.7.5.exe`，保持「跳过 LLM 证书校验」与「调试模式」开启；
2. 群里再发一条消息：若再失败，现在会显示**真实错误**并落 `group-send-fail` 日志，把日志发回分析；
3. 强烈建议同时把「项经理」「项小沐」的资料里绑定 **opencode-go/glm-5.2**（该 provider 在此网络环境已验证可用），绕开对 api.siliconflow.cn 的网络拦截——跳过证书校验只能解决「证书被拦」，解决不了「域名被墙/超时」；
4. v1.7.5：`npm test` 96 通过，TLS e2e 3 用例回归通过，deb 已装本机（1.7.5）并启动验证。

## 涉及文件

- 新增：`packages/core/src/logger.ts`、`packages/core/tests/e2e.tls.test.ts`
- 修改：`sidecar/manager.ts`（extraEnv）、`index.ts`（开关方法 + 日志接线）、`oc/client.ts`（完整错误 + 提示）、`chat/private.ts`、`orchestrator/group.ts`、`orchestrator/delegate.ts`（失败落日志）、`ipc/contract.ts`、`apps/desktop/src/main/ipc.ts`、`EngineSettings.tsx`（两个开关）
- 版本：1.7.3 → **1.7.4**（PATCH：修 bug + 已有功能打补丁）

## 追加排查：v1.7.6（真凶：本地 POST 60 秒超时，与证书/网络无关）

### 现象

Windows 换绑 `opencode-go/deepseek-v4-flash` 后报 `⚠️ 项经理 处理消息失败：The operation was aborted due to timeout`，勾不勾「跳过 LLM 证书校验」都一样。

### 根因（v1.7.5 的 send-start/group-send-fail 日志直接定位）

`send-start`（01:07:39.929）→ `group-send-fail`（01:08:39.940）**精确 60 秒**，堆栈在 `OcClient.req` —— 是 Jeff 主进程对**本地 sidecar** 的 `POST /session/:id/message` 带 `AbortSignal.timeout(60000)`。实验实证（mock LLM 人为延迟）：**opencode 1.18 的这个 POST 会阻塞到整个 run 结束（成功或报错）才返回**，mock 延迟 70 秒时 run 在 ~70 秒完成、我们在 60 秒先超时——所以只要 LLM 生成（max 思考 + 慢网络）超过 60 秒就必现；LLM 秒回时（此前所有 e2e）永远不会暴露。与证书开关无关，因此勾不勾一样。另实证：sidecar 连不上 LLM API 时 opencode 内部带退避重试 ~60 秒后才以 APIError 结束 run，同样超过我们旧的 60 秒 POST 超时。

### 修复

1. `OcClient.sendMessage`：POST 超时从固定 60s 改为 `input.timeoutMs`（默认 **600s**，与等待回复的轮询 deadline 一致）；轮询 deadline 同步用 `waitMs`。委派已单独传 600s。
2. `OcClient.summarize`：POST 超时 60s → `input.timeoutMs ?? 300s`（压缩同样是阻塞语义）。
3. e2e 回归：`e2e.tls.test.ts` 支持 `MOCK_DELAY_MS=70000` 模拟慢生成——修复前第 2 用例 60s 必炸、修复后 ~80s 正常完成；`mock-llm.mjs` 新增 `MOCK_DELAY_MS` 延迟注入（修复前实验中发现 helper 的请求回调需 async，已改）。

### 验证

- `MOCK_DELAY_MS=70000` e2e 3 用例全过（含 70 秒慢生成成功返回）；`npm test` 96 通过；typecheck 仅存量 3 个 e2e helper 错误。
- 版本 1.7.6（PATCH），deb 已装本机并启动验证。

### Windows 验证要点

装 `jeff-Setup-1.7.6.exe` 后群里发消息：deepseek-v4-flash（max 思考）慢时回复可能要等 1~5 分钟，属正常；仍失败的话真实错误会显示出来（不再被「已停止生成」/超时掩盖），配合调试日志即可继续定位。
