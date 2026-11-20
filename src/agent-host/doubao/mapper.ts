// Turns Doubao CLI's stream-json events into the patches and effects every protocol's mapper
// produces. A reply streams as text deltas under its message's id and comes again whole when it is
// completed or replaced; tool calls and their results come whole, under ids of their own. One
// message's text may stream on both sides of its tool calls, so each stretch of it between calls
// is an entry of its own. The stream carries no thoughts and no token counts.

import path from 'node:path'
import type { ThreadEntry, ToolContent, ToolEntry, ToolKind } from '@shared/thread'
import { t } from '../i18n'
import {
  addEntry,
  commandDescription,
  fenced,
  toLf,
  toolEffects,
  withoutAhead,
  type MapperContext,
  type MapperOutput,
} from '../session-updates'
import type {
  AssistantEvent,
  ExportedTurn,
  PermissionDenial,
  StreamEvent,
  TextDeltaEvent,
  ToolResultBlock,
  ToolUseBlock,
  UserEvent,
} from './protocol'

/** Output a tool printed, its start cut once it grows past this. */
const OUTPUT_LIMIT = 64 * 1024

function output(): MapperOutput {
  return { patches: [], effects: [] }
}

function cut(text: string): string {
  return text.length > OUTPUT_LIMIT ? `…\n${text.slice(text.length - OUTPUT_LIMIT)}` : text
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A command's result as Doubao words it, `Command '<command>' exited with code <n>. stdout: …`. */
export function commandResult(
  command: string | null,
  text: string,
): { code: number | null; output: string } {
  const head =
    command === null
      ? /^Command '[\s\S]*?' exited with code (-?\d+)\.\s?/
      : new RegExp(`^Command '${escapeRegExp(command)}' exited with code (-?\\d+)\\.\\s?`)
  const match = head.exec(text)
  if (!match) return { code: null, output: text }
  const rest = text.slice(match[0].length).replace(/^stdout: ?/, '')
  return { code: Number(match[1]), output: rest }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * What `text` holds after `prefix`, their spacing aside, as when a message's whole text repeats the
 * stretches before its last call; null when it does not start with them.
 */
export function after(text: string, prefix: string): string | null {
  const chars = [...text]
  let i = 0
  for (const char of prefix) {
    if (/\s/.test(char)) continue
    while (i < chars.length && /\s/.test(chars[i]!)) i++
    if (chars[i] !== char) return null
    i++
  }
  const rest = chars.slice(i).join('').replace(/^\s+/, '')
  return rest === '' ? null : rest
}

/** A file's path as the row names it: from the session's folder when inside it. */
function shown(cwd: string, file: string): string {
  const p = pathsOf(cwd)
  const relative = p.relative(cwd, file)
  return relative !== '' && !relative.startsWith('..') && !p.isAbsolute(relative) ? relative : file
}

function absolute(cwd: string, file: string): string {
  const p = pathsOf(cwd)
  return p.isAbsolute(file) ? file : p.resolve(cwd, file)
}

/** The paths of the system the session runs on, which the CLI writes them in. */
function pathsOf(cwd: string): typeof path.posix {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? path.win32 : path.posix
}

type ToolFacts = Pick<ToolEntry, 'title' | 'toolKind' | 'locations' | 'content'> &
  Pick<Partial<ToolEntry>, 'rawInput' | 'description'>

const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'ShellExec'])
const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit'])

