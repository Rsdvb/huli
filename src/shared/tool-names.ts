// Huli: a tool call's title as a person reads it, where the agent named the call only by its tool.
// `mcp__kettu__read_artifact_type`, as Claude Code names an MCP call, or `kettu: read_artifact_type`,
// as Codex does, reads "Kite · Read artifact type"; another server's tool reads as its server and
// tool humanized, as "GitHub Tools · Create issue"; a bare Claude Code tool name, as "Stop background
// task". The desktop's thread, menu bar panel and Requests pane and the phone all read titles here.

/** The languages the names come in; any other reads English. */
export type ToolNameLocale = 'en' | 'zh-CN'

/** Kite's own server, which the agents know by Kettu's name. */
const OWN_SERVER = 'kettu'

type Names = Record<string, readonly [en: string, zh: string]>

/** Kite's own tools, as the app names them. */
const OWN_TOOLS: Names = {
  // Artifacts
  create_artifact: ['Create artifact', '创建产物'],
  create_artifact_from_type: ['Create artifact from type', '按类型创建产物'],
  read_artifact: ['Read artifact', '读取产物'],
  update_artifact: ['Update artifact', '更新产物'],
  delete_artifact: ['Delete artifact', '删除产物'],
  list_artifacts: ['List artifacts', '列出产物'],
  list_artifact_versions: ['List artifact versions', '列出产物版本'],
  restore_artifact_version: ['Restore artifact version', '恢复产物版本'],
  list_artifact_types: ['List artifact types', '列出产物类型'],
  read_artifact_type: ['Read artifact type', '读取产物类型'],
  read_artifact_data: ['Read artifact data', '读取产物数据'],
  write_artifact_data: ['Write artifact data', '写入产物数据'],
  read_comments: ['Read comments', '读取评论'],
  reply_comment: ['Reply to comment', '回复评论'],
  resolve_comment: ['Resolve comment', '解决评论'],
  // Sessions and agents
  list_agents: ['List agents', '列出 Agent'],
  list_sessions: ['List sessions', '列出会话'],
  get_session: ['View session', '查看会话'],
  read_session_history: ['Read session history', '读取会话记录'],
  rename_session: ['Rename session', '重命名会话'],
  archive_session: ['Archive session', '归档会话'],
  set_board_status: ['Set board status', '设置看板状态'],
  start_session: ['Start session', '开始会话'],
  send_message: ['Send message', '发送消息'],
  set_plan: ['Update plan', '更新计划'],
  notify: ['Notify you', '通知你'],
  // Workflows
  list_workflows: ['List workflows', '列出工作流'],
  create_workflow: ['Create workflow', '创建工作流'],
  suggest_workflow: ['Suggest workflow', '建议工作流'],
  report_step: ['Report step', '汇报步骤'],
  // Memory, the guide and problem reports
  remember: ['Remember', '记住'],
  list_memories: ['List memories', '列出记忆'],
  read_memory: ['Read memory', '读取记忆'],
  update_memory: ['Update memory', '更新记忆'],
  forget_memory: ['Forget memory', '忘记记忆'],
  read_kettu_guide: ['Read Kite guide', '读取纸鸢指南'],
  report_problem: ['Report problem', '报告问题'],
  // Marketplace
  marketplace_check: ['Check Marketplace listing', '检查市场条目'],
  marketplace_mine: ['List my Marketplace listings', '列出我发布的市场条目'],
  marketplace_publish: ['Publish to Marketplace', '发布到市场'],
  marketplace_unlist: ['Unlist from Marketplace', '从市场下架'],
  // Browser
  browser_navigate: ['Open page in browser', '浏览器打开网页'],
  browser_navigate_back: ['Browser back', '浏览器后退'],
  browser_reload: ['Reload browser', '浏览器刷新'],
  browser_snapshot: ['Read browser page', '读取浏览器页面'],
  browser_click: ['Browser click', '浏览器点击'],
  browser_type: ['Browser type', '浏览器输入'],
  browser_press_key: ['Browser key press', '浏览器按键'],
  browser_scroll: ['Browser scroll', '浏览器滚动'],
  browser_select_option: ['Browser select option', '浏览器选择选项'],
  browser_take_screenshot: ['Browser screenshot', '浏览器截图'],
  browser_wait_for: ['Browser wait', '浏览器等待'],
  browser_console_messages: ['Read browser console', '读取浏览器控制台'],
  browser_network_requests: ['Read browser network requests', '读取浏览器网络请求'],
  browser_network_request: ['Read browser network request', '读取浏览器网络请求详情'],
  browser_evaluate: ['Run script in browser', '在浏览器中运行脚本'],
  browser_ask_user: ['Ask you to act in the browser', '请你在浏览器中操作'],
  browser_tabs: ['Browser tabs', '浏览器标签页'],
  browser_upload_file: ['Browser upload file', '浏览器上传文件'],
  browser_hover: ['Browser hover', '浏览器悬停'],
  browser_drag: ['Browser drag', '浏览器拖动'],
  browser_click_at: ['Browser click at a point', '浏览器按位置点击'],
  browser_emulate: ['Browser emulation', '浏览器模拟'],
  browser_route: ['Mock browser network', '模拟浏览器网络请求'],
  browser_downloads: ['List browser downloads', '列出浏览器下载'],
  browser_pdf: ['Save page as PDF', '网页存为 PDF'],
  browser_trace: ['Trace page performance', '记录网页性能'],
  browser_storage_state: ['Saved sign-in state', '已存登录状态'],
  // Computer use
  computer_list_apps: ['List apps on the computer', '列出电脑上的 App'],
  computer_list_windows: ['List windows on the computer', '列出电脑上的窗口'],
  computer_get_window_state: ['Read window state', '读取窗口状态'],
  computer_click: ['Computer click', '电脑点击'],
  computer_type_text: ['Computer type text', '电脑输入文字'],
  computer_press_key: ['Computer key press', '电脑按键'],
  computer_hotkey: ['Computer shortcut', '电脑快捷键'],
  computer_scroll: ['Computer scroll', '电脑滚动'],
  computer_drag: ['Computer drag', '电脑拖动'],
  computer_invoke_menu: ['Choose computer menu item', '打开电脑菜单项'],
  // Devices
  device_list: ['List devices', '列出设备'],
  device_open: ['Open device', '打开设备'],
  device_close: ['Close device', '关闭设备'],
  device_snapshot: ['Read device screen', '读取设备屏幕'],
  device_tap: ['Device tap', '设备点按'],
  device_fill: ['Device fill', '设备填写'],
  device_type: ['Device type', '设备输入'],
  device_scroll: ['Device scroll', '设备滚动'],
  device_swipe: ['Device swipe', '设备轻扫'],
  device_press_button: ['Device button press', '设备按键'],
  device_rotate: ['Rotate device', '旋转设备'],
  device_screenshot: ['Device screenshot', '设备截图'],
  device_install_app: ['Install app on device', '在设备上安装 App'],
  device_launch_app: ['Open app on device', '在设备上打开 App'],
  device_terminate_app: ['Close app on device', '在设备上关闭 App'],
  device_open_url: ['Open link on device', '在设备上打开链接'],
  device_logs: ['Read device logs', '读取设备日志'],
  device_set_appearance: ['Set device appearance', '设置设备外观'],
  device_set_location: ['Set device location', '设置设备位置'],
  device_set_permission: ['Set device permission', '设置设备权限'],
  device_wait: ['Wait on device', '在设备上等待'],
  device_find: ['Find on device', '在设备上查找'],
  device_is: ['Check device screen', '检查设备屏幕'],
  device_get: ['Read device element', '读取设备元素'],
  device_alert: ['Handle device alert', '处理设备弹窗'],
  device_keyboard: ['Device keyboard', '设备键盘'],
  device_batch: ['Run device steps', '在设备上执行多步操作'],
  device_record_start: ['Record device screen', '录制设备屏幕'],
  device_record_stop: ['Stop device recording', '停止录制设备屏幕'],
  device_screenshot_compare: ['Compare device screen', '对比设备截图'],
  device_network: ['Read app network activity', '查看应用网络请求'],
  device_push: ['Send test notification', '发送测试推送'],
  device_perf: ['Sample app performance', '采样应用性能'],
  device_reset_app: ['Reset app data', '重置应用数据'],
  // Terminals
  terminal_run: ['Run in terminal', '在终端运行'],
  terminal_read: ['Read terminal', '读取终端'],
  terminal_wait: ['Wait for terminal', '等待终端'],
  terminal_input: ['Type into terminal', '向终端输入'],
  terminal_stop: ['Stop terminal', '停止终端'],
}

