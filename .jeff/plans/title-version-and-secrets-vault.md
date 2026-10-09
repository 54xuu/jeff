# 方案：窗口标题显示版本号 + 设置 → 密码（Secrets Vault）

- 状态：**待用户确认执行**（经 grill-me 拷问达成共识，尚未改动任何代码）
- 日期：2026-10-09
- 基线版本：2.2.3　→　目标版本：**2.2.4（PATCH，用户已确认；整包只 bump 一次）**
- 涉及端：桌面端（Ubuntu / Windows）。Android App 本次不做，列为待办（见 §9）。

---

## 1. 需求

1. 不用再进「关于 Jeff」查版本：应用**窗口标题**直接显示版本号。
2. 新增 **设置 → 密码**：集中保存「密码 / 密钥 / Token」（如 `byted-web-search` 需要的 `WEB_SEARCH_API_KEY`）。Jeff 启动时把它们注册为环境变量，skill 脚本不再依赖系统环境变量。

## 2. 拷问结论（决策表）

| # | 问题 | 决策 | 理由 |
|---|------|------|------|
| 1 | 版本号显示位置 | **只改原生窗口标题 `Jeff v2.2.4`** | 改动最小，三平台一致；任务栏 / Alt-Tab 也可见。不做自绘标题栏 |
| 2 | 本机存储 | **Electron `safeStorage` 加密**；不可用（Linux 无 keyring）时**降级明文 + 页面醒目提示** | 现有思源 token、插件密钥均为明文；密码页汇总所有敏感值，风险面更大，应更强。core 保持与 Electron 解耦（`SecretCipher` 接口） |
| 3 | 注入范围与冲突 | **全局注入**所有「已启用」条目；**Jeff 值始终覆盖系统同名变量** | 与用户「启动时注册到系统变量」原意一致；密码页是唯一权威源。sidecar 一个进程服务所有智能体，无法按 skill 隔离，不做假隔离 |
| 4 | 改完何时生效 | **保存后更新注入表；页面横幅「需重启引擎后生效」+「立即重启引擎」按钮**；有运行中对话/定时任务时二次确认；**不自动重启** | sidecar 环境在 spawn 时定死；外部引擎每轮重取，下一轮生效 |
| 5 | 同步与备份 | **值永不离开本机**；仅同步元数据（变量名 / 备注 / 启用状态 / 更新时间 / 删除墓碑）；其他机器显示「待填写」 | 符合 AGENTS.md「敏感值不进备份」硬规则，同时减轻双机重填负担 |
| 6 | 值回显 | 渲染层**默认拿不到明文**，列表只显示「已设置 · 末 4 位」；点「显示 / 编辑」才经**独立 IPC** 按需取明文；**全部密码 IPC 对手机遥控拒绝** | 最小暴露面 |
| 7 | 防泄漏 | **分层**：① 不给模型任何读/写密码的工具（含小杰）② Jeff 落盘脱敏（聊天消息入库、调试日志、sidecar 日志）③ 页面写明局限 | 工具结果直接回灌 LLM，Jeff 拦不住；落盘部分可 best-effort 处理 |
| 8 | 版本号 | **PATCH → 2.2.4** | 用户明确选择 |

## 3. 现状事实（已核实）

