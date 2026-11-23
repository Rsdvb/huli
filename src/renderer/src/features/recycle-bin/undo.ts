// Huli: a delete's 「已移到回收站」 with Undo for five seconds, as archive's is: Undo puts what went
// back from the bin, by the keys the client knows from what it deleted. A host older than the bin
// deleted for good, so it gets neither.

import { Delete02Icon } from '@hugeicons/core-free-icons'
import type { SessionSummary } from '@shared/agent-host'
import { binKey, MAX_BIN_KEYS } from '@shared/recycle-bin'
import { toast } from '@renderer/components/ui/toast'
import { undoToast } from '@renderer/features/sidebar/undo'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { hostOfSession, sessionTitle } from '@renderer/stores/sessions'
import { hostHasBin } from './support'

/** Puts `keys` back from the bin of the host `hostId`, a request at most as long as one may be. */
async function restore(hostId: string | null, keys: readonly string[]): Promise<void> {
  let held = 0
  for (let at = 0; at < keys.length; at += MAX_BIN_KEYS) {
    const result = await hostAt(hostId, 'bin.restore', { keys: keys.slice(at, at + MAX_BIN_KEYS) })
    held += result.held.length
  }
  if (held > 0) toast(i18n.t('settings:recycleBin.undoHeld'))
}

/**
 * Shows `title` with Undo, which restores `keys` from the bin of the host `hostId` (null for this
 * computer). False when that host has no bin, which deleted for good, and nothing was shown.
 */
export function binnedToast(
  title: string,
  keys: readonly string[],
  hostId: string | null = null,
): boolean {
  if (keys.length === 0 || !hostHasBin(hostId)) return false
  undoToast(
    title,
    () => void restore(hostId, keys).catch((error: unknown) => toast(errorMessage(error))),
    Delete02Icon,
  )
  return true
}

/** The toast for sessions that went to the bin, on whichever hosts they were. */
export function binnedSessionsToast(all: readonly SessionSummary[]): void {
  const summaries = all.filter((summary) => hostHasBin(hostOfSession(summary)))
  if (summaries.length === 0) return
  const byHost = new Map<string | null, string[]>()
  for (const summary of summaries) {
    const hostId = hostOfSession(summary)
    byHost.set(hostId, [...(byHost.get(hostId) ?? []), binKey('session', summary.id)])
  }
  const title =
    summaries.length === 1
      ? i18n.t('settings:recycleBin.movedTitle', { title: sessionTitle(summaries[0]!) })
      : i18n.t('settings:recycleBin.movedCount', { count: summaries.length })
  undoToast(
    title,
    () => {
      for (const [hostId, keys] of byHost) {
        void restore(hostId, keys).catch((error: unknown) => toast(errorMessage(error)))
      }
    },
    Delete02Icon,
  )
}

/** The title of a toast for one thing that went to the bin. */
export function movedTitle(title: string): string {
  return i18n.t('settings:recycleBin.movedTitle', { title })
}
