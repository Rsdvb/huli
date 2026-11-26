// Huli: the requests a session's agent waits on, answered in turn. The host numbers each blocking
// request as it arrives (`PendingPermission.queue`); every client shows the oldest as its card and
// the others collapsed behind it, so the user never answers a later one without seeing the first.
// Requests that wait at once ran at once, as parallel tool calls do, so the agent takes their
// answers in any order, and 全部同意 / 全部拒绝 may answer the plain ones together.

import type { PendingPermission, ThreadEntry, ThreadState, ToolEntry } from './thread'

/** A tool call whose request waits in the session's queue. */
export type QueuedRequest = ToolEntry & { permission: PendingPermission & { queue: number } }

/** Whether an entry's request waits in the queue; one without a number is answered on its own. */
export function inQueue(entry: ThreadEntry | undefined): entry is QueuedRequest {
  return entry?.kind === 'tool' && entry.permission?.queue !== undefined
}

/** The queued requests among `entries`, oldest first. */
export function requestQueue(entries: Iterable<ThreadEntry | undefined>): QueuedRequest[] {
  const queued: QueuedRequest[] = []
  for (const entry of entries) if (inQueue(entry)) queued.push(entry)
  return queued.sort((a, b) => a.permission.queue - b.permission.queue)
}

const NONE: readonly QueuedRequest[] = []
const known = new WeakMap<ThreadState, readonly QueuedRequest[]>()

/**
 * A thread's queue, oldest first, read once for each state of it. A session that is not waiting
 * for permission has none, which every patch of a streaming turn reads without a walk.
 */
export function threadQueue(state: ThreadState | null | undefined): readonly QueuedRequest[] {
  if (!state || state.session.status !== 'awaiting_permission') return NONE
  let queue = known.get(state)
  if (!queue) {
    const found = requestQueue(state.order.map((id) => state.byId[id]))
    queue = found.length === 0 ? NONE : found
    known.set(state, queue)
  }
  return queue
}

/** Whether a card waits behind an older request, which is answered first. */
export function waitsBehind(queue: readonly QueuedRequest[], entryId: string): boolean {
  return queue.length > 1 && queue[0]!.id !== entryId && queue.some((e) => e.id === entryId)
}

/**
 * A plain request to use a tool, which allow once or deny answers: not an ask's questions, a plan,
 * an MCP server's form or a question put as a request, which the user answers on their own card.
 */
export function plainRequest(entry: QueuedRequest): boolean {
  const { permission } = entry
  return (
    !permission.questions &&
    !permission.plan &&
    !permission.elicitation &&
    entry.question === undefined
  )
}

/**
 * Whether the host judged a request high: its risk level where it sent one, else its older mark,
 * which its high level holds.
 */
export function highRisk(permission: PendingPermission): boolean {
  return permission.risk ? permission.risk.level === 'high' : permission.risky === true
}

/** What 全部同意 or 全部拒绝 does with a request: answers it with this option, or skips it. */
export function bulkOption(entry: QueuedRequest, decision: 'allow' | 'deny'): string | null {
  if (!plainRequest(entry)) return null
  const { options } = entry.permission
  // Never a high request, and never an allow that outlasts the one call.
  if (decision === 'allow' && highRisk(entry.permission)) return null
  const kind = decision === 'allow' ? 'allow_once' : 'reject_once'
  return options.find((option) => option.kind === kind)?.id ?? null
}

/** How the queue's requests split for 全部同意 or 全部拒绝: those it answers and those it leaves. */
export function bulkSplit(
  queue: readonly QueuedRequest[],
  decision: 'allow' | 'deny',
): { answered: QueuedRequest[]; skipped: QueuedRequest[] } {
  const answered: QueuedRequest[] = []
  const skipped: QueuedRequest[] = []
  for (const entry of queue) (bulkOption(entry, decision) ? answered : skipped).push(entry)
  return { answered, skipped }
}
