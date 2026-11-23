// agy's tool calls in the shape the ACP mapper reads every agent's. agy 1.5.9 sends its tool's own
// name beside each call, a command's input as `{ CommandLine, toolSummary }`, its output under a
// header of times and the exit code, and an MCP server's tool as `mcp_<server>_<tool>`. It keeps
// what it writes for itself, such as a Plan mode plan, in `~/.gemini/antigravity-cli/brain/`. Its own
// tools it has no title for come as "Run <name>", which 1.5.12 sends for `send_message`, the
// subagent and task tools, `generate_image`, `schedule` and `finish`.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { McpServer } from '../connection'
import { GUIDE_TOOL } from '../guide/guide'
import { t } from '../i18n'
import { SERVICE_NAME } from '../service-name'
import {
  descriptionLine,
  fenced,
  toLf,
  type MapperContext,
  type TurnScope,
} from '../session-updates'
import { GATEWAY_TOOL } from '../tool-gateway'

const RESULT = /^Created At: [^\n]*\nCompleted At: [^\n]*\nCommand exited with code (-?\d+)\.\n\n/
const OUTPUT = 'Command output:\n'
const NO_OUTPUT = 'No output from the command.'
const OWN_FOLDER = /(?:^|\/)\.gemini\/antigravity-cli\/brain\//
const OWN_PREFIX = `mcp_${SERVICE_NAME}_`
const GATEWAY_NAME = `${OWN_PREFIX}${GATEWAY_TOOL}`

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The name agy gives the tool beside the call, which ACP has no field for. */
function toolName(update: acp.ToolCallUpdate): string | null {
  const name = (update as { name?: unknown }).name
  return typeof name === 'string' ? name : null
}

/**
 * agy's names for the tools a session's MCP servers run without asking, the set Claude Code's and
 * Codex's settings are given.
 */
export function agyAutoAllowed(servers: readonly McpServer[] | undefined): ReadonlySet<string> {
  return new Set(
    (servers ?? []).flatMap((server) =>
      server.type === 'stdio'
        ? []
        : (server.autoAllow ?? []).map((tool) => `mcp_${server.name}_${tool}`),
    ),
  )
}

/**
 * A call of Kettu's gateway as the call of the tool it runs, so it asks, shows and is held as a
 * direct call of that tool is. agy 1.5.14 repeats the name and input on every update of a call. A
 * call without `arguments`, which only describes a tool, stays the gateway's.
 */
export function throughGateway<T extends acp.ToolCallUpdate>(update: T): T {
  if (toolName(update) !== GATEWAY_NAME) return update
  const input = record(update.rawInput)
  const tool = input?.tool
  const args = record(input?.arguments)
  if (typeof tool !== 'string' || !args) return update
  const name = `${OWN_PREFIX}${tool}`
  const summary = input!.toolSummary
  const rawInput = typeof summary === 'string' ? { ...args, toolSummary: summary } : args
  return {
    ...update,
    name,
    title: `Run ${name}`,
    rawInput,
    ...('args' in update ? { args: rawInput } : {}),
  }
}

/** Whether a call of the gateway only describes a tool, which runs nothing. */
function describesOnly(toolCall: acp.ToolCallUpdate): boolean {
  if (toolName(toolCall) !== GATEWAY_NAME) return false
  const input = record(toolCall.rawInput)
  return typeof input?.tool === 'string' && input.arguments === undefined
}

/**
 * The option that allows a call once, for a call of one of those tools, or of Kettu's gateway that
 * only describes a tool while Kettu's server is the session's; null for any other. A gateway call
 * that runs a tool is decided as that tool, after `throughGateway`.
 */
export function agyAllowOnce(
  toolCall: acp.ToolCallUpdate,
  options: readonly acp.PermissionOption[],
  allowed: ReadonlySet<string> | undefined,
): string | null {
  const name = toolName(toolCall)
  if (name === null) return null
  const lookup = describesOnly(toolCall) && allowed?.has(`${OWN_PREFIX}${GUIDE_TOOL}`) === true
  if (!lookup && !allowed?.has(name)) return null
  return options.find((option) => option.kind === 'allow_once')?.optionId ?? null
}

/** What a finished command printed, and its exit code; null for a result of another shape. */
function commandResult(text: string): { output: string; exitCode: number } | null {
  const match = RESULT.exec(toLf(text))
  if (!match) return null
  const rest = toLf(text).slice(match[0].length)
  const output = rest.startsWith(OUTPUT)
    ? rest.slice(OUTPUT.length)
    : rest === NO_OUTPUT
      ? ''
      : null
  if (output === null) return null
  return { output: output.replace(/\n+$/, ''), exitCode: Number(match[1]) }
}

/** A command's call: its command line with what it says it does, and what it printed. */
function command(update: acp.ToolCallUpdate, line: string, summary: unknown): acp.ToolCallUpdate {
  const shaped: acp.ToolCallUpdate = {
    ...update,
    rawInput:
      typeof summary === 'string' ? { command: line, description: summary } : { command: line },
  }
  const block = update.content?.length === 1 ? update.content[0] : undefined
  if (block?.type !== 'content' || block.content.type !== 'text') return shaped
  const result = commandResult(block.content.text)
  if (!result) return shaped
  shaped.content = result.output
    ? [{ type: 'content', content: { type: 'text', text: fenced(result.output) } }]
    : []
  // agy reports a command that exited non-zero as completed; Claude Code and Codex fail it.
  if (update.status === 'completed' && result.exitCode !== 0) shaped.status = 'failed'
  return shaped
}

/**
 * The first question of an `ask_question` call, which its row is titled by and stands apart as a
 * question for; null for any other call.
 */
