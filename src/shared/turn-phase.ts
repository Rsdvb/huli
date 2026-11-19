// What the agent is doing now in its running turn, read from the thread's latest entries. The
// desktop's working row shows it, and the agent host puts it in a session's summary, so a device
// and its Live Activity can say it too.

import type { ThreadState, ToolEntry, ToolKind } from './thread'

export type TurnPhaseName =
  | 'thinking'
  | 'execute'
  | 'read'
  | 'search'
  | 'fetch'
  | 'edit'
  | 'writing'
  | 'compacting'
  | 'approval'
  | 'working'

/**
 * What the agent is doing now in its running turn. For a tool call's work, `count` is how many
 * such calls run at once; it is 1 otherwise.
 */
export interface TurnPhase {
  phase: TurnPhaseName
  count: number
}

/** The phase and, for a tool call's work, the title of the latest such call, as the command. */
export interface TurnWork extends TurnPhase {
  step: string | null
}

const TOOL_PHASES: Partial<Record<ToolKind, TurnPhaseName>> = {
  execute: 'execute',
  read: 'read',
  search: 'search',
  fetch: 'fetch',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
}

const WORKING: TurnWork = { phase: 'working', count: 1, step: null }

// Entries that carry no output of their own, so the phase comes from what is before them.
const QUIET = new Set([
  'plan',
  'notice',
  'git',
  'artifact',
  'subagent',
  'memory',
  'control_ask',
  'control_note',
])

// The phase is read on every streamed chunk, so a long run of tool calls is read no further back.
const LOOKBACK = 64

interface TurnRead {
  work: TurnWork
  /** The latest running tool call the phase comes from. */
  tool: ToolEntry | null
  /** The thought that streams, while the agent thinks. */
  thought: string | null
}

const quiet = (work: TurnWork): TurnRead => ({ work, tool: null, thought: null })

function readTurn(state: ThreadState | null | undefined): TurnRead {
  if (!state) return quiet(WORKING)
  if (state.session.status === 'awaiting_permission') {
    return quiet({ phase: 'approval', count: 1, step: null })
  }
  const { order, byId } = state
  const running: ToolEntry[] = []
  let tools = false
  for (let i = order.length - 1; i >= Math.max(0, order.length - LOOKBACK); i--) {
    const entry = byId[order[i]!]
    if (!entry) continue
    if (entry.kind === 'tool') {
      tools = true
      if (entry.status === 'pending' || entry.status === 'in_progress') running.push(entry)
      continue
    }
    // A subagent's card after the message: the agent waits on it rather than writes.
    if (entry.kind === 'subagent' && !tools) return quiet(WORKING)
    if (QUIET.has(entry.kind)) continue
    if (tools) break
    if (entry.kind === 'thought') {
      return entry.streaming
        ? { work: { phase: 'thinking', count: 1, step: null }, tool: null, thought: entry.markdown }
        : quiet(WORKING)
    }
    if (entry.kind === 'agent') {
      return quiet(entry.streaming ? { phase: 'writing', count: 1, step: null } : WORKING)
    }
    if (entry.kind === 'compaction' && entry.status === 'in_progress') {
      return quiet({ phase: 'compacting', count: 1, step: null })
    }
    // The turn's own message, or anything that ends a step.
    return quiet(WORKING)
  }
  const latest = running[0]
  const phase = latest && TOOL_PHASES[latest.toolKind]
  if (!phase) return quiet(WORKING)
  const work = {
    phase,
    count: running.filter((tool) => TOOL_PHASES[tool.toolKind] === phase).length,
    step: latest.title || null,
  }
  return { work, tool: latest, thought: null }
}

/**
 * The phase, from the turn's latest entries: a thought or a message of the agent that streams, or
 * the latest of the tool calls at the end that still runs. Finished tool calls at the end are
 * work between steps.
 */
export function turnWork(state: ThreadState | null | undefined): TurnWork {
  return readTurn(state).work
}