/** What the thread shows of a call before its result: its title, kind, files and input. */
export function toolFacts(name: string, input: Record<string, unknown>, cwd: string): ToolFacts {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  const at = (kind: ToolKind, title: string): ToolFacts => ({
    title,
    toolKind: kind,
    locations: file ? [{ path: absolute(cwd, file) }] : [],
    content: [],
  })
  const json = (): Pick<ToolFacts, 'rawInput'> =>
    Object.keys(input).length > 0 ? { rawInput: JSON.stringify(input, null, 2) } : {}
  if (SHELL_TOOLS.has(name)) {
    const command = toLf(str(input.command) ?? '')
    // An escalation says why in the confirmation it asks for.
    const description = commandDescription(input) ?? str(input.justification) ?? undefined
    return {
      title: command || t('codex.tool.runCommand'),
      toolKind: 'execute',
      locations: [],
      content: [],
      ...(command ? { rawInput: command } : {}),
      ...(description ? { description } : {}),
    }
  }
  switch (name) {
    case 'Read':
      return at(
        'read',
        file ? t('codex.tool.readFile', { path: shown(cwd, file) }) : t('dsh.tool.read'),
      )
    case 'Write': {
      const facts = at(
        'edit',
        file ? t('dsh.tool.write', { path: shown(cwd, file) }) : t('dsh.tool.edit'),
      )
      if (file && typeof input.content === 'string') {
        facts.content = [
          { type: 'diff', path: absolute(cwd, file), oldText: null, newText: input.content },
        ]
      }
      return facts
    }
    case 'Edit': {
      const facts = at(
        'edit',
        file ? t('dsh.tool.editFile', { path: shown(cwd, file) }) : t('dsh.tool.edit'),
      )
      const oldText = typeof input.old_string === 'string' ? input.old_string : null
      const newText = typeof input.new_string === 'string' ? input.new_string : null
      if (file && oldText !== null && newText !== null) {
        facts.content = [{ type: 'diff', path: absolute(cwd, file), oldText, newText }]
      }
      return facts
    }
    case 'NotebookEdit':
      return {
        ...at(
          'edit',
          file ? t('dsh.tool.editFile', { path: shown(cwd, file) }) : t('dsh.tool.edit'),
        ),
        ...json(),
      }
    case 'Glob':
    case 'Grep': {
      const pattern = str(input.pattern) ?? ''
      const where = str(input.path) ?? str(input.glob)
      return {
        title: where
          ? t('codex.tool.searchIn', { query: pattern, path: shown(cwd, where) })
          : t('codex.tool.search', { query: pattern }),
        toolKind: 'search',
        locations: [],
        content: [],
      }
    }
    case 'WebSearch':
    case 'Search': {
      const queries = [
        str(input.query),
        ...(Array.isArray(input.queries) ? input.queries.map(str) : []),
      ].filter((query): query is string => query !== null)
      return {
        title: queries.length
          ? t('codex.tool.webSearch', { query: queries.join(' · ') })
          : t('codex.tool.webSearchAll'),
        toolKind: 'search',
        locations: [],
        content: [],
      }
    }
    case 'LinkReader':
    case 'web.fetch': {
      const url = str(input.url)
      return {
        title: url ? t('codex.tool.openPage', { url }) : t('dsh.tool.fetch'),
        toolKind: 'fetch',
        locations: [],
        content: [],
      }
    }
  }
  return { title: name, toolKind: 'other', locations: [], content: [], ...json() }
}

/** The text of a result's blocks. */
function resultText(block: ToolResultBlock): string {
  return (block.content ?? [])
    .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('\n')
}

/** A call the CLI refused to run because nobody could confirm it, by its result's words. */
const REFUSED = /^User rejected (?:sandbox escalation|the (?:request|action))/i

interface Call {
  name: string
  input: Record<string, unknown>
}

/** The stretches of one message's text, each an entry, the last one still open to deltas. */
interface Message {
  parts: { id: string; text: string }[]
  open: boolean
}

/** One Doubao session's mapper: what Kettu shows of its events. */
export class DoubaoMapper {
  private readonly calls = new Map<string, Call>()
  private readonly messages = new Map<string, Message>()

  constructor(private readonly cwd: string) {}

  /** Maps one event; null for one this mapper does not take. */
  event(event: StreamEvent, ctx: MapperContext): MapperOutput | null {
    const out = output()
    switch (event.type) {
      case 'stream_event':
        this.delta(ctx, out, event)
        break
      case 'assistant':
        this.assistant(ctx, out, event)
        break
      case 'user':
        this.results(ctx, out, event)
        break
      case 'result':
        this.closeAll(out)
        if (event.permission_denials?.length) this.denials(ctx, out, event.permission_denials)
        break
      default:
        return null
    }
    return out
  }

