// The conversation as rows: its entries, and after each turn that ended, the files that turn
// changed and a footer with its time, its length and what can be done with its reply.

import type { PlanEntry, ThreadEntry, ThreadState, ToolEntry } from '@shared/thread'
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
  | { type: 'entry'; key: string; entry: ThreadEntry }
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

/**
 * The rows of `thread`, oldest first. Plans are left out for the pinned plan above the composer,
 * as the desktop shows them in its top bar, and so are the messages sent as a card's answer. With
 * `live`, the turn still runs and its last run of work is the latest.
 */
export function threadRows(thread: ThreadState, live = false): Row[] {
  const rows: Row[] = []
  let tools: ToolEntry[] = []
  let replies: AgentEntry[] = []
  let startedAt: number | null = null
  let run: ThreadEntry[] | null = null
  const closeRun = () => {
    if (run) rows.push({ type: 'run', key: `run:${run[0]!.id}`, entries: run, latest: false })
    run = null
  }
  const { order, byId } = thread
  for (let i = 0; i < order.length; i++) {
    const entry = byId[order[i]!]
    if (!entry) continue
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
        // Compactions in a row read as one divider: the latest stands for them all.
        const next = byId[order[i + 1] ?? '']
        if (next?.kind === 'compaction') continue
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
  const last = rows[rows.length - 1]
  if (live && last?.type === 'run') rows[rows.length - 1] = { ...last, latest: true }
  return rows
}

/** The latest plan of the thread, or of the page before it, and whether its turn is the latest. */
export function latestPlan(
  thread: ThreadState | null,
  before: PlanEntry | null,
): { plan: PlanEntry | null; ownTurn: boolean } {
  if (!thread) return { plan: before, ownTurn: false }
  let ownTurn = true
  for (let i = thread.order.length - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind === 'plan') return { plan: entry, ownTurn }
    if (entry?.kind === 'user' && !entry.steered && !entry.approval) ownTurn = false
  }
  return { plan: before, ownTurn: false }
}

const list = (x: readonly unknown[], y: readonly unknown[]) =>
  x.length === y.length && x.every((item, i) => item === y[i])

/** Whether two rows draw the same, so a row redraws only when its own data changed. */
export function sameRow(a: Row, b: Row): boolean {
  if (a.type !== b.type || a.key !== b.key) return false
  if (a.type === 'entry') return a.entry === (b as typeof a).entry
  if (a.type === 'run') {
    const other = b as typeof a
    return a.latest === other.latest && list(a.entries, other.entries)
  }
  if (a.type === 'changes') return list(a.tools, (b as typeof a).tools)
  const other = b as Extract<Row, { type: 'footer' }>
  return a.end === other.end && a.endedAt === other.endedAt && list(a.replies, other.replies)
}
