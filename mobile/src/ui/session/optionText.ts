// The agents' own option names in Chinese, where the phone knows them: Claude Code's modes,
// models and effort levels come from the computer in English, and the desktop's zh-CN catalog
// (src/shared/locales/zh-CN/host.json) has the words for the others. Anything else stays as the
// agent gave it.

const NAMES: Record<string, string> = {
  // Claude Code (agent-host/claude/config.ts).
  'ask before edits': '编辑前询问',
  'accept edits': '接受编辑',
  'plan only': '仅计划',
  auto: '自动',
  'full access': '完全访问',
  'fast mode': '快速模式',
  'default (recommended)': '默认（推荐）',
  default: '默认',
  // Codex, Antigravity and DeepSeek, as host.json says them.
  'read-only': '只读',
  'read only': '只读',
  'workspace access': '工作区访问',
  'workspace write': '工作区可写',
  'auto review': '自动审查',
  plan: '计划',
  'plan mode': '计划模式',
  mode: '模式',
  model: '模型',
  effort: '推理强度',
  // Effort levels.
  off: '关',
  minimal: '极低',
  low: '低',
  medium: '中',
  med: '中',
  high: '高',
  xhigh: '超高',
  'x high': '超高',
  'extra high': '超高',
  extra: '超高',
  max: '最高',
}

const DESCRIPTIONS: Record<string, string> = {
  'asks before it changes a file or runs a command': '改文件或运行命令前先问',
  'edits files freely; still asks before commands': '直接改文件，运行命令前仍会问',
  'reads and plans. changes nothing': '只读和计划，不做任何改动',
  'claude handles permission decisions': '由 Claude 决定是否需要询问',
  'never asks. use it in a sandbox or a worktree': '什么都不问。请在沙箱或工作树里使用',
  'faster responses on supported models': '支持的模型回复更快',
  'ask before edits or network access': '修改文件、访问网络前需授权',
  'ask for outside edits or network access': '可改工作区；改外部文件、联网需授权',
  'only ask about potentially unsafe actions': '仅在操作可能不安全时询问',
  'any file or network, without approval': '访问所有文件和网络，无需授权',
  '1.5x speed, increased usage': '1.5 倍速度，用量更多',
  'ask before edits and commands': '改动和命令先问',
  // Antigravity's default mode.
  'ask before edits and commands, per your permission settings': '改动和命令先问，按你的权限设置',
  'approve file edits in the workspace without asking': '工作区里的文件改动不问',
  'approve edits and safe commands; ask before irreversible actions':
    '改动和安全的命令不问，不可撤回的操作先问',
  'plan carefully before executing a task': '先仔细计划再动手',
  'plan before making changes': '先做计划再改动',
}

const key = (text: string) =>
  text
    .trim()
    .replace(/[.。]$/, '')
    .toLowerCase()

/** An option's or a choice's name in Chinese, or as given. */
export function optionName(name: string): string {
  return NAMES[key(name)] ?? name
}

/** A choice's description in Chinese, or as given. */
export function optionDescription(text: string): string {
  return DESCRIPTIONS[key(text)] ?? text
}

const FAMILY: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
}

/**
 * A model's name short enough for the composer's chip: 「Opus 5.5」 for a Claude model by its id,
 * so Default shows the model it stands for; a name without its parenthesis otherwise.
 */
export function shortModelName(choice: { name: string; modelId?: string }): string {
  // A dated id, claude-opus-4-20250514, has no minor version.
  const claude = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(choice.modelId ?? '')
  const family = claude ? FAMILY[claude[1]!.toLowerCase()] : undefined
  if (claude && family) {
    return claude[3] ? `${family} ${claude[2]}.${claude[3]}` : `${family} ${claude[2]}`
  }
  const name = choice.name.slice(choice.name.lastIndexOf('/') + 1)
  const bare = name.replace(/\s*\([^)]*\)\s*$/, '').trim()
  return optionName(bare || name)
}
