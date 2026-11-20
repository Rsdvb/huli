// The conversation as rows: its entries, and after each turn that ended, the files that turn
// changed and a footer with its time, its length and what can be done with its reply.

import type { PlanEntry, ThreadEntry, ThreadState, ToolEntry } from '@shared/thread'
import { writingId } from '@shared/turn-phase'
import { workflowCardOf } from '../../components/entries/workflowTools'
import { diffTexts, type Diff } from '../../diff'

type TurnEnd = Extract<ThreadEntry, { kind: 'turn_end' }>
type AgentEntry = Extract<ThreadEntry, { kind: 'agent' }>

export interface FileEdit {
  path: string
  oldText: string | null
  newText: string
  diff: Diff
}

export interface FileChange {
  path: string
  /** A file the turn made rather than changed. */
  created: boolean
  insertions: number
  deletions: number
  edits: FileEdit[]
}

export type Row =
  /**
   * `writing` marks the reply the agent is still writing. Its entry's own `streaming` is not
   * enough: an agent that never ends a message leaves each of its turn's messages streaming.
   */
  | { type: 'entry'; key: string; entry: ThreadEntry; writing?: true }
  /**
   * The work between messages, as the desktop folds it: thoughts, tool calls and project memory
   * writes in a row, one line that opens to a line per step. `latest` is the last thing in a
   * thread whose turn still runs.
   */
  | { type: 'run'; key: string; entries: ThreadEntry[]; latest: boolean }
  | { type: 'changes'; key: string; tools: ToolEntry[] }
  | {
      type: 'footer'
      key: string
      end: TurnEnd
      /** When the turn ended, when the thread knows when it began. */
      endedAt: number | null
      replies: AgentEntry[]
    }

// A tool's edits are worked out once, however often the list redraws.
const edits = new WeakMap<ToolEntry, FileEdit[]>()

export function toolEdits(tool: ToolEntry): FileEdit[] {
  const known = edits.get(tool)
  if (known) return known
  const made = tool.content.flatMap((part): FileEdit[] =>
    part.type === 'diff'
      ? [
          {
            path: part.path,
            oldText: part.oldText,
            newText: part.newText,
            diff: diffTexts(part.oldText, part.newText),
          },
        ]
      : [],
  )
  edits.set(tool, made)
  return made
}

/** A turn's edits by file, in the order it first touched them. */
export function fileChanges(tools: ToolEntry[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const tool of tools) {
    if (tool.status === 'failed' || tool.status === 'cancelled') continue
    for (const edit of toolEdits(tool)) {
      let change = byPath.get(edit.path)
      if (!change) {
        change = {
          path: edit.path,
          created: edit.oldText === null,
          insertions: 0,
          deletions: 0,
          edits: [],
        }
        byPath.set(edit.path, change)
      }
      change.insertions += edit.diff.insertions
      change.deletions += edit.diff.deletions
      change.edits.push(edit)
    }
  }
  return [...byPath.values()]
}

/** One diff of every edit to a file, in order, for the diff screen. */
export function mergedDiff(change: FileChange): Diff {
  if (change.edits.length === 1) return change.edits[0]!.diff
  const rows: Diff['rows'] = []
  let columns = 0
  let lastLine = 0
  let rough = false
  change.edits.forEach((edit, index) => {
    const d = edit.diff
    if (index > 0 || d.rows[0]?.kind !== 'hunk') {
      rows.push({ kind: 'hunk', text: `第 ${index + 1} 处改动` })
    }
    rows.push(...d.rows)
    columns = Math.max(columns, d.columns)
    lastLine = Math.max(lastLine, d.lastLine)
    rough ||= d.rough
  })
  return {
    rows,
    insertions: change.insertions,
    deletions: change.deletions,
    columns,
    lastLine,
    rough,
  }
}

function hasEdits(tool: ToolEntry): boolean {
  return tool.content.some((part) => part.type === 'diff')
}

/**
 * Whether an entry folds into a run of work, as the desktop's thread signature reads it: thoughts,
 * tool calls and project memory writes. A request for permission, waiting or answered, a question,
 * a plan, an MCP server's request and a workflow tool's card each stand on their own.
 */
export function foldsIntoRun(entry: ThreadEntry): boolean {
  if (entry.kind === 'thought') return true
  if (entry.kind === 'memory') return entry.layer === 'project'
  if (entry.kind !== 'tool') return false
  if (entry.question !== undefined || entry.planVersion !== undefined) return false
  if (entry.elicitation !== undefined || entry.permission) return false
  if (workflowCardOf(entry)) return false
  const result = entry.permissionResult
  if (result && (typeof result !== 'object' || result.by !== 'routine')) return false
  return true
}

/** Whether a user entry starts a turn: what a turn's changes and footer count start over at it. */
function startsTurn(entry: ThreadEntry): boolean {
  return entry.kind === 'user' && !entry.steered && !entry.approval
}

