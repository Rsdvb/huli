// Huli: what main keeps of the backups between runs, in `backup-state.json` beside the data it
// backs up (and never in a backup), and the backups picked to restore, which the page names by a
// token alone.

import { randomBytes } from 'node:crypto'
import type { BackupError, BackupProblem, BackupResult, RestoreOutcome } from '@shared/backup'

export const STATE_FILE = 'backup-state.json'

export interface StateFile {
  version: 1
  /** When the last backup was tried, whatever came of it; the schedule counts from it. */
  lastAttempt: number | null
  last: BackupResult | null
  error: BackupError | null
  restore: RestoreOutcome | null
}

export const EMPTY_STATE: StateFile = {
  version: 1,
  lastAttempt: null,
  last: null,
  error: null,
  restore: null,
}

const PROBLEMS: readonly BackupProblem[] = [
  'destination-missing',
  'destination-unwritable',
  'no-space',
  'migrating',
  'failed',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 4096

/** The state file as read, each record that does not parse dropped. */
export function parseState(raw: unknown): StateFile {
  if (!isRecord(raw) || raw.version !== 1) return { ...EMPTY_STATE }
  const last = isRecord(raw.last) ? raw.last : null
  const error = isRecord(raw.error) ? raw.error : null
  const restore = isRecord(raw.restore) ? raw.restore : null
  return {
    version: 1,
    lastAttempt: isCount(raw.lastAttempt) ? raw.lastAttempt : null,
    last:
      last &&
      isCount(last.at) &&
      isText(last.file) &&
      isCount(last.bytes) &&
      isCount(last.files) &&
      isCount(last.durationMs)
        ? {
            at: last.at,
            file: last.file,
            bytes: last.bytes,
            files: last.files,
            durationMs: last.durationMs,
          }
        : null,
    error:
      error && isCount(error.at) && PROBLEMS.includes(error.problem as BackupProblem)
        ? {
            at: error.at,
            problem: error.problem as BackupProblem,
            message: isText(error.message) ? error.message : null,
          }
        : null,
    restore:
      restore && isCount(restore.at) && typeof restore.ok === 'boolean' && isText(restore.from)
        ? {
            at: restore.at,
            ok: restore.ok,
            from: restore.from,
            safety: isText(restore.safety) ? restore.safety : null,
            message: isText(restore.message) ? restore.message : null,
          }
        : null,
  }
}

/** How long a backup picked to restore may wait for the user's confirmation. */
export const PICK_TTL_MS = 30 * 60 * 1000

const TOKEN = /^[0-9a-f]{32}$/

/**
 * The backups main's dialog picked and checked, each under a random token the page sends back to
 * restore it, so the page never names a file. A token is good once, and for a while.
 */
export class PickedBackups {
  private readonly picks = new Map<string, { file: string; at: number }>()

  add(file: string, now: number): string {
    for (const [token, pick] of this.picks) {
      if (now - pick.at > PICK_TTL_MS) this.picks.delete(token)
    }
    const token = randomBytes(16).toString('hex')
    this.picks.set(token, { file, at: now })
    return token
  }

  /** The file the token names, which it no longer does after; throws for any other value. */
  take(token: unknown, now: number): string {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error('Not a picked backup')
    const pick = this.picks.get(token)
    this.picks.delete(token)
    if (!pick || now - pick.at > PICK_TTL_MS) throw new Error('Pick the backup again')
    return pick.file
  }
}
