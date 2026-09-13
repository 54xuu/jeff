# 二十轮全功能实测（live10）：全绿收官，零应用层 bug

- 日期：2026-09-13
- 会话目标：跑 20 轮测试把 Jeff 全部功能用一遍，自己找 bug、修 bug；收尾 bump 版本 + 双平台打包（不打 tag/release）
- 结论：**20/20 全绿，未发现应用层 bug**。版本 bump 至 `1.7.29`，产出 deb + exe 双平台安装包（仅版本号变化，代码与 1.7.28 一致）。

## 一、测试台 live10（`.tmp/live10/`，gitignore 不入库）

在 live9 基础上复制扩展：

- `seed10.mjs`：预置 home（opencode-go 网关 `/zen/go/v1`，三模型 qwen3.7-plus / deepseek-v4-pro / kimi-k2.6）、6 医生 + 1 群主的项目群「联合会诊」、**新增不入群的「康复科钱主任」**（供 GUI 添加成员轮使用）、8 个演示 skill + byted-web-search、mysql-test MCP、WebDAV 沙箱 `/jeff-live10-<ts>`。
- `live10.spec.ts`：20 轮，串行演进——R1（备份起点）与 R5（功能巡检起点）重新 seed，其余轮次共用同一份 home，使 R7 的产物（会诊记录员）能被 R11/R12/R17/R18/R20 链式依赖，更贴近真实使用。

## 二、20 轮清单与结果

| 轮次 | 内容 | 结果 |
|---|---|---|
| R1 | 立即备份 skills（弹窗统计 + 远端文件 + manifest 三方一致） | ✅ 18.9s |
| R2 | 两段式恢复（stage 列表 → apply，快照可回退，多余文件清除） | ✅ 10.0s |
| R3 | 整目录镜像（增/改/删传播 + skills-versions 归档 + 远端丢文件自愈） | ✅ 20.4s |
| R4 | 镜像删除熔断（大面积本地删除先中止，二次确认放行） | ✅ 20.2s |
| R5 | MDT 群聊：群主 @派发 5 专家 → 综合会诊意见（5 位 assistant 发言落库） | ✅ 2.3m |
| R6 | 心内科私聊多轮（上下文记忆，血压管理建议） | ✅ 35.1s |
| R7 | 小杰代操创建「会诊记录员」（jeff_agent_create） | ✅ 32.3s |
| R8 | MCP 设置页回归（编辑回填/重启引擎/暗亮主题截图） | ✅ 23.1s |
| R9 | 联网搜索 byted-web-search（回复含真实链接） | ✅ 30.9s |
| R10 | 群协作：营养科写工作空间《饮食建议.md》 | ✅ 24.3s |
| R11 | **小杰拉「会诊记录员」进群**（jeff_project_add_member，DB project_agent + 群成员 UI 双对账） | ✅ 30.7s |
| R12 | **群简介更新为「用户说明」**：逐成员写明职责（jeff_project_update，DB + 抽屉输入框双对账） | ✅ 27.8s |
| R13 | 任务看板建任务指派记录员（jeff_task_create/list，task 表对账：JEF-1/high/todo） | ✅ 29.7s |
| R14 | GUI 群资料抽屉改群名（两次改写 + DB 对账） | ✅ 14.6s |
| R15 | GUI 添加成员（康复科钱主任入群，DB + 成员列表 UI 对账） | ✅ 11.7s |
| R16 | 群会话管理（新会话标记「当前」、改名，重开抽屉确认持久化） | ✅ 13.3s |
| R17 | 写工作空间之外文件回归（external_directory allow，`.tmp/live10-out/` 落盘对账） | ✅ 29.9s |
| R18 | 小杰更新智能体资料（jeff_agent_update，agents:list 对账） | ✅ 28.8s |
| R19 | 第二病例群聊（老王宫颈癌合并甲亢，≥3 位专家发言 + 综合意见） | ✅ 1.9m |
| R20 | 会话搜索（小杰 jeff_session_search 命中 7 条并汇报摘要） | ✅ 29.8s |

每轮截图（`evidence/` 下 33 张 PNG）+ 消息/工具/文件 JSON 留档；人工目检了 R5（会诊正文与排版）、R12（用户说明注入群简介）、R15（8 人群成员列表）、R16（会话改名持久化）四张关键截图，布局与暗亮主题均正常。

## 三、bug 情况

- **应用层 bug：0 个**。聊天/流式/工具调用/委派、MCP、权限外写文件、WebDAV 备份恢复镜像熔断、群/智能体/任务/会话管理、设置页均一次通过。
- 唯一一次失败（R11 首跑报「应调用 jeff_project_add_member」）是**批次切分问题**：`--grep "R1|R2..."` 的 `R1` 子串误匹配 R10-R19，导致 R11 在 R7（创建会诊记录员）之前执行，前置缺失。属测试编排问题而非应用 bug；改用 `\bR(6|...)\b` 词边界并按依赖顺序分批后全绿。教训：**playwright --grep 是子串正则，轮次编号匹配必须加 `\b` 词边界**。

## 四、收尾（按 AGENTS.md 硬性约定）

- 版本 bump：`1.7.28 → 1.7.29`（五处一致：根/core/desktop package.json、package-lock.json×4、version.ts），本轮无代码修复，bump 仅作测试收官发版信号。
- 收尾测试全绿：`npm test`（189 passed）、`npm run typecheck`（仅 3 个存量 e2e helper 报错，改动前就在）、mock E2E（1 passed）。
- 双平台打包 + 产物校验（见下节）。

## 五、可复用经验

1. **链式串行演进**：功能轮共用一份 home 不 reseed，可以测「上一轮创建的智能体被下一轮拉群/指派/改资料」这类跨轮状态依赖，比每轮独立 seed 覆盖更真实。
2. **DB 双向对账**：测试进程用 `DatabaseSync(readOnly)` 直连沙箱 jeff.db 断言 `project_agent`/`project.description`/`task` 落库，配合 UI 断言防「界面假成功」。
3. **工具面巡检**：小杰的 `jeff_agent_*`/`jeff_project_*`/`jeff_task_*`/`jeff_session_search` 全部实测命中，群简介「用户说明」会被注入群聊 system prompt（抽屉里标注了这一点）。
