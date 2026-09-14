import { ADMIN_TOOL_NAMES } from './adminTools.js'
import { PROJECT_STATUSES, TASK_PRIORITIES, TASK_STATUSES } from '../db/repos.js'

export interface ToolDef {
  name: string
  description: string
  args: Record<string, { type: string; description?: string; items?: unknown; enum?: string[] }>
}

/** 全量工具定义（M1：admin；M2：project/task；M3：memory/session_search/delegate） */
export function allToolDefs(): ToolDef[] {
  return [
    {
      name: ADMIN_TOOL_NAMES[0], // jeff_agent_create
      description:
        '创建一个新的智能体（Jeff 里的聊天好友）。创建前先和用户确认名字与用途；模型可留空表示跟随全局默认。返回新智能体 id。',
      args: {
        name: { type: 'string', description: '显示名，如「架构师阿伟」' },
        avatar: { type: 'string', description: '头像 emoji，默认 🤖' },
        description: { type: 'string', description: '一句话简介（仅展示）' },
        instructions: { type: 'string', description: '身份指令/系统提示（它擅长什么、怎么干活的规矩）' },
        model_provider: { type: 'string', description: '默认模型 provider id，可留空' },
        model_id: { type: 'string', description: '默认模型 id，可留空' },
        thinking: { type: 'string', description: "默认思考档位：空串=跟随模型；none/low/high/max", enum: ['', 'none', 'low', 'high', 'max'] },
      },
    },
    {
      name: ADMIN_TOOL_NAMES[1], // jeff_agent_update
      description: '修改智能体信息（名字/头像/简介/指令/默认模型/思考程度/归档）。内置管家小杰不可修改。',
      args: {
        id: { type: 'string', description: '智能体 id' },
        name: { type: 'string', description: '新名字（可选）' },
        avatar: { type: 'string', description: '新头像 emoji（可选）' },
        description: { type: 'string', description: '新简介（可选）' },
        instructions: { type: 'string', description: '新指令（可选）' },
        model_provider: { type: 'string', description: '模型 provider（可选）' },
        model_id: { type: 'string', description: '模型 id（可选）' },
        thinking: { type: 'string', description: "思考档位：空串=跟随模型；none/low/high/max", enum: ['', 'none', 'low', 'high', 'max'] },
        archived: { type: 'boolean', description: '归档/取消归档（可选）' },
      },
    },
    {
      name: ADMIN_TOOL_NAMES[2], // jeff_agent_delete
      description: '删除智能体（软删除）。内置管家小杰不可删除。删除前必须先跟用户确认。',
      args: { id: { type: 'string', description: '智能体 id' } },
    },
    {
      name: ADMIN_TOOL_NAMES[3], // jeff_agent_list
      description: '列出所有智能体（含内置管家小杰）。',
      args: {},
    },
    {
      name: ADMIN_TOOL_NAMES[4], // jeff_agent_get
      description: '查询单个智能体详情。',
      args: { id: { type: 'string', description: '智能体 id' } },
    },
    // M2 追加：project/task 工具
    {
      name: 'jeff_project_create',
      description:
        '创建项目群（= 微信群）：需要群名、群主 leader（某个智能体 id，统筹一切）和工作者列表（统一 worker，不做开发/产品等细分类）。返回项目 id。',
      args: {
        title: { type: 'string', description: '群名' },
        icon: { type: 'string', description: '群图标 emoji' },
        description: { type: 'string', description: '群简介' },
        leader_agent_id: { type: 'string', description: '群主智能体 id（必须已存在）' },
        workspace_dir: { type: 'string', description: '工作空间目录（可选；空=Jeff 默认工作区；群内产出默认落此目录）' },
        members: {
          type: 'array',
          description: '工作者列表（role 忽略，一律存为 worker），每项 {agentId}',
          items: { type: 'object' },
        },
      },
    },
    {
      name: 'jeff_project_update',
      description: '修改项目群（名称/简介/图标/状态/群主/工作空间目录）。',
      args: {
        id: { type: 'string', description: '项目 id' },
        title: { type: 'string', description: '新群名（可选）' },
        description: { type: 'string', description: '新简介（可选）' },
        icon: { type: 'string', description: '新图标（可选）' },
        status: { type: 'string', description: '状态', enum: [...PROJECT_STATUSES] },
        leader_agent_id: { type: 'string', description: '新群主 id（可选）' },
        workspace_dir: { type: 'string', description: '工作空间目录（可选；传空串清除为默认工作区）' },
      },
    },
    {
      name: 'jeff_project_list',
      description: '列出所有项目群（含群主与工作者）。',
      args: {},
    },
    {
      name: 'jeff_project_add_member',
      description: '向项目群添加工作者智能体（角色固定为 worker）。',
      args: {
        project_id: { type: 'string', description: '项目 id' },
        agent_id: { type: 'string', description: '智能体 id' },
      },
    },
    {
      name: 'jeff_project_remove_member',
      description: '把工作者智能体移出项目群（不能移除群主；请先改群主）。',
      args: { project_id: { type: 'string', description: '项目 id' }, agent_id: { type: 'string', description: '智能体 id' } },
    },
    {
      name: 'jeff_project_delete',
      description: '解散/软删除项目群（任务与群聊记录随软删除保留，可从同步历史恢复）。删除前必须先跟用户确认。',
      args: { id: { type: 'string', description: '项目 id' } },
    },
    {
      name: 'jeff_task_create',
      description: '在项目里创建任务（编号自动生成 JEF-n）。可指定指派对象（智能体）、优先级。',
      args: {
        project_id: { type: 'string', description: '项目 id' },
        title: { type: 'string', description: '标题' },
        description: { type: 'string', description: '描述/验收标准' },
        priority: { type: 'string', description: '优先级', enum: [...TASK_PRIORITIES] },
        assignee_agent_id: { type: 'string', description: '指派的智能体 id（可选）' },
        parent_task_id: { type: 'string', description: '父任务 id（可选，子任务拆分）' },
      },
    },
    {
      name: 'jeff_task_update',
      description: '修改任务（标题/描述/状态/优先级/指派/排序）。',
      args: {
        id: { type: 'string', description: '任务 id' },
        title: { type: 'string', description: '新标题（可选）' },
        description: { type: 'string', description: '新描述（可选）' },
        status: { type: 'string', description: '新状态', enum: [...TASK_STATUSES] },
        priority: { type: 'string', description: '新优先级', enum: [...TASK_PRIORITIES] },
        assignee_agent_id: { type: 'string', description: '改指派（传空串清除）' },
      },
    },
    {
      name: 'jeff_task_list',
      description: '列出项目里的任务（可按状态过滤）。',
      args: {
        project_id: { type: 'string', description: '项目 id' },
        status: { type: 'string', description: '状态过滤（可选）', enum: [...TASK_STATUSES] },
      },
    },
    {
      name: 'jeff_task_delete',
      description: '删除任务（软删除）。',
      args: { id: { type: 'string', description: '任务 id' } },
    },
    // M3 追加：memory / session_search / delegate
    {
      name: 'jeff_memory',
      description:
        '读写长期记忆（会在每次对话时注入 system prompt，请保持精炼）。' +
        'action: list 查看 / add 新增（与现有条目重复则不重复添加）/ replace 用 new_text 替换 old_text 唯一匹配的条目 / remove 删除 old_text 唯一匹配的条目 / batch 原子执行一组操作（用于腾空间时合并整理）。' +
        'scope（可选）：省略=写自己的 agent 记忆；user=全局用户画像；project:<projectId>=项目群记忆。' +
        '适合记：用户偏好、环境事实、被纠正的错误、长期惯例；不要记：可随时重查的信息、当前会话临时内容。',
      args: {
        action: { type: 'string', description: '操作', enum: ['list', 'add', 'replace', 'remove', 'batch'] },
        scope: {
          type: 'string',
          description: "记忆域：省略=self；user=用户画像；project:<projectId>=项目记忆（内置管家还可写 user）",
        },
        text: { type: 'string', description: 'add 的新条目内容' },
        old_text: { type: 'string', description: 'replace/remove 的唯一子串匹配' },
        new_text: { type: 'string', description: 'replace 的替换内容' },
        operations: {
          type: 'array',
          description: 'batch 的操作数组，每项 {action, text?, old_text?, new_text?}',
          items: { type: 'object' },
        },
      },
    },
    {
      name: 'jeff_session_search',
      description:
        '全文搜索所有历史会话（你自己的、项目群里的）。返回命中的会话与消息片段。用于回忆「之前说过什么/怎么定的」。',
      args: {
        query: { type: 'string', description: '关键词（支持中文）' },
        limit: { type: 'number', description: '返回条数，默认 8' },
        scope: { type: 'string', description: '限定范围（可选）：private:<agentId> 或 group:<projectId>' },
      },
    },
    {
      name: 'jeff_delegate',
      description:
        '（仅群主 leader）把一项具体工作委派给群成员智能体执行：它会带着群上下文在独立会话里干完并把结果回帖到群里。' +
        '委派后你会被唤醒看到结果，再决定是否汇总或继续委派。instruction 要具体：做什么、产出什么、何时算完成。',
      args: {
        member_agent_id: { type: 'string', description: '成员智能体 id' },
        instruction: { type: 'string', description: '具体任务指令' },
      },
    },
    // M4 追加：定时任务（小杰代操「每天早上 8 点…」）
    {
      name: 'jeff_cron_create',
      description:
        '创建定时任务：到点自动向某个智能体（私聊）或项目群发一条消息并让它执行/回复，用于「每天早上 8 点在群里问今天的病区动态」「每天 8 点让 AI 资讯助手报最新资讯」这类场景。' +
        'cron_expr 是 5 段式（分 时 日 月 周，本机时区）：0 8 * * * = 每天 08:00；30 8 * * 1-5 = 工作日 08:30。创建前先和用户确认时间与提示词。',
      args: {
        name: { type: 'string', description: '任务名，如「晨间病区动态」' },
        target_type: { type: 'string', description: '目标类型：agent=私聊某智能体 / project=项目群', enum: ['agent', 'project'] },
        target_id: { type: 'string', description: '目标 id：智能体 id 或项目 id' },
        cron_expr: { type: 'string', description: '5 段式 cron：分 时 日 月 周（如 0 8 * * *）' },
        prompt: { type: 'string', description: '到点要发出的提示词（如「请汇报今天的病区动态」）' },
        miss_policy: { type: 'string', description: '错过处理：catchup=开机后补跑一次（重要）/ skip=顺延跳过（不重要）', enum: ['catchup', 'skip'] },
      },
    },
    {
      name: 'jeff_cron_list',
      description: '列出所有定时任务（含目标、时间描述、启用状态、上次运行结果）。',
      args: {},
    },
    {
      name: 'jeff_cron_update',
      description: '修改定时任务（改名/改时间/改提示词/改错过策略/启用停用）。',
      args: {
        id: { type: 'string', description: '任务 id' },
        name: { type: 'string', description: '新任务名（可选）' },
        cron_expr: { type: 'string', description: '新 cron 表达式（可选）' },
        prompt: { type: 'string', description: '新提示词（可选）' },
        miss_policy: { type: 'string', description: '错过处理（可选）', enum: ['catchup', 'skip'] },
        enabled: { type: 'boolean', description: '启用/停用（可选）' },
      },
    },
    {
      name: 'jeff_cron_delete',
      description: '删除定时任务（软删除）。删除前先跟用户确认。',
      args: { id: { type: 'string', description: '任务 id' } },
    },
    // M4 追加：插件
    {
      name: 'jeff_plugin_list',
      description:
        '列出已安装的插件（如「智慧病房」）：包含插件名、简介、首页地址、提供的快捷指令与 MCP 工具。' +
        '插件是「打包好的能力」，启用后它的工具会以 MCP 形式可用。用户问「装了什么插件 / 智慧病房怎么用」时用本工具。',
      args: {},
    },
    // M4 追加：内置浏览器（任意 agent 可用，模拟人操作网页）
    {
      name: 'jeff_browser_navigate',
      description:
        '在内置浏览器面板里打开一个网址并等待加载完成（若是本地服务首页，如插件 homepage，直接用即可）。' +
        '面板未打开时会自动打开；面板是用户可见的，用户可以同时看到你在做什么。',
      args: { url: { type: 'string', description: '要打开的 http/https 地址' } },
    },
    {
      name: 'jeff_browser_get_content',
      description: '读取内置浏览器当前页面的可见文本与结构信息（标题、URL、主要文本、可交互元素清单）。分析页面、找按钮/输入框时先调它。',
      args: {
        max_chars: { type: 'number', description: '返回文本上限，默认 8000' },
        selector: { type: 'string', description: '只取某个 CSS 选择器内的内容（可选）' },
      },
    },
    {
      name: 'jeff_browser_click',
      description: '在内置浏览器里点击元素（模拟真人点击）：优先用 CSS 选择器；也可用文字匹配（点击包含该文字的可点击元素）。',
      args: {
        selector: { type: 'string', description: 'CSS 选择器（可选，优先）' },
        text: { type: 'string', description: '要点击的元素文字（选择器为空时按文字查找按钮/链接）' },
      },
    },
    {
      name: 'jeff_browser_type',
      description: '在内置浏览器里向输入框键入文字（会先聚焦并用原生输入事件，兼容 React 等受控组件）。',
      args: {
        selector: { type: 'string', description: '输入框 CSS 选择器' },
        text: { type: 'string', description: '要输入的文字' },
        clear: { type: 'boolean', description: '是否先清空原有内容（默认 true）' },
        submit: { type: 'boolean', description: '输入后是否回车提交（默认 false）' },
      },
    },
    {
      name: 'jeff_browser_screenshot',
      description: '截取内置浏览器当前画面（返回图片给支持视觉的模型）。模型不支持看图时会自动降级为页面文本。',
      args: {},
    },
  ]
}
