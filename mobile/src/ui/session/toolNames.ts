// An MCP tool's name as a person reads it: `mcp__kettu__read_artifact_type`, as Claude Code names a
// call, or `kettu: read_artifact_type`, as Codex does, reads 「Huli · 读取 Artifact 类型」; another
// server's tool reads as its server and tool humanized, as 「GitHub Tools · Create issue」.

/** Huli's own server, which the agents know by Kettu's name. */
const OWN_SERVER = 'kettu'

/** Huli's own tools, as the app names them. */
const OWN_TOOLS: Record<string, string> = {
  // Artifacts
  create_artifact: '创建 Artifact',
  create_artifact_from_type: '按类型创建 Artifact',
  read_artifact: '读取 Artifact',
  update_artifact: '更新 Artifact',
  delete_artifact: '删除 Artifact',
  list_artifacts: '列出 Artifacts',
  list_artifact_versions: '列出 Artifact 版本',
  restore_artifact_version: '恢复 Artifact 版本',
  list_artifact_types: '列出 Artifact 类型',
  read_artifact_type: '读取 Artifact 类型',
  read_artifact_data: '读取 Artifact 数据',
  write_artifact_data: '写入 Artifact 数据',
  read_comments: '读取评论',
  reply_comment: '回复评论',
  resolve_comment: '解决评论',
  // Sessions and agents
  list_agents: '列出 Agent',
  list_sessions: '列出会话',
  get_session: '查看会话',
  read_session_history: '读取会话记录',
  rename_session: '重命名会话',
  archive_session: '归档会话',
  start_session: '开始会话',
  send_message: '发送消息',
  set_plan: '更新计划',
  // Workflows
  list_workflows: '列出工作流',
  create_workflow: '创建工作流',
  suggest_workflow: '建议工作流',
  report_step: '汇报步骤',
  // Memory and the guide
  remember: '记住',
  list_memories: '列出记忆',
  read_memory: '读取记忆',
  update_memory: '更新记忆',
  forget_memory: '忘记记忆',
  read_kettu_guide: '读取 Huli 指南',
  report_problem: '报告问题',
  // Browser
  browser_navigate: '浏览器打开网页',
  browser_navigate_back: '浏览器后退',
  browser_reload: '浏览器刷新',
  browser_snapshot: '读取浏览器页面',
  browser_click: '浏览器点击',
  browser_type: '浏览器输入',
  browser_press_key: '浏览器按键',
  browser_scroll: '浏览器滚动',
  browser_select_option: '浏览器选择选项',
  browser_take_screenshot: '浏览器截图',
  browser_wait_for: '浏览器等待',
  browser_console_messages: '读取浏览器控制台',
  browser_network_requests: '读取浏览器网络请求',
  browser_evaluate: '在浏览器中运行脚本',
  browser_ask_user: '请你在浏览器中操作',
  browser_tabs: '浏览器标签页',
  // Computer use
  computer_list_apps: '列出电脑上的 App',
  computer_list_windows: '列出电脑上的窗口',
  computer_get_window_state: '读取窗口状态',
  computer_click: '电脑点击',
  computer_type_text: '电脑输入文字',
  computer_press_key: '电脑按键',
  computer_hotkey: '电脑快捷键',
  computer_scroll: '电脑滚动',
  computer_drag: '电脑拖动',
  computer_invoke_menu: '打开电脑菜单项',
  // Devices
  device_list: '列出设备',
  device_open: '打开设备',
  device_close: '关闭设备',
  device_snapshot: '读取设备屏幕',
  device_tap: '设备点按',
  device_fill: '设备填写',
  device_type: '设备输入',
  device_scroll: '设备滚动',
  device_swipe: '设备轻扫',
  device_press_button: '设备按键',
  device_rotate: '旋转设备',
  device_screenshot: '设备截图',
  device_install_app: '在设备上安装 App',
  device_launch_app: '在设备上打开 App',
  device_terminate_app: '在设备上关闭 App',
  device_open_url: '在设备上打开链接',
  device_logs: '读取设备日志',
  device_set_appearance: '设置设备外观',
  device_set_location: '设置设备位置',
  device_set_permission: '设置设备权限',
  // Terminals
  terminal_run: '在终端运行',
  terminal_read: '读取终端',
  terminal_wait: '等待终端',
  terminal_input: '向终端输入',
  terminal_stop: '停止终端',
}

/** Words that keep their own spelling when a name is humanized. */
const WORDS: Record<string, string> = {
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

/** A server's name as the app shows it: Huli for its own. */
function serverName(server: string): string {
  if (server.toLowerCase() === OWN_SERVER) return 'Huli'
  return humanize(server)
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// `mcp__<server>__<tool>`, as Claude Code names a call; `<server>: <tool>`, as Codex does, whose
// servers are config keys in lower case, which keeps a sentence such as "Error: timeout" out.
const CLAUDE_NAME = /^mcp__(.+?)__([A-Za-z0-9_.-]+)$/
const CODEX_NAME = /^([a-z][a-z0-9_.-]*)\s*[:：]\s*([A-Za-z][A-Za-z0-9_.-]*)$/

/** The MCP server and tool a call's title names, or null for any other title. */
export function mcpTool(title: string): { server: string; tool: string } | null {
  const match = CLAUDE_NAME.exec(title.trim()) ?? CODEX_NAME.exec(title.trim())
  return match ? { server: match[1]!, tool: match[2]! } : null
}

/** A call's title as it reads: an MCP tool's server and name made readable, any other as it is. */
export function toolTitle(title: string): string {
  const named = mcpTool(title)
  if (!named) return title
  const own = named.server.toLowerCase() === OWN_SERVER
  const tool = (own ? OWN_TOOLS[named.tool] : undefined) ?? humanize(named.tool)
  return `${serverName(named.server)} · ${tool}`
}
