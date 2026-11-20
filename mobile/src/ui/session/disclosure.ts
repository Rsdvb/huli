// What the user opened in a conversation, kept apart from the rows that show it: the list drops
// rows far out of view and hands a row's view to another row as it scrolls, and either would
// otherwise forget what was opened, or show it opened on the wrong row. Each part that opens keys
// itself by what it shows, such as a tool call's id, under its session.

import { useCallback, useSyncExternalStore } from 'react'
import { useSessionRows } from './context'

/** How many keys are kept; the oldest go first, closing what they held. */
const KEPT = 4000

const values = new Map<string, boolean>()
const listeners = new Map<string, Set<() => void>>()

function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}

function write(key: string, value: boolean): void {
  values.delete(key)
  values.set(key, value)
  if (values.size > KEPT) values.delete(values.keys().next().value!)
  for (const listener of listeners.get(key) ?? []) listener()
}

/**
 * Whether the part keyed `key` is open, `initial` until the user changes it, and the way to change
 * it. The same key on another row, or on the same row mounted again, reads the same answer.
 */
export function useDisclosure(
  key: string,
  initial = false,
): [boolean, (next: boolean | ((was: boolean) => boolean)) => void] {
  const { sessionId } = useSessionRows((r) => ({ sessionId: r.sessionId }))
  const full = `${sessionId}\n${key}`
  const open = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(full, listener), [full]),
    () => values.get(full) ?? initial,
  )
  const set = useCallback(
    (next: boolean | ((was: boolean) => boolean)) =>
      write(full, typeof next === 'function' ? next(values.get(full) ?? initial) : next),
    [full, initial],
  )
  return [open, set]
}

/** A short key for a long text, such as a code block's, which has no id of its own. */
export function textKey(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `${text.length}:${(hash >>> 0).toString(36)}`
}
