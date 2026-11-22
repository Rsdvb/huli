// Scenario selection and options, from the prompt text and the environment.

export const SCENARIOS = [
  'basic-turn',
  'long-stream',
  'tool-storm',
  'permission',
  'parallel-permissions',
  'cancel',
  'long-turn',
  'crash',
  'error',
  'auth-required',
  'out-of-credit',
  'plan-limit',
  'refusal',
  'large-history',
  'slow-start',
  'all-updates',
  'subagent',
  'plan',
  'background',
  'requests',
  'thinking',
  'reasoning',
  'svg',
  'shell',
  'usage',
  'status',
  'context',
  'recall',
  'instructions',
  'attachments',
  'chinese',
  'artifacts',
  'report',
  'tables',
  'open-site',
  'browser',
  'device',
  'computer',
  'approvals',
  'content',
  'media',
  'screenshots',
  'documents',
  'write',
  'anchors',
  // Huli: manager mode's manager, worker and reviewer.
  'manager-demo',
  'work',
  'review',
] as const

export type ScenarioName = (typeof SCENARIOS)[number]

export const SCENARIO_DESCRIPTIONS: Record<ScenarioName, { description: string; hint?: string }> = {
  'manager-demo': {
    description: 'A manager: dispatches three workers through Kite and answers its reports',
    hint: 'start it as fake:/manager-demo so the manager block goes ahead',
  },
  work: {
    description: 'A worker: may ask first, may fail once, edits a file and calls report_work',
    hint: '--ask --fail-once --file <path> --read',
  },
  review: {
    description: 'A reviewer: asks for changes in round 1, approves from FAKE_AGENT_APPROVE_ON',
  },
  'basic-turn': {
    description: 'A short answer with markdown, then reads, an edit, a new file and a test run',
  },
  'long-stream': {
    description: '200 KB of markdown in small chunks',
    hint: '--rate <updates per second> --size <bytes, such as 200k> --rich',
  },
  'tool-storm': {
    description: '500 tool calls with updates for each',
    hint: '--count <n> --pace <ms each call runs and waits after>',
  },
  permission: {
    description: 'A command that needs approval, with all four option kinds',
    hint: '--withdraw <ms>',
  },
  'parallel-permissions': { description: 'Three tool calls asking for permission at once' },
  cancel: { description: 'A long turn that honors cancellation', hint: '--ignore-cancel' },
  'long-turn': {
    description: 'Thinks, reads, runs commands and edits until you cancel, as the context grows',
  },
  crash: { description: 'Exits mid-turn with a non-zero code', hint: '--code <n> --silent' },
  error: {
    description: 'Fails the turn with an internal error',
    hint: '--silent --hold <ms before it fails, or until cancelled>',
  },
  'auth-required': {
    description: 'Signs the agent out; requests fail until you sign in, then the retry answers',
  },
  'plan-limit': {
    description:
      "Stops at the plan's usage limit as Claude Code words it; sent again after the reset, it answers",
    hint: '--reset <seconds until the plan resets> --silent',
  },
  'out-of-credit': {
    description: 'Fails the turn as a provider out of credit does; the retry answers',
  },
  refusal: {
    description: 'The model declines to go on, as Claude ends a turn with stop_reason refusal',
    hint: '--plain: without a word of its own first',
  },
  'large-history': {
    description: 'Makes reopening this session replay 1,000 entries',
    hint: '--entries <n>',
  },
  'slow-start': { description: 'Explains how to start the agent slowly (set at launch)' },
  'all-updates': { description: 'Sends every session update variant once, plus an unknown one' },
  subagent: {
    description: 'Runs a subagent in a child session with a permission request',
    hint: '--finished <n quick subagents that end first> --busy <n reads, a second each, before it asks>',
  },
  plan: {
    description: 'A plan whose items progress while the agent works',
    hint: '--step <ms each step takes>',
  },
  background: {
    description: 'Starts a command in the background, as Claude Code does with run_in_background',
  },
  requests: {
    description: "Reports a request's usage as claude-agent-acp does, then the result's",
    hint: '--hold <ms before the turn ends> --then <ms until it answers by itself> --at-end',
  },
  thinking: { description: 'A long thought, then an answer' },
  reasoning: {
    description: 'Long raw reasoning between runs of work, beside short thoughts and messages',
    hint: '--summaries',
  },
  svg: { description: 'A reply with svg code blocks: a diagram, a badge and bare path data' },
  shell: {
    description: 'A reply with shell blocks to run: one line, several lines and a password prompt',
  },
  usage: {
    description: "The plan limits, as Claude Code's /usage reports them",
    hint: '--plain --unreadable',
  },
  status: { description: "The plan limits, as Codex's /status reports them" },
  context: { description: "What fills the context, as Claude Code's /context reports it" },
  recall: { description: 'Answers with your previous message, as the agent remembers it' },
  instructions: {
    description: 'Answers with the text its session was started with in its system prompt',
  },
  attachments: { description: 'Lists the images, files and links the prompt carried' },
  chinese: { description: 'A long answer in Chinese, with every Markdown block' },
  artifacts: {
    description: "Makes or changes a canvas through Kettu's artifacts service, then reads it",
    hint:
      '--read <artifact id> --site <image in the project> --type <document|slides> ' +
      '--from <folder in the project>... --until-cancel --child <id> ' +
      '--meta <session id|none> --execute',
  },
  'open-site': {
    description: 'Opens a site through the browser tools, which asks the user for a new one',
    hint: '<url>',
  },
  browser: {
    description: "Calls Kettu's browser tools in turn, calling again while the user has the page",
    hint: '<browser_* tool> [arguments as JSON] [; wait <ms> ; ...]',
  },
  device: {
    description: 'Calls one of the device tools with JSON arguments and reports its answer',
    hint: '<tool> <json arguments>',
  },
  computer: {
    description: "Calls Kettu's computer use tools in turn and says what they answered",
    hint: '<computer_* tool> [arguments as JSON] [; wait <ms> ; ...]',
  },
  approvals: {
    description: 'A command of two steps, then an edit with its diff, each asking first',
    hint: 'single',
  },
  report: { description: 'Short Chinese notes between runs of work, then a report' },
  tables: {
    description: 'Five tables: long, wide, long paths and a URL, many columns, and Chinese',
  },
  content: {
    description:
      'Every kind of reply content: text, lists, links, a table, maths, commands, a diff and blocks',
  },
  media: {
    description: "Pictures, a video and a file that cannot play, from the project's media folder",
  },
  screenshots: {
    description:
      "Tool calls that take screenshots and read the project's media folder pictures, for the thumbnails on folded rows",
  },
  documents: {
    description:
      "Writes a PDF, a Word document and a 24 MB PDF into the session's folder and names them, for the phone's preview",
  },
  write: {
    description: "Writes the text and its model into a file of the session's folder, a real edit",
    hint: '[file] [text]',
  },
  anchors: { description: 'A Chinese answer in sections whose #anchor links go to its headings' },
}

