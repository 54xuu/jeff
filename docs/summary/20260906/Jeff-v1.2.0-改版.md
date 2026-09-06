# Jeff v1.2.0 改版：供应商重构 / 思考模式 / MCP 重做 / 记忆与 AGENTS.md / Skills 备份

> 日期：2026-09-06 · 版本：v1.1.0 → v1.2.0 · 产物：`apps/desktop/release/jeff-desktop_1.2.0_amd64.deb`（188MB）、`Jeff-1.2.0.AppImage`

## 一、本次需求与落地情况（全部完成）

| # | 需求 | 落地 |
|---|------|------|
| 1 | 图标改绿底白字「JF」（zcode 风格） | 重写 `gen-icon.mjs` 字母几何绘制，重新生成全套 png + tray |
| 2 | 模型选择按 `{提供商名称} / {模型ID}` 显示 + 右侧思考模式下拉 | `ChatWindow`/`GroupWindow`：chip 文本按规格；思考档位来自供应商配置，随消息发送 `variant` |
| 3 | 去掉内置供应商，专注自定义 | UI 入口移除；旧 builtin 数据升级时直接丢弃（`migrateProviders`） |
| 4 | API 格式支持 Chat / Responses / Anthropic | `apiFormat` 三选一 → opencode npm 包 `@ai-sdk/openai-compatible` / `@ai-sdk/openai` / `@ai-sdk/anthropic` |
| 5 | 供应商页横向 tabs + 永远的【+】 | `ProviderSettings` 重构：tab 列表（启用状态点）+ 末尾【+】+ 右侧详情（启用/禁用/删除） |
| 6 | 每个提供商可启用/禁用/删除 | `enabled` 字段；禁用的提供商不写入 opencode.json、不参与默认模型 |
| 7 | 去掉「默认模型」设置 | 会话兜底 = 第一个启用提供商的第一个模型（动态计算，写 `model`/`small_model`） |
| 8 | 添加模型：ID/上下文/最大输出/输入类型/输出类型/思考模式 | 模型表单全覆盖；输出类型固定文本；思考模式多选 none/low/high/max |
| 9 | OpenAI 与 Anthropic 思考控制差异 | 统一映射：OpenAI 系 `reasoningEffort`（max→high）；Anthropic `thinking.budgetTokens`（low=4096/high=16384/max=32768，none=显式禁用）→ 写入模型 `variants` |
| 10 | MCP：JSON 输入框直接粘贴 + 报错提醒 + 列表（工具/状态） | `parseMcpServersJson` 双格式兼容（`mcpServers` 包裹 / opencode map / Claude command+args+env 自动转换）；解析成功预览后合并；列表每项显示连接状态 + 工具清单（`@modelcontextprotocol/sdk` 直连 `tools/list`，10s 超时）+ 启用/禁用/删除 |
| 11 | 记忆：确认触发方式 + 防浪费 + 小杰整理 | 保持模型自主触发（jeff_memory 工具，说「记住/忘记」即可）；管理页条目化（§ 分条、单条删除）+ 字符预算占用条（user 1375 / 其他 2200） |
| 12 | 用户级 + 项目级 AGENTS.md | 用户级 `<data>/AGENTS.md` + 项目级 `<工作空间>/AGENTS.md`，每轮 system 注入；设置 → 记忆页可编辑 |
| 13 | opencode 状态显示 + 重启按钮 | 新设置页「引擎服务」：状态/端口/opencode 版本/二进制路径/数据目录 + 重启服务 + 最近 300 行日志 |
| 14 | 聊天侧栏只留【+】，菜单含「发起群聊」（气泡图标） | 【+】菜单两项：新建会话（当前对象）、发起群聊 |
| 15 | 群聊选工作空间目录，输出文件落工作空间 | CreateGroupModal 加目录选择（Electron 目录选择器 + 手输）；opencode 会话按 `?directory=` 锚定到该目录；群上下文提示词声明输出目录 |
| 16 | 通讯录左右布局，每个智能体可设「指令、模型、思考程度」 | `AgentsPage` 重构：左列表右表单；小杰可配模型/思考（名称头像指令锁定） |
| 17 | skill 直接用 `~/.agents/skills` | opencode.json 写入 `skills.paths: ["~/.agents/skills"]`（v1.18 原生支持 `~` 展开，免 symlink，跨平台） |
| 18 | WebDAV 备份 skills + 冲突安全 | 见下节「安全模型」 |
| 19 | 修完更新本机到最新版 | deb 已产出（1.2.0）；`dpkg -i` 需要密码，见「待办」 |

## 二、Skills 备份安全模型（重点，不可出错的部分）

skills 目录是用户与其他工具（zcode 等）共享的，Jeff 不是属主，因此**绝不能套用实体同步的双向合并**：

1. **单向备份**：自动/手动同步只把 `~/.agents/skills` 上传到 `<basePath>/skills/**`；本地文件永不自动写回。
2. **本地删除不传播**：本地删掉的文件远端保留（只增不删）。
3. **版本归档**：上传前对比内容（FNV-1a hash + 长度），远端同名不同内容时，先把远端旧文件归档到 `<basePath>/skills-versions/<相对路径>/<时间戳>` 再覆盖（`overwrite: false`，绝不覆盖归档）。多台设备交替备份不互相抹历史。
4. **两段式恢复**：
   - 「从备份恢复…」→ 下载远端全量到 `<data>/restore-staging/skills` 预览清单（不碰本地）；
   - 确认后 → 先把本地整个 skills 目录快照到 `<data>/backups/skills-<时间戳>/`（本地兜底，可手工回退）→ 覆盖式恢复（只覆盖备份里存在的文件，**绝不删除本地多出的文件**）。
