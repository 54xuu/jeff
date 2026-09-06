# Jeff v1.3.0：对话体验重构（参考 Codex / opencode desktop）

> 日期：2026-09-06 · 版本：v1.2.0 → v1.3.0 · 定位校准：「Code + Work」agent 工作台（Vibe Coding + 项目管理文档输出）

## 一、需求与落地（grill-me 拷问后 6 项决策全部落地）

| # | 需求 | 决策与实现 |
|---|------|-----------|
| 1 | 应用菜单像编辑器 | 重排为 agent 应用型五组：**Jeff**（关于/设置 Cmd+,/退出）、**文件**（新建会话 Cmd+N、发起群聊 Cmd+Shift+N、打开小杰 Cmd+1）、**编辑**（标准）、**显示**（亮/暗/跟随系统、缩放、开发者工具）、**帮助**（使用说明 Cmd+/、GitHub）。菜单动作经 `jeff:push` 广播到渲染层执行；去掉默认「窗口」组 |
| 2 | 回复后看不到思考/工具调用 | assistant 气泡内折叠区：「思考过程」（reasoning parts 采集，历史+流式）+「工具调用 N」（每工具一行 名称+状态，展开看输出，>2000 字符截断可展开全文）；流式过程中思考实时累积 + 工具状态行（SSE `message.part.updated` 的 tool part） |
| 3 | 发送应变停止按钮 | 同位置图标切换：发送中变红色方块停止按钮，私聊 abort 会话；群聊新增 `group:stop` IPC（abort 最近路由会话 `session:group:last:<projectId>`），停止后在群里落「⏹️ 已停止生成」系统消息；头部文字「停止」移除 |
| 4 | 新会话后历史看不到（微信式聊天记录） | 头部时钟图标 → 右侧抽屉：私聊列出该 agent 全部会话（opencode session list 按 agent slug/标题前缀过滤 + 当前高亮）；群聊按成员分组（含 `?directory=` 目录会话）；点会话预览完整历史；「继续此会话」切为当前（写 kv 指针）；删除旧会话（同步清悬空指针，`kv.prefixScan`） |
| 5 | 智能体两侧颜色一样很怪 | 左列表对齐聊天列表（选中态绿底+右侧绿条），右编辑区浅色分层 |
| 6 | 模型要可搜索、只显示供应商里添加的 | 数据源从 opencode 平台接口切到 `settings:providers`（`modelsConfigured` IPC，禁用提供商不出现，顺带解决内置 opencode 免费模型混入）；新组件 `ModelPickerCombo`（搜索过滤+按提供商分组+档位标签）用于智能体表单；聊天 composer 菜单顶部加搜索框 |
| 7 | 参考 opencode desktop | 采纳其「会话可回溯」理念做历史抽屉；气泡保持微信式但 assistant 弱化为浅底无边框卡片（codex 阅读感） |

## 二、实现要点

- **reasoning 全链路**：历史 `mapSessionMessages` 提取 `reasoning` parts → `ChatMsg.reasoning`；流式 SSE `message.part.delta` 增加 `field==='reasoning'` 增量与 `message.part.updated` 纠偏，`evChatStream` 载荷扩展 `reasoning`/`tools`；群聊回复把 reasoning/tools 存进消息 meta（`history()` 还原），替代原来顶部的 `🔧` 文字行。
- **会话列表过滤**：opencode `GET /session` 支持 `?directory=`（群聊目录会话）；私聊按 `agent === agentSlug(id)` 或当前指针或标题前缀 `与 X 的聊天` 过滤。
- **模型目录**：`configuredModelOptions(providers)` 纯函数（单测覆盖），composer 菜单、ModelPickerCombo、思考档位共用同一数据源。

## 三、踩坑

1. **pkill 自杀**：`pkill -f jeff-desktop` 会匹配到自身 bash 命令串把 shell 杀掉（第二次踩了！）——用 `pgrep -f '^/usr/bin/jeff-desktop'` 精确锚定再 kill。
2. **单实例锁又立功**：本机安装的 1.2.0 在跑时，打包冒烟实例秒退 0 截图——冒烟前先清 `~/.config/Jeff/Singleton*` 并停掉运行中的实例，跑完再拉起。
3. details 折叠区的 `open` 属性是受控初值：流式中每次重渲染会重置用户的手动开合状态，改成非受控 + 「思考中…」文字标记。

## 四、验收

- `npm run typecheck` ✅；`npm test`：**73 passed / 11 skipped（84）**，新增 `tests/v13-chat.test.ts`（reasoning 提取/纯思考消息跳过/configuredModelOptions 过滤禁用提供商）
- 冒烟 + CDP：头部新会话+时钟按钮 ✅、抽屉打开（标题「聊天记录」+ 空态）✅、composer chip `我的中转 / gpt-4o` + 思考下拉 ✅、`models:configured` 只返回已添加模型 ✅、智能体页新配色 ✅
- 截图：`.tmp/smoke-v13/`（chat/contacts/providers）
- 本机已 `dpkg -i` 升到 1.3.0 并重启验证（sidecar 端口 14117）

## 五、已知行为与遗留

- 折叠区需要真实模型回复（含 reasoning/工具）才能看到内容——冒烟环境无 API Key，截图只见结构；实际使用小杰/智能体回复即可验证。
- 群聊委派（delegator）的执行结果暂不携带 reasoning/tools（仍是纯文本回群），下版本可补。
- 工具输出折叠区长度截断阈值 2000 字符，「展开全文」一次性展开（不分页）。
- v1.3.0 未打 tag；发 Release 时 `git tag v1.3.0 && git push origin v1.3.0`。
