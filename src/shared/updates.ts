// State of the updater in main, as every surface reads it.

import type { BusySession } from './host-control'
import type { Locale } from './locale'

export type UpdateState =
  | { kind: 'off'; reason: 'development' | 'unsupported' }
  | { kind: 'idle'; checkedAt: number | null } // up to date, or not checked yet
  | { kind: 'checking'; manual: boolean }
  | { kind: 'available'; version: string; mode: 'install' | 'link' } // found, not downloading
  | { kind: 'moving'; version: string } // Update on a read-only volume, moving the app first
  // manual: Update. replaces: the downloaded version a newer one replaces, whose notice stays up.
  | {
      kind: 'downloading'
      version: string
      percent: number
      manual: boolean
      replaces?: string
    }
  // Downloaded and verified; notes: the release's highlights in each language it has them in.
  | { kind: 'ready'; version: string; notes?: Partial<Record<Locale, string[]>> }
  // move: the move failed; githubUnreachable: GitHub, the only source, could not be reached.
  | { kind: 'error'; message: string; manual: boolean; move?: true; githubUnreachable?: true }

export interface UpdateStatus {
  state: UpdateState
  mode: 'install' | 'link' // how this build updates, even while updates are off
  readOnly: boolean // on a read-only volume, which only macOS Install mode tests
  current: string // the running version
  updatedFrom: string | null // set for the first launch after an update
  dismissed: string | null // the version whose notice was dismissed
  /** Set while the restart into the update waits for this many working sessions to finish. */
  restartWhenIdle: { sessions: number } | null
}

/**
 * Whether a restart to update can wait for this working session: its turn and its subagents end
 * by themselves, unlike background commands and scheduled wakeups.
 */
export function restartWaitsFor(session: BusySession): boolean {
  return session.turnStartedAt !== null || (session.background?.subagents.length ?? 0) > 0
}

// Huli: the channel's path is kept out of the repository; tools/huli/update-path.mjs fills it in
// before a build. A build without it, such as `pnpm dev`, has no update channel.
export const RELEASES_URL = 'https://huli.132-145-200-0.sslip.io/u/__HULI_UPDATE_PATH__'

/** Whether the build was given the channel's path, which is 32 hex characters. */
export const UPDATE_CHANNEL_READY = /\/u\/[0-9a-f]{32}$/.test(RELEASES_URL)

/**
 * Huli: the channel is the one place updates come from, with the cloud on or off and whatever
 * download source an older settings file chose; its builds are on no GitHub release. It serves no
 * source list, so a check asks it alone, as upstream's GitHub only does with `RELEASES_URL`.
 */
export const CHANNEL_ONLY = true

export function releaseUrl(version: string): string {
  // Huli: the channel serves files only; release notes are on the repository's releases.
  return `https://github.com/Rsdvb/huli/releases/tag/v${version}`
}
