# 对话上下文与 WebDAV 传输设置

日期：2026-09-07

## 问题

1. 对话界面需要查看「上下文」，并支持达到阈值自动压缩与手动【压缩】。
2. WebDAV 同步曾报 `client network socket disconnected ... TLS`；远端 Sealos 已修复后，仍要求 Jeff 对齐 timeout / TLS Verify 设置。

## 结论与方案

### 上下文压缩

- **不自研压缩**：复用 Jeff 内置 opencode sidecar **1.18.26** 的 auto compact。
- 自动压缩条件（sidecar `overflow.ts`）：模型 `limit.context > 0` 且上一轮 tokens ≥ `contextLimit - reserved`（reserved ≈ `min(20000, maxOutput)`）。
- 手动压缩：`POST /session/{id}/summarize`，Jeff 封装为 `OcClient.summarize` + IPC `context:compress`。
- UI：私聊/群聊标题栏占用条 +【压缩】按钮；`ContextDrawer` 展示 System / Compact 摘要 / 活跃消息。
- `contextLimit` 在供应商模型表单改为**必填**（未填则自动压缩永不触发）。

### WebDAV

- 当时 TLS 失败根因在 Sealos（握手被掐 + HTTP/80 `503 no healthy upstream`），非 Jeff 客户端；服务端已恢复。
- Jeff 仍增加：`timeoutMs` 默认 60s、`tlsVerify` 默认 true（串行，无 Concurrent Reqs）。
- 保存时密码留空保留已存密码。

## 主要改动

| 区域 | 文件 |
|------|------|
| 上下文切分 / 阈值 | `packages/core/src/chat/context.ts` |
| summarize API | `packages/core/src/oc/client.ts` |
| preview/compress | `packages/core/src/index.ts`、`ipc/contract.ts`、`apps/desktop/src/main/ipc.ts` |
| UI | `ContextDrawer.tsx`、`ChatWindow.tsx`、`GroupWindow.tsx`、`styles.css` |
| contextLimit 必填 | `ProviderSettings.tsx` |
| WebDAV 传输 | `sync/engine.ts`、`SyncSettings.tsx` |
| 单测 | `packages/core/tests/context.test.ts` |

## 验证

- `packages/core`：`vitest run context.test.ts` 通过（5 cases）。
- desktop 对本改动相关文件 typecheck 无新增错误。
- 未对真实 Sealos 端点做联调（密码不入库、不写文档）。

## 使用说明

1. 在「设置 → 模型供应商」为每个模型填写上下文窗口（tokens）。
2. 对话标题栏查看占用；接近自动压缩线时变色；点占用条打开上下文抽屉。
3. 【压缩】手动触发 summarize；历史消息仍保留在聊天记录中，仅模型上下文被压缩。
4. WebDAV 设置可调请求超时与是否校验证书；自签证书才关闭校验。

## 本机更新（2026-09-07）

- 已 `npm run package:linux`，产物：`apps/desktop/release/jeff-desktop_1.3.0_amd64.deb`（约 188MB，含上下文/WebDAV 改动）。
- Agent 环境无交互 sudo，未能代执行 `dpkg -i`；已用 `release/linux-unpacked/jeff-desktop` 拉起当前构建供手测（数据仍在 `~/.jeff`）。
- 系统覆盖安装请本机终端执行：

```bash
sudo dpkg -i /home/xujian/cdbox/jeff/apps/desktop/release/jeff-desktop_1.3.0_amd64.deb
/usr/bin/jeff-desktop &
```

## 后续：保存并同步重入 + 假 401（同日）

1. **「上一轮同步仍在进行」**：`configureSync` 在 `autoSync` 时会异步 `syncNow`，UI「保存并同步」紧接着再调一次 → 撞重入锁。已改为 configure 只写配置，由 UI 单独触发 sync。
2. **假 401**：账号密码正确；`webdav` 库的 `createDirectory({ recursive: true })` 与无尾斜杠 `stat('/jeff')` 在该 Apache 上会误回 401。已改为逐级非 recursive MKCOL，存在性检查优先 `stat('/jeff/')`。