  /** Ends the stretches still streaming, as when the turn stops before its reply came whole. */
  finish(): MapperOutput {
    const out = output()
    this.closeAll(out)
    return out
  }

  private delta(ctx: MapperContext, out: MapperOutput, event: TextDeltaEvent): void {
    const text = event.event?.delta?.type === 'text_delta' ? event.event.delta.text : ''
    if (!text) return
    const message = this.message(event.message_id)
    const last = message.parts.at(-1)
    if (message.open && last && ctx.thread.byId[last.id]) {
      last.text += text
      out.patches.push({ op: 'entry.appendText', id: last.id, text })
      return
    }
    this.openPart(ctx, out, event.message_id, message, text, true)
  }

  private message(id: string): Message {
    let message = this.messages.get(id)
    if (!message) {
      message = { parts: [], open: false }
      this.messages.set(id, message)
    }
    return message
  }

  private openPart(
    ctx: MapperContext,
    out: MapperOutput,
    messageId: string,
    message: Message,
    text: string,
    streaming: boolean,
  ): void {
    // Never `m:<digits>`: the host numbers its own entries past every id of that form, and
    // Doubao's message ids are numbers past what a counter can count up from.
    const id = `m:${messageId}#${message.parts.length + 1}`
    message.parts.push({ id, text })
    message.open = streaming
    addEntry(ctx, out, {
      kind: 'agent',
      id,
      markdown: text,
      attachments: [],
      streaming,
      ...(ctx.replaying ? {} : { at: ctx.now }),
    })
  }

  private close(out: MapperOutput, message: Message): void {
    if (!message.open) return
    message.open = false
    const last = message.parts.at(-1)
    if (last) out.patches.push({ op: 'entry.update', id: last.id, changes: { streaming: false } })
  }

  private closeAll(out: MapperOutput): void {
    for (const message of this.messages.values()) this.close(out, message)
  }

  private assistant(ctx: MapperContext, out: MapperOutput, event: AssistantEvent): void {
    const { id, content } = event.message
    const calls = content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
    if (calls.length > 0) {
      // A call ends the stretch of text before it.
      this.closeAll(out)
      for (const call of calls) this.toolCall(ctx, out, call)
      return
    }
    const text = content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    if (text) this.whole(ctx, out, id, text)
  }

  /**
   * A message's whole text: the stretches before its last call are already shown, so the last
   * stretch becomes what follows them; a text that replaced them goes in the last stretch whole.
   */
  private whole(ctx: MapperContext, out: MapperOutput, messageId: string, text: string): void {
    const message = this.message(messageId)
    const last = message.parts.at(-1)
    if (!last || !ctx.thread.byId[last.id]) {
      this.openPart(ctx, out, messageId, message, text, false)
      return
    }
    const before = message.parts
      .slice(0, -1)
      .map((part) => part.text)
      .join('')
    const tail = (before !== '' && after(text, before)) || text
    if (message.open || tail !== last.text) {
      last.text = tail
      out.patches.push({
        op: 'entry.update',
        id: last.id,
        changes: { markdown: tail, streaming: false },
      })
    }
    message.open = false
  }

  private toolCall(ctx: MapperContext, out: MapperOutput, block: ToolUseBlock): void {
    const input = block.input ?? {}
    const known = this.calls.get(block.id)
    // A call is sent again once its input is there; it keeps the input it had otherwise.
    const call = { name: block.name, input: block.input ? input : (known?.input ?? {}) }
    this.calls.set(block.id, call)
    const id = `t:${block.id}`
    const facts = toolFacts(call.name, call.input, this.cwd)
    const existing = ctx.thread.byId[id]
    if (existing?.kind === 'tool') {
      if (block.input) out.patches.push({ op: 'entry.update', id, changes: facts })
      return
    }
    const entry: ToolEntry = {
      kind: 'tool',
      id,
      status: 'in_progress',
      permission: null,
      permissionResult: null,
      ...facts,
    }
    addEntry(ctx, out, entry)
    toolEffects(out, block.id, id, null, entry)
  }

