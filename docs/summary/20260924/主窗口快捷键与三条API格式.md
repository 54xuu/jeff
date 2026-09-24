# 主窗口快捷键与三条 API 格式

- 日期：2026-09-24
- 版本：1.8.28
- 对照：ZCode `normalizeModelProviderBaseUrlForKind`、`normalizeAnthropicBaseURL`、`withAnthropicAuthorizationHeader`（`packages/services/src/model-provider/legacyModelProviderSerialized.ts`、`apps/zcode-cli/packages/adapters/src/model/model-execution.ts`）

## Ctrl+Alt+F 显示 / 隐藏主窗口

菜单「显示 → 显示/隐藏主窗口」，加速键 `CmdOrCtrl+Alt+F`。另外用 Electron `globalShortcut` 注册同一组合，窗口藏到后台、Jeff 不在前台时也能唤起。

- 窗口已在前台：隐藏，进程不退出，托盘还在。
- 最小化、被挡住或已经隐藏：还原并抢到前面。
- 窗口已经被关掉：重新打开。
- 菜单加速键和全局热键若在同一次按键里各触发一次，400ms 内只执行一次，避免藏起来又立刻弹回。
- 封闭测试和冒烟（`JEFF_E2E` / `JEFF_SMOKE`）不注册全局热键，避免抢本机按键。
- Windows 和 X11 用 Electron `globalShortcut`。本机是 GNOME Wayland，这条 API 注册任何组合都返回失败，所以改写 GNOME 自定义快捷键 `jeff-toggle`：绑定 `<Control><Alt>f`，命令是当前可执行文件加 `--toggle-window`。已在跑的实例收到第二次启动后切换显隐；没在跑就直接打开。已有的其它自定义快捷键只追加、不覆盖。

## Chat / Responses / Anthropic 的请求地址

opencode 1.18.30 自带的 AI SDK 会在 baseURL 后面自己追加路径：

| 格式 | npm | SDK 追加 | 实际请求 |
|------|-----|----------|----------|
| Chat | `@ai-sdk/openai-compatible` | `/chat/completions` | `{前缀}/chat/completions` |
| Responses | `@ai-sdk/openai`（默认就是 Responses，不是 Chat） | `/responses` | `{前缀}/responses`，前缀保留 `/v1` |
| Anthropic | `@ai-sdk/anthropic` | `/messages` | `{前缀}/v1/messages` |

以前探测和真实发送各拼各的。Anthropic 只在 baseURL 恰好是 `https://api.anthropic.com` 时才会自动补 `/v1`，网关根地址会打到 `/messages` 而不是 `/v1/messages`；探测却总是拼 `/v1/messages`，所以设置页显示能连、对话却失败。用户把完整地址（已经带 `/chat/completions` 或 `/responses`）贴进 baseURL 时，SDK 会再拼一层。

现在写入 `opencode.json` 和设置页探测共用 `sdkBaseURL`：

- 剥掉用户粘贴的终点后缀，`/v1` 留下。
- Anthropic 没填时用 `https://api.anthropic.com/v1`；填了网关前缀（如 `https://host/anthropic`）则补成 `…/v1`，再由 SDK 追加 `/messages`。
- 完全重复粘贴的绝对地址（`https://host/v1/https://host/v1`）折成一份。
- Responses 继续写 `setCacheKey: false`，工具桥继续拿掉网关不认的 `include` / `reasoningSummary` / `textVerbosity` / `promptCacheKey`。
- Anthropic 探测同时带 `x-api-key` 与 `Authorization: Bearer`。对话时工具桥在 `chat.headers` 里给 `@ai-sdk/anthropic` 补 Bearer（已有 Authorization 则不动）。SDK 自己仍会带 `x-api-key` 和 `anthropic-version`。

设置页三条格式的说明改成上述路径，新建提供商时也能看到。
