# 插件开发（Jeff v1.8.0+）

插件的定位：**把「必须用、但不通用」的能力打包给 Jeff**。典型例子是行业系统（如智慧病房）——
它本质是一个 MCP 服务，但手工配 MCP（地址、认证头、环境变量）对使用者太重。
插件把「MCP 接入 + 快捷指令 + 首页」写成一个声明文件，用户点一下启用即可。

## 目录结构

插件就是**一个目录**，放在 Jeff 的插件根目录里：

```
~/.jeff/plugins/<plugin-id>/
  plugin.json          # 必需：清单（下节）
  <其它文件>            # 可选：图标、说明、脚本等，会随插件一起备份到 WebDAV
```

- 目录名与 `plugin.json` 的 `id` 必须一致（不一致时以清单为准，但改名会更清晰）。
- 目录本身就是注册表：删目录 = 卸载，不需要改数据库。
- 启用状态与密钥存在 Jeff 本地（**不参与 WebDAV 同步**），配置随机器走。

安装方式：把目录放进 `~/.jeff/plugins/`，或在 **插件页 → 导入插件** 选择一个含 `plugin.json` 的目录。
仓库里 `examples/plugins/zhbf-night/` 是一个可直接导入的样例（MCP 指向 mac mini 演示环境
`http://192.168.3.249:4000/mcp`，含护士站看板首页统计工具）。

## plugin.json

```jsonc
{
  "id": "zhbf-night",              // 必填，字母数字 . _ -（用作 MCP 注入前缀）
  "name": "智慧病房",               // 必填，界面显示名
  "version": "1.0.0",              // 可选，仅展示
  "icon": "🏥",                     // 可选，emoji 图标
  "description": "一句话说明这个插件干什么",  // 可选
  "homepage": "http://localhost:5173/dashboard", // 可选，http(s)；插件页可一键用内置浏览器打开

  // 可选：聊天框输入 / 呼出的快捷指令（name 必须以 / 开头，prompt 是选中后插入并发送的内容）
  "commands": [
    { "name": "/zhbf", "description": "查看病区整体动态", "prompt": "请通过智慧病房插件查询当前病区概况…" }
  ],

  // 可选：MCP 接入声明。启用插件时自动写入 Jeff 的 MCP 配置（key = plugin-<id>），停用即摘除
  "mcp": {
    "url": "http://127.0.0.1:8080/mcp",   // remote：Streamable HTTP 地址
    "headers": { "X-Agent-Token": "${SECRET}" }, // 认证头；${SECRET} 取插件页里保存的密钥
    "tools": ["ward_overview", "ward_labs"]      // 仅作说明展示，实际以服务端 tools/list 为准
  }
}
```

local（stdio）型 MCP 服务改用 `command` 与 `environment`：

```jsonc
"mcp": { "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"], "environment": { "FOO": "bar" } }
```

`mcp` 与 `commands` 都可以省略（纯指令插件、纯展示插件都合法）。

## 跟小杰说句话就能做插件（v1.8.2+）

不用手写 `plugin.json`：私聊**小杰**，把需求说清楚，它会用 `jeff_plugin_*` 工具把插件落盘。

例：「帮我做个插件，id 用 `ward-board`，名字叫『病区看板』，MCP 用 http://127.0.0.1:8080/mcp，
加一个 `/ward` 指令查病区概况，首页 http://localhost:5173。」

小杰的这套能力有几条刻意的边界：

- 工具**只给小杰**（`jeff_plugin_*` 在其它智能体的 agent 定义里被禁用）。插件的 `mcp.command`
  会被引擎当子进程拉起、`mcp.url` 会把内网地址接进模型工具面——这等于「写一份能执行命令的配置」，
  与 `jeff_agent_*` 同级，不下放给项目群里可能接触不可信内容的 worker 智能体。
- **新建的插件默认停用**。小杰建完会停下来说清设计要点，你确认后它再调 `jeff_plugin_enable`。
- **带本地命令（`mcp.command`）的插件小杰无法启用**：调 enable 会被拒绝，并让你去插件页点开关。
  这是刻意的安全闸——本地命令会拉起子进程。
