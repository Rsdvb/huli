// The conversation as rows: its entries, and after each turn that ended, the files that turn
// changed and a footer with its time, its length and what can be done with its reply.

import type { ThreadEntry, ThreadState, ToolEntry } from '@shared/thread'
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

/** The rows of `thread`, oldest first. */
export function threadRows(thread: ThreadState): Row[] {
  const rows: Row[] = []
  let tools: ToolEntry[] = []
  let replies: AgentEntry[] = []
  let startedAt: number | null = null
  for (const id of thread.order) {
    const entry = thread.byId[id]
    if (!entry) continue
    switch (entry.kind) {
      case 'user':
        if (!entry.steered && !entry.approval) {
          tools = []
          replies = []
          startedAt = entry.at ?? null
        }
        break
      case 'agent':
        replies.push(entry)
        startedAt ??= entry.at ?? null
        break
      case 'tool':
        if (hasEdits(entry)) tools.push(entry)
        break
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
  return rows
}

/** Whether two rows draw the same, so a row redraws only when its own data changed. */
export function sameRow(a: Row, b: Row): boolean {
  if (a.type !== b.type || a.key !== b.key) return false
  if (a.type === 'entry') return a.entry === (b as typeof a).entry
  const list = (x: readonly unknown[], y: readonly unknown[]) =>
    x.length === y.length && x.every((item, i) => item === y[i])
  if (a.type === 'changes') return list(a.tools, (b as typeof a).tools)
  const other = b as typeof a
  return a.end === other.end && a.endedAt === other.endedAt && list(a.replies, other.replies)
}