export interface ScenarioOptions {
  rate: number // updates per second, for long-stream
  size: number // bytes, for long-stream
  count: number // tool calls, for tool-storm
  paceMs: number // tool-storm: how long each call runs, and the wait before the next
  ignoreCancel: boolean
  withdrawMs: number | null // permission: withdraw the request after this long
  exitCode: number
  entries: number // large-history: the entries its replay synthesizes
  plain: boolean // usage: Claude Code's own text, as the adapter forwards it when its report fails
  rich: boolean // long-stream: maths, diagrams and long code blocks among the sections
  // usage: a reply without limits, as an account without a plan gets; FAKE_AGENT_USAGE=unreadable
  // gives it to the `/usage` Kettu runs itself.
  unreadable: boolean
  stepMs: number // plan: how long each step's tool call runs
  holdMs: number // requests: open after its request; error: before it fails; not scaled
  thenMs: number | null // requests: when it answers by itself after the turn, not scaled
  atEnd: boolean // requests: usage only as the turn ends, as OpenCode reports it
  read: string | null // artifacts: the artifact to read instead
  site: string | null // artifacts: an image of the project, for a page of several files instead
  type: string | null // artifacts: a type to make an artifact of instead, document or slides
  from: string[] // artifacts: folders of the project to make one artifact of each instead
  untilCancel: boolean // artifacts: the turn runs on after its calls until it is cancelled
  child: string | null // artifacts: the calls come from this subagent session, as OpenCode's do
  meta: string | null // artifacts: the session id the calls name instead; none names none
  execute: boolean // artifacts: the calls run inside one tool call, as OpenCode's Code Mode runs them
  silent: boolean // error, crash, plan-limit: fails before writing anything
  resetS: number // plan-limit: seconds until the plan resets, not scaled
  summaries: boolean // reasoning: short summaries in place of the raw reasoning
  finished: number // subagent: quick subagents that run and end before the one that asks
  busy: number // subagent: reads its child makes, a second each, before it asks
  // titles: a branch name is held until this file exists, FAKE_AGENT_BRANCH_NAME_GATE
  branchNameGate: string | null
}

export interface ScenarioChoice {
  scenario: ScenarioName | 'compact'
  options: ScenarioOptions
  text: string // the prompt without the command; for a command, its words before the first flag
}

export type Env = Record<string, string | undefined>

function isScenario(name: string): name is ScenarioName {
  return (SCENARIOS as readonly string[]).includes(name)
}

