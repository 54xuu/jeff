# Jeff 1.12.0 多执行引擎交付记录

## 变更

OpenCode 继续作为开箱即用的默认引擎；新增 Codex CLI、Cursor CLI、Claude Code 适配器。智能体资料和手机聊天菜单可以设置引擎、模型、思考档位，设置页可检测 CLI 并保存本机路径。统一执行层管理流式正文、思考、工具、用量、原生会话续接、停止和异常退出。

引擎切换创建新会话，历史会话沿原引擎续接。私聊、群成员、子任务、定时任务保持各自的会话。智能体配置双向同步；原生会话、认证和可执行路径只保存在本机。Jeff MCP 通过会话令牌绑定调用者，拒绝模型自行提供身份与已关闭会话的调用。受现有专属权限保护的小杰和医护助手禁止外部引擎。

手机绑定补上三阶段进度、电脑名称和安全码，明确提示等待电脑确认。Windows 收到请求时显示通知、后台任务栏闪烁和已开启的提示音。此次用户遇到的停留实际是电脑等待确认，协议未失败。

记忆工具新增自动分流：保密信息进入不参与同步的本机记忆，公开信息按全局/项目范围进入 AGENTS.md 的管理区块。保留手工规则与旧记忆，拒绝凭据进入公开规则。桌面记忆页加入范围搜索、分类筛选、独立滚动及未保存保护；手机增加记忆与公开规则编辑入口。

使用说明见 [多执行引擎](../../execution-engines.md)。

## 回归与真实模型

最终应用源码回归：核心 423 通过、17 跳过；relay 11 通过；部署脚本 7 项通过；类型检查通过；桌面 mock 2、v18 4、cron 11、多引擎/大量记忆范围 2、绑定 2 用例通过；手机单测 29、浏览器 25 用例通过。最终串行核心日志：`.tmp/multi-engine-core-serial-final.log`；桌面、手机 E2E 与三端构建日志：`.tmp/multi-engine-delivery-history-final.log`；类型检查：`.tmp/multi-engine-typecheck-final.log`。另外补正 Claude CLI 子进程测试夹具为 `.cjs`，避免仓库 `type: module` 将其误解析为 ESM。

真实协议新增覆盖 Claude 的独立内容块快照、缺失/变化的消息 ID、空快照与终态正文；Cursor 真实 MCP 事件工具名与参数，以及私有 `.cursor/mcp.json` 注入。Claude 的真实私有规则注入探测返回正确工作目录。

OpenCode 与 Codex 真实模型界面、文本落库对账通过。Codex 三轮原生会话续接、文件产物、Jeff 会话 MCP、插件 MCP 服务端请求头与参数通过；混合引擎群协作及到点 Codex 定时任务会话隔离通过。证据：`.tmp/engine-live/codex-managed/evidence.json`、`.tmp/engine-evidence/extended-live.json`、真实界面截图及对应日志。截图已人工检查。

Ubuntu 的 Claude 模型服务返回 AgentPlan 订阅错误，Cursor 返回 Authentication required，故这两条 Ubuntu 真实模型链路未验证。Windows 原始 NSIS 包安装后 UI runner 无法启动应用。Windows ChatGPT 随后通过 ASAR 逐文件检查确认包内归档损坏：`node_modules/@jeff/core/src/chat/private.ts` 条目声明长度 16,168 字节，数据实际只有 16,155 字节，导致之后 13,663 个文件的 offset 错 13 字节；13,802 个条目中 13,646 个 SHA-256 不匹配，根 `package.json` 也无法解析。Windows 安装包本身逐文件解包对比正确，损坏已在安装包的 `app.asar` 内。Windows ChatGPT 仅重写 ASAR 元数据及对应 offset，校验所有数据区字节不变后替换本机 `app.asar`；修复后 13,802 条目全部校验通过，Jeff 进程与主窗口启动成功。Windows `.jeff` 的数据库和 AGENTS.md 修复前后哈希完全一致，SQLite 只读完整性检查返回 `ok`。Windows 当前锁屏，窗口版本/视觉人工验收尚待解锁；原始 NSIS 安装包仍损坏，重装会覆盖本机修复，不能作为正式产物分发。安装包源头为何写出长度与内容不一致仍未查明。