- 窗口：`apps/desktop/src/main/index.ts` `createWindow()` 里 `title: 'Jeff'`；`apps/desktop/src/renderer/index.html` 的 `<title>Jeff</title>` 在页面加载后会**覆盖**窗口标题。使用原生标题栏。
- 版本源：`packages/core/src/version.ts` 的 `APP_VERSION`（`ipc.ts` 的 appInfo 已使用）。e2e 中没有对窗口标题的断言。
- skill 脚本由 opencode 的 bash 工具拉起，**继承 sidecar 进程环境**。sidecar 环境 = `SidecarManager.sidecarEnv()`：`{...process.env, XDG_*, OPENCODE_* ..., ...extraEnv()}`，`extraEnv` 由 `JeffCore.sidecarExtraEnv()`（`packages/core/src/index.ts`）提供，**spawn 时求值，且排在最后可覆盖**。
- 外部引擎（codex / claude / cursor / opencode-system）环境来自 `engines/environment.ts` `prepareEnvironment()` 的 `{ ...process.env }`，每轮重新构建。
- kv 表（`kvRepo`）是通用键值存储；同步引擎只同步**显式列出**的 kv 键（`sync/engine.ts` settings 包），新增键默认不同步。
- 先例：思源 token（`integration:siyuan`）、插件密钥（`plugin-secret:*`）明文存 kv，且有单测断言不进 WebDAV（`sync.test.ts`）。
- 远程白名单：`packages/core/src/remote/whitelist.ts`，新增 IPC 必须同一提交归类，否则 `remote.test.ts` 红。
- 设置分区：`SettingsSection`（`store.ts`）、`SettingsNav.tsx`、`SettingsContent.tsx`、`CommandPalette.tsx` 的 `SETTINGS_SECTIONS` 需同步登记。

## 4. 技术实现

### 4.1 窗口标题带版本号（小改动）

- `createWindow()`：`title: \`Jeff v${APP_VERSION}\``。
- 拦截覆盖：`win.on('page-title-updated', (e) => e.preventDefault())`，保证渲染层 `<title>` 不再改写原生标题。
- `index.html` 的 `<title>` 同步在构建期不动（保持 `Jeff`，避免 dev 与打包差异）；以主进程为准。
- 「关于」页保留版本信息不变。
- 标题随 `APP_VERSION` 自动更新，不再手写版本号（避免漂移；`version.test.ts` 已守门）。

### 4.2 密码库（core）：`packages/core/src/secrets/`

文件划分：

| 文件 | 职责 |
|------|------|
| `types.ts` | `SecretCipher`（`isAvailable()/encrypt(plain)/decrypt(blob)`）、`SecretEntry`、`SecretMeta` |
| `vault.ts` | `SecretVault`：增删改查、校验、加解密、元数据导出/合并 |
| `envInjection.ts` | `buildSecretEnv()`：产出要注入的 `Record<string,string>` |
| `redact.ts` | 脱敏器：`setSecretValues()` / `redactText()` |

**数据模型**（kv 键 `secrets:vault`，一个 JSON）：

```ts
interface StoredSecret {
  name: string          // 环境变量名，唯一
  valueEnc: string      // cipher 输出（base64），明文降级时前缀 'plain:'
  note: string          // 备注，如「火山联网搜索 byted-web-search」
  enabled: boolean
  updatedAt: number
  deletedAt: number | null   // 墓碑，仅用于元数据同步
  pending?: boolean     // 元数据从其他机器同步而来、本机尚未填值
}
```

**校验规则**：

- 变量名：`^[A-Za-z_][A-Za-z0-9_]*$`，长度 ≤ 128，大小写敏感（Windows 环境变量不区分大小写 → 保存时按大小写不敏感判重）。
- **保留名拒绝**：`PATH, HOME, USERPROFILE, SHELL, TMPDIR, TEMP, TMP, NODE_OPTIONS, NODE_TLS_REJECT_UNAUTHORIZED` 及前缀 `LD_ / DYLD_ / ELECTRON_ / JEFF_ / XDG_ / OPENCODE_`（这些会破坏运行环境或隔离设计）。
- 值：非空、≤ 8 KB、不含 `\0`；首尾空白保留原样但保存前提示（粘贴常带换行 → UI 侧默认 trim 并说明）。
- 条目数上限 200。

**注入规则**（`buildSecretEnv()`）：仅 `enabled && !deletedAt && !pending && 值可解密` 的条目；解密失败的条目跳过并记录到状态里（不抛错阻塞启动）。

**接入点**：