function parseSize(value: string | undefined): number | null {
  if (!value) return null
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)b?$/i.exec(value.trim())
  if (!match) return null
  const unit = match[2]!.toLowerCase()
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1
  return Math.round(Number(match[1]) * factor)
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function flagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === `--${name}`) {
      const next = args[i + 1]
      return next !== undefined && !next.startsWith('--') ? next : ''
    }
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}

/** Every value a flag that may repeat was given, in order. */
function flagValues(args: string[], name: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const next = args[i + 1]
    if (arg === `--${name}` && next !== undefined && !next.startsWith('--')) values.push(next)
    else if (arg.startsWith(`--${name}=`)) values.push(arg.slice(name.length + 3))
  }
  return values
}

/**
 * `/scenario <name> [text] [--flags]` or `/<name> [text] [--flags]` picks a scenario; any other
 * text runs the default, `FAKE_AGENT_SCENARIO` or `basic-turn`. Flags override the environment.
 */
export function chooseScenario(prompt: string, env: Env): ScenarioChoice {
  const trimmed = prompt.trim()
  const words = trimmed.split(/\s+/)
  let scenario: ScenarioName | 'compact' | null = null
  let args: string[] = []
  let text = trimmed
  const first = words[0] ?? ''
  if (first === '/scenario' && words[1] && isScenario(words[1])) {
    scenario = words[1]
    args = words.slice(2)
  } else if (first.startsWith('/')) {
    const name = first.slice(1)
    if (isScenario(name) || name === 'compact') {
      scenario = name
      args = words.slice(1)
    }
  }
  if (scenario) {
    const flag = args.findIndex((arg) => arg.startsWith('--'))
    text = (flag === -1 ? args : args.slice(0, flag)).join(' ')
  }
  if (!scenario) {
    const fallback = env.FAKE_AGENT_SCENARIO
    scenario = fallback && isScenario(fallback) ? fallback : 'basic-turn'
  }

  const withdraw = flagValue(args, 'withdraw')
  const options: ScenarioOptions = {
    rate: parseNumber(flagValue(args, 'rate')) || parseNumber(env.FAKE_AGENT_RATE) || 200,
    size: parseSize(flagValue(args, 'size')) ?? parseSize(env.FAKE_AGENT_SIZE) ?? 200 * 1024,
    count: parseNumber(flagValue(args, 'count')) ?? parseNumber(env.FAKE_AGENT_COUNT) ?? 500,
    paceMs: parseNumber(flagValue(args, 'pace')) ?? 2,
    ignoreCancel:
      flagValue(args, 'ignore-cancel') !== undefined || env.FAKE_AGENT_IGNORE_CANCEL === '1',
    withdrawMs: withdraw === undefined ? null : withdraw === '' ? 1500 : parseNumber(withdraw),
    exitCode: parseNumber(flagValue(args, 'code')) ?? 3,
    entries: historyEntries(env, parseNumber(flagValue(args, 'entries'))),
    plain: flagValue(args, 'plain') !== undefined,
    rich: flagValue(args, 'rich') !== undefined,
    unreadable:
      flagValue(args, 'unreadable') !== undefined || env.FAKE_AGENT_USAGE === 'unreadable',
    stepMs: parseNumber(flagValue(args, 'step')) ?? 300,
    holdMs: parseNumber(flagValue(args, 'hold')) ?? 0,
    thenMs: parseNumber(flagValue(args, 'then')),
    atEnd: flagValue(args, 'at-end') !== undefined,
    read: flagValue(args, 'read') || null,
    site: flagValue(args, 'site') || null,
    type: flagValue(args, 'type') || null,
    from: flagValues(args, 'from'),
    untilCancel: flagValue(args, 'until-cancel') !== undefined,
    child: flagValue(args, 'child') || null,
    meta: flagValue(args, 'meta') || null,
    execute: flagValue(args, 'execute') !== undefined,
    silent: flagValue(args, 'silent') !== undefined,
    resetS: parseNumber(flagValue(args, 'reset')) ?? 300,
    summaries: flagValue(args, 'summaries') !== undefined,
    finished: parseNumber(flagValue(args, 'finished')) ?? 0,
    busy: parseNumber(flagValue(args, 'busy')) ?? 0,
    branchNameGate: env.FAKE_AGENT_BRANCH_NAME_GATE || null,
  }
  return { scenario, options, text }
}

/** The size of a large-history replay: the flag, else `FAKE_AGENT_HISTORY_ENTRIES`, else 1,000. */
export function historyEntries(env: Env, flag: number | null = null): number {
  return flag || parseNumber(env.FAKE_AGENT_HISTORY_ENTRIES) || 1000
}

/** Multiplies every delay; 0 runs scenarios as fast as possible, for tests. */
export function delayScale(env: Env): number {
  return parseNumber(env.FAKE_AGENT_DELAY_SCALE) ?? 1
}
