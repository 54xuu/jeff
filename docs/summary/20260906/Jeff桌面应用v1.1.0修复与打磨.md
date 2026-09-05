# Jeff 桌面应用 v1.1.0 修复与打磨（总结）

> 本文记录 v1.0.0 Windows 安装后反馈的 8 项问题修复与整体打磨。仓库：https://github.com/54xuu/jeff · 版本：v1.1.0
> 上篇：`docs/summary/20260905/Jeff桌面应用设计与实现.md`

## 一、8 项问题落地情况（8/8）

| # | 问题 | 根因与落地 | 状态 |
|---|---|---|---|
| 1 | 本地找不到 Windows/Linux 安装包 | electron-builder 输出目录是 `apps/desktop/release/`；本地此前只有旧 0.1.0 Linux 包（版本 bump 前构建），Windows 包只在 CI（windows runner）构建后直传 Release，本地从未生成。本次本地构建出 `Jeff-1.1.0.AppImage` + `jeff-desktop_1.1.0_amd64.deb` 并验证；「关于」页补充安装包位置说明 | ✅ |
| 2 | 菜单是英文 | 应用从未设置菜单，显示的是 Electron 默认英文菜单。新增 `setupAppMenu()` 中文模板（文件/编辑/视图/窗口/帮助，role 保留快捷键，关于 = 中文对话框）；托盘本就是中文 | ✅ |
| 3 | 设置页中间一坨、右边空白 | 设置页被塞进 280px 的中栏 `.list-pane`，右栏只有静态提示。重构为「左（分组导航）+ 右（内容区）」布局：SettingsPage 拆成 6 个子组件（模型供应商/MCP 连接器/记忆/WebDAV 同步/外观/关于），`store.settingsSection` 驱动切换 | ✅ |
| 4 | 增加硅基流动 + 图片识别实测 | 见「二、2/3」；预设提供**中国站（siliconflow-cn）/国际站（siliconflow）**两个条目；用 `Qwen/Qwen3.5-9B` 真实实测识别 `~/Pictures/a033c9b7f84d2bba84dee3814d6d6499.jpeg` 成功（准确描述检验报告单内容与红框异常指标） | ✅ |
| 5 | MCP 连接器支持编辑 JSON | 每个 MCP server 增加「编辑 JSON」弹窗（opencode 原生格式、等宽字体），保存前用 `parseMcpServerJson`（core 纯函数，含单测）做结构校验：local 必须有字符串数组 command，remote 必须 http(s) url，headers 必须键值对象 | ✅ |
| 6 | 点深夜但右下角显示太阳、点击无效 | 根因：主题按钮点击只改 DOM 不更新 zustand store，且主进程 `settingsSet` 不发 `data-changed` 推送 → store 里的 theme 永远是旧值，按钮再点永远算出同一个 next（可能永远切不回亮色）。修复：走 store + `applyTheme` + 主进程补 emit；图标按**生效主题**（system 解析后）显示；tooltip 动态（切换到亮色/深夜模式）；settings 未加载时禁用。注：按钮在左栏底部（仓库里仅此一处主题按钮），太阳图标=当前深夜属刻意设计 | ✅ |
| 7 | 项目记忆怎么实现 | 后端 v1.0.0 已实现（`memory/projects/<projectId>/MEMORY.md`，群聊 agent 自动沉淀），只是 UI 没露出。记忆设置页重构为分层展示：全局用户画像 / 智能体记忆 / 项目群记忆（空记忆显示占位与说明），可人工编辑保存 | ✅ |
| 8 | 版本号规范 | 已确认语义化规则：bug→patch、功能→minor、重构→major。本次含新功能 → 统一 bump **1.1.0**（root + core + desktop + APP_VERSION），提交后打 tag `v1.1.0` 触发 CI 双平台发布 | ✅ |

## 二、计划内新功能（解决「像 demo」）

1. **Markdown 渲染**：react-markdown + remark-gfm + rehype-highlight，替换私聊/群聊气泡的纯文本 `<p>` 渲染；表格/任务列表/删除线可用，代码块带语言标签 + 复制按钮 + 双主题高亮配色。react-markdown 默认不渲染裸 HTML，无 XSS 注入面。
2. **流式输出**：消费 opencode SSE `message.part.delta`（载荷 `{sessionID, messageID, partID, field, delta}`）与 `message.part.updated`（全量纠偏），core 按 sessionID 解析归属后经 bus → IPC `chat-stream` 推渲染层；渲染层增量气泡 + 闪烁光标，完成信号（`message.updated` completed / `session.idle`）后清缓冲并拉全量兜底。只推 assistant 消息（按 message.updated 的 role 过滤用户回显）。
3. **图片消息（多模态）**：私聊 + 群聊 composer 支持附件按钮 / 粘贴 / 拖拽，dataURL 缩略图预览；IPC `chatSend/groupSend` 增加 `images`；core 映射为 opencode file part（`{type:'file', mime, url: dataURL}`）；自定义 provider 需在模型上声明多模态能力（见踩坑 2）；历史回放还原图片（私聊从 opencode parts、群聊从 `chat_message.meta.images`）；点击图片看大图。

## 三、额外发现并修复的隐藏 bug（4 个是「功能本来就没通过」级）