已经新增 ASAR 逐文件完整性校验 `scripts/verify-asar.mjs`，Linux 和 Windows electron-builder 打包命令在产出后自动校验，遇到错误直接终止。回归测试覆盖了这种“一个条目短 13 字节、后续 offset 连锁错位”的故障。实际检查本轮本地包时，Linux ASAR 13,802 个条目全通过，Windows ASAR 发现同样的损坏；因此原 Windows 产物 SHA-256 `8d94ba83c284ff6a0c2d0b4031fe1cee3e6d79055739ad64e2ed5d0d4b867fbf` 明确标记为**损坏、不可重装或分发**，并须从经验证源码重新构建。部署清单提交号与实际提交号也需要在新构建中一并核对。详细故障字节、修复步骤及哈希见 Windows 工作区 `D:\P_xujian\workspace\jeff\Jeff-1.12.0-Windows-启动故障修复结果.md`。

## 安全与兼容

真实样本覆盖中文分段 JSON、增量与最终快照去重、失败工具、缺少结束事件、进程中断、Unix 遗留子进程及 Windows npm shim 路径。会话 MCP 测试验证身份注入与跨会话令牌隔离；同步测试验证旧字段缺失不覆盖已有配置、本机路径与会话不上传。

外部引擎使用 Jeff 私有运行目录，不覆盖工作区或全局配置。图片、思考档位与压缩按能力提示；不支持时明确报错。外部上下文统计与手动压缩暂不提供。Codex 原生插件和主机技能自动发现关闭；受专属禁用规则保护的智能体仅允许 OpenCode。

## 正式产物与安装验收

| 正式产物 | SHA-256 |
|---|---|
| `apps/desktop/release/jeff-desktop_1.12.0_amd64.deb` | `898047ececa705601514b9e9061d4a38c100af673caf1163470bdf9a10cf555f` |
| `apps/desktop/release/Jeff-1.12.0.AppImage` | `d8aec8bffd6411af956081124207e329e294c4d8b5f7eea7fdfb19de3def91d4` |
| `apps/desktop/release/jeff-Setup-1.12.0.exe` | `8d94ba83c284ff6a0c2d0b4031fe1cee3e6d79055739ad64e2ed5d0d4b867fbf` |
| `apps/mobile/android/release/jeff-1.12.0.apk` | `3a6a5e28bb218de04081440e3cdaaaed8dbaf3f7e94794fc81d3a05bbb3964f0` |

三个平台均为 1.12.0、同一份最终源码。Ubuntu 已安装，`dpkg-query` 为 1.12.0；安装后的 `/opt/Jeff/resources/app.asar` 与 `linux-unpacked` MD5 均为 `6545ce718d55c0162de765dece3399c6`。实际安装版「关于」「引擎服务」「记忆」页面和默认 OpenCode sidecar 启动通过。

Windows 产物为 PE32 Nullsoft Installer，内置 `opencode.exe` 与本次引擎/记忆特征在包内。APK 的包名 `app.jeff.mobile`、versionName `1.12.0`、versionCode `11200`；release 签名验证通过。最终 APK SHA-256 与 AVD、Windows Android 真机测试使用的 APK 完全相同；Android 14 AVD 与 Windows 连接的物理设备 instrumentation 均为 3/3。APK release 签名 v1/v2 验证通过，证书 SHA-256 为 `3ff7dff8f41e9e7025e6e297820dd58225e3d17b147b6ee7013bab6d77c49c1d`。Linux 已重新安装 `.deb`，`dpkg-query` 显示 1.12.0，安装目录与正式 `linux-unpacked` 的 app.asar MD5 均为 `6545ce718d55c0162de765dece3399c6`。


实际 Android 8.1 / WebView 61 验收发现 Python 高亮的动态 Unicode 正则使真实回复白屏；修复为按浏览器能力关闭语法着色，保留原文、复制、链接与表格。失败证据保留在 `.tmp/engine-mobile-live/physical-render-error.json`，回归单测及真实回复 instrumentation 通过。Windows Cursor 官方 cmd 版本选择与 npm shim 分开解析，覆盖最新完整版本、残缺版本和 ps1 对应 cmd 的安全解析。
