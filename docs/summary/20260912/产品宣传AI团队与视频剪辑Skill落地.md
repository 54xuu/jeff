# 「产品宣传」AI 视频创作团队与 jeff-video-cut 落地

> 日期：2026-09-12
> 目标：组建一个能按产品宣传需求自动产出「抖音短视频 mp4 + 自媒体说明文件」的 AI 团队，
> 并让相关能力通过 WebDAV 同步到 Windows 后开箱可用。

## 一、交付物总览

| 类别 | 位置 | 说明 |
|---|---|---|
| 新 skill | `~/.agents/skills/jeff-video-cut/` | 图文口播视频合成，内置跨平台 ffmpeg |
| 新智能体 | 宣经理 `agt_UQQFkvOI0CLm`、音小合 `agt_gs2LexF4vwUJ`、视小剪 `agt_yWtKjPslA9ca` | 绘小图 `agt_msnkRmHzcCha` 复用并扩充指令 |
| 新项目群 | `产品宣传` `prj_5HA5Es6CYHCs` | 群主宣经理 + 绘小图/音小合/视小剪，工作空间 `/home/xujian/cdbox/product-promo` |
| 视频产物 | `/home/xujian/cdbox/product-promo/deliver/` | 5 条 8~9 秒成片（2 个主题 / 4 种规格） |
| 发布文案 | 各 `deliver/*/自媒体说明文件.md` | 标题 ≤20 字无 Emoji、简介 ≤55 字、5 个标签 |
| 分镜表 | `docs/分镜/*-分镜表.md` | 两个主题各一份 |
| WebDAV | `/jeff/skills/…`、`/jeff/agents-md/…` | skills 镜像 + 智能体/项目群数据 + 视频备份 |

## 二、jeff-video-cut：为什么自己写一个

现有环境里**没有**本地视频剪辑能力：`yuanchu-pipeline` 走的是局域网 Mac mini 渲染 API，
不具备单机可用性。所以新建了自包含 skill。

### 架构

```
分镜脚本(JSON) + 图片 + 配音mp3
        │
        ├─ Pillow 合成整幅画面（底图适配 + 中文排版 + 底衬/描边/阴影）
        │     → 每个场景一张与画幅等尺寸 PNG
        │
        └─ ffmpeg 生成时间轴（xfade 转场 + acrossfade 音频 + 混音 + x264/aac）
              → mp4
```

之所以把排版放 Pillow、把时间轴放 ffmpeg：中文换行、自动缩号、半透明底衬这些用
`drawtext`/`drawbox` 很难调准，而 Pillow 一次渲染成整幅图后，编码侧只剩时间轴，
问题域被切干净，也方便 `--keep-temp` 直接目检排版。

### 内置 ffmpeg 的体积取舍（关键决策）

原始二进制太大：Linux `ffmpeg` 76MB、Windows `ffmpeg.exe` 157MB（BtbN master 构建），
两平台裸装 ~233MB，直接做 WebDAV 镜像既慢又容易 PUT 超时。

采用**「xz 压缩包内置 + 首次运行解压到缓存目录」**：

| 平台 | 包大小 | 解压后 | 来源 |
|---|---|---|---|
| linux-x64 | 20.23 MB | 76.13 MB | johnvansickle static（完全静态，无 glibc 依赖） |
| windows-x64 | 47.17 MB | 156.71 MB | BtbN ffmpeg-master-latest-win64-gpl |

- 同步体积从 233MB 降到 **67MB**，且首次运行只需 2~3 秒（Linux 实测 2.5s）
- 解压目标为 `~/.cache/jeff-video-cut/bin/<platform>/`（Windows 为 `%LOCALAPPDATA%`），
  **故意放在 skills 目录之外**——否则解压出的裸二进会被 WebDAV 镜像再次上传，
  白白把 233MB 推上远端
- `bin/manifest.json` 记录 sha256，解压后校验，防同步损坏
- 中文字体同样内置：从 Noto Sans CJK SC 子集化出 **3.0MB / 7562 字**（覆盖 GB2312 全集），
  Windows 端不再依赖系统是否装了微软雅黑

### 能力清单