/**
 * The phase with what it works on, as a person would say it: the file a call reads or edits, the
 * command it runs, what it searches for, or the heading of the thought being written.
 */
export interface TurnDoing extends TurnPhase {
  /** One line; null when there is nothing to name. */
  detail: string | null
  /** Whether `detail` is a search's query, which reads in quotes. */
  quoted: boolean
}

const firstLine = (text: string): string => text.trim().split('\n', 1)[0]!.trim()

const baseName = (path: string): string =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path

// "x", `x`, “x” or 'x'; the last one in a title is what a search looks for (Grep's pattern comes
// after its --include="...", Glob's pattern after its path).
const QUOTED = /"([^"\n]+)"|`([^`\n]+)`|“([^”\n]+)”|'([^'\n]+)'/g

function lastQuoted(title: string): string | null {
  let found: string | null = null
  for (const match of title.matchAll(QUOTED)) {
    found = match[1] ?? match[2] ?? match[3] ?? match[4] ?? null
  }
  return found
}

// A heading alone on its line, closed: "**Checking the quota**".
const HEADING = /^[ \t]*(?:\*\*|__)([^\n*_]+?)(?:\*\*|__)[ \t]*$/gm

let headingKept: { markdown: string; heading: string | null } | null = null

/** The latest heading in a thought that streams, as the agent's reasoning summaries mark them. */
export function thoughtHeading(markdown: string): string | null {
  if (headingKept?.markdown === markdown) return headingKept.heading
  let heading: string | null = null
  for (const match of markdown.matchAll(HEADING)) heading = match[1]!.trim() || heading
  headingKept = { markdown, heading }
  return heading
}

function toolDetail(tool: ToolEntry): { detail: string | null; quoted: boolean } {
  const plain = (detail: string | null) => ({ detail: detail || null, quoted: false })
  switch (tool.toolKind) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move': {
      const diff = tool.content.find((c) => c.type === 'diff')
      const path = tool.locations[0]?.path ?? (diff?.type === 'diff' ? diff.path : undefined)
      if (path) return plain(baseName(path))
      return plain(firstLine(tool.title.replace(/^(read|edit|write|delete|move)\s+/i, '')))
    }
    case 'execute':
      // Without the input, the title is the agent's own label and may already say "Run".
      return plain(firstLine(tool.rawInput ?? tool.title.replace(/^run\s+/i, '')))
    case 'search':
    case 'fetch': {
      const query = lastQuoted(tool.title)
      if (query) return { detail: query.trim(), quoted: true }
      return plain(firstLine(tool.title.replace(/^fetch\s+/i, '')))
    }
    default:
      return plain(null)
  }
}

/** What the agent is doing now, with what it works on; see `TurnDoing`. */
export function turnDoing(state: ThreadState | null | undefined): TurnDoing {
  const { work, tool, thought } = readTurn(state)
  const base = { phase: work.phase, count: work.count }
  if (tool) return { ...base, ...toolDetail(tool) }
  if (thought !== null) return { ...base, detail: thoughtHeading(thought), quoted: false }
  return { ...base, detail: null, quoted: false }
}

/** The phase alone, as the desktop's working row reads it. */
export function turnPhase(state: ThreadState | null | undefined): TurnPhase {
  const { phase, count } = turnWork(state)
  return { phase, count }
}

/**
 * The message the agent is still writing, when it is the turn's latest entry; once anything else
 * follows it, it reads as written even before the agent says so. An agent that streams messages
 * without ending each, as ACP's do, leaves every message of the turn streaming until it ends.
 */
export function writingId(state: ThreadState | null | undefined): string | null {
  if (!state) return null
  for (let i = state.order.length - 1; i >= 0; i--) {
    const entry = state.byId[state.order[i]!]
    // A plan or a notice may land while the message still streams; a subagent's card follows it.
    if (!entry || entry.kind === 'plan' || entry.kind === 'notice') continue
    return entry.kind === 'agent' && entry.streaming ? entry.id : null
  }
  return null
}
