// agy's subagents as Kettu's. agy 1.5.12 starts one with its own `invoke_subagent` tool, whose
// call ends once the subagent exists, and sends nothing of the subagent's work over ACP. It writes
// that work in its brain folder, `~/.gemini/antigravity-cli/brain/`: the parent conversation's
// `.system_generated/subagents/<id>.json` names each subagent it started, the subagent's first
// message in its own `.system_generated/messages/` names the call that started it, and its
// `.system_generated/logs/transcript.jsonl` holds one line per step it took. Kettu shows each call
// as a subagent session whose thread it reads from that transcript, never writing to the folder.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { ThreadEntry } from '@shared/thread'
import type { SessionTarget } from '../connection'
import { t } from '../i18n'
import { isInside } from '../paths'
import {
  addEntry,
  type MapperContext,
  type MapperEffect,
  type MapperOutput,
  type SubagentState,
} from '../session-updates'
import { mapSessionUpdate } from './mapper'
import { fromAgy, throughGateway, type AgyNames } from './agy-tools'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

// A conversation's id as one folder's name: no separator, and not `.` or `..`.
const CONVERSATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** What an `invoke_subagent` call asks: the subagent's prompt, role and model, as agy names them. */
export interface SubagentCall {
  prompt: string
  role: string | null
  model: string | null
}

/** The call when it is agy's `invoke_subagent`; null for any other. */
export function subagentCall(update: acp.ToolCallUpdate): SubagentCall | null {
  if ((update as { name?: unknown }).name !== 'invoke_subagent') return null
  const input = isObject(update.rawInput) ? update.rawInput : {}
  const model = text(input.Model)
  return {
    prompt: typeof input.Prompt === 'string' ? input.Prompt : '',
    role: text(input.Role) || null,
    // agy's `inherit` runs the subagent on the parent's model, which its own steps name.
    model: model && model !== 'inherit' ? model : null,
  }
}

/** The ACP session id Kettu keeps the subagent a call started under. */
export const subagentSessionId = (toolCallId: string): string => `agy-subagent:${toolCallId}`

const TITLE_CHARS = 80

/** A prompt's first heading or line, without its Markdown, as the subagent's title. */
export function subagentTitle(prompt: string): string | null {
  for (const raw of prompt.split('\n')) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '')
      .replace(/(\*\*|__|`)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!line) continue
    const chars = [...line]
    return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS).join('').trimEnd()}…` : line
  }
  return null
}

/** What the subagent's card says beside its title: its role and the model it runs on. */
export function subagentDescription(role: string | null, model: string | null): string | null {
  const parts = [role, model].filter((part): part is string => !!part)
  return parts.length > 0 ? parts.join(' · ') : null
}

// The transcript.

/** One step of agy's transcript, as far as Kettu reads it. */
export interface AgyStep {
  index: number
  source: string
  type: string
  status: string
  content: string
  thinking: string
  model: string | null
  calls: { name: string; args: Json }[]
}

/** agy writes each argument of a step's call as JSON text of its value. */
function argValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

/** A transcript line as a step; null for one Kettu cannot read. */
export function parseStep(line: string): AgyStep | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(value) || typeof value.step_index !== 'number') return null
  const calls = Array.isArray(value.tool_calls)
    ? value.tool_calls.flatMap((call) => {
        if (!isObject(call) || typeof call.name !== 'string') return []
        const args = isObject(call.args) ? call.args : {}
        return [
          {
            name: call.name,
            args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, argValue(v)])),
          },
        ]
      })
    : []
  return {
    index: value.step_index,
    source: typeof value.source === 'string' ? value.source : '',
    type: typeof value.type === 'string' ? value.type : '',
    status: typeof value.status === 'string' ? value.status : '',
    content: typeof value.content === 'string' ? value.content : '',
    thinking: typeof value.thinking === 'string' ? value.thinking : '',
    model: typeof value.model === 'string' && value.model ? value.model : null,
    calls,
  }
}

