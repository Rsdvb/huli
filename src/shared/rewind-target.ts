// Huli: which of the user's messages a rewind can go back to, and where it cuts the thread.

import type { ThreadEntry, ThreadState } from './thread'

type Thread = Pick<ThreadState, 'order' | 'byId'>

/** How a rewind goes back to a message: with it given back to edit, or keeping it and its reply. */
export type RewindMode = 'edit' | 'rewind'

/** A message that started a turn of its own, as against one steered into a running turn. */
function startsTurn(entry: ThreadEntry | undefined): boolean {
  return entry?.kind === 'user' && !entry.steered
}

/**
 * A message of the user's own that started a turn: not one steered into a running turn, nor one
 * another session's agent or a card's answer wrote.
 */
export function canRewindFrom(entry: ThreadEntry | undefined): boolean {
  return entry?.kind === 'user' && !entry.steered && entry.from === undefined && !entry.approval
}

/**
 * The first message a rewind from `entryId` takes out, which the host cuts the thread before:
 * the message itself to edit it, else the next one that started a turn; null when there is none.
 */
export function rewindTarget(thread: Thread, entryId: string, mode: RewindMode): string | null {
  const at = thread.order.indexOf(entryId)
  if (at < 0 || !canRewindFrom(thread.byId[entryId])) return null
  if (mode === 'edit') return entryId
  for (let i = at + 1; i < thread.order.length; i++) {
    const id = thread.order[i]!
    if (startsTurn(thread.byId[id])) return id
  }
  return null
}
