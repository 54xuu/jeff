# Jeff 协作规范（AGENTS.md）

本文件给 Cursor / 人类协作者：改代码、发版、升级本机时的约定。

## 版本号（SemVer）

仓库当前版本以三处 `package.json` 为准（必须保持一致）：

- 根目录 [`package.json`](package.json)
- [`packages/core/package.json`](packages/core/package.json)
- [`apps/desktop/package.json`](apps/desktop/package.json)

### 核心原则：默认 PATCH，MINOR 要克制

版本号是**用户可见的发版信号**，不是每次改代码的进度条。近期已到 `1.7.0`，后续优先慢升。

判定顺序（从上往下，命中即停）：

| 优先级 | 变更类型 | 升哪个 | 典型例子 |
|--------|----------|--------|----------|
| 1 | **破坏性**（数据不兼容、强制迁移、删公开能力） | **MAJOR**（`x.0.0`） | 库表无法平滑升级；同步协议破坏旧客户端 |
| 2 | **独立可感知的新能力**（用户能说出「多了一个功能」） | **MINOR**（`x.y.0`，PATCH 归零） | 全新设置页分区、全新同步品类（若整块上线）、新交互入口 |
| 3 | 其余一律 | **PATCH**（`x.y.z`） | 修 bug、补同步缺口、文案、测试、CI、小重构、在已有功能上打补丁 |

**宁可 PATCH，不要轻易 MINOR。** 拿不准时：

- Agent / 协作者：**默认 PATCH**；若认为该升 MINOR/MAJOR，**先问用户确认**再 bump。
- 「修 bug + 顺手补一小块配置进已有同步」→ **PATCH**（例如同步刷新失败 + 把 MCP 塞进已有 settings 包）。
- 「纯文档 / 纯测试 / 只改 AGENTS.md」→ **不 bump**。
- 同一会话、同一发版意图内的多处改动 → **只 bump 一次**（按整包最高级别，不按文件数累加）。

### 何时 bump、何时打安装包

1. **bump 时机**：用户明确要求发版 / 合入并安装验证时；不要在每个小提交途中反复改版本号。
2. bump 时改齐三处 `package.json`（必要时同步 `package-lock.json`）。
3. 需要本机验证时再打包装：

```bash
npm run package:linux
sudo dpkg -i apps/desktop/release/jeff-desktop_<version>_amd64.deb
# 然后退出并重新打开 Jeff，在「设置 → 关于」确认版本号
```

推送 `v*` tag 会触发 GitHub Actions 构建 Windows / Linux 安装包并发布到 Releases。Tag 应与三处 `package.json` 版本一致（如 `v1.7.1`）。

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