const TIMES = /^(?:(?:Created|Completed) At: [^\n]*\n)+/
const MESSAGE =
  /\[Message\] timestamp=\S+ sender=(\S+) priority=\S+ content=([\s\S]*?)\n<\/SYSTEM_MESSAGE>/

/** A system step's message from another conversation: who sent it and what it says. */
function message(step: AgyStep): { sender: string; text: string } | null {
  const match = MESSAGE.exec(step.content)
  return match ? { sender: match[1]!, text: match[2]! } : null
}

/** A step's call as the ACP call agy would have sent for it, which agy's mapping then shapes. */
function stepCall(id: string, name: string, args: Json): acp.ToolCall & { name: string } {
  const file = text(args.Path) || text(args.AbsolutePath) || text(args.TargetFile)
  const base = file ? file.split(/[\\/]/).pop() || file : ''
  const locations = file ? [{ path: file }] : []
  switch (name) {
    case 'run_command':
      return {
        toolCallId: id,
        name,
        title: text(args.CommandLine),
        kind: 'execute',
        status: 'in_progress',
        rawInput: args,
      }
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return {
        toolCallId: id,
        name,
        title: `File ${base}`,
        kind: name === 'read_file' ? 'read' : 'edit',
        status: 'in_progress',
        locations,
        rawInput: args,
      }
    case 'search_web':
      return {
        toolCallId: id,
        name,
        title: `"${text(args.query) || text(args.Query)}" on Web`,
        kind: 'search',
        status: 'in_progress',
        rawInput: args,
      }
    default:
      return {
        toolCallId: id,
        name,
        title: `Run ${name}`,
        kind: 'other',
        status: 'in_progress',
        rawInput: args,
      }
  }
}

const RESULT_CHARS = 20_000

/**
 * A call's result as agy sends it over ACP: a file read shows no text, a file written or edited
 * shows its change, and a command its output under one header of times, as agy's own results do.
 */
function resultContent(name: string, args: Json, content: string): acp.ToolCallContent[] {
  const file = text(args.Path)
  if (name === 'read_file') return []
  if (name === 'write_file' && file && typeof args.Content === 'string') {
    return [{ type: 'diff', path: file, oldText: null, newText: args.Content }]
  }
  if (name === 'edit_file' && file && typeof args.Replacement === 'string') {
    const before = typeof args.Target === 'string' ? args.Target : null
    return [{ type: 'diff', path: file, oldText: before, newText: args.Replacement }]
  }
  const body = content.replace(TIMES, '')
  const result = name === 'run_command' ? `Created At: -\nCompleted At: -\n${body}` : body.trim()
  if (!result) return []
  const cut = result.length > RESULT_CHARS ? `${result.slice(0, RESULT_CHARS)}\n…` : result
  return [{ type: 'content', content: { type: 'text', text: cut } }]
}

/** What a run of the subagent's transcript has left to match: its calls still waiting for a result. */
export interface TranscriptRun {
  waiting: { id: string; name: string; args: Json }[]
  /** The model its steps ran on, once one names it. */
  model: string | null
}

export const newRun = (): TranscriptRun => ({ waiting: [], model: null })

/**
 * The subagent's steps as its thread's entries, each with an id of its step, so reading a step
 * again changes nothing. A model step gives its thought, its text and its calls; each tool step
 * after it is the next call's result; a message from the parent shows as its message, but for the
 * prompt the thread starts with. `parent` is the parent's conversation id, `parentId` its session.
 */
