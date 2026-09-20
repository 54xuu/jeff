# 重写 README：AI 团队叙事 + 截图

- 日期：2026-09-20
- 范围：`README.md` + `docs/assets/` 产品截图（无版本 bump）

## 对齐结论（grilling）

- 读者：产品访客
- 开头：心智模型 + 项目管理→docx / 产品宣传→mp4
- 截图：①产品宣传群（用户 Snipaste）②智能体通讯录 ③小杰私聊 ④内置浏览器 `weixin.qq.com`
- 深夜主题；禁止入镜「POCT+AI项目管理」
- 文末抖音获取与交流，不放 Releases/安装包

## 产物

| 文件 | 说明 |
|------|------|
| `README.md` | 重写为产品向短文 |
| `docs/assets/group-promo.png` | 自 `Snipaste_2026-09-20_10-14-01.png` 复制 |
| `docs/assets/agents.png` | 通讯录（项目管理组折叠，无 POCT 文案） |
| `docs/assets/xiaojie.png` | 小杰新会话欢迎页（旧会话含 POCT 建群史，不可用） |
| `docs/assets/browser-weixin.png` | 三栏：小杰 + 内置浏览器打开微信官网 |
| `docs/assets/20260920105423_26_93.png` | 用户提供的抖音联系卡 |

## 截图方法

本机为 Wayland，`xwd`/GNOME 截屏被拒。对已安装 Jeff（`--remote-debugging-port=9222` + X11）用 Playwright `connectOverCDP` 截渲染层，仅含应用内容。

## 验收

- README 四图 + 抖音图路径均存在
- README 无 POCT、无下载/Releases 引导
- ②③④ 截前隐藏 POCT 群；③ 强制 `chat:new` 避开含 POCT 的历史消息
