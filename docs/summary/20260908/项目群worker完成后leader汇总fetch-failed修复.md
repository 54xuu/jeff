# 项目群 worker 完成后 leader 汇总 fetch failed 修复

- 日期：2026-09-08
- 版本：v1.7.9（PATCH）
- 范围：`packages/core/src/sidecar/manager.ts`、`packages/core/src/index.ts`、`packages/core/src/oc/client.ts`、`packages/core/src/orchestrator/group.ts`、`packages/core/src/orchestrator/delegate.ts`、`apps/desktop/src/main/ipc.ts`

## 问题

项目群协作流程（leader 拆解 → @ 派发 worker → worker 串行执行 → 汇报 @leader）中，worker 处理完成后交回 leader 总结时报错：

```
项经理 处理消息失败：fetch failed
TypeError: fetch failed
    at node:internal/deps/undici/undici:14902:13
    at async OcClient.req (.../out/main/index.js:661:17)
    at async OcClient.sendMessage (...:713:22)
    at async GroupChat.runTurn (...:2240:15)
    at async GroupChat.send (...:2172:19)
```

附录 A 日志证据：失败发生在 leader 的**新回合**（`GroupChat.runTurn`），错误是裸 `TypeError: fetch failed`，且没有对应的 `assistant-error`——说明请求没有得到 HTTP 响应，优先指向本机 sidecar 连接/端口生命周期，而不是 LLM 证书（那类错误会经 sidecar 落 `assistant-error`）。

## 根因

1. **sidecar 崩溃自动重启后 `OcClient` 仍持旧端口**（主因）：`SidecarManager.scheduleRestart()` 只调用 `start()` 更新自身 `port`，不通知 `JeffCore` 重建客户端；只有设置页手动重启（`restartSidecar()`）才重建。worker 回合成功后 sidecar 若重启换端口，leader 总结回合的 POST 就打到已失效的旧端口，fetch 层直接抛 `TypeError: fetch failed`。界面 sidecar 状态显示 running（新实例），但聊天请求仍失败——与用户现场一致。
2. **无后端并发保护**：同一项目的多次 `GroupChat.send`、sidecar 重启、`ensureSession` 并发创建会话、删除 thread 与在途请求之间没有互斥，都会放大失效窗口。
3. **诊断盲区**：`OcClient.req` 不记录端口/耗时/`cause`/sidecar 状态，日志无法确认现场；`sendMessage` 的 deadline 从 POST 返回后才起，总时长可能翻倍；`/abort` 失败完全静默。

## 方案（经 grill-me 逐项确认）

| 决策点 | 结论 |
| --- | --- |
| 修复范围 | 生命周期修复 + 同一项目群请求串行化 + 诊断增强；不盲目重试 |
| 失败语义 | worker 已完成、leader 总结失败 → 部分成功可恢复：保留 worker 成果与错误系统消息，返回 `{ routedTo, summaryFailed: true, summaryError }`，不自动重试 POST（防任务重复执行），用户可再发一条消息请求总结 |
| 串行锁粒度 | 按 `projectId` 串行、不同项目并行；leader 回合内的 `jeff_delegate` 在本流程锁内不再取锁，避免嵌套死锁 |

## 实现

### 1. Sidecar 生命周期与客户端绑定

- `SidecarManager`：
  - 新增 `generation`（每次健康启动 +1），启动成功后发 `ready` 事件 `{ port, generation }`（初次启动与崩溃自动重启都触发）；
  - `start/stop/自动重启` 统一经 `runExclusive` 串行队列，手动重启与自动重启不再交错；
  - 启动健康检查超时（15s）时 `SIGKILL` 本次 spawn 的进程再置 `crashed`，防僵尸进程占端口（exit 事件照常安排自动重启）。