export function stepsOutput(
  ctx: MapperContext,
  steps: readonly AgyStep[],
  run: TranscriptRun,
  context: { parent: string; parentId: string | null; prompt: string; names: AgyNames },
): MapperOutput {
  const out: MapperOutput = { patches: [], effects: [] }
  const add = (entry: ThreadEntry): void => {
    if (!ctx.thread.byId[entry.id]) addEntry(ctx, out, entry)
  }
  const call = (update: acp.ToolCall | acp.ToolCallUpdate): void => {
    const shaped = fromAgy(throughGateway(update), context.names)
    const mapped = mapSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        ...shaped,
      } as acp.SessionUpdate,
      ctx,
    )
    out.patches.push(...mapped.patches)
  }
  for (const step of steps) {
    if (step.type === 'PLANNER_RESPONSE') {
      if (step.model) run.model = step.model
      if (step.thinking.trim()) {
        add({
          kind: 'thought',
          id: `m:agy-${step.index}#thought`,
          markdown: step.thinking.trim(),
          streaming: false,
        })
      }
      if (step.content.trim()) {
        add({
          kind: 'agent',
          id: `m:agy-${step.index}`,
          markdown: step.content.trim(),
          attachments: [],
          streaming: false,
        })
      }
      step.calls.forEach((made, i) => {
        const id = `agy-${step.index}.${i}`
        run.waiting.push({ id, name: made.name, args: made.args })
        call(stepCall(id, made.name, made.args))
      })
      continue
    }
    if (step.type === 'SYSTEM_MESSAGE') {
      const sent = message(step)
      if (!sent || sent.sender !== context.parent) continue
      if (sent.text.trim() === context.prompt.trim()) continue
      add({
        kind: 'session_message',
        id: `m:agy-${step.index}`,
        senderId: context.parentId,
        content: [{ type: 'text', text: sent.text }],
      })
      continue
    }
    if (step.source === 'MODEL' && step.type === 'GENERIC') {
      const made = run.waiting.shift()
      if (!made) continue
      call({
        ...stepCall(made.id, made.name, made.args),
        status: step.status === 'ERROR' ? 'failed' : 'completed',
        content: resultContent(made.name, made.args, step.content),
      })
    }
  }
  return out
}

/** Whether the subagent's last step ended its work: a model step that made no call. */
export function stepsDone(steps: readonly AgyStep[]): boolean {
  const last = steps.at(-1)
  return last?.type === 'PLANNER_RESPONSE' && last.calls.length === 0
}

// The brain folder.

/** A subagent a conversation started, as its `subagents` file names it. */
export interface BrainSubagent {
  conversationId: string
  role: string | null
  killed: boolean
}

/** Reads agy's brain folder; every method answers null or nothing for what it cannot read. */
export interface AgyBrain {
  subagents(conversationId: string): Promise<BrainSubagent[]>
  /** The `invoke_subagent` call that started the conversation. */
  spawnedBy(conversationId: string): Promise<string | null>
  /** The transcript's complete lines from byte `from`, and the byte the next read starts at. */
  transcript(
    conversationId: string,
    from: number,
  ): Promise<{ lines: string[]; next: number } | null>
}

const SUBAGENTS = 64
const MESSAGES = 256
const FILE_BYTES = 2 * 1024 * 1024
const TRANSCRIPT_READ = 4 * 1024 * 1024

