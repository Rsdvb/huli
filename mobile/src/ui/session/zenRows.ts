// Huli: the conversation's rows as the 简洁视图 shows them, as the desktop's zen-items.ts derives
// its thread's items: without the tool calls that went well, or only each turn's message, its
// final replies, its changes and footer, and what waits for the user, with the steps between them
// folded into one line per turn that opens it. Requests and questions always show. A view of the
// rows the list builds anyway, memoized by the screen.

import type { ThreadEntry } from '@shared/thread'
import type { ToolCallView } from '@shared/zen-view'
import type { Row } from './turns'

/** The line that stands for a turn's hidden steps, which opens the turn. */
export interface HiddenRow {
  type: 'hidden'
  key: string
  turn: string
  count: number
}

export type ZenRow = Row | HiddenRow

/** Kite's own records that tell rather than ask, which only conclusions hide. */
const TELLING: ReadonlySet<ThreadEntry['kind']> = new Set([
  'git',
  'session_started',
  'subagent',
  'control_note',
])

function wentWell(entry: ThreadEntry): boolean {
  return entry.kind === 'tool' && entry.status === 'completed' && !entry.permission
}

// A run without its calls that went well, kept by the run it came from, so the list compares the
// same object while nothing in it changed.
const trimmed = new WeakMap<Extract<Row, { type: 'run' }>, Row | null>()

function trimRun(row: Extract<Row, { type: 'run' }>): Row | null {
  if (trimmed.has(row)) return trimmed.get(row)!
  const kept = row.entries.filter((entry) => !wentWell(entry))
  const out =
    kept.length === row.entries.length ? row : kept.length > 0 ? { ...row, entries: kept } : null
  trimmed.set(row, out)
  return out
}

function startsTurn(row: Row): boolean {
  return (
    row.type === 'entry' && row.entry.kind === 'user' && !row.entry.steered && !row.entry.approval
  )
}

export function zenRows(
  rows: readonly Row[],
  view: ToolCallView,
  open: ReadonlySet<string>,
): ZenRow[] {
  if (view === 'all') return rows as Row[]
  if (view === 'hideSuccessful') {
    return rows.flatMap((row) => {
      if (row.type !== 'run') return [row]
      const kept = trimRun(row)
      return kept ? [kept] : []
    })
  }
  // Turns: from a message you sent, or from what follows a footer when the agent went on alone.
  const turns: Row[][] = []
  for (const row of rows) {
    const last = turns.at(-1)
    if (!last || startsTurn(row) || last.at(-1)?.type === 'footer') turns.push([row])
    else last.push(row)
  }
  const out: ZenRow[] = []
  for (const turn of turns) {
    const key = turn[0]!.key
    if (open.has(key)) {
      out.push(...turn)
      continue
    }
    const ended = turn.some((row) => row.type === 'footer')
    // The final replies: those after the turn's last work, or all of them when it ended on work;
    // none while the turn runs, as the desktop shows them once it ends.
    let lastWork = -1
    turn.forEach((row, i) => {
      if (row.type === 'run') lastWork = i
    })
    const after = turn.some((row, i) => i > lastWork && row.type === 'reply')
    const shows = (row: Row, i: number): boolean => {
      switch (row.type) {
        case 'changes':
        case 'footer':
          return true
        case 'run':
          return false
        case 'reply':
          return ended && (!after || i > lastWork)
        case 'entry': {
          const { entry } = row
          if (entry.kind === 'user' || entry.kind === 'compaction') return true
          if (TELLING.has(entry.kind)) return false
          if (entry.kind === 'notice') return entry.severity !== 'info'
          return true
        }
      }
    }
    let count = 0
    let lineAt = -1
    const kept: ZenRow[] = []
    turn.forEach((row, i) => {
      if (shows(row, i)) kept.push(row)
      else {
        if (lineAt < 0) lineAt = kept.length
        // A long reply's later parts are the same message.
        if (row.type === 'run') count += row.entries.length
        else if (row.type !== 'reply' || row.part.index === 0) count += 1
      }
    })
    if (count > 0)
      kept.splice(lineAt, 0, { type: 'hidden', key: `hidden:${key}`, turn: key, count })
    out.push(...kept)
  }
  return out
}