1. `JeffCore.sidecarExtraEnv()`：把 `buildSecretEnv()` 合并进返回值（排在 TLS 开关之前/之后均可，保留名已被禁止，不会冲突）。因 `extraEnv` 排在 `sidecarEnv()` 最后，天然实现「Jeff 值覆盖系统同名变量」。
2. `prepareEnvironment()`：增加可选参数 `extraEnv`，在 `{...process.env}` 之后合并；`engines/client.ts` 两处调用方传入。**不修改主进程 `process.env`**（避免污染 MCP 探测、ffmpeg 等无关子进程，也避免主进程被动泄漏）。
3. MCP 本地进程由 sidecar 拉起，自动继承；`mcp/probe.ts` 的 `minimalEnv()` 保持最小环境不变。

**Cipher 注入**：

- core 构造时接收可选 `secretCipher`；桌面主进程用 `safeStorage` 实现并传入（`isEncryptionAvailable()`；Linux 额外检查 `getSelectedStorageBackend()`，若为 `basic_text` 视为**不可用**，因为那只是硬编码口令的伪加密）。
- 不可用 → 明文降级，条目带 `plain:` 前缀，状态里 `encrypted=false`，UI 横幅提示；之后如果 cipher 变得可用（装了 keyring），下次保存/启动时**自动迁移**为加密。
- 解密失败（换了系统用户 / keyring 重置）→ 该条目标记「无法解密，请重新填写」，不影响其他条目。

### 4.3 同步（仅元数据）

- `sync/engine.ts` settings 包新增 `secretsMeta`：`[{name, note, enabled, updatedAt, deletedAt}]`，**不含任何 `valueEnc` / 明文**。
- 导入合并：按 `name` 做 LWW（`updatedAt`），墓碑传播删除；本机没有该名字 → 新建 `pending=true`、无值，在 UI 显示「待填写」；本机已有值 → 只更新备注/启用/墓碑，**不动值**。
- 本地填写值后 `pending=false` 并刷新 `updatedAt`。
- 回归单测（`sync.test.ts` 或新增 `secrets-sync.test.ts`）：断言 WebDAV 远端文件中**不含**测试明文与密文，且 B 机器合并后条目为 pending。

### 4.4 脱敏（落盘）

- `redact.ts` 维护当前「已启用且长度 ≥ 8」的值集合（由 vault 在加载/变更时刷新）；`redactText(s)` 用精确子串替换为 `••••(NAME)`，按值长度降序避免前缀吞并。
- 接入点（落地时核对）：`chatMessageRepo.add`（聊天消息入库）、`logger.ts`（调试日志）、sidecar 日志转发（`sidecar.on('log')`）。保持函数式、无副作用，性能以「集合为空直接短路」保证。
- 局限（写进页面和文档）：只能处理**精确值**；模型已经收到的工具结果、被模型改写/编码（base64、截断）的值无法拦截；LLM 提供商侧已收到的内容无法撤回。
- 不加任何 `jeff_secret_*` 工具；`allToolDefs()` 与小杰 Prompt 均不涉及；在 `docs/agents/product-model.md` 写明「密码页不对模型开放」。

### 4.5 IPC 与远程白名单

新增通道（`packages/core/src/ipc/contract.ts`，命名 `secrets:*`）：

| 通道 | 入参 | 返回 | 说明 |
|------|------|------|------|
| `secrets:list` | — | `{ items: {name,note,enabled,hasValue,last4,pending,undecryptable,shadowed?}[], encrypted: boolean, restartNeeded: boolean }` | 无明文 |
| `secrets:save` | `{ name, value?, note, enabled, originalName? }` | 保存后的条目视图 | 改名 = 删旧建新；`value` 省略表示不改值 |
| `secrets:delete` | `{ name }` | void | 写墓碑 |
| `secrets:reveal` | `{ name }` | `{ value }` | 仅「显示/编辑/复制」时调用 |
| `secrets:applyRestart` | — | void | 重启引擎；有运行中任务需先 `secrets:busy` 确认 |
| `secrets:busy` | — | `{ running: number }` | 当前运行中的对话/定时任务数（复用现有运行状态源，落地时核实来源） |

