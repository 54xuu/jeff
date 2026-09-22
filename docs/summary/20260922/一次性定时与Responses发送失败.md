# 一次性定时任务与 Responses 发送失败

- 日期：2026-09-22
- 对照：ZCode `packages/services/src/session/automationCron.ts`（`recurring=false` 的一次性自动化，过点不滚到下一年）

## 定时任务：今天 12:00 只跑一次

以前只有 5 段 cron。把「今天 12:00」写成 `0 12 22 9 *` 之后，过了这一分钟就会被排到**明年**的同一天。

现在任务可以带绝对时间 `run_at`：

- 界面：新建任务先选「重复 / 仅一次」。仅一次用日期时间，并有「今天 12:00」。
- 小杰：`jeff_cron_create` / `jeff_cron_update` 增加标量参数 `run_at`（`今天 12:00`、`明天 08:30`、`2026-09-22 12:00`）。和 `cron_expr` 一起传时以 `run_at` 为准。
- 到点入队后 `finishOnce` 停用任务并清掉下次触发，推进 `updated_at`，别的设备同步后不会再跑。
- 已经过去超过 1 分钟的目标直接拒绝，不会悄悄改期。刚过去不到 1 分钟视为立刻执行。
- 同步仍重算重复任务的 `next_run_at`；一次性只认 `run_at`，过点后留空。

## Responses API 的 400

用本机 opencode 1.18.30 对 `opencode-go`（`@ai-sdk/openai` → `/responses`）发一轮对话是成功的。400 出在两类请求上：

1. Zen Go 的 `/responses` 没有 `x-opencode-session` 时，网关返回 `MissingSessionID`（HTTP 400）。引擎只在 provider id 以 `opencode` 开头时自动加这个头。
2. 自定义 Responses 端点不认官方才有的 `include`（`reasoning.encrypted_content`）、`reasoningSummary`、`textVerbosity`、`prompt_cache_key`，整请求被拒。

改动：

- Responses 供应商写入 `setCacheKey: false`，避免 opencode 再塞 `prompt_cache_key`。
- 工具桥插件增加 `chat.params`（非官方 `openai` 的 `@ai-sdk/openai` 去掉上述字段）和 `chat.headers`（baseURL 含 `opencode.ai` 时补上 session 头）。
- 聊天失败时把上游 `error.message` 写进提示（例如「上游返回：Request is missing x-opencode-session」），不再只剩一句「上下文超长或参数不被支持」。

## 测试

- `@jeff/core` 单测 306 通过。
- 新增：`今天 12:00` 解析、过点拒绝、一次性到点停用、同步不滚到明年、工具 `run_at`、400 文案带上游原因。
- 桌面封闭 E2E：`ui` 1 通过，`cron` 11 通过（含「仅一次」把 `2099-06-01 12:00` 写入 `run_at`），`v18` 4 通过。
- 版本 PATCH `1.8.21` → `1.8.22`。