/** agy's brain folder under `homeDir`, read only and never through a link out of it. */
export function fileBrain(homeDir: string, platform: Platform = process.platform): AgyBrain {
  const root = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain')
  let realRoot: Promise<string | null> | null = null
  /** The real path of a file in a conversation's `.system_generated` folder, or null. */
  const within = async (conversationId: string, ...parts: string[]): Promise<string | null> => {
    if (!CONVERSATION.test(conversationId)) return null
    realRoot ??= realpath(root).catch(() => null)
    const base = await realRoot
    if (base === null) {
      realRoot = null
      return null
    }
    const real = await realpath(
      path.join(root, conversationId, '.system_generated', ...parts),
    ).catch(() => null)
    return real !== null && isInside(real, base, platform) ? real : null
  }
  const json = async (file: string): Promise<unknown> => {
    const info = await stat(file).catch(() => null)
    if (!info?.isFile() || info.size > FILE_BYTES) return null
    try {
      return JSON.parse(await readFile(file, 'utf8')) as unknown
    } catch {
      return null
    }
  }
  const files = async (folder: string | null, limit: number): Promise<string[]> => {
    if (folder === null) return []
    const names = await readdir(folder).catch(() => [] as string[])
    return names
      .filter((name) => name.endsWith('.json') && CONVERSATION.test(name))
      .slice(0, limit)
      .map((name) => path.join(folder, name))
  }
  return {
    async subagents(conversationId) {
      const listed: BrainSubagent[] = []
      for (const file of await files(await within(conversationId, 'subagents'), SUBAGENTS)) {
        const value = await json(file)
        if (!isObject(value) || typeof value.conversationId !== 'string') continue
        if (!CONVERSATION.test(value.conversationId)) continue
        const descriptor = isObject(value.subagentDescriptor) ? value.subagentDescriptor : {}
        listed.push({
          conversationId: value.conversationId,
          role: text(descriptor.role) || null,
          killed: value.state === 'SUBAGENT_STATE_KILLED',
        })
      }
      return listed
    },
    async spawnedBy(conversationId) {
      let first: { at: string; id: string } | null = null
      for (const file of await files(await within(conversationId, 'messages'), MESSAGES)) {
        const value = await json(file)
        if (!isObject(value) || !isObject(value.sourceMetadata)) continue
        const tool = value.sourceMetadata.tool
        const made = isObject(tool) && isObject(tool.toolCall) ? tool.toolCall : null
        if (made?.name !== 'invoke_subagent' || typeof made.id !== 'string') continue
        const at = typeof value.timestamp === 'string' ? value.timestamp : ''
        if (!first || at < first.at) first = { at, id: made.id }
      }
      return first?.id ?? null
    },
    async transcript(conversationId, from) {
      const file = await within(conversationId, 'logs', 'transcript.jsonl')
      if (file === null) return null
      const handle = await open(file, 'r').catch(() => null)
      if (!handle) return null
      try {
        const { size } = await handle.stat()
        // A file shorter than what was read was written again: it is read from its start.
        const start = size < from ? 0 : from
        const length = Math.min(size - start, TRANSCRIPT_READ)
        if (length <= 0) return { lines: [], next: start }
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, start)
        const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a)
        // A line longer than a read is passed over rather than waited for.
        if (end < 0)
          return { lines: [], next: bytesRead === TRANSCRIPT_READ ? start + bytesRead : start }
        const lines = buffer
          .subarray(0, end)
          .toString('utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
        return { lines, next: start + end + 1 }
      } finally {
        await handle.close()
      }
    },
  }
}

// Following the subagents.

/** How often a running subagent's transcript is read again, and how long its call is looked for. */
export const POLL_MS = 3_000
const FIND_TRIES = 10
const WAKE_READS = 10

interface Followed {
  parent: string // the parent's ACP session id, agy's conversation id
  toolCallId: string
  sessionId: string // the subagent's ACP session id in Kettu
  call: SubagentCall
  conversation: string | null // the subagent's own conversation id, once found
  role: string | null
  /** The call has ended, so a subagent not found by now has nothing more to show. */
  ended: boolean
  failed: boolean
  tries: number
  /** Reads left before a subagent that was messaged and has not started on it counts as idle. */
  wake: number
  from: number
  run: TranscriptRun
  last: AgyStep | null
  state: 'running' | 'idle' | null
  description: string | null
  timer: ReturnType<typeof setTimeout> | null
  reading: boolean
}

export interface SubagentDeps {
  brain: AgyBrain
  target(sessionId: string): SessionTarget | undefined
  ignored(sessionId: string | null, what: string): void
  pollMs?: number
}

/**
 * agy's subagents of every session of one connection: each `invoke_subagent` call becomes a
 * subagent session, which shows the call's prompt at once and, while it runs, the steps its
 * transcript adds, read again every few seconds and no longer once it is idle.
 */
export class AgySubagents {
  private readonly followed = new Map<string, Followed>()
  /** The call that started each subagent conversation found so far. */
  private readonly spawned = new Map<string, string>()
  private closed = false

  constructor(private readonly deps: SubagentDeps) {}

