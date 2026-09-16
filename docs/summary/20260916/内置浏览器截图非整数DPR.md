# 内置浏览器截图在非整数 DPR 下必失败（v1.8.13）

## 现象

Windows 版在「产品宣传」群让宣经理跑无声门诊叫号采集任务：登录、截工作台 4 个 tab、截门诊叫号各菜单、写脚本。界面没有任何助手正文，最后报 `⚠️ 宣经理 处理消息失败：The operation was aborted due to timeout`。

## 根因

`jeff:browser:pageShot`（`apps/desktop/src/main/ipc.ts`）用 CDP 截完图后，只接受「实际像素 / 请求 CSS 像素」为**整数倍**的缩放。这台 Windows 机器是 **137.5%**（请求 937×703 拿到 1288×967，`1288/937 ≈ 1.3746`，`round(937×1.375)=1288`）。于是无论把视口改成 800×600 / 640×480 / 自适应，每一次 `jeff_browser_screenshot` 都报「超出当前窗口能渲染的范围」。

连续失败后模型放弃内置浏览器，转去 `bash` 调外部 `agent-browser` CLI，命令挂死约 27 分钟，整轮被当时的 30 分钟群回合预算掐断，产出全部作废。

同一条判断会挡掉国内笔记本最常见的 125% / 150% / 175% 缩放，与「换个缩放比例都成立」的截图契约矛盾。

## 修复

- `packages/core/src/tools/browserArgs.ts` 新增 `resolveScreenshotScale`：先对常见系统缩放档位（含 1.25 / 1.375 / 1.5 / 1.75）做取整匹配，否则要求宽高等比且比例落在 1x–4x；对不上才视为渲染表面裁剪。
- 主进程截图走该函数，再 `nativeImage.resize` 压回请求的 CSS 像素。
- 群回合预算从 30 分钟提到 90 分钟（多页截图 + 写总结这类长任务会超过 30 分钟；与 `jeff_delegate` 共用同一常量）。
- `launchJeff` 可透传 Electron 启动参数，便于用 `--force-device-scale-factor=1.375` 在 Linux 上复现 Windows DPR。

## 验证

- `@jeff/core` 单测（含 137.5% 真实案例）+ desktop typecheck + mock UI E2E + v18 全绿。
- `.tmp/live15/` 真模型：R0 在 1.375x 下 4:3 / 800×600 截图 PNG 尺寸等于视口；R1 复刻宣经理 + 用户原话任务，5 分钟内采完工作台 4 tab + 门诊叫号 5 个菜单（每张 960×720）并写出 `产品宣传视频脚本.md`，无 `group-send-fail`、无外部 `agent-browser` CLI。按任务设计停在脚本草稿，未代为「确认执行」。

产物目录：`.tmp/live15/workdir/v20260915-无声门诊叫号功能介绍/`。