/**
 * Claude Code's own tools the host gives no title of their own, which arrive as their bare names.
 */
const CLAUDE_TOOLS: Names = {
  SendMessage: ['Message agent', '给 Agent 发消息'],
  TeamCreate: ['Create agent team', '创建 Agent 团队'],
  TeamDelete: ['Disband agent team', '解散 Agent 团队'],
  TaskOutput: ['Read background task output', '读取后台任务输出'],
  BashOutput: ['Read background task output', '读取后台任务输出'],
  TaskStop: ['Stop background task', '停止后台任务'],
  KillShell: ['Stop background task', '停止后台任务'],
  KillBash: ['Stop background task', '停止后台任务'],
  Monitor: ['Watch background task', '监视后台任务'],
  ToolSearch: ['Find tools', '查找工具'],
  SlashCommand: ['Run slash command', '运行斜杠命令'],
  ListMcpResourcesTool: ['List MCP resources', '列出 MCP 资源'],
  ReadMcpResourceTool: ['Read MCP resource', '读取 MCP 资源'],
  ListMcpResources: ['List MCP resources', '列出 MCP 资源'],
  ReadMcpResource: ['Read MCP resource', '读取 MCP 资源'],
  RefreshMcpTools: ['Refresh MCP tools', '刷新 MCP 工具'],
  ScheduleWakeup: ['Schedule wakeup', '定时唤醒'],
  CronCreate: ['Create scheduled job', '创建定时任务'],
  CronDelete: ['Delete scheduled job', '删除定时任务'],
  CronList: ['List scheduled jobs', '列出定时任务'],
  EnterWorktree: ['Enter worktree', '进入工作树'],
  ExitWorktree: ['Leave worktree', '离开工作树'],
  Workflow: ['Run workflow', '运行工作流'],
  SendUserFile: ['Send file to you', '发送文件给你'],
  SubagentHandback: ['Hand back to main agent', '交回主 Agent'],
  ReadNotifications: ['Read notifications', '读取通知'],
  PushNotification: ['Send notification', '发送通知'],
  RemoteTrigger: ['Remote trigger', '远程触发'],
  ReportFindings: ['Report findings', '汇报发现'],
  MultiEdit: ['Edit file', '编辑文件'],
  ProposeGoal: ['Propose goal', '提议目标'],
  ProposeSkills: ['Propose skills', '提议技能'],
  propose_skills: ['Propose skills', '提议技能'],
  SetGoal: ['Set goal', '设定目标'],
  ListAgents: ['List agents', '列出 Agent'],
  SendUserMessage: ['Message you', '给你发消息'],
  ReadMcpResourceDirTool: ['List MCP resource folder', '列出 MCP 资源目录'],
  WaitForMcpServers: ['Wait for MCP servers', '等待 MCP 服务器'],
  LSP: ['Ask the language server', '查询语言服务器'],
  EndConversation: ['End conversation', '结束对话'],
  SendFeedback: ['Send feedback', '发送反馈'],
  Projects: ['Projects', '项目'],
  Artifact: ['Artifact', '产物'],
  ClaudeDesign: ['Claude Design', 'Claude Design'],
  OfferChromeSetup: ['Offer Chrome setup', '提议设置 Chrome'],
}

