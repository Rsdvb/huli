// Huli: a step a lean page held in part (a digest of its output, its input or its title) is read
// whole with `sessions.entry` when its card opens, and the last few are kept so a card opened again
// shows at once. A memory warning drops them.

import { useCallback, useEffect, useState } from 'react'
import { hasToolDigest, type ThreadEntry, type ToolEntry } from '@shared/thread'
import type { HostLink } from '@shared/remote/link'
import { hostErrorText } from '../../hostErrors'

const KEPT = 12

const kept = new Map<string, ToolEntry>()
const reading = new Map<string, Promise<ToolEntry>>()

const keyOf = (sessionId: string, entryId: string) => `${sessionId}\0${entryId}`

function remember(key: string, entry: ToolEntry): void {
  kept.delete(key)
  kept.set(key, entry)
  for (const old of kept.keys()) {
    if (kept.size <= KEPT) break
    kept.delete(old)
  }
}

function read(link: HostLink, sessionId: string, entryId: string): Promise<ToolEntry> {
  const key = keyOf(sessionId, entryId)
  const running = reading.get(key)
  if (running) return running
  const run = (link.request('sessions.entry', { sessionId, entryId }) as Promise<ThreadEntry>)
    .then((entry) => {
      if (entry.kind !== 'tool') throw new Error('这不是一次工具调用。')
      remember(key, entry)
      return entry
    })
    .finally(() => reading.delete(key))
  reading.set(key, run)
  return run
}

/** Forgets the steps read whole, as when the system runs short of memory. */
export function dropFullEntries(): void {
  kept.clear()
}

/**
 * The step whole while its card is open: the entry itself when nothing of it was left out, else
 * the one `sessions.entry` read, with the entry's own state, which patches keep current.
 */
export function useFullEntry(
  link: HostLink,
  sessionId: string,
  entry: ToolEntry,
): { entry: ToolEntry; loading: boolean; error: string | null; retry(): void } {
  const partial = hasToolDigest(entry)
  const key = keyOf(sessionId, entry.id)
  const [full, setFull] = useState<ToolEntry | null>(() =>
    partial ? (kept.get(key) ?? null) : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!partial) return
    let live = true
    const known = kept.get(key)
    if (known) {
      setFull(known)
      return
    }
    setError(null)
    read(link, sessionId, entry.id).then(
      (whole) => live && setFull(whole),
      (failure: unknown) => live && setError(hostErrorText(failure, '没能读取这一步的完整内容。')),
    )
    return () => {
      live = false
    }
  }, [link, sessionId, entry.id, key, partial, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  if (!partial) return { entry, loading: false, error: null, retry }
  if (!full || full.id !== entry.id) return { entry, loading: error === null, error, retry }
  return {
    entry: {
      ...full,
      status: entry.status,
      permission: entry.permission,
      permissionResult: entry.permissionResult,
    },
    loading: false,
    error: null,
    retry,
  }
}
