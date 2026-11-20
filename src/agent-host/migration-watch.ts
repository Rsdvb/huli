// Huli: tells main's backup while the thread database moves its data to a new format: its schema
// migration as it opens, then the move of schema 9's pictures out into files, which the thread
// worker makes in short steps while it is quiet. A backup waits until both are done.

import type { ThreadStore } from './threads/store'

const POLL_MS = 60_000

/** Reports `true` at once and `false` once the moves are done; stop ends the watch. */
export function watchMigration(
  threads: Pick<ThreadStore, 'ready' | 'mediaTotals'>,
  report: (running: boolean) => void,
  pollMs = POLL_MS,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  report(true)
  const check = async (): Promise<void> => {
    if (stopped) return
    let left = 0
    try {
      left = (await threads.mediaTotals()).legacy
    } catch {
      // A database that cannot answer moves nothing; the backup need not wait for it.
    }
    if (stopped) return
    if (left > 0) {
      timer = setTimeout(() => void check(), pollMs)
      timer.unref?.()
      return
    }
    report(false)
  }
  void threads.ready.then(check)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