5. **重入锁**：`sync()` 加 in-flight 锁（顺手修复的隐患：自动定时器与手动按钮并发会交叉读写远端、弄脏 `sync:laststate`）；并发调用返回「上一轮同步仍在进行，本次跳过」。

冲突只剩一种形态：两台设备改了同一个 skill → 远端为最后上传版本 + 旧版本在 versions 里 + 本地从未被自动修改。测试覆盖：`tests/skills-sync.test.ts`（含本地快照、不删除、归档、重入锁断言）。

## 三、两个关键技术结论（源码级验证）

1. **opencode v1.18.26 原生支持 per-message 思考档位**：`POST /session/:id/message` 的 `PromptInput` 有 `variant?: string` 字段，取值即模型配置 `variants` 的 key —— 会话内切换思考档位不需要任何 hack。
2. **opencode v1.18.26 原生支持按目录建会话**：session 端点带 `WorkspaceRoutingQuery`（`?directory=`），群聊会话可直接锚定到项目工作空间目录（文件操作以该目录为根）。注意 `WorkspaceRoutingQueryFields` 是 `directory` + `workspace` 两个查询参数。

## 四、踩坑记录

1. **WebDAV mock 的 PROPFIND 自引用**：mock（以及部分真实服务器/代理）列目录会返回目录自身 href（带尾斜杠），递归扫描会无限循环。`listRemoteFiles` 必须跳过「与当前目录同名的子项」并做 visited 去重 —— 真实环境同样需要这个防御。
2. **旧 CSS 规则打架**：`.agents-page` 在 v1.0 被定义为 `flex-direction: column`（当时它就是列表页），v1.2 改左右布局时只覆盖 `display:flex` 不够，必须显式 `flex-direction: row`，否则编辑器被堆到列表下面。
3. **AgentsPage 挂错容器**：原来它在 list-pane 里渲染，改成左右布局后编辑器被挤在 300px 栏里 —— 通讯录要整页搬进 main-pane（App.tsx），空 list-pane 用 `.list-pane:empty { display:none }` 收起。
4. **旧打包产物假象**：排查「思考下拉不显示」时反复被旧 asar 误导（`linux-unpacked` 不 `rm -rf` 就复用旧产物）。验证打包内容用 `npx asar list`/`extract-file` 对 hash，别信目录时间戳。
5. **CDP 调试残留**：`--remote-debugging-port` 调试实例被 SIGKILL 后会留下孤儿 opencode sidecar + Electron 单实例锁（`~/.config/Jeff/Singleton*`），后续正常实例会秒退。清理：杀进程 + 删锁文件。
6. **`--enable-logging`**：packaged Electron 的渲染层 console 只有加这个参数才能在 stdout 看到，是排查「UI 为什么这样」最快的路径。

## 五、已知行为（非 bug）

- **冷启动 7~8 秒内模型目录为空**：sidecar 启动完成后模型列表/思考下拉才出现（已做三重兜底：refreshCatalog 重试 12×2s、sidecar-status 事件补拉、主进程 did-finish-load 补发状态）。期间 chip 显示 `providerID / modelID` 兜底文本，不影响使用；配置页保存后立即刷新。
- **MCP 探测与 sidecar 无关**：探测是 Jeff 直连（显示「能不能连、有哪些工具」），配置是否被 opencode 加载以引擎重启为准。

## 六、验收记录

- `npm run typecheck` ✅；`npm test`：**70 passed / 11 skipped（81）**，新增 `configwriter.test.ts`（迁移/兜底模型/variants 三格式）、`mcparse.test.ts`（双格式解析）、`skills-sync.test.ts`（备份安全模型 + 重入锁）
- 冒烟截图（`.tmp/smoke-v12h`、`.tmp/smoke-release`）：聊天页模型 chip `我的中转 / gpt-4o` + 思考下拉 ✅、供应商 tabs ✅、MCP 导入/列表 ✅、记忆条目+预算+AGENTS.md ✅、引擎服务（版本/端口/重启/日志）✅、通讯录左右布局（小杰可配模型/思考）✅、WebDAV + skills 备份区 ✅
- 群聊会话按 `?directory=` 锚定工作空间（运行时验证建议：建群选目录 → 群里让它写文件 → 检查文件落在该目录）

## 七、遗留 / 待办

- **本机安装**：`sudo dpkg -i apps/desktop/release/jeff-desktop_1.2.0_amd64.deb`（需要密码，未能代执行；安装后重启 Jeff 即为 1.2.0）
- 之后要发 GitHub Release 时打 `v1.2.0` tag 走 CI（双平台产物）
- MCP 探测结果未来可缓存到 kv，避免每次进设置页都重连
- `skills.paths` 未来可做成设置项（现在固定 `~/.agents/skills`，配置里已有的 paths 会保留合并）