- 以上**全部**在 `whitelist.ts` 的 `DENY` 中登记，note：「密码只在电脑本机管理，手机遥控不可读写」。
- 「重启需求」状态：vault 维护 `appliedHash`（上次 spawn 时注入表的 hash）；当前注入表 hash ≠ `appliedHash` 即 `restartNeeded=true`。sidecar `ready` 后更新 `appliedHash`。
- 保存/删除后 `bus.emit('data-changed','secrets')` 刷新 UI；`scheduleAutoSync()` 仅在元数据变化时触发。

### 4.6 桌面 UI：设置 → 密码

遵循 `docs/ui-interaction-guidelines.md`：

- 注册分区 `secrets`：`store.ts` 的 `SettingsSection`、`SettingsNav.tsx`（名称「密码」，副标题「密钥 / Token / 账号」，锁形图标）、`SettingsContent.tsx`、`CommandPalette.tsx`。
- 新文件 `components/settings/SecretsSettings.tsx`（+ 样式沿用现有 settings 变量）。
- 页面结构（首屏即看出对象与状态）：
  1. 页头「密码」+ 一句话：「这里的变量会在 Jeff 引擎启动时注入环境，供技能脚本使用（如 `WEB_SEARCH_API_KEY`）。」
  2. **状态区**（`role="status"`）：加密状态（「已用系统钥匙串加密」/ 红色「系统钥匙串不可用，当前以明文保存在本机」）；`restartNeeded` 时的横幅 + 「立即重启引擎」按钮。
  3. **局限提示**：「注入后模型可通过执行命令读到环境变量，请只放愿意交给 Jeff 智能体使用的凭据。值不会同步到其他设备。」（折叠为一行 + 展开，避免重复说明。）
  4. 工具栏：搜索框（>6 条出现）+「添加」。
  5. **列表**（单一受控列表，一行一条）：变量名 / 备注 / 状态徽标（已启用 / 已停用 / 待填写 / 无法解密）/ 值摘要「已设置 · ••••1a2b」/ 操作（显示、复制、编辑、启用开关、删除）。
  6. **添加/编辑对话框**：变量名、值（密码型输入 + 眼睛）、备注、启用；变量名实时校验（保留名、重名、格式）并在字段旁给出原因；保存中/已保存/失败状态，**失败保留输入**；未保存关闭需「保存并关闭 / 放弃 / 取消」。
  7. 空状态：「还没有密码。例如为联网搜索技能添加 `WEB_SEARCH_API_KEY`。」+ 添加按钮。
  8. 删除确认：说明「删除后技能将无法读取该变量；其他设备上的同名条目也会被标记删除（值本来就不在其他设备上）」。
- 无障碍：所有输入有可见标签、焦点顺序与视觉顺序一致、对话框有标题与关闭方式、`role="alert"` 报错。
- 窄窗口（宽 1000px 下）列表字段换行，不横向溢出；暗色主题使用主题 token。

### 4.7 文档与规则

- `docs/agents/product-model.md`：新增「密码库」小节（模型对象、注入范围、同步仅元数据、不对模型开放、局限）；备份约定补一句「密码值不进同步/备份，仅元数据走同步」。
- `docs/agents/testing.md`：补「密码注入真实链路验证」做法。
- `CONTEXT.md`：新增术语「密码库 / 注入变量」。
- 若需要决策记录：`docs/adr/` 新增一条「密码值只存本机、全局注入、不对模型开放」。
- 总结文档：`docs/summary/20261009/标题显示版本号与密码库.md`（按全局规则，随提交）。

## 5. 版本与提交

