# 修复 win 发版失败并重出 v1.7.2 双平台

## 问题

GitHub Actions tag `v1.7.2` 的 run (#34114411097) 结果：

1. **release (windows-latest, win) 失败，exit code 1**：失败点是第 5 步「拉取 opencode 二进制」——`fetch-opencode.mjs` 用单次 `fetch` 下载约 180MB 的 `opencode-windows-x64.zip`，没有任何重试；Windows runner 下载大文件偶发断流即整步失败，后续 `electron-vite build` / NSIS 打包 / 发布产物全部 skipped。
2. **release (ubuntu-latest, linux) 出现 Node 20 deprecation 警告**：来自 `softprops/action-gh-release@v2`（运行时是 node20，GitHub 强制在 node24 上跑）。仅警告，不是失败根源。

Linux job 本身全部成功（AppImage + deb 已发布）。

## 决策（grill-me 确认）

| 决策点 | 选择 |
|--------|------|
| win 失败修复 | 脚本加重试（3 次指数退避）+ workflow 加 `actions/cache` 缓存 oc-bin |
| Node 20 警告 | `softprops/action-gh-release` @v2 → @v3（v3 运行时 node24） |
| 重发方式 | 删远端 v1.7.2 tag 重打到修复 commit（保留旧 Release，重推后 action 按 tag 找到现有 Release 并覆盖同名资产） |
| 本机安装 | `npm run package:linux` 本地打包 + `sudo dpkg -i` |

## 改动

| 项 | 做法 |
|----|------|
| [`fetch-opencode.mjs`](../../../apps/desktop/scripts/fetch-opencode.mjs) | `downloadTo` 重试 3 次（2s/4s/8s 退避），fetch 失败与传输中途断流都算；最终报错带 URL 与尝试次数 |
| [`release.yml`](../../../.github/workflows/release.yml) | release job 加 `actions/cache@v4`（path `apps/desktop/resources/oc-bin`，key `oc-bin-<platform>-<opencode版本>`，命中时脚本靠版本 marker 秒过）；opencode 版本提取为 job 级 `env.OPENCODE_VERSION`；3 处 `action-gh-release` 升 @v3 |

## 验证

- 有效版本重跑 fetch 脚本：下载 → 解压 → marker 就绪，9 秒完成。
- 无效版本（404）触发重试路径：确认 3 次尝试、2s/4s 退避、最终报错带 URL。
- 本地 `node --check` 语法通过；`.gitignore` 已覆盖 `release/` 与 `resources/oc-bin/`。

## 发版

- Git：commit `e86e12a` 推送 `main`；删除远端 tag `v1.7.2` 后重打到该 commit 再推送，触发双平台重新构建
- Release：https://github.com/54xuu/jeff/releases/tag/v1.7.2 （应含 AppImage / deb / exe 三类产物）
- 本机：`npm run package:linux` → `sudo dpkg -i apps/desktop/release/jeff-desktop_1.7.2_amd64.deb`，「设置 → 关于」确认 1.7.2

## 版本

保持 **1.7.2** 不 bump（CI 修复 + 按需求重出同版本双平台产物）。