/** The rows of entries that hold at most one turn's start, at their beginning, oldest first. */
function turnRows(entries: readonly ThreadEntry[]): Row[] {
  const rows: Row[] = []
  let tools: ToolEntry[] = []
  let replies: AgentEntry[] = []
  let startedAt: number | null = null
  let run: ThreadEntry[] | null = null
  const closeRun = () => {
    if (run) rows.push({ type: 'run', key: `run:${run[0]!.id}`, entries: run, latest: false })
    run = null
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.kind === 'tool' && hasEdits(entry)) tools.push(entry)
    if (foldsIntoRun(entry)) {
      ;(run ??= []).push(entry)
      continue
    }
    if (entry.kind === 'plan' || (entry.kind === 'user' && entry.approval)) continue
    closeRun()
    switch (entry.kind) {
      case 'user':
        if (!entry.steered) {
          tools = []
          replies = []
          startedAt = entry.at ?? null
        }
        break
      case 'agent':
        replies.push(entry)
        startedAt ??= entry.at ?? null
        break
      case 'compaction': {
        // Compactions in a row read as one divider: the latest stands for them all. The entry
        // after the last of a turn starts the next turn, so it is never one.
        if (entries[i + 1]?.kind === 'compaction') continue
        break
      }
      case 'turn_end':
        if (tools.length > 0) rows.push({ type: 'changes', key: `changes:${entry.id}`, tools })
        rows.push({
          type: 'footer',
          key: `footer:${entry.id}`,
          end: entry,
          endedAt: startedAt !== null ? startedAt + entry.durationMs : null,
          replies,
        })
        tools = []
        replies = []
        startedAt = null
        continue
    }
    rows.push({ type: 'entry', key: entry.id, entry })
  }
  closeRun()
  return rows
}

/** The entries of `thread` in order, cut where each turn starts. */
function turnsOf(thread: ThreadState): ThreadEntry[][] {
  const turns: ThreadEntry[][] = []
  let current: ThreadEntry[] = []
  for (const id of thread.order) {
    const entry = thread.byId[id]
    if (!entry) continue
    if (startsTurn(entry) && current.length > 0) {
      turns.push(current)
      current = []
    }
    current.push(entry)
  }
  if (current.length > 0) turns.push(current)
  return turns
}

function markLatest(rows: Row[], thread: ThreadState, live: boolean): Row[] {
  const last = rows[rows.length - 1]
  if (live && last?.type === 'run') rows[rows.length - 1] = { ...last, latest: true }
  const writing = writingId(thread)
  if (writing !== null) {
    // The reply being written is among the last rows; only plans and notices may follow it.
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!
      if (row.type === 'entry' && row.key === writing) {
        rows[i] = { ...row, writing: true }
        break
      }
    }
  }
  return rows
}

/**
 * The rows of `thread`, oldest first. Plans are left out for the plan pinned under the header,
 * as the desktop shows them in its top bar, and so are the messages sent as a card's answer. With
 * `live`, the turn still runs and its last run of work is the latest.
 */
export function threadRows(thread: ThreadState, live = false): Row[] {
  return markLatest(turnsOf(thread).flatMap(turnRows), thread, live)
}

interface Turn {
  entries: ThreadEntry[]
  rows: Row[]
}

/**
 * `threadRows` for one screen, oldest first, as the conversation's list takes them. A turn whose
 * entries are the same objects as last time keeps its rows, so a token appended to the reply
 * being written rebuilds only the latest turn's; and every row that draws the same as before keeps
 * its object, so the list and its rows compare by reference. While nothing changed, the same
 * array comes back.
 *
 * It runs on every patch the screen applies, so it walks the thread once and allocates only for
 * the turns that changed: a turn is compared entry by entry with what it held, in place, rather
 * than gathered into a new array first, and only a rebuilt turn's rows are matched to its old ones.
 */