- 实现、测试通过后统一 bump **2.2.4**：根 / core / desktop / mobile / relay 的 `package.json`、`package-lock.json`、`packages/core/src/version.ts`；Android `versionCode = 20204`。
- 提交遵守 AGENTS.md Git 规范：只 `git add -- <明确路径>`，复核 staged diff；`.tmp/` 和凭据不入库。
- `.jeff/plans/` 是否入库：本计划文件默认**不随功能提交**，除非你要求（目录目前未被 gitignore，执行前会再确认一次）。

## 6. 测试与验收

### 6.1 单元测试（`packages/core/tests/`）

新增 `secrets.test.ts`：

- 变量名校验：合法 / 非法字符 / 过长 / 保留名（`PATH`、`LD_PRELOAD`、`ELECTRON_RUN_AS_NODE`、`JEFF_HOME`、`OPENCODE_CONFIG`）/ 大小写不敏感判重。
- 值校验：空 / 超长 / 含 `\0`。
- 加密往返：假 cipher（可切换 available / 抛错）；密文不含明文；明文降级带 `plain:` 前缀；cipher 变可用后自动迁移加密。
- 解密失败：单条标记「无法解密」，其他条目继续注入。
- `buildSecretEnv()`：仅启用 + 有值 + 未删除 + 非 pending；停用/墓碑/pending 不注入。
- 覆盖语义：`sidecarEnv()` 里 Jeff 值覆盖 `process.env` 同名；`prepareEnvironment()` 同样覆盖，且**不修改** `process.env`。
- `list` 视图不含明文；`reveal` 返回明文；改名 = 墓碑 + 新建；`restartNeeded` 的 hash 逻辑（改值 / 停用 / 新增 → true；spawn 后 → false）。
- 脱敏：精确替换、多值、前缀重叠、短值（<8）不处理、空集合短路；`chatMessageRepo.add` 与日志路径各一条用例。
- 同步（`secrets-sync.test.ts`）：远端文件**不含**明文和 `valueEnc`；B 机器合并得到 `pending`；LWW、墓碑传播、已有值不被覆盖。
- `remote.test.ts`：全部 `secrets:*` 通道为 deny（沿用契约自动校验，不改断言）。
- `version.test.ts`：bump 后版本一致。
- 标题：抽出纯函数 `windowTitle(version)`，单测断言 `Jeff v2.2.4` 形态。

### 6.2 UI 封闭 E2E（Playwright，无需模型）

新增 `apps/desktop/e2e/secrets.spec.ts` 并加入 `playwright.config.ts` 的 `secrets` project：

1. **标题**：启动后 `electronApp.evaluate(() => BrowserWindow.getAllWindows()[0].getTitle())` === `Jeff v${APP_VERSION}`；跳转设置页、切换主题后仍不变（验证 `page-title-updated` 拦截）。
2. **空状态 → 添加**：添加 `WEB_SEARCH_API_KEY`，列表显示「已设置 · ••••末4位」；DOM 中**不含**完整明文。
3. **重新读取事实**：重启应用（同一 seed home）后条目仍在；用 IPC `secrets:list` / 直接读 SQLite kv，断言**库内无明文**（加密可用环境）或带 `plain:` 前缀并显示红色横幅（降级环境，由测试注入 cipher 开关）。
4. **校验**：保留名、非法字符、重名在字段旁给错误并禁止保存；失败保留输入。
5. **显示 / 复制 / 编辑 / 停用 / 删除**：每个动作后重新读取验证；删除二次确认。
6. **重启横幅**：保存后出现「需重启引擎后生效」；点「立即重启引擎」后横幅消失、`appInfo.sidecarStatus` 回到 running。
7. **注入真实链路（封闭，不依赖模型）**：测试辅助通过 core 测试钩子直接请求 sidecar 的 shell/pty 能力不稳定，改用**可观测探针**——在 `JEFF_E2E=1` 下，由 core 暴露只读调试端点 `debug:sidecarEnvKeys`（仅返回已注入变量名 + SHA-256(value) 前 8 位，**不返回值**），断言：保存后重启 → 该变量名与哈希出现；停用后重启 → 消失；系统同名变量时 Jeff 值胜出（哈希为 Jeff 值）。
8. **窗口尺寸与主题**：1000×680（最小）、1440×900；亮 / 暗主题截图；检查无横向溢出、对话框不被裁切；长备注 / 长变量名 / 50 条列表 + 搜索可用。
9. **键盘**：Tab 顺序、Esc 关对话框、Enter 提交、焦点环可见。
10. **同步 UI**：设置 → 同步 页不新增任何密码备份入口（防止违反入口约定）。

