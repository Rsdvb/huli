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

/**
 * The phase, from the turn's latest entries: a thought or a message of the agent that streams, or
 * the latest of the tool calls at the end that still runs. Finished tool calls at the end are
 * work between steps.
 */
export function turnWork(state: ThreadState | null | undefined): TurnWork {
  if (!state) return WORKING
  if (state.session.status === 'awaiting_permission') {
    return { phase: 'approval', count: 1, step: null }
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
    if (entry.kind === 'subagent' && !tools) return WORKING
    if (QUIET.has(entry.kind)) continue
    if (tools) break
    if (entry.kind === 'thought') {
      return entry.streaming ? { phase: 'thinking', count: 1, step: null } : WORKING
    }
    if (entry.kind === 'agent') {
      return entry.streaming ? { phase: 'writing', count: 1, step: null } : WORKING
    }
    if (entry.kind === 'compaction' && entry.status === 'in_progress') {
      return { phase: 'compacting', count: 1, step: null }
    }
    // The turn's own message, or anything that ends a step.
    return WORKING
  }
  const latest = running[0]
  const phase = latest && TOOL_PHASES[latest.toolKind]
  if (!phase) return WORKING
  return {
    phase,
    count: running.filter((tool) => TOOL_PHASES[tool.toolKind] === phase).length,
    step: latest.title || null,
  }
}

/** The phase alone, as the desktop's working row reads it. */
export function turnPhase(state: ThreadState | null | undefined): TurnPhase {
  const { phase, count } = turnWork(state)
  return { phase, count }
}