  /**
   * What the parent's thread shows for a subagent's call: no row, but the subagent, running while
   * the call does and failed with it. The card goes where the call would have.
   */
  callOutput(parent: string, update: acp.ToolCallUpdate, call: SubagentCall): MapperOutput {
    const sessionId = subagentSessionId(update.toolCallId)
    let followed = this.followed.get(sessionId)
    const effect: Extract<MapperEffect, { kind: 'subagent' }> = { kind: 'subagent', sessionId }
    if (!followed) {
      followed = {
        parent,
        toolCallId: update.toolCallId,
        sessionId,
        call,
        conversation: null,
        role: call.role,
        ended: false,
        failed: false,
        tries: 0,
        wake: 0,
        from: 0,
        run: newRun(),
        last: null,
        state: null,
        description: subagentDescription(call.role, call.model),
        timer: null,
        reading: false,
      }
      this.followed.set(sessionId, followed)
      effect.title = subagentTitle(call.prompt) ?? call.role
      effect.description = followed.description
      effect.canCancel = false
    }
    const status = update.status
    if (status === 'completed' || status === 'failed') followed.ended = true
    if (status === 'failed' && !followed.failed) {
      followed.failed = true
      effect.state = idle(null, { message: update.title ?? 'invoke_subagent failed' })
      followed.state = 'idle'
    } else if ((status === 'pending' || status === 'in_progress') && followed.state === null) {
      effect.state = { kind: 'running' }
      followed.state = 'running'
    }
    const changed = Object.keys(effect).length > 2
    return { patches: [], effects: changed ? [effect] : [] }
  }

  /** After the parent applied a subagent's call: its prompt shows, and its transcript is read. */
  started(update: acp.ToolCallUpdate): void {
    const followed = this.followed.get(subagentSessionId(update.toolCallId))
    if (!followed || followed.failed) return
    const target = this.deps.target(followed.sessionId)
    if (target && followed.call.prompt.trim()) {
      const ctx = target.context()
      const out: MapperOutput = { patches: [], effects: [] }
      if (!ctx.thread.byId['m:agy-prompt']) {
        addEntry(ctx, out, {
          kind: 'session_message',
          id: 'm:agy-prompt',
          senderId: ctx.sessionIdFor(followed.parent),
          content: [{ type: 'text', text: followed.call.prompt }],
        })
        target.apply(out)
      }
    }
    this.schedule(followed, 0)
  }

  /**
   * A message the parent sent to one of its subagents, which wakes it: it is read again for a while,
   * since its transcript takes the message only once the subagent starts on it.
   */
  messaged(recipient: string): void {
    for (const followed of this.followed.values()) {
      if (followed.conversation !== recipient) continue
      followed.wake = WAKE_READS
      this.schedule(followed, this.pollMs)
    }
  }

  /** A row's name for a conversation: a subagent's role or title, or the main agent. */
  nameOf(conversationId: string): string | null {
    for (const followed of this.followed.values()) {
      if (followed.conversation === conversationId) {
        return followed.role ?? subagentTitle(followed.call.prompt)
      }
      if (followed.parent === conversationId) return t('antigravity.tool.mainAgent')
    }
    return null
  }

  /** Stops following the subagents of a session that closed, or of every session. */
  forget(parent?: string): void {
    for (const [id, followed] of this.followed) {
      if (parent !== undefined && followed.parent !== parent) continue
      if (followed.timer) clearTimeout(followed.timer)
      this.followed.delete(id)
    }
    if (parent === undefined) this.closed = true
  }

  private get pollMs(): number {
    return this.deps.pollMs ?? POLL_MS
  }

  private schedule(followed: Followed, delay: number): void {
    if (this.closed || followed.timer) return
    followed.timer = setTimeout(() => {
      followed.timer = null
      void this.read(followed)
    }, delay)
  }

