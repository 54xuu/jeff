# Windows 任务完成后只有声音、没有右下角消息提醒

- 日期：2026-09-19（关闭按钮跟进：2026-09-20）
- 范围：Jeff v1.8.19 → v1.8.21（PATCH）
- 现象：Windows 上任务/回复完成后能听到提示音，屏幕右下角没有气泡；v1.8.20 补上气泡后，点 `×` 不能马上关掉，要等几秒才消失

## 一、根因

声音和视觉走两条通道，不是「提醒入口没接到」（那是 v1.8.17 的问题，当时声音和文字一起缺）。

1. **提示音**由渲染层自己播（`notify.ts` 的 `HTMLAudioElement`），不经过操作系统，所以 Windows 上一定听得见。
2. **视觉**原先交给 Electron `Notification` → Windows Toast。这条路要满足开始菜单快捷方式 AUMID、操作中心权限、免打扰/横幅开关。NSIS 安装包不是 Squirrel，ToastActivatorCLSID 也不完整，常见结果是：`show()` 返回成功，横幅却不出现（顶多进操作中心，或者被静默丢弃）。
3. 叠加默认「仅后台才弹桌面通知」：Jeff 在前台看别的会话时，代码主动不发视觉提醒，只留提示音。Windows 用户等任务时经常把窗口开着，于是「只有声音」更明显。

Linux 的 freedesktop 通知不受这条 Toast 链路影响，所以表现为「Windows 特有」。

## 二、修复

Windows **不再把右下角气泡交给系统 Toast**，改成主进程自绘 `alwaysOnTop` 小窗，锚在当前屏工作区右下角（避开任务栏）：

```
notifyTurnDone
  → 提示音（渲染层，不变）
  → shouldShowDesktopNotify
  → IPC notify:desktop
  → win32：showWindowsBalloon（失败再兜底系统 Notification）
  → linux：Electron Notification（保留对象防 GC；行为与以前一致）
```

策略：

- 正看着这个会话：仍然不提醒（声音、气泡都不出）。
- Windows：只要开了桌面通知、且不是当前会话，前台看别的聊天也会弹出右下角气泡（对齐微信/QQ，不跟「仅后台」走）。
- Linux：继续尊重「仅后台」开关，避免 GNOME 顶栏横幅在前台抢视线。
- 点击气泡：唤起主窗口并跳到对应会话；8 秒后自动消失。

系统 Toast 仍作为 Windows 气泡创建失败时的兜底，并加上 `timeoutType: 'never'`、把 `Notification` 对象留住直到 close/click/failed，避免 GC 把还没画出来的横幅拆掉。

v1.8.21：点 `×` 立刻关掉。原先用 `location.hash` 通知主进程，但 `data:` 页在 Chromium 里经常不触发 `did-navigate-in-page`，等于关掉信号丢了，只能等 8 秒定时器。改成 `document.title` + `console.log` + `window.close()` 三条立刻到达主进程的通道，主进程 `hide()` 掉窗口。

## 三、测试

- `npm test`：300 passed / 17 skipped（`notify-visual.test.ts` 覆盖通道、Windows 前台也弹、气泡坐标、HTML 转义、`parseBalloonAction`、close 不再走 hash）
- `npm run typecheck -w jeff-desktop` 通过；core `tsc --noEmit` 通过
- mock UI E2E：1 passed
- v18 封闭：4 passed
- cron 10 轮：10 passed

本机是 Linux，Windows 真机以安装 `jeff-Setup-1.8.21.exe` 后点气泡 `×` 应立刻消失为准。

## 四、发版

- 版本 1.8.19 → 1.8.20 → **1.8.21**（PATCH：气泡能弹之后，修关闭按钮延迟）
- 五处版本号一致：根 / core / desktop 三处 `package.json` + `package-lock.json`（4 处）+ `version.ts`

## 五、产物

- Linux：`jeff-desktop_1.8.21_amd64.deb` + `Jeff-1.8.21.AppImage`
  - 本机 `dpkg -l jeff-desktop` = **1.8.21**
  - `/opt/Jeff/resources/app.asar` 与 `linux-unpacked` md5 一致：`6662a27edeaf1ddc1d0d3c67c08b3302`
- Windows：`jeff-Setup-1.8.21.exe` 为 PE32 Nullsoft；`win-unpacked` 的 `app.asar` 命中 `jeff-balloon:close` / `1.8.21`；`oc-bin/windows-x64/opencode.exe` 在位