- `JeffCore`：
  - 新增 `rebindOcClient()`：按 `ocGeneration` 判重，停旧 SSE → 新建当前端口 `OcClient` → 重启 SSE → `wireOcClient()`（注入 `statusProvider`）；
  - 监听 `ready` 事件自动重绑——崩溃自动重启换端口后，后续请求立即使用新端口；
  - `restartSidecar()` 加 Promise 互斥（并发调用共享同一结果）；
  - 不再重建 GroupChat/PrivateChat（二者持 `() => this.oc` 闭包无内存状态，顺带消除 delegator 持旧 groupChat 的隐患）。

### 2. 同一项目群请求串行化（`GroupChat`）

- `send()` 全流程包进按 `projectId` 的互斥队列（leader 首回合 → worker 串行 → leader 总结不可交叉），不同项目并行；
- `ensureSession` 加 per-key 创建锁：同一 (群, thread, agent) 并发调用只创建一次会话，防 KV 指针互相覆盖；
- `runTurn` 落库后 `threads.touch()`；`Delegator` worker 结果回群后补 `touch`。

### 3. `OcClient` 网络诊断与超时

- `req()` 统一捕获异常：
  - 连接层失败 → 记 `oc-req-fail` 调试日志（`method/path/port/elapsedMs/sidecar 状态/err.name/message/cause`），包装为 `引擎服务连接失败（127.0.0.1:端口 METHOD path）：…` 并保留原始 `cause`；
  - `TimeoutError/AbortError` 与 HTTP 非 2xx 原样抛出（前者保住「已停止生成」判定，后者不能误报成连接失败）；
- `sendMessage` 总预算从进入时计：POST 与 `getMessages` 轮询共用剩余时间（`getMessages` 增加 timeout 参数）；
- `abortSession` 的 `/abort` 失败写 `abort-fail` 日志，不再静默；
- SSE：`sse-eof`（服务端正常关流）与 `sse-error`（含端口/name/message）诊断，`/global/event` 行为不变。

### 4. 群聊部分成功返回

- `group.ts`：仅包住最终 leader summary 回合的非停止异常——worker 成果与 `runTurn` 已写的失败系统消息保留，追加「成员执行结果已保留，可再发一条消息让其总结」系统提示，返回 `summaryFailed`；worker 阶段失败仍整体 reject；
- `ipc.ts`：`group:send` 返回类型同步；渲染层无需改动（invoke 正常 resolve，历史刷新即展示系统消息）。

## 测试

- `group.test.ts` 新增 4 用例：summary 失败可恢复（严格 3 次调用、无自动第 4 次 POST、成果与系统消息保留）、worker 阶段失败整体 reject 不触发总结、同项目并发串行/跨项目并行（maxActive=2）、`ensureSession` 并发只建一次会话；
- 新增 `tests/oc.test.ts`（本地 http mock 5 用例）：端口不可达包装错误+cause+诊断日志、HTTP 500 不误报连接失败、总 deadline 覆盖 POST+轮询、happy path、abort-fail 日志；
- 新增 `tests/sidecar.manager.test.ts`（假 opencode 脚本 3 用例）：start 发 ready(port, generation=1)、崩溃自动重启换代（generation=2、新实例健康）、stop 干净退出；
- 全量 `npm test` 114 通过；typecheck 仅剩 `apps/desktop/e2e` helper 3 个既有报错（HEAD 上已存在，与本次无关）。

## 验证与发版

- `npm run package:linux` → `jeff-desktop_1.7.9_amd64.deb`（本机 `sudo dpkg -i` 安装验证）；
- `npm run package:win` → `jeff-Setup-1.7.9.exe`；
- 按约定不打 tag / 不发 release。

## 排查指引（下次遇到类似问题）

- `group-send-fail` 错误为裸 `fetch failed` 且无 `assistant-error` → 本机 sidecar 连接问题，看同一时间的 `sidecar-status`（crashed/starting）与新增的 `oc-req-fail`（含端口/cause/sidecar 状态）；
- 有 `assistant-error` → 请求已进入 opencode/LLM 层（证书/上游问题），与 sidecar 本地连接无关；
- `sidecar-ready` 日志（新增）记录每次启动的端口与代际，可对账「请求端口 vs sidecar 实际端口」。
