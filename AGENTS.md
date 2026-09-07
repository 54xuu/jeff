# Jeff 协作规范（AGENTS.md）

本文件给 Cursor / 人类协作者：改代码、发版、升级本机时的约定。

## 版本号（SemVer）

仓库当前版本以三处 `package.json` 为准（必须保持一致）：

- 根目录 [`package.json`](package.json)
- [`packages/core/package.json`](packages/core/package.json)
- [`apps/desktop/package.json`](apps/desktop/package.json)

规则（`MAJOR.MINOR.PATCH`）：

| 变更类型 | 升哪个数字 | 说明 |
|----------|------------|------|
| 修 bug / 小修正 / CI 修通 | **PATCH**（第三个 +1） | 例如 `1.4.0` → `1.4.1` |
| 新功能或功能重构 | **MINOR**（第二个 +1，PATCH 归零） | 例如 `1.3.0` → `1.4.0` |
| 破坏性变更（数据不兼容、强制迁移等） | **MAJOR**（第一个 +1，其余归零） | 少见，需明确说明 |

每次解决问题并合入后：

1. 按上表 bump 三处 `package.json`（必要时同步 `package-lock.json`）。
2. **必须升级本机已安装的 Jeff**：打 Linux 包并覆盖安装，再重启应用验证。

```bash
npm run package:linux
sudo dpkg -i apps/desktop/release/jeff-desktop_<version>_amd64.deb
# 然后退出并重新打开 Jeff，在「设置 → 关于」确认版本号
```

推送 `v*` tag 会触发 GitHub Actions 构建 Windows / Linux 安装包并发布到 Releases。

## 产品心智模型

- **智能体** = 聊天好友（通讯录可配；私聊顶栏「资料」可改）
- **项目群** = 微信群（群资料抽屉可改群名/工作空间/群主/成员；任务看板同抽屉）
- **小杰** = 内置管家，可用 `jeff_agent_*` / `jeff_project_*` 等工具代操配置

## 开发常用命令

```bash
npm install
npm test                    # @jeff/core 单测
npm run typecheck           # 或分别 tsc core / desktop
npm run dev -w jeff-desktop
```

临时文件与测试脚本放在仓库根目录 `.tmp/`（已 gitignore），不要提交。
