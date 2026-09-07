# Jeff：阻塞 bug + WeUI 主题架构 + 可重复 E2E

> 日期：2026-09-06（会话跨至 09-07）· 版本：v1.3.0 增量

## 一、完成内容

### 1. 两个阻塞 bug

| Bug | 根因 | 修复 |
|---|---|---|
| 通讯录「保存」卡在「保存中…」 | `AgentEditor.submit` 不 await、不复位 `saving` | `async/await` + `try/finally`；失败 Toast |
| 模型下拉选完不像选中 | ① `split('/')[1]` 截断硅基流动 `Qwen/Qwen3.5-9B`；② 触发器显示原始 key；③ `Field` 用 `<label>` 包 button 导致双击 toggle | `parseModelKey`/`formatModelKey`（按第一个 `/`）；触发器显示友好标签；`Field` 改 `<div>`；Esc/点空白关闭 |

### 2. WeUI 主题包架构

- `data-theme-pack=weui` × `data-theme=light|dark`
- CSS 变量合同：`--weui-BRAND` → `--green`，字号阶 `--fs-*`，按钮高度 `--btn-h`
- 设置 → 外观：新增「主题」选择（当前仅「微信 WeUI」）+ 原有亮/暗/跟随系统
- 小组件：`Button` / `Field` / `Dialog` / `Toast`（`apps/desktop/src/renderer/src/components/ui/`）
- settings schema：`themePack: 'weui'`

### 3. Playwright Electron E2E

| 命令 | 作用 |
|---|---|
| `npm run test:e2e` | UI 封闭清单（可不连真实模型） |
| `npm run test:e2e:live` | skill + MCP 真实冒烟（读 `.tmp/e2e.env`，无密钥则 skip） |

- 隔离 `JEFF_HOME=.tmp/jeff-e2e-*`，不碰 `~/.jeff`
- 密钥只写 `.tmp/e2e.env`（已 gitignore）
- E2E 端口段 `16096–17096`，跳过单实例锁（`JEFF_E2E=1`）

### 4. 顺带修的 MCP 探测展示

UI 期望 `status/toolCount`，IPC 原先直接返回 `{ ok, tools }`，探测结果从不显示。已在 IPC 层映射为 `McpProbeResult`。

## 二、验收

- `npm test`（core Vitest）：76 passed / 11 skipped
- `npm run test:e2e`：1 passed（~22s）
- `npm run test:e2e:live`：1 passed（~50s，硅基流动 + 豆包搜索 + mysql-test 只读）

## 三、密钥与安全

- **未**把 API Key / MySQL 密码 / sudo 密码写入源码或 `docs/`
- Live 凭据仅本地 `.tmp/e2e.env`
- MySQL 冒烟：只读 `SHOW DATABASES`，seed 里写操作为 `false`

## 四、关键路径

- `packages/core/src/util/modelKey.ts`
- `apps/desktop/src/renderer/src/components/AgentsPage.tsx`
- `apps/desktop/src/renderer/src/components/ModelPickerCombo.tsx`
- `apps/desktop/src/renderer/src/components/settings/AppearanceSettings.tsx`
- `apps/desktop/e2e/`（`ui.spec.ts` / `live.spec.ts` / helpers）
- `apps/desktop/src/main/ipc.ts`（settings themePack、mcpProbe 映射）

## 五、本机安装（2026-09-07）

- 产物：`apps/desktop/release/jeff-desktop_1.3.0_amd64.deb`（含本次 fix 提交）
- 安装：`sudo dpkg -i …/jeff-desktop_1.3.0_amd64.deb` → `/usr/bin/jeff-desktop`
- 已启动供手测；日常数据仍在 `~/.jeff`（与 E2E 隔离目录无关）