### 6.3 真实模型 E2E（第二层，聊天/工具链路受影响，必须跑）

按 `docs/agents/testing.md`：

- 在测试 seed 的 `~/.agents/skills/` 放一个临时 skill `secret-probe`（`SKILL.md` + `probe.sh`）：脚本读 `PROBE_SECRET`，把 **SHA-256 哈希**（不是明文）写到服务端可验证位置（`.tmp/` 下文件）。
- 步骤：密码页添加 `PROBE_SECRET=<随机值>` → 重启引擎 → 让 Agent 加载并运行 `secret-probe` → **验收落在服务端事实**：文件里的哈希 = 预期哈希；系统环境里**不设置**该变量以证明来源是密码库。
- 反向：停用该条 → 重启 → 再跑 → 文件显示变量缺失。
- 脱敏验证：让模型执行 `echo $PROBE_SECRET`，断言数据库 `chat_message` 与调试日志中**不含明文**，含 `••••(PROBE_SECRET)`（承认 LLM 侧已收到，属已知局限，写入报告）。
- 外部引擎（若本机有 codex / claude CLI）：抽查一个引擎的子进程环境含该变量（沿用 engines 测试里的 fake CLI 打印 env 哈希，封闭完成，不依赖真实账号）。

### 6.4 全量回归（AGENTS.md 第一层，全部通过才可打包）

```bash
npm test
npm run typecheck
cd apps/desktop && npm run test:e2e
npm run test -w @jeff/mobile
cd apps/desktop && npx playwright test -c e2e/playwright.config.ts --project=v18
cd apps/desktop && npx playwright test -c e2e/playwright.config.ts --project=cron
cd apps/desktop && npx playwright test -c e2e/playwright.config.ts --project=secrets
```

### 6.5 三平台正式交付（硬性门槛）

版本统一 2.2.4、同一份最终源码（先提交代码再打包，清单提交号与实际构建一致）：

| 目标 | 构建 | 验收重点 |
|------|------|----------|
| Ubuntu | `npm run package:linux`（`.deb` + AppImage）；本机 `sudo -S` 安装 deb（口令读 ZCode 记忆，不回显） | deb 版本、asar 逐文件校验（`scripts/verify-asar.mjs`）；安装版标题 `Jeff v2.2.4`；密码页加密状态（本机有 keyring 时应为「已加密」）；重启后条目保留；`secret-probe` 真实跑通 |
| Windows | `npm run package:win`（wine）；`npm run deploy:windows -- --target win11 --android auto --suite <具名测试集>` | PE32 / opencode.exe / 特征串；安装版标题含版本；DPAPI 加密可用；密码注入 + 重启引擎；窗口标题在任务栏可见 |
| Android | `cd apps/mobile && npm run cap:sync && cd android && ./gradlew --no-daemon assembleRelease`（release keystore，口令走环境变量） | 版本 2.2.4 / versionCode 20204；`apksigner verify`；**本次无 App 功能改动**，只验证安装、连接桌面后既有功能正常，并确认 `secrets:*` 经遥控被拒绝（桌面侧日志 / 返回错误文案） |

最终报告必须分别给出 **Ubuntu / Windows / Android 三行结论**（通过 / 失败 / 未验证，含测试范围、产物路径与 SHA-256、证据位置）。

## 7. 实施顺序（拆小步，每步可独立验证）