1. **群聊 agent 回复内容一直是空的**（v1.0.0 起）：`OcClient.sendMessage` 轮询 `GET /session/:id/message` 时只取了列表条目的 `info`，而 parts 在条目顶层 → `reply.parts` 恒空 → 群聊落库内容为空。修复：合并 `entry.parts` 回 info。
2. **内置预设 provider 的 API Key 从未生效**（v1.0.0 起）：auth.json 写在了 config 目录，而 opencode 从 `$XDG_DATA_HOME/opencode/auth.json` 读密钥 → 内置预设（Anthropic/OpenAI/DeepSeek…）保存后目录里根本不出现。修复：auth.json 改写 `ocDataHome/opencode/auth.json`，实测硅基流动目录正常出现 47 个模型。
3. **自定义 provider 无法发图片**：opencode 按模型元数据（`attachment` + `modalities.input 含 image`）决定是否转发图片，未声明时会把图片替换成「model does not support image input」错误文本。修复：configWriter 为声明了多模态的模型写入 `{attachment: true, modalities:{input:['text','image'],output:['text']}}`；AddProvider 表单增加「支持图片输入」勾选。
4. **agentSlug 撞名**：16 字符截断可能碰撞且文件名即 agent 名 → 加 4 位 sha1 短哈希后缀（`registry.syncAll` 自动清理旧格式文件，slug 变更安全）。
5. 杂项：`ipc.ts` 死变量、`memoryTools.ts` 空 finally、`Delegator.perMessageCount` 无限增长（加 30min TTL 清理）、`npm run smoke` 指向被 gitignore 的 `.tmp` 脚本（移至 `scripts/smoke.mjs` 并提交）、`.zcode/` 入 gitignore。

## 四、关键踩坑（对二次开发最有价值）

1. **opencode 图片转发有三道门**：① 消息 parts 用 `{type:'file', mime, url: dataURL}`（OpenAPI `FilePartInput`）；② 模型必须声明 `attachment:true` + `modalities.input:['text','image']`，否则图片被替换成错误文本进 prompt；③ models.dev 有 `siliconflow`（国际站 .com）与 `siliconflow-cn`（中国站 .cn）两个 provider，**两站 Key 不通用**——中国站 Key 必须选 siliconflow-cn。
2. **opencode 密钥文件在 data 目录**：`$XDG_DATA_HOME/opencode/auth.json`，格式 `{type:'api', key}`；放 config 目录无效。
3. **SSE 流式事件**：`message.part.delta` 只在流式 LLM 输出时触发（载荷含 field/delta）；`message.part.updated` 是全量快照可做纠偏；完成以 assistant `time.completed` 或 `session.idle` 为准。用户消息的 part 回显也会走这些事件，必须按 role 过滤。
4. **electron-vite 别名**：渲染进程 `@jeff/core` 被别名到 `ipc/contract.ts`（避免 node 依赖进浏览器 bundle）→ 渲染层要用的纯 TS 工具必须从 contract.ts 再导出（本次 `parseMcpServerJson/McpServerCfg` 因类型循环引用还引发了 rollup 绑定错乱，解法：类型定义移到 `mcp/parse.ts` 单点）。
5. **E2E 必须串行**：多个 E2E 文件并行 = 多个真实 sidecar + mock LLM 抢资源，随机超时/ECONNRESET；`vitest run --no-file-parallelism` 稳定全绿。
6. **打包产物必须重打 asar**：`electron-vite build` 只更新 `out/`，`linux-unpacked`/安装包里的 `app.asar` 仍是旧代码——冒烟验证前必须重跑 electron-builder。
7. **opencode 400 排查路径**：BadRequest 不带明细时，先看 OpenAPI `components.schemas`（serve 模式 `GET /doc`）里对应 Input schema 的 required 字段，比猜快得多。

## 五、测试与验收记录

- **单测 56/56**：新增 MCP JSON 校验（8 用例）、群聊图片 meta 往返；configwriter 断言更新（auth 路径）。
- **E2E 11/11**（`JEFF_E2E=1` + `--no-file-parallelism`，真实 sidecar + mock LLM）：新增流式增量事件（单调增长 + done 收尾 + 完成后无残留）、图片 part 透传（mock 确认收到 image_url）+ 历史回放还原 images。
- **真实 API 实测**：硅基流动中国站 + `Qwen/Qwen3.5-9B`——文本对话 ✅；图片识别 ✅（准确描述检验报告单与红框异常指标）；历史回放 images ✅。
- **打包冒烟**：`scripts/smoke.mjs` 多视图截图（chat/contacts/settings 六分组 × 亮/深夜主题），逐张人工审查布局与交互；最终 `Jeff-1.1.0.AppImage` 冒烟通过（关于页 v1.1.0、引擎 running）；deb 解包验证主程序/桌面入口/内嵌 opencode 二进制齐全（本机无免密 sudo，未做 dpkg -i 安装）。
- **CI**：push tag `v1.1.0` 触发 release matrix（ubuntu + windows），产物自动上传 GitHub Releases。

## 六、遗留事项（建议后续迭代）

- 项目绑定本地代码目录（agent 在指定目录干活、记忆按目录沉淀）——已与需求方确认放下一版专项
- 会话搜索 UI 入口、私聊历史会话切换 UI（能力已具备）
- 流式输出在群聊 @多成员委派场景的呈现细化（当前只流式显示当前回复者）
- Windows 包的 GUI 冒烟自动化（CI 上仍无截图验证）
- opencode 升级评估（锁定 1.18.26）
