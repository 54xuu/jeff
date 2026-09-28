# 给 Jeff 创建「医疗销售」项目群总结文档

- **完成日期**：2026-09-28
- **项目群名称**：医疗销售（`prj_JOEDXHipy8dT`）
- **核心定位**：教用户如何销售自主开发的产品（如智慧病房、Jeff Agent 工具等），并教用户怎么找客户、制定严密可落地的销售推进计划。

---

## 1. 架构与成员配置

在 `~/.jeff/jeff.db` 及 Sidecar 中完整创建并配置了 2 个专业销冠智能体与 1 个项目群：

| 实体 | 类型 / 角色 | ID | 头像 | 核心设定与职责 | 模型配置 |
|---|---|---|---|---|---|
| **销大中** | 智能体 / 群主 (Leader) | `agt_Mk8F6-SZKQt8` | 💼 | 资深医疗行业销冠，大局观强、极具条理性。负责宏观销售节奏把控、医疗客户开发六步法拆解、一步步制定销售落地推进计划；向销小美派发痛点攻坚要求并验收交付。 | `deepseek/deepseek-flash` (thinking: high) |
| **销小美** | 智能体 / 工作者 (Worker) | `agt_StkyXu01uood` | 👠 | 王牌医疗销冠，灵动敏锐、思维独特。负责从一线医护痛点与客户心理切入，设计反套路破局点子、微型试点方案（PoC 打法）、攻心拜访话术与异议化解，向销大中公开汇报。 | `deepseek/deepseek-flash` (thinking: high) |
| **医疗销售** | 项目群 | `prj_JOEDXHipy8dT` | 🩺 | 群主为销大中，成员为销小美；`workspace_dir` 设为空以支持 Windows 与 Linux 本地自适应。 | 协作流水线调度 |

---

## 2. 知识库与技能调用铁律（Win / Linux 双平台兼容）

在智能体身份指令（`instructions`）、Sidecar Agent 定义文件（`jeff_*.md`）及项目群权威规则文件（`~/.jeff/agents-md/prj_JOEDXHipy8dT.md`）中，均硬性固化了三大知识源调用规则：

1. **智慧病房产品背景**：
   - 规定涉及“智慧病房”时，必须先调阅思源笔记文档 ID：`20260721160406-5m7afnz`；
   - 调用方式：调用 `siyuan-read` 技能（通过 skill 工具），或在终端执行 `python scripts/export_md.py 20260721160406-5m7afnz`（兼容 python / python3）。
2. **Jeff Agent 智能体工具产品背景**：
   - 规定涉及“Jeff Agent”时，必须先调阅思源笔记文档 ID：`20260928220736-9fjtvd4`；
   - 调用方式：调用 `siyuan-read` 技能（通过 skill 工具），或在终端执行 `python scripts/export_md.py 20260928220736-9fjtvd4`（兼容 python / python3）。
3. **外部医院、政策、竞品与招标信息**：
   - 规定涉及目标医院规模、院领导背景、公开招投标中标记录、竞争对手或医保政策时，优先调用 `byted-web-search` 技能（火山引擎豆包搜索），或在终端执行 `python scripts/web_search.py "<关键词>"`。

---

## 3. WebDAV 云端同步与 Windows 即开即用验证

调用 Jeff 核心同步引擎 `SyncEngine` 将本次变更推送到云端 WebDAV 服务（`https://47.106.209.32/jeff`）：

- **远端文件确认已就位**：
  - `/jeff/agents.json`：包含 `agt_Mk8F6-SZKQt8`（销大中）与 `agt_StkyXu01uood`（销小美）定义；
  - `/jeff/projects.json`：包含 `prj_JOEDXHipy8dT`（医疗销售）定义与 2 位成员关系；
  - `/jeff/agents-md/project-prj_JOEDXHipy8dT.md`：权威规则文件已同步上云。
- **Windows 端同步即用保证**：
  - 用户在 Windows 客户端打开 Jeff 后，点击「立即同步」（或等待后台自动同步）：
    1. 会自动合并新增智能体与医疗销售项目群到 Windows 本地数据库；
    2. 自动拉取权威规则到 Windows 本地的 `~/.jeff/agents-md/`；
    3. Windows 端的 `syncRegistry()` 会自动在本地 `~/.jeff/oc-home/config/opencode/agent/` 下动态生成对应 `jeff_<slug>.md` 并刷新 sidecar；
    4. 用户即可在 Windows 端直接看到「医疗销售」项目群并开始对话。

---

## 4. 工作空间与回归测试

1. **工作空间目录结构**：
   - 在独立工作区 `/home/xujian/jeff-workspaces/医疗销售/` 与默认工作区下均初始化了：
     - `docs/sales-plans/`（结构化销售推进方案）
     - `docs/leads/`（目标客户与线索档案）
     - `docs/pitch/`（拜访说辞与演示材料武器库）
     - `README.md` 与 `AGENTS.md`
2. **测试验证**：
   - `npm test`（@jeff/core 与 @jeff/relay 单测，含版本号一致性）全绿通过；
   - 包级类型检查通过（无新增 TypeScript 报错）。
