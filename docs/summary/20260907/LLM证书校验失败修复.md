# LLM 证书校验失败修复（v1.7.4）

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

## Windows 机器上的操作建议

1. 安装 `jeff-Setup-1.7.4.exe`；
2. 设置 → 引擎服务 → 勾选「跳过 LLM 证书校验」（引擎自动重启）；
3. 再到「POCT+AI项目管理」群发消息验证；
4. 若仍有问题，先勾选「调试模式」复现一次，把 `~/.jeff/logs/debug-*.log` 发回来分析。

## 涉及文件

- 新增：`packages/core/src/logger.ts`、`packages/core/tests/e2e.tls.test.ts`
- 修改：`sidecar/manager.ts`（extraEnv）、`index.ts`（开关方法 + 日志接线）、`oc/client.ts`（完整错误 + 提示）、`chat/private.ts`、`orchestrator/group.ts`、`orchestrator/delegate.ts`（失败落日志）、`ipc/contract.ts`、`apps/desktop/src/main/ipc.ts`、`EngineSettings.tsx`（两个开关）
- 版本：1.7.3 → **1.7.4**（PATCH：修 bug + 已有功能打补丁）
