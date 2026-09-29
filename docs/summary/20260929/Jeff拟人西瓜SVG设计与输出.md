# Jeff 拟人西瓜扁平化 Logo 重构（对齐 Cue Agent 极简纯粹几何风格）

## 1. 迭代背景与风格对齐

根据用户提供的参考图（`/home/xujian/Pictures/Snipaste_2026-09-29_22-37-55.png`），准确提炼出了 **Manus / Cue Agent** 角色图标的核心视觉特征：
1. **纯几何色块外形**：如火滴、五角星、公文包、三角形、圆形、爱心、圆角方块；线条圆润干净，没有任何藤蔓、渐变、腮红或多余零碎点缀。
2. **极简拟人五官系统（Cue 风格）**：
   - **大圆形白眼底**（`#FFFFFF`）+ **纯黑大瞳孔**（`#0F172A`），瞳孔带有微微的注视朝向（可爱、呆萌、专注）；
   - **极简小黑线条嘴**：一笔带有微微倾斜弧度的小黑微笑线（`stroke-linecap="round"`），瞬间勾勒出俏皮治愈的性格。
3. **半圆西瓜契合**：西瓜天然就是「半圆切片」或「半圆拱顶」，红绿经典对比，无需任何条纹与瓜藤细节即可一眼认出是西瓜。

## 2. 核心设计呈现

### 方案 A（正式采用·标准西瓜切片）：[`docs/assets/logo.svg`](docs/assets/logo.svg)
- **外形结构**：平顶圆弧底的半圆形西瓜切片（外圈平滑圆角翡翠绿皮 `#10B981` + 内圈西瓜鲜红瓤 `#F43F5E`）；
- **五官呈现**：一对经典的 Cue 纯圆大白眼与专注小黑瞳孔 + 极简弧线小嘴；
- **效果预览**：
  ![Jeff Semicircle Logo](docs/assets/logo.png)

### 方案 B（半圆拱顶西瓜切片）：`docs/assets/logo-dome-slice.png`
- **外形结构**：平底圆弧顶的半圆拱门切片形态；
- **效果预览**：
  ![Jeff Dome Slice](docs/assets/logo-dome-slice.png)

### 方案 C（纯绿色半圆几何体）：`docs/assets/logo-solid-green.png`
- **外形结构**：完全对齐参考图中纯蓝三角形/纯青圆形/纯灰方形的单色块极简小怪兽风格；
- **效果预览**：
  ![Jeff Solid Green](docs/assets/logo-solid-green.png)

## 3. 产出与提交

- 矢量源码：[`docs/assets/logo.svg`](docs/assets/logo.svg)（仅 12 行 SVG 代码，纯几何无冗余）
- 渲染预览：[`docs/assets/logo.png`](docs/assets/logo.png)（512×512）
- 变体产物：`docs/assets/logo-dome-slice.png`、`docs/assets/logo-solid-green.png`