export function rowBuilder(): (thread: ThreadState, live: boolean) => Row[] {
  let turns = new Map<ThreadEntry, Turn>()
  let shown: Row[] = []
  let seen: { order: string[]; byId: Record<string, ThreadEntry>; live: boolean } | null = null
  return (thread, live) => {
    const { order, byId } = thread
    if (seen && seen.order === order && seen.byId === byId && seen.live === live) return shown
    seen = { order, byId, live }
    const kept = new Map<ThreadEntry, Turn>()
    const rows: Row[] = []
    let i = 0
    while (i < order.length) {
      const first = byId[order[i]!]
      if (!first) {
        i++
        continue
      }
      // The turn runs from its first entry to the next that starts a turn.
      let end = i + 1
      while (end < order.length) {
        const entry = byId[order[end]!]
        if (entry && startsTurn(entry)) break
        end++
      }
      const known = turns.get(first)
      let same = known !== undefined
      if (known) {
        let k = 0
        for (let x = i; x < end && same; x++) {
          const entry = byId[order[x]!]
          if (!entry) continue
          if (known.entries[k] !== entry) same = false
          k++
        }
        if (k !== known.entries.length) same = false
      }
      let turn: Turn
      if (same) {
        turn = known!
      } else {
        const entries: ThreadEntry[] = []
        for (let x = i; x < end; x++) {
          const entry = byId[order[x]!]
          if (entry) entries.push(entry)
        }
        const built = turnRows(entries)
        // A turn not known by its first entry, as the first after an older page came in, may
        // still hold rows shown before.
        turn = { entries, rows: keepRows(known ? known.rows : shown, built) }
      }
      kept.set(first, turn)
      for (const row of turn.rows) rows.push(row)
      i = end
    }
    turns = kept
    const next = markLatest(rows, thread, live)
    // A row marked as the latest or as being written is a new object each time: the one shown
    // stands for it while it draws the same.
    for (let r = next.length - 1; r >= 0 && r >= next.length - MARKED_FROM_END; r--) {
      const old = shown[r - next.length + shown.length]
      if (old && old !== next[r] && sameRow(old, next[r]!)) next[r] = old
    }
    let changed = next.length !== shown.length
    for (let r = 0; !changed && r < next.length; r++) changed = next[r] !== shown[r]
    if (changed) shown = next
    return shown
  }
}

// How far from the end the rows markLatest may mark lie: the latest run is the last row, and only
// plans and notices may follow the reply being written.
const MARKED_FROM_END = 8

/** `next` with each row that draws as one of `before` does replaced by it; `before` if all were. */
export function keepRows(before: readonly Row[], next: Row[]): Row[] {
  if (before.length === 0) return next
  const byKey = new Map<string, Row>()
  for (const row of before) byKey.set(row.key, row)
  let same = before.length === next.length
  for (let i = 0; i < next.length; i++) {
    const old = byKey.get(next[i]!.key)
    if (old && old !== next[i] && sameRow(old, next[i]!)) next[i] = old
    if (next[i] !== before[i]) same = false
  }
  return same ? (before as Row[]) : next
}
// Where the latest plan lies in a thread's order, and whether its turn is the latest: a thread with
// no plan was read whole on every patch, though only an added entry can change this.
const planAt = new WeakMap<readonly string[], { index: number; ownTurn: boolean }>()

/** The latest plan of the thread, or of the page before it, and whether its turn is the latest. */
export function latestPlan(
  thread: ThreadState | null,
  before: PlanEntry | null,
): { plan: PlanEntry | null; ownTurn: boolean } {
  if (!thread) return { plan: before, ownTurn: false }
  let at = planAt.get(thread.order)
  if (!at) {
    at = { index: -1, ownTurn: false }
    let ownTurn = true
    for (let i = thread.order.length - 1; i >= 0; i--) {
      const entry = thread.byId[thread.order[i]!]
      if (entry?.kind === 'plan') {
        at = { index: i, ownTurn }
        break
      }
      if (entry?.kind === 'user' && !entry.steered && !entry.approval) ownTurn = false
    }
    planAt.set(thread.order, at)
  }
  const entry = at.index >= 0 ? thread.byId[thread.order[at.index]!] : undefined
  return entry?.kind === 'plan'
    ? { plan: entry, ownTurn: at.ownTurn }
    : { plan: before, ownTurn: false }
}

const NO_TURN = { start: null, end: null }

/**
 * The latest turn as Undo takes it out: the user's message that starts it, where the computer cuts
 * the thread as the desktop's Undo does, and the end whose footer offers it; nulls until it ended.
 */
export function latestTurn(thread: ThreadState | null): {
  start: string | null
  end: string | null
} {
  let end: string | null = null
  for (let i = (thread?.order.length ?? 0) - 1; i >= 0; i--) {
    const entry = thread!.byId[thread!.order[i]!]
    if (entry?.kind === 'turn_end') end ??= entry.id
    if (entry?.kind === 'user' && !entry.steered) {
      return end === null ? NO_TURN : { start: entry.id, end }
    }
  }
  return NO_TURN
}

const list = (x: readonly unknown[], y: readonly unknown[]) =>
  x.length === y.length && x.every((item, i) => item === y[i])

/** Whether two rows draw the same, so a row redraws only when its own data changed. */
export function sameRow(a: Row, b: Row): boolean {
  if (a.type !== b.type || a.key !== b.key) return false
  if (a.type === 'entry') {
    const other = b as typeof a
    return a.entry === other.entry && a.writing === other.writing
  }
  if (a.type === 'run') {
    const other = b as typeof a
    return a.latest === other.latest && list(a.entries, other.entries)
  }
  if (a.type === 'changes') return list(a.tools, (b as typeof a).tools)
  const other = b as Extract<Row, { type: 'footer' }>
  return a.end === other.end && a.endedAt === other.endedAt && list(a.replies, other.replies)
}
