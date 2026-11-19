// State of the updater in main, as every surface reads it.

import type { Locale } from './locale'

export type UpdateState =
  | { kind: 'off'; reason: 'development' | 'unsupported' }
  | { kind: 'idle'; checkedAt: number | null } // up to date, or not checked yet
  | { kind: 'checking'; manual: boolean }
  // Found, not downloading. In Link mode downloadUrl is the .dmg for this Mac, when there is one.
  | { kind: 'available'; version: string; mode: 'install' | 'link'; downloadUrl: string | null }
  | { kind: 'moving'; version: string } // Update on a read-only volume, moving the app first
  | { kind: 'downloading'; version: string; percent: number; manual: boolean } // manual: Update
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