- 小杰**没有文件与命令工具**（`bash` / `edit` / `write` / `patch` 在它的 agent 定义里被禁用），
  插件只能通过 `jeff_plugin_*` 结构化落盘，不能由它直接改磁盘文件。
- 参数是**平铺标量**（`mcp_url` / `mcp_command` / `mcp_headers` / `mcp_env`，附带文件用 `files` 数组）。
  这是实测调出来的形状：早期把 MCP 声明写成嵌套对象时，模型侧会把整个对象丢成空串，
  插件就落成「没有 MCP、没有附带文件」的半成品。空串/空数组一律按「没传」处理，
  避免模型补默认值把已配好的字段抹掉（否则一次「全字段补空」的 update 就能清空插件）。

| 工具 | 用途 |
|------|------|
| `jeff_plugin_create` | 新建插件（默认不启用） |
| `jeff_plugin_update` | 改清单（只传要改的字段，其余保持原样） |
| `jeff_plugin_read` | 读原始 `plugin.json` 与目录文件清单（改之前先看现状） |
| `jeff_plugin_enable` | 启用/停用（本地命令型会被拒绝） |
| `jeff_plugin_delete` | 卸载（先与用户确认） |

## 密钥管理

- 清单里需要认证的地方写 `${SECRET}` 占位符。
- 用户在 **插件页 → 钥匙图标** 里粘贴令牌；Jeff 存到本机 kv（`plugin-secret:<id>`），**不进 WebDAV**。
- 注入引擎时占位符被替换为真实值——所以插件目录本身可以安全地提交到 Git 或同步到云端。

## 启用后发生什么

1. Jeff 把 `mcp` 写进 `settings:mcp`（key 为 `plugin-<id>`，**不会覆盖用户手配的同名 MCP**）。
2. `opencode.json` 重写，引擎在下次会话前重启加载——插件的 MCP 工具即可被任意智能体调用。
3. `commands` 出现在私聊/群聊输入框的 `/` 菜单里。
4. `homepage` 可用内置浏览器打开；智能体也能用 `jeff_browser_*` 工具在同一面板里操作这个页面。

## 备份与恢复

- 插件目录会随 WebDAV 同步一起镜像到 `<basePath>/plugins/`（带文件清单 `plugins-manifest.json`）。
- 手动入口在 **设置 → 同步 → 插件**（v1.8.1 起所有备份/恢复入口统一收在设置页）：
  「立即备份」/「从备份恢复」。恢复前会先把本地插件目录快照到 `~/.jeff/backups/plugins-<时间戳>/`，可手工回退。
- 恢复后 Jeff 会重建 MCP 注入；密钥需在本机重新填写（刻意不跨设备同步敏感值）。

## 校验与常见错误

清单在列表里会做校验，写错不会让插件「消失」，而是带错误原因展示（方便修）：

| 错误 | 原因 |
|------|------|
| `插件 id 非法` | id 含 `/`、空格等非法字符 |
| `plugin.json 不是合法 JSON` | 用了 `//` 注释或尾逗号（JSON 不支持） |
| `homepage 必须是 http/https` | 填了 `file://` 等本地协议 |
| `mcp.url 必须是 http/https` | 地址协议不对 |
| `指令名必须以 / 开头` | `commands[].name` 少了斜杠 |
| `mcp 需要 url（remote）或 command（local）` | MCP 声明不完整 |

## 给所有智能体用的能力

插件启用后，**任意**智能体可用的相关工具（`jeff_plugin_*` 那组只有小杰有）：

| 工具 | 用途 |
|------|------|
| `jeff_plugin_list` | 列出已装插件、简介、首页、指令与 MCP 工具（智能体回答「装了什么插件」时用） |
| `jeff_browser_navigate` / `click` / `type` / `get_content` / `screenshot` | 在内置浏览器里模拟人操作网页（面板未打开会自动打开） |
