# Ubuntu 本地编译 Windows exe

## 问题

此前每次要产出 Windows 安装包（`jeff-Setup-<version>.exe`）都只能推送 `v*` tag 走 GitHub Actions（windows-latest runner），调试循环太长：改一行 → commit → tag → 等 CI → 下载产物。

## 结论：本机可以直接打，唯一前置是 wine

排查确认了三个关键事实：

1. **项目零原生 Node 模块**——数据库用的是 Node 内置 `node:sqlite`（`packages/core/src/db/db.ts`），不存在需要交叉编译的 C/C++ 代码，也不需要 electron-rebuild。
2. **Windows 版 sidecar `opencode.exe` 无需编译**——它是 opencode 官方发布的预编译二进制，由 `apps/desktop/scripts/fetch-opencode.mjs` 构建时下载，本地 `apps/desktop/resources/oc-bin/windows-x64/` 已有缓存。
3. **唯一障碍是 wine**——electron-builder 在 Linux 上打 NSIS 包时要用 wine 修改 PE 资源（rcedit / signtool 步骤）。今天早些时候的会话就因 `spawn wine ENOENT` 失败过（见 [群会话即任务.md](群会话即任务.md)）。

## 执行过程

```bash
sudo apt-get update && sudo apt-get install -y wine64   # 装 wine 6.0.3
npm run package:win                                      # electron-vite build + electron-builder --win --x64
```

- 首次 `apt-get install` 因索引过期导致 i386 依赖 404，`apt-get update` 后重试即成功。
- 打包一次通过，产物 `apps/desktop/release/jeff-Setup-1.7.3.exe`（175 MB）。
- 冒烟验证：`wine64 apps/desktop/release/jeff-Setup-1.7.3.exe` 成功弹出「Jeff Setup」NSIS 安装向导，证明包结构有效（未实际安装，验证后已关闭）。

## 固化

打包流程已写入工作区 [AGENTS.md](../../../AGENTS.md)「本机打 Windows 安装包」一节：装 wine64 → `npm run package:win` → 产物路径 + 可选 wine 冒烟验证。

## 注意事项

- 本地打包只用于调试验证；正式发版仍以推送 `v*` tag 走 GitHub Actions 为准。
- 纯构建流程改动，不涉及代码变更，**不 bump 版本号**。
- wine 首次运行会生成 `~/.wine` 前缀，属正常现象。
