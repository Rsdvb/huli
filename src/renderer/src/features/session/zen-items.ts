// Huli: the thread's items as the 简洁视图 shows them, a view derived from the items the thread
// builds anyway. Hiding successful tool calls drops the completed calls from their runs; showing
// only conclusions keeps each turn's message, its final reply and footer, and what waits for the
// user (requests, questions, Kite's cards), folding the rest into one line per turn that opens it.
// Requests and questions always show. Find shows everything while it is open, outside this.

import type { ThreadEntry, ThreadState } from '@shared/thread'
import type { ToolCallView } from '@shared/zen-view'
import type { Item } from './thread-items'

/** Kite's own records that tell rather than ask, which only conclusions hide. */
const TELLING: ReadonlySet<ThreadEntry['kind']> = new Set([
  'git',
  'session_started',
  'subagent',
  'control_note',
])

/**
 * One character an entry, beside the thread's signature: S a tool call that went well, i a record
 * that only tells, `.` anything else. Read only while the view hides something.
 */
export function zenSignatureOf(state: ThreadState | null | undefined): string {
  if (!state) return ''
  let out = ''
  for (const id of state.order) {
    const entry = state.byId[id]
    if (!entry) out += '.'
    else if (entry.kind === 'tool') {
      out +=
        entry.status === 'completed' &&
        !entry.permission &&
        entry.question === undefined &&
        entry.elicitation === undefined &&
        entry.planVersion === undefined
          ? 'S'
          : '.'
    } else if (TELLING.has(entry.kind) || (entry.kind === 'notice' && entry.severity === 'info')) {
      out += 'i'
    } else out += '.'
  }
  return out
}

/** The entries an item holds, for counting what a turn hides. */
function entryCount(item: Item): number {
  if (item.type === 'run' || item.type === 'group') return item.ids.length
  if (item.type === 'entry') return 1
  return 0
}

/**
 * The items the view shows, and the turn each hidden item belongs to, so a jump to one can open
 * its turn. `expanded` turns show whole.
 */
export function zenItems(
  items: readonly Item[],
  order: readonly string[],
  zen: string,
  view: ToolCallView,
  expanded: ReadonlySet<string>,
): { items: Item[]; turnOf: Map<string, string> } {
  const turnOf = new Map<string, string>()
  if (view === 'all') return { items: [...items], turnOf }
  const at = new Map(order.map((id, i) => [id, i]))
  const zenOf = (id: string): string => zen[at.get(id) ?? -1] ?? '.'

  if (view === 'hideSuccessful') {
    const out: Item[] = []
    for (const item of items) {
      if (item.type !== 'run') {
        out.push(item)
        continue
      }
      const kept = item.ids.flatMap((id, i) => (zenOf(id) === 'S' ? [] : [[id, i] as const]))
      if (kept.length === item.ids.length) out.push(item)
      else if (kept.length > 0) {
        out.push({
          ...item,
          ids: kept.map(([id]) => id),
          signature: kept.map(([, i]) => item.signature[i]).join(''),
        })
      }
    }
    return { items: out, turnOf }
  }

  // Conclusions: the items cut into turns, each from a message you sent, or from what follows a
  // reply's footer when the agent went on by itself.
  const turns: Item[][] = []
  for (const item of items) {
    const starts =
      turns.length === 0 ||
      (item.type === 'entry' && item.turnStart) ||
      turns.at(-1)!.at(-1)?.type === 'reply'
    if (starts) turns.push([item])
    else turns.at(-1)!.push(item)
  }
  const out: Item[] = []
  for (const turn of turns) {
    const key = turn[0]!.key
    if (expanded.has(key)) {
      out.push(...turn)
      continue
    }
    const reply = turn.find((item) => item.type === 'reply')
    const answers = new Set(reply?.type === 'reply' ? reply.agentIds : [])
    const shows = (item: Item): boolean => {
      if (item.type === 'reply' || item.type === 'status') return true
      if (item.type !== 'entry') return false
      switch (item.char) {
        case 'u':
        case 's':
        case 'w':
        case 'p':
          return true
        case 'a':
          return answers.has(item.id)
        case 'o':
          return zenOf(item.id) !== 'i'
        default:
          return false
      }
    }
    let count = 0
    let lineAt = -1
    const kept: Item[] = []
    for (const item of turn) {
      if (shows(item)) kept.push(item)
      else {
        if (lineAt < 0) lineAt = kept.length
        count += entryCount(item)
        turnOf.set(item.key, key)
      }
    }
    if (count > 0)
      kept.splice(lineAt, 0, { key: `hidden:${key}`, type: 'hidden', turn: key, count })
    out.push(...kept)
  }
  return { items: out, turnOf }
}
