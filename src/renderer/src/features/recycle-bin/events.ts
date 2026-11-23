// Huli: the recycle bin's `bin.changed`, for the pages showing a host's bin while they show it.
// Nothing is read for a bin no page shows.

type Listener = () => void

const listeners = new Map<string, Set<Listener>>()

const keyOf = (hostId: string | null): string => hostId ?? ''

/** A host's bin changed. */
export function binChanged(hostId: string | null): void {
  for (const listener of listeners.get(keyOf(hostId)) ?? []) listener()
}

/** Hears of changes to a host's bin until the returned function is called. */
export function onBinChanged(hostId: string | null, listener: Listener): () => void {
  const key = keyOf(hostId)
  const set = listeners.get(key) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(key, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}
