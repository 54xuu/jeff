# 真实模型 E2E 与打包后验证

本文件由 [`AGENTS.md`](../../AGENTS.md) 拆出。第一层「所有任务必跑」的命令留在 AGENTS.md；这里是第二层（真实模型 E2E）与第三层（打包后产物验证）。

## 第二层：涉及「聊天 / 流式 / 工具 / MCP / 权限 / 群协作」的改动必跑真实模型 E2E

mock 只覆盖 happy path；流式一致性、权限挂起、MCP 拉起这类跨进程问题只有真 sidecar + 真模型能暴露。做法（v1.7.24 已跑通 8 轮全绿，测试台在 `.tmp/live8/`，可复制改造）：

1. **测试台**：`.tmp/liveN/` 放 `seedN.mjs`（预置 home：provider 用硅基流动 `deepseek-ai/DeepSeek-V3.2` + thinking=high、智能体、项目群、MCP 配置）+ `liveN.spec.ts` + `playwright.config.ts`（timeout 20 分钟、workers=1、serial）。凭据读 `.tmp/e2e.env`，不写进仓库。
2. **驱动方式**：`launchJeff({ home })`（home 已有 jeff.db 不要再传 seed）；回合结束判据 = **先等 `chat-stop` 出现、再等 `chat-send` 回来**（不能只看流式 caret，工具步之间会短暂消失）。
3. **验收判据**：不止看 UI——用 `window.jeff.invoke('chat:history'/'group:history')` 对账落库的 `text/reasoning/tools`；文件类任务断言产物文件内容；配置类任务（小杰代操）断言 DB/kv 真的变了。流式期间所见必须在完成后仍能在落库里找到。
4. **每轮截图**（`page.screenshot` fullPage 到 `evidence/`）+ 数据 JSON 留档，**人工目检截图**（布局、时间戳、暗/亮主题、链接可读性）。
5. 运行：`cd apps/desktop && JEFF_OPENCODE_BIN=<资源目录 opencode> npx playwright test -c ../../.tmp/liveN/playwright.config.ts <spec 绝对路径>`。
6. 常见坑：`pkill -f` 会匹配自身命令行把 shell 杀掉（别在同一条命令里用）；真实模型单轮可达数分钟，超时放够；权限类问题必须读「项目工作树之外、不在 /tmp」的路径才复现得出来。
7. **工具参数形状要拿真模型验**（v1.8.2 血泪）：把某个工具参数声明成裸 `type:'object'` 时，模型侧会把整个对象丢成空串——插件就落成「没有 MCP、没有附带文件」的半成品，而模型还会在回复里言之凿凿地说配置好了。给模型的参数**只用标量 / 标量数组**（或数组里包对象，那个是好的），**嵌套对象一律拆成平铺字段**（如 `mcp_url` / `mcp_command` / `mcp_headers`），并在实现里对空串做「视为未传」的兜底，否则模型一次「全字段补空」的 update 就能把已配好的字段抹掉。
8. **agent 用哪条路完成任务，只有真模型能告诉你**：同一次 R7 里，模型先调 `jeff_plugin_*`，参数没进去之后**自己改用 `bash`/`edit`/`write` 直接改磁盘上的 `plugin.json`**——虽然结果碰巧对了，但这既绕过了工具语义，也说明「管家不该有文件工具」这条指令当时是句空话。发现这类「绕路」要当成产品 bug 修（改工具形状 + 真禁掉不该有的工具），而不是把断言改松。
9. **日志是最好的证据**：`<home>/logs/debug-<date>.log` 里 `tool-pending` / `tool-start` / `tool-done` 三行带完整 `args` 与 `output`，能直接看出「模型到底传了什么」。断言失败时先看它，别猜。
10. **没有模型也能覆盖真链路**（v1.8.3 新增）：`<home>/oc-home/config/opencode/plugin/jeff-bridge.js` 里有工具桥的 `BASE` 与 `TOKEN`，测试进程直接 `POST /tools/<name>` 就是「真工具 + 真跨进程 + 真落库」——v18 封闭套件用它覆盖了定时任务边界、插件校验、浏览器点击/填表/上传/错误分析。定时任务到点、插件 MCP 注入这类**时间与引擎**相关的能力仍必须真模型跑。
11. **验收要落在服务端事实**：表单断言**服务端收到的字段**、上传断言**服务端收到的字节**、插件断言 **MCP 服务端收到的调用与请求头**、定时任务断言 **DB 运行记录**。只看 DOM 或模型回复会漏掉「说成功了其实没落地」。
12. **「测试没通过」先分清是谁的锅**：v1.8.3 的 27 轮里，初版失败的 8 轮有 5 轮是**测试台自己的假设错了**（按旧标题查库、把 `plugin.json` 当越权靶子——它其实是 `jeff_plugin_update` 的正当对象、误判「软删要顺手改 enabled」、跨轮复用 home 导致旧 URL 残留）。改测试断言前先问一句：这是产品语义错了，还是我的预期错了？

## 密码库注入

封闭验收不依赖模型成功回复：

1. 设置 → 密码写入变量（例如 `PROBE_SECRET`），确认页面默认只显示末 4 位，数据库在钥匙串可用时不含明文。
2. 点「立即重启引擎」。`JEFF_E2E=1` 时 `debug:sidecarEnvKeys` 只返回变量名和值的 SHA-256 前 8 位，用它核对注入的是密码库的值，而不是系统里的同名变量。
3. 真实模型抽查：临时 skill 只把变量的哈希写到工作区文件，不断言模型回复文本。停用该条目并重启后，同一脚本应报告变量缺失。
4. 让模型执行 `echo $PROBE_SECRET` 时，Jeff 的 `chat_message` 和 `logs/debug-*.log` 不应再含明文。模型提供商已经收到的工具结果无法撤回。

## 第三层：打包后产物验证

deb：`dpkg -l jeff-desktop` 版本正确 + `/opt/Jeff` 与 `linux-unpacked` 的 app.asar md5 一致；exe：`file` 为 PE32 Nullsoft + `grep -a <本次改动特征串> win-unpacked/resources/app.asar` 命中 + `oc-bin/windows-x64/opencode.exe` 在位。