export function agyQuestion(update: acp.ToolCallUpdate): string | null {
  if (toolName(update) !== 'ask_question') return null
  const questions = record(update.rawInput)?.questions
  const first = Array.isArray(questions) ? record(questions[0]) : null
  const question = typeof first?.question === 'string' ? first.question.trim() : ''
  return question || null
}

/** A conversation agy names by its id, such as a subagent's, as a row names it; null if unknown. */
export type AgyNames = (conversationId: string) => string | null

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** The first of `keys` the input holds as text, for an argument agy has spelled more than one way. */
function arg(input: Record<string, unknown> | null, ...keys: string[]): string {
  for (const key of keys) {
    const value = text(input?.[key])
    if (value) return value
  }
  return ''
}

/**
 * The title, and what the call says when it shows nothing else, of agy's own tools it sends
 * untitled; null for any other tool.
 */
function ownTool(
  name: string,
  input: Record<string, unknown> | null,
  names: AgyNames,
): { title: string; text?: string } | null {
  switch (name) {
    case 'send_message': {
      const to = arg(input, 'Recipient', 'ConversationId')
      const message = arg(input, 'Message')
      const named = to ? (names(to) ?? to.slice(0, 8)) : t('antigravity.tool.mainAgent')
      return { title: t('antigravity.tool.sendMessage', { to: named }), text: message }
    }
    case 'manage_subagents': {
      const action = arg(input, 'Action')
      return {
        title: action
          ? t('antigravity.tool.manageSubagentsAction', { action })
          : t('antigravity.tool.manageSubagents'),
      }
    }
    case 'manage_task': {
      const action = arg(input, 'Action')
      return {
        title: action
          ? t('antigravity.tool.manageTaskAction', { action })
          : t('antigravity.tool.manageTask'),
      }
    }
    case 'define_subagent': {
      const named = arg(input, 'Name', 'TypeName')
      return {
        title: named
          ? t('antigravity.tool.defineSubagentNamed', { name: named })
          : t('antigravity.tool.defineSubagent'),
      }
    }
    case 'generate_image':
      return { title: t('antigravity.tool.generateImage'), text: arg(input, 'Prompt') }
    case 'schedule':
      return { title: t('antigravity.tool.schedule') }
    case 'finish':
      return { title: t('antigravity.tool.finish'), text: arg(input, 'Result', 'Summary') }
    default:
      return null
  }
}

/** An agy tool call in the shape the mapper reads every agent's. */
export function fromAgy<T extends acp.ToolCallUpdate>(update: T, names: AgyNames = () => null): T {
  const input = record(update.rawInput)
  if (typeof input?.CommandLine === 'string') {
    return command(update, input.CommandLine, input.toolSummary) as T
  }
  const question = agyQuestion(update)
  if (question !== null) return { ...update, title: question }
  const name = toolName(update)
  // Only the title agy gives a tool it has none for is replaced.
  const own = name !== null && update.title === `Run ${name}` ? ownTool(name, input, names) : null
  if (!own) return update
  const shaped: T = { ...update, title: own.title }
  if (own.text && !update.content?.length) {
    shaped.content = [{ type: 'content', content: { type: 'text', text: own.text } }]
  }
  return shaped
}

/**
 * What agy says a call other than a command does, its `toolSummary`, as the entry's description;
 * a command's is set as Claude Code's is.
 */
export function agySummary(update: acp.ToolCallUpdate): string | undefined {
  const input = record(update.rawInput)
  if (!input || typeof input.CommandLine === 'string') return undefined
  return descriptionLine(input.toolSummary)
}

/**
 * agy's `edit_file` request with the whole file in place of the snippet it names: agy's request
 * carries its `Target` and `Replacement` as the diff, which shows with wrong line numbers and a
 * changed last line, while the finished call carries the whole file's. `read` gives the file's
 * text; a file that cannot be read, or has the target not exactly once, leaves the snippet.
 */
export async function inWholeFile<T extends acp.ToolCallUpdate>(
  update: T,
  read: (path: string) => Promise<string | null>,
): Promise<T> {
  if (toolName(update) !== 'edit_file') return update
  const input = record(update.rawInput)
  const { Path: file, Target: target, Replacement: replacement } = input ?? {}
  if (typeof file !== 'string' || typeof target !== 'string' || typeof replacement !== 'string') {
    return update
  }
  if (target === '') return update
  const text = await read(file)
  if (text === null) return update
  const at = text.indexOf(target)
  if (at < 0 || text.indexOf(target, at + 1) >= 0) return update
  const edited = text.slice(0, at) + replacement + text.slice(at + target.length)
  return { ...update, content: [{ type: 'diff', path: file, oldText: text, newText: edited }] }
}

/** Calls on agy's own files that show no row, per turn, for their updates that name no file. */
const ownFileCalls = new WeakMap<TurnScope, Set<string>>()

/**
 * Whether a call works only on files agy keeps for itself, which are agy's, not the project's: it
 * shows no row and changes nothing in the project. A call whose row the thread has keeps it.
 */
export function onAgyOwnFiles(update: acp.ToolCallUpdate, ctx: MapperContext): boolean {
  if (ctx.thread.byId[`t:${update.toolCallId}`]) return false
  let calls = ownFileCalls.get(ctx.scope)
  if (calls?.has(update.toolCallId)) return true
  const paths = (update.locations ?? []).map((location) => location.path.replace(/\\/g, '/'))
  if (paths.length === 0 || !paths.every((path) => OWN_FOLDER.test(path))) return false
  if (!calls) {
    calls = new Set()
    ownFileCalls.set(ctx.scope, calls)
  }
  calls.add(update.toolCallId)
  return true
}
