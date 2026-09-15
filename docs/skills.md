# 技能（Skills）

技能 = 一份 `SKILL.md`（+ 它自带的脚本/模板），让智能体在不重装应用的前提下多出一项专门能力
（读思源笔记、转录音频、画图、合成视频…）。智能体看到技能清单后，自己用 `skill` 工具按需加载。

## 目录：只有一处 `~/.agents/skills`

```
~/.agents/skills/<skill-name>/SKILL.md
```

- **模型能看到的技能，只来自这一个目录**（外加 opencode 二进制里自带的内置技能，如 `customize-opencode`）。
- 该目录是跨工具的 agent skills 标准目录（ZCode / Claude Code 等也认它），**不随 Jeff 数据目录（`~/.jeff`）搬**；
  测试 / 便携模式可用环境变量 `JEFF_SKILLS_DIR` 覆盖（`packages/core/src/paths.ts`）。
- 用户说「用 XX 技能做 Y」时，智能体应当：`skill` 工具按名字加载 → 按 SKILL.md 的说明执行（通常是 `bash` 跑它自带的脚本）。

### 两个开关合起来才等于「只认这一处」

| 位置 | 作用 |
|------|------|
| `opencode.json` 的 `skills.paths: ["~/.agents/skills"]`（`packages/core/src/oc/configWriter.ts`） | 把该目录**显式挂载**进 opencode。这是用户技能进模型的**唯一入口** |
| 环境变量 `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`（`packages/core/src/sidecar/manager.ts`） | 关掉 opencode 对「外部目录」的**隐式扫描**（`~/.claude/skills`、项目里向上找的 `.agents/.claude` 等） |

⚠️ 别把这两条当重复劳动：没有第一条，一个技能都看不到；没有第二条，别的工具的技能目录会混进来。
回归单测：`packages/core/tests/skills-dir.test.ts`。

## 内置使用说明技能 `jeff-usage`

应用自己也会在这个目录下写一个技能：`~/.agents/skills/jeff-usage/SKILL.md`
（内容由 `JeffCore.writeUsageSkill()` 每次启动重写）。它讲的是「Jeff 怎么用」，
用户问「Jeff 能做什么」时会被加载。放在这里的理由：模型看到的技能只有一个来源，
应用自带的也不例外；顺带随 WebDAV 同步到其他机器。旧版本遗留在
`<数据目录>/oc-home/config/opencode/skills/` 的副本会在启动时清掉。

## 备份 / 恢复（设置 → 同步）

`~/.agents/skills` 是**目录型数据**（文件多、整目录推 WebDAV 慢），所以它有独立的
「立即备份 skills / 从备份恢复」按钮，不跟「立即同步」混在一起。语义是**整目录镜像**：

- 备份 = 远端 `skills/` 与本地完全一致（本地删了远端也删，删前归档到 `skills-versions/<rel>/<时间戳>`）。
- 恢复 = 本地整个目录被备份内容替换（替换前先把本地快照到 `<数据目录>/backups/skills-<时间戳>/`）。
- **新机器保护**：本地没有「你自己的技能」（目录缺失，或只剩应用自带的 `jeff-usage`）而远端有备份时，
  备份直接报错跳过，一个文件都不删——避免把远端整套技能当「多余项」清掉。先点「从备份恢复」再备份。

## 加一个技能

```bash
mkdir -p ~/.agents/skills/my-skill
cat > ~/.agents/skills/my-skill/SKILL.md <<'EOF'
---
name: my-skill
description: 一句话说清「什么时候该用它」（模型就是靠这句决定要不要加载）
---

# My Skill

## Usage
```bash
python scripts/do_it.py <args>
```
EOF
```

要点：
- `description` 是触发条件，写清「什么场景用它」，别只写能力名。
- 目录自包含：脚本、配置样例放技能目录里，用相对路径引用（技能加载时会告诉模型技能的绝对路径）。
- 敏感值（token 等）放技能目录下的配置文件（如 `siyuan.env`），**不要**写进 `SKILL.md`；
  并在 `SKILL.md` 里写一句「令牌由脚本自己读，不要把 env 文件读进上下文」——否则模型排查时
  会把 token 读进模型上下文，也会落进 `<数据目录>/logs/debug-*.log`。
- 新增技能立即生效，无需重启：opencode 在每次需要技能时扫描目录。

## 排障：智能体没用/用错技能

按这个顺序查（都不需要模型）：

1. **技能被发现了没**（真 sidecar 的接口，端口在 `<数据目录>/logs/debug-<日期>.log` 的 `sidecar-ready` 行）：
   ```bash
   curl -s http://127.0.0.1:<port>/skill | python3 -m json.tool | head -40
   ```
   或者直接看日志里的 `skill path not found` 警告（挂载的目录不存在时会打）。
2. **模型到底调了什么**：`<数据目录>/logs/debug-<日期>.log` 里的 `tool-pending` / `tool-start` / `tool-done`
   三行带完整 `args` 与 `output`——一眼能看出它是在调 `skill`，还是绕路去 `bash`/`read` 猜路径。
3. **智能体有没有权限**：`skill` 权限在 `opencode.json` 的 `permission` 里是 `allow`；小杰（内置管家）
   刻意没有 `bash`/`edit`/`write`/`patch`——它**能加载**技能但**不能执行**技能里的脚本，
   这种情况下它应当如实说明，而不是编内容。