/** Words that keep their own spelling when a name is humanized. */
const WORDS: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  id: 'ID',
  ids: 'IDs',
  url: 'URL',
  urls: 'URLs',
  pr: 'PR',
  prs: 'PRs',
  ui: 'UI',
  github: 'GitHub',
  gitlab: 'GitLab',
  sql: 'SQL',
  html: 'HTML',
  json: 'JSON',
  mcp: 'MCP',
}

const zh = (locale: string): boolean => locale.toLowerCase().startsWith('zh')

/** `read_artifact_type` or `readArtifactType` as "Read artifact type". */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((word) => WORDS[word.toLowerCase()] ?? word.toLowerCase())
  if (words.length === 0) return name
  const first = words[0]!
  words[0] = first.charAt(0).toUpperCase() + first.slice(1)
  return words.join(' ')
}

/**
 * A server's name as the app shows it: Kite for its own; another's words capitalized, a word that
 * has capitals of its own, as `GitHub` in `GitHub_Tools`, kept as written. Claude's connectors from
 * claude.ai read without their `claude_ai_` prefix.
 */
export function serverName(server: string, locale: string = 'zh-CN'): string {
  if (server.toLowerCase() === OWN_SERVER) return zh(locale) ? '纸鸢' : 'Kite'
  const words = server
    .replace(/^claude_ai_(?=.)/i, '')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((word) => {
      const known = WORDS[word.toLowerCase()]
      if (known) return known
      if (/[A-Z]/.test(word)) return word
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
  return words.length > 0 ? words.join(' ') : server
}

// `mcp__<server>__<tool>`, as Claude Code names a call; `<server>: <tool>`, as Codex does. A Codex
// server is a config key: one in lower case, or one with a separator or a tool name with one, so
// that a sentence such as "Error: timeout" is no tool.
const CLAUDE_NAME = /^mcp__(.+?)__([A-Za-z0-9_.-]+)$/
const CODEX_NAME = /^([A-Za-z][A-Za-z0-9_.-]*)\s*[:：]\s*([A-Za-z][A-Za-z0-9_.-]*)$/
// A tool named in snake case, as Codex's dynamic tools are, with nothing else in its title.
const SNAKE_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/

/** The MCP server and tool a call's title names, or null for any other title. */
export function mcpTool(title: string): { server: string; tool: string } | null {
  const text = title.trim()
  const claude = CLAUDE_NAME.exec(text)
  if (claude) return { server: claude[1]!, tool: claude[2]! }
  const codex = CODEX_NAME.exec(text)
  if (!codex) return null
  const [, given, tool] = codex as unknown as [string, string, string]
  const server = given.replace(/^mcp__(?=.)/, '')
  const keyLike = server === server.toLowerCase() || /[_.-]/.test(server) || /[_.-]/.test(tool)
  return keyLike ? { server, tool } : null
}

function named(names: Names, key: string, locale: string): string | undefined {
  const pair = Object.hasOwn(names, key) ? names[key] : undefined
  return pair && (zh(locale) ? pair[1] : pair[0])
}

/** A tool's own name, without its server, as the app shows it. */
export function toolName(server: string | null, tool: string, locale: string = 'zh-CN'): string {
  const own = server !== null && server.toLowerCase() === OWN_SERVER
  return (own ? named(OWN_TOOLS, tool, locale) : undefined) ?? humanize(tool)
}

/**
 * A call's title as it reads: an MCP tool's server and name made readable, a bare tool name in
 * words, any other title as it is.
 */
export function toolTitle(title: string, locale: string = 'zh-CN'): string {
  const bare = title.trim()
  const claudeTool = named(CLAUDE_TOOLS, bare, locale)
  if (claudeTool !== undefined) return claudeTool
  const mcp = mcpTool(bare)
  if (mcp) return `${serverName(mcp.server, locale)} · ${toolName(mcp.server, mcp.tool, locale)}`
  if (SNAKE_NAME.test(bare)) return humanize(bare)
  return title
}