- 画幅：`9:16`(1080×1920) / `16:9` / `1:1` / `4:5` / `3:4` / `4:3` / `2:1`，或直写 `1080x1920`
- 两种排版模式：`stack`（自动纵向堆叠，标题折行不撞副标题）、`absolute`（绝对定位字幕/角标）
- 文案：自动换行、自动缩号、`max_lines` 截断、字间距、行高、描边、阴影、圆角底衬、整组底衬
- 底图适配：`cover` / `contain` / `blur`（模糊底 + 完整图）
- 转场 16 种；`Ken Burns` 缓推；背景音乐循环 + 音量 + 尾淡出
- 自动对比度护栏（见下文问题 5）
- 辅助：`--dry-run` 校验不编码、`--probe` 替代 ffprobe、`--keep-temp` 保留合成图

## 三、团队配置

| 成员 | 角色 | thinking | 职责 |
|---|---|---|---|
| 宣经理 | leader | high | 需求追问 → 分镜表 → 派活 → 验收 → 写《自媒体说明文件.md》 |
| 绘小图 | worker | low | 封面/插图/结尾图（jeff-image-gen） |
| 音小合 | worker | low | 逐段口播配音 + 报时长（jeff-tts） |
| 视小剪 | worker | low | 编排时间轴、烧字幕、导出 mp4（jeff-video-cut） |

- 流水线：**宣经理追问 → 分镜表经用户确认 → 绘图 → 配音 → 剪辑自检 → 验收 → 发布文案**
- 用户可随时 `@` 任一 worker 改细节，其余成员不插话
- 项目规矩落在 `~/.jeff/agents-md/prj_5HA5Es6CYHCs.md`，随同步下发
- 抖音硬指标写进 leader 指令：标题 ≤20 字**无 Emoji**、简介 ≤55 字（少量 Emoji）、**恰好 5 个**标签

## 四、5 轮测试记录（每轮 5~10 秒）

| 轮次 | 主题 | 规格 | 时长 | 验证重点 |
|---|---|---|---|---|
| R1 | POCT 一体机 | 9:16 | 8.63s | 全链路真实生图 + 双段配音 + 字幕 |
| R2 | POCT 一体机 | 16:9 | 8.43s | 横屏适配、`blur` 布局、Ken Burns、整组底衬 |
| R3 | POCT 一体机 | 9:16 | 8.77s | 同图硬切换字幕（无缝换词）、混用转场 |
| R4 | POCT 一体机 | 9:16 | 7.70s | 换音色（知性女声）、长句自动缩号、对比度护栏 |
| R5 | 智慧护理看板 | 9:16 | 8.77s | 全新主题完整闭环 + 交付目录 + 发布文案 |

每轮均抽帧目检，证据留在 `.tmp/evidence/r1..r5/`。真实调用统计：生图 6 张、TTS 7 段。

## 五、测试中修掉的 6 个真实问题

### 1. `setpts=PTS-STARTPTS` 让 xfade 直接拒绝

**现象**：`The inputs needs to be a constant frame rate; current rate of 1/0 is invalid`。
**排查**：逐滤镜做矩阵实验，定位到只要链上出现 `setpts=PTS-STARTPTS`，
xfade 就判定输入帧率非法（`fps` / `format` / `setsar` / `settb` 都无辜）。
**修复**：去掉视频链上的 `setpts`（图片输入本就从 PTS 0 开始，是多余的）。

### 2. 混用硬切与淡入淡出时视频被腰斩（最隐蔽）

**现象**：R3 预期 8.84s，实际只出 **4.40s**。
**根因**：帧量化。原先用 `0.02s` 近似硬切，而 30fps 下一帧是 `0.0333s`——
过渡比一帧还短，xfade 在帧边界上提前终止了整条链；且各路时长的浮点累加
与 ffmpeg 实际产出的整帧数不一致，越叠越偏。
**修复**：把整条时间轴改成**以帧为基准**——所有时长量化到整帧、转场最少 1 帧、
硬切在全 xfade 链里也按 1 帧扣减，`total_frames` 与 `build_filter` 口径完全对齐。
修复后三轮时长与预期**逐帧一致**。

### 3. 结尾图被模型烘死 `Thank You`

**现象**：生成的结尾图自带居中的 `Thank You`，与叠加的「感谢观看」撞成一团。
**根因**：提示词里写了「ending card / 致谢卡片」，强烈诱导模型自己排版文字，
`no text` 压不住。
**修复**：改描述为「abstract empty background texture」，并把负面约束写狠
（`no typography / no letterforms / no watermark / no signature text / nothing resembling writing`）。
重生成后干净。已把这条教训写进 `绘小图` 指令与 skill 的素材自检章节。

### 4. 素材里被模型加了「文字占位框」