  private async read(followed: Followed): Promise<void> {
    if (followed.reading || this.followed.get(followed.sessionId) !== followed) return
    followed.reading = true
    let again = false
    try {
      again = await this.step(followed)
    } catch (error) {
      this.deps.ignored(followed.parent, `agy subagent ${followed.toolCallId}: ${String(error)}`)
    } finally {
      followed.reading = false
    }
    if (again && this.followed.get(followed.sessionId) === followed) {
      this.schedule(followed, this.pollMs)
    }
  }

  /** One look at the brain folder; true while there is more to read. */
  private async step(followed: Followed): Promise<boolean> {
    const { brain } = this.deps
    if (followed.conversation === null) {
      const listed = await brain.subagents(followed.parent)
      for (const subagent of listed) {
        let call = this.spawned.get(subagent.conversationId) ?? null
        if (call === null) {
          call = await brain.spawnedBy(subagent.conversationId)
          if (call !== null) this.spawned.set(subagent.conversationId, call)
        }
        if (call === followed.toolCallId) {
          followed.conversation = subagent.conversationId
          followed.role = followed.role ?? subagent.role
          break
        }
      }
      if (followed.conversation === null) {
        // Without the folder the card keeps the prompt and ends with its call.
        followed.tries++
        if (!followed.ended || followed.tries < FIND_TRIES) return true
        this.settle(followed, followed.failed ? null : idle('end_turn', null))
        return false
      }
    }
    const conversation = followed.conversation
    // The steps go to the subagent's thread, so none is read while Kettu does not hold it.
    const target = this.deps.target(followed.sessionId)
    if (!target) return true
    const read = await brain.transcript(conversation, followed.from)
    if (read) {
      if (read.next < followed.from) followed.run = newRun()
      followed.from = read.next
      const steps = read.lines.map(parseStep).filter((step): step is AgyStep => step !== null)
      if (steps.length > 0) {
        followed.last = steps.at(-1)!
        followed.wake = 0
        const ctx = target.context()
        target.apply(
          stepsOutput(ctx, steps, followed.run, {
            parent: followed.parent,
            parentId: ctx.sessionIdFor(followed.parent),
            prompt: followed.call.prompt,
            names: (id) => this.nameOf(id),
          }),
        )
      }
    }
    const killed = (await brain.subagents(followed.parent)).some(
      (subagent) => subagent.conversationId === conversation && subagent.killed,
    )
    if (killed) {
      this.settle(followed, idle('cancelled', null))
      return false
    }
    if (followed.last && stepsDone([followed.last])) {
      if (followed.wake > 0) {
        followed.wake--
        return true
      }
      this.settle(followed, idle('end_turn', null))
      return false
    }
    this.settle(followed, { kind: 'running' })
    return true
  }

  /** Tells the parent the subagent's state when it changed, with the model once a step names it. */
  private settle(followed: Followed, state: SubagentState | null): void {
    const target = this.deps.target(followed.parent)
    if (!target) return
    const effect: Extract<MapperEffect, { kind: 'subagent' }> = {
      kind: 'subagent',
      sessionId: followed.sessionId,
    }
    const description = subagentDescription(
      followed.role,
      followed.call.model ?? modelName(target, followed.run.model),
    )
    if (description !== followed.description) {
      followed.description = description
      effect.description = description
    }
    const next = state === null ? null : state.kind === 'running' ? 'running' : 'idle'
    if (state && next !== followed.state) {
      followed.state = next
      effect.state = state
    }
    if (Object.keys(effect).length > 2) target.apply({ patches: [], effects: [effect] })
  }
}

function idle(
  stopReason: string | null,
  error: { message: string } | null,
): Extract<SubagentState, { kind: 'idle' }> {
  return { kind: 'idle', stopReason, error, tokens: null }
}

/** A model id as the parent's model option names it, such as "Gemini 4 Neon (High)". */
function modelName(target: SessionTarget, model: string | null): string | null {
  if (model === null) return null
  const option = target.context().thread.session.config.find((item) => item.category === 'model')
  return option?.choices?.find((choice) => choice.value === model)?.name ?? model
}