  private results(ctx: MapperContext, out: MapperOutput, event: UserEvent): void {
    for (const block of event.message.content) {
      if (block.type === 'tool_result') this.toolResult(ctx, out, block)
    }
  }

  private toolResult(ctx: MapperContext, out: MapperOutput, block: ToolResultBlock): void {
    const id = `t:${block.tool_use_id}`
    const existing = ctx.thread.byId[id]
    if (existing?.kind !== 'tool') return
    const call = this.calls.get(block.tool_use_id) ?? { name: existing.title, input: {} }
    const text = toLf(resultText(block))
    const failed = block.is_error === true
    const changes: Partial<ToolEntry> = {}
    let content: ToolContent[] = []
    if (failed && REFUSED.test(text)) {
      // Doubao CLI rejected the confirmation itself: in `-p` it cannot ask anyone.
      changes.status = 'cancelled'
      changes.denied = {
        by: 'mode',
        reason: str(call.input.justification) ?? t('doubao.notice.deniedReason'),
      }
      content = [{ type: 'markdown', markdown: cut(text) }]
    } else if (SHELL_TOOLS.has(call.name)) {
      const command = typeof call.input.command === 'string' ? call.input.command : null
      const result = commandResult(command, text)
      if (result.code !== null) changes.exitCode = result.code
      const printed = result.output.replace(/\s+$/, '')
      content = printed ? [{ type: 'markdown', markdown: fenced(cut(printed)) }] : []
      changes.status = failed ? 'failed' : 'completed'
    } else if (FILE_TOOLS.has(call.name) && !failed) {
      // A write's result is empty; the diff its call showed stays.
      content = existing.content
      changes.status = 'completed'
    } else {
      changes.status = failed ? 'failed' : 'completed'
      if (text) content = [{ type: 'markdown', markdown: fenced(cut(text)) }]
    }
    if (content.length === 0 && block.content_status === 'truncated') {
      content = [{ type: 'markdown', markdown: t('doubao.tool.outputTooLong') }]
    }
    changes.content = content
    out.patches.push({ op: 'entry.update', id, changes })
    toolEffects(out, block.tool_use_id, id, existing.status, { ...existing, ...changes })
  }

  /** What the CLI refused on its own, said once the turn ends so the user knows to change mode. */
  private denials(ctx: MapperContext, out: MapperOutput, denials: PermissionDenial[]): void {
    const asked = denials.flatMap((denial) => {
      const what = str(denial.prompt) ?? str(denial.tool_name)
      return what ? [`- ${what.replace(/\s+/g, ' ')}`] : []
    })
    addEntry(ctx, out, {
      kind: 'notice',
      id: ctx.nextId(),
      severity: 'warning',
      title: t('doubao.notice.denied', { count: denials.length }),
      description: [t('doubao.notice.deniedHint'), ...asked].join('\n'),
    })
  }

  /** A conversation's history from `--export`, as the user's messages and the replies. */
  replay(turns: readonly ExportedTurn[], ctx: MapperContext): MapperOutput {
    const out = output()
    for (const turn of turns) {
      const query = typeof turn.query === 'string' ? withoutAhead(turn.query) : ''
      if (query.trim()) {
        const entry: ThreadEntry = {
          kind: 'user',
          id: ctx.nextId(),
          content: [{ type: 'text', text: query }],
        }
        out.patches.push({ op: 'entry.add', entry })
      }
      const response = typeof turn.response === 'string' ? turn.response : ''
      if (response.trim()) {
        out.patches.push({
          op: 'entry.add',
          entry: {
            kind: 'agent',
            id: ctx.nextId(),
            markdown: response,
            attachments: [],
            streaming: false,
          },
        })
      }
    }
    return out
  }
}
