# 所有 Agent 模型统一为 Luna 并保护开发会话

## 变更结果

- 通过 Windows 已安装 Jeff 的结构化配置接口，将 24 个 Agent 个人默认模型与 19 个项目群成员模型覆盖统一设为 `gpt-6-luna`。
- 每个 Agent 与群成员的思考等级均保留原值；Agent 引擎、Prompt、群规则、成员职责、成员关系及群主关系均未改变。
- 更新前的最小回滚快照和迁移前后核对结果保存在本机忽略目录 `.tmp/engine-design/luna-model/`，不包含 Prompt 正文或凭据。
- 使用隔离资料完成个人会话（Luna / low）与群会话（Luna / high）真实链路验证，模型标记均成功返回并落库；未触碰用户当前会话。
- 未关闭或重启 ChatGPT、Codex、Cursor、Jeff 等既有进程。隔离测试窗口正常关闭；迁移用 Jeff 实例仍保持打开。未安装本次构建的软件包。
- 在 `AGENTS.md` 增加进程归属与结束前核对要求、禁止按名称批量终止，以及 Git 暂存、提交和推送检查清单。

## 测试

- `npm test`：core 429 通过、17 跳过；relay 11 通过；部署/ASAR 测试 10 通过。
- `npm run typecheck`：通过。
- `npm run test -w @jeff/mobile`：29 通过。
- Desktop mock E2E：无显示服务的首次运行因缺少 `$DISPLAY` 未能启动；使用 Xvfb 重跑后 2/2 通过。
- 封闭 v18 E2E：4/4 通过；cron E2E：11/11 通过（均使用 Xvfb）。
- Windows 隔离模型 E2E：个人会话与群会话均通过，模型及思考等级已核对实际保存值。

## 正式构建与产物校验

仓库版本保持 `1.12.1`，没有应用代码改动或版本升级。

| 平台 | 产物 | 校验 | SHA-256 |
| --- | --- | --- | --- |
| Ubuntu | `apps/desktop/release/jeff-desktop_1.12.1_amd64.deb` | Debian 包版本 1.12.1；ASAR 13,802 项校验通过 | `4233b7a9085ec6924ecff2f6ddeabe288011015fcdfc4225fc3668cffd71d7d9` |
| Ubuntu | `apps/desktop/release/Jeff-1.12.1.AppImage` | ELF x86-64 | `4ae8772ae81a8a92c4ebb3de506c1b4dd9edc2eb97df02d15b0bd852f1a85add` |
| Windows | `apps/desktop/release/jeff-Setup-1.12.1.exe` | PE32 NSIS；ASAR 13,802 项校验通过；内置 Windows OpenCode 存在 | `700d99a91d74445fc80f3c88cc8de7e43a92838f1ca36cd3232a1d971e01ce32` |
| Android | `apps/mobile/android/release/jeff-1.12.1.apk` | `app.jeff.mobile`；versionName 1.12.1；versionCode 11201；v1/v2 签名验证通过 | `cc9451d55cc2f0965ea496e866d8ed93d3e39779c4348b1565c0c321873d23b3` |

Linux 与 Windows unpacked `app.asar` 的 SHA-256 均为 `6501bfa3627f473f69a6b6e31bf4d908be0330de2ebc2bb1f11de451bbb42d4e`。构建产物只用于本次验收，未安装或提交。