1. 标题显示版本（含 `windowTitle` 纯函数单测 + e2e 标题用例）。
2. `secrets/` 核心：类型、vault、校验、cipher 接口 + 单测（红→绿）。
3. 注入接入：`sidecarExtraEnv`、`prepareEnvironment`、`appliedHash/restartNeeded` + 单测。
4. IPC 契约 + 主进程实现（`safeStorage` cipher）+ 白名单 deny + `remote.test.ts` 绿。
5. 同步元数据 + 单测。
6. 脱敏 + 单测。
7. UI：分区注册、`SecretsSettings.tsx`、对话框、状态横幅；先静态结构审阅，再接真实 IPC。
8. e2e `secrets` project + `debug:sidecarEnvKeys`（仅 `JEFF_E2E`）。
9. 文档（product-model / testing / CONTEXT / ADR）。
10. 全量回归 → 真实模型 E2E → bump 2.2.4 → 提交 → 三平台打包与安装验收 → 总结文档。

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| Linux 无 keyring，`safeStorage` 实为 `basic_text` 伪加密 | 检测 `getSelectedStorageBackend()`，视为不可用并**明示**明文降级，不假装安全 |
| 换系统用户 / keyring 重置后无法解密 | 单条标记「无法解密」，不阻塞启动，提示重填 |
| 保留名被注入导致 sidecar 异常或隔离失效 | 保存时拒绝；`buildSecretEnv()` 再做一次兜底过滤 |
| 脱敏误伤普通文本 | 仅处理长度 ≥ 8 的精确值；用户可停用条目；单测覆盖边界 |
| 模型读环境变量泄漏到 LLM | 无法技术根除；页面与文档明示；不提供任何模型工具 |
| 同步元数据合并产生「幽灵条目」 | 墓碑 + LWW，单测覆盖；pending 条目不注入 |
| 重启引擎打断运行中的对话 | 不自动重启，运行中任务二次确认 |
| Windows 环境变量名大小写不敏感 | 判重不区分大小写；注入时保持用户输入大小写 |
| 新 IPC 漏登记白名单 | 同一提交内归类，`remote.test.ts` 守门 |

## 9. 不做 / 待办

- **不做**：按 skill / 智能体绑定变量（技术上无法隔离，只会造成假安全感）；主密码；端到端加密同步值；密码相关模型工具；导入系统环境变量 / 其他密码管理器。
- **Android App 待办**：手机端不提供密码管理（遥控对 `secrets:*` 一律拒绝），本次在总结里写明；如需要「手机提示某技能缺变量」可后续单独立项。
- **可后续增强**：skill 的 `SKILL.md` 声明所需环境变量（如 `requires_env`），密码页据此提示「某技能缺 `WEB_SEARCH_API_KEY`」并一键添加。

## 10. 验收清单（执行完成的判定）

- [ ] 窗口标题显示 `Jeff v2.2.4`，切换页面 / 主题不变，三平台安装版实测。
- [ ] 设置 → 密码可增 / 改 / 删 / 停用 / 搜索，值默认不回显，保存后重读事实正确。
- [ ] 加密状态真实可见；降级明文有醒目提示。
- [ ] 保存 → 重启引擎 → `secret-probe` skill 在**系统未设同名变量**时读到正确值（服务端事实验证）。
- [ ] 停用 / 删除后重启不再注入；Jeff 值覆盖系统同名变量。
- [ ] 同步远端文件不含值与密文；其他机器显示「待填写」。
- [ ] 聊天记录与调试日志中无明文（脱敏生效），局限已写入页面与文档。
- [ ] 所有 `secrets:*` IPC 对遥控拒绝。
- [ ] 第一层全部测试 + `secrets` project + 真实模型 E2E 通过。
- [ ] 版本 2.2.4 全仓一致；Ubuntu / Windows / Android 三平台产物构建并按上表验收，最终报告三行结论齐全。