**现象**：R5 正文图中间出现一个浅色半透明圆角矩形，与字幕底衬叠成两层。
**根因**：模型在有人物站位的构图上自己画了个「排版占位框」。
**修复**：提示词补 `no placeholder boxes, no frames, no borders, no panels, no rounded rectangles,
no UI elements`，重生成。同类教训一并固化进指令与 skill。

### 5. 浅色底图上的浅色字幕不可读 → 加自动对比度护栏

**现象**：R4 封面长副标题（浅青 `#8FE3FF`）压在明亮的墙面上，几乎看不清。
**根因**：上游素材明暗不可控，写死颜色的文案不保证可读。
**修复**：在渲染前**实测对比度**——把文字落点区域切成 6×4 网格取最差格的对比度
（整块取平均会被明暗混杂区域骗过，实测踩过这个坑），低于 3:1 就自动补一圈反色描边
并打印告警，让 agent 知道「这条本来看不清」，而不是默默出一版废片。
护栏生效后 R1/R3/R4 各自动修正一处低对比文案。

### 6. 配音语速与时长估算偏差

**现象**：按「字符数 ÷ 语速」估算场景时长，实测偏短约 2 倍。
**实测**：13 字无逗号 ≈ 2.6s（0.33 s/字）；带停顿的逗号每个约 +0.5~0.9s。
**修复**：流程上强制「配音先行 + 用 `--probe` 量出真实时长再写分镜」，
不再靠估算；`jeff-tts` 侧把实测基线写进注释供后续参考。

## 六、WebDAV 同步结果

### skills 镜像

```
backupSkills() → ok, uploaded 109, skipped 531, deleted 0, 152.7s
```

- 新增 `jeff-video-cut` 全部文件（2 个 xz + 2 个字体 + 5 个脚本 + 文档）已上传
- 已实现的增量哈希生效：531 个既有文件全部跳过，未重复上传
- 远端逐一 HEAD 校验 12 个关键文件，**全部 200 且体积一致**
- 大文件首次上传需要更长超时：备份时把 `timeoutMs` 临时调到 600s，
  完成后**原样还原为 60s**，未改动用户配置

### 智能体 / 项目群

`syncNow()` 后远端 `agents.json` 含 4 位成员（指令完整）、
`projects.json` 含「产品宣传」群（标题/群主/成员/工作空间齐全）、
`agents-md/project-prj_5HA5Es6CYHCs.md` 已下发。

### 跨平台可用性

Jeff 同步引擎对 `workspace_dir` 的设计是**按设备保留**（应用远端时忽略路径），
所以 Windows 端同步后不会拿到 Linux 路径，会落到 Windows 自己的默认工作区，开箱可用。
若想在 Windows 上指定目录，进群资料改一次即可（可选）。

## 七、怎么用

在 Jeff 里进入「产品宣传」项目群，把想宣传的功能说给宣经理，例如：

> 帮我做一条「血气分析仪 AI 智能助手」的宣传视频，面向检验科主任，重点讲自动审核和异常预警。

宣经理会先反问产品、受众、核心卖点、时长、画幅、禁忌，
给出分镜表让你确认，确认后依次派给绘小图、音小合、视小剪，
最后交 mp4 + `自媒体说明文件.md`。

### 单独调 skill 的复现命令

```bash
CUT=~/.agents/skills/jeff-video-cut/scripts/video_cut.py

python3 $CUT --spec timeline.json --dry-run     # 先校验
python3 $CUT --spec timeline.json               # 再合成
python3 $CUT --probe voice.mp3                  # 量配音时长
python3 $CUT --list-ratios                      # 画幅档位
```

## 八、遗留与建议

1. **字幕时序**：当前一个场景 = 一段静态文案，同一画面内的时间轴字幕（ass/karaoke）
   需要拆成同图多场景（R3 已验证该手法），暂未做真正的「单场景内字幕行切换」。
2. **背景音乐**：R2 验证了混音链路，但目前没有内置曲库，
   每次都要用户提供 mp3；后续可考虑接入免版权曲库。
3. **Windows 安装包**：本次改动**没有触碰 Jeff 应用代码**，
   skill 走 WebDAV 下发、智能体数据走常规同步，都不在安装包内，
   因此未做版本 bump 与双平台重新打包（打包产物与 v1.7.26 完全一致，无验证价值）。
   如仍需出包，说一声即可。
4. **真实模型端到端**：5 轮测试是直接驱动三个 skill 完成的，
   团队编排（群里 leader 派活）尚未跑真实模型 E2E；建议在 Windows 端首次使用时
   跑一条最简单的需求，确认 sidecar 能拉起这三个 skill。
