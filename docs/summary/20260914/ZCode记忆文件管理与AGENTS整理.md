# ZCode 记忆文件管理与 AGENTS.md 整理

日期：2026-09-14

## 背景

用户希望在其他工具（Cursor 等）也能管理 ZCode 的记忆文件，实现跨工具读写；同时整理 AGENTS.md，解决不同工具加载规则文件的差异问题。

## ZCode 记忆文件位置（查证结论）

- 存储根目录：`/home/xujian/.zcode/cli/memories/projects/<项目标识>/memory/`
- `<项目标识>` = `工作目录名-哈希`，哈希不可从路径推算。本机现有映射：
  - `/home/xujian/cdbox/jeff` → `jeff-1d2f0b1cdfcc2a44`（11 个记忆文件）
  - zhbf-night → `zhbf-night-f24097e941eec48d`（18 个）
- **没有全局用户记忆目录**：`type: user` 的记忆也存在项目目录下，「用户记忆 vs 项目记忆」只是 frontmatter `metadata.type` 的取值（`user / feedback / project / reference`），物理上混存在同一目录
- 结构：`MEMORY.md` 为索引（每条记忆一行指针），其余每 `.md` 文件一条事实；ZCode 自动写入的文件 frontmatter 另带 `node_type: memory`、`originSessionId`，其他工具手写可不带

## 改动内容

1. **新建 `/home/xujian/.agents/AGENTS.md`**（全局规则唯一权威源）
   - 迁移并整理原 `~/.zcode/AGENTS.md` 全部内容：修错别字（「总结问道」→「总结文档」、「登陆」→「登录」）、MySQL `my.ini` 长行拆成 4 个子条目、统一标题层级
   - 新增第 6 节「ZCode 记忆文件管理」：存储位置、本机项目标识映射表、MEMORY.md 索引规则、单文件 frontmatter 格式、无全局用户记忆目录的说明
2. **`/home/xujian/.zcode/AGENTS.md` 改为指针**：只保留一句话指向 `/home/xujian/.agents/AGENTS.md`，单一来源、避免两处漂移（代价是 ZCode 每会话多读一次文件）
3. **整理 `/home/xujian/cdbox/jeff/AGENTS.md`**：
   - 开头新增「规则文件分层」：全局通用规则在 `~/.agents/AGENTS.md`，本文件只保留 jeff 特有规则——这样 Cursor 等其他工具从项目根就能找到全部规则
   - 新增「ZCode 记忆文件」小节：本仓库记忆目录绝对路径 `jeff-1d2f0b1cdfcc2a44`，格式详见全局文件第 6 节
   - 正文已较规整，其余未动

## 设计要点

- 选 `~/.agents/AGENTS.md` 作权威源：该目录已存在（放 skills），且是跨工具约定的通用位置；`~/.zcode/` 是 ZCode 专属目录，其他工具不一定读
- 项目标识哈希不可推算，所以映射表直接写死在全局文件里，新项目出现时需人工补充
- 纯文档改动，按仓库规则不 bump 版本、不打安装包

## 验证

- `~/.agents/AGENTS.md`、`~/.zcode/AGENTS.md`、jeff `AGENTS.md` 三处内容互相引用一致
- 记忆目录路径、项目标识均按本机实际目录核对（`ls /home/xujian/.zcode/cli/memories/projects/`）
