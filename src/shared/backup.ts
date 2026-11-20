// Huli: the daily backup of this computer's data folder as main tells Settings › Backup about it.
// Main makes and restores the backups; the page shows them and asks, and never names a path.

/** Why a backup did not run or did not finish; `failed` carries the system's message. */
export type BackupProblem =
  /** The folder the user picked is not there, as a drive that is not plugged in. */
  | 'destination-missing'
  | 'destination-unwritable'
  | 'no-space'
  /** Skipped: the agent host was moving its data to a new format. */
  | 'migrating'
  | 'failed'

export interface BackupResult {
  /** When it finished, in ms since the epoch. */
  at: number
  /** The backup's file name in the folder. */
  file: string
  bytes: number
  files: number
  durationMs: number
}

export interface BackupError {
  at: number
  problem: BackupProblem
  message: string | null
}

/** How the last restore went, shown until a backup runs again. */
export interface RestoreOutcome {
  at: number
  ok: boolean
  /** The backup restored from: its file name. */
  from: string
  /** The safety copy of the data it replaced: its file name, when one was made. */
  safety: string | null
  message: string | null
}

export interface BackupStatus {
  /** Where backups go now: the folder picked, or the default one. */
  folder: string
  defaultFolder: boolean
  /** A backup is being made now; `progress` from 0 to 1 once known. */
  running: boolean
  progress: number | null
  last: BackupResult | null
  /** The last attempt's problem; a backup that succeeds clears it. */
  error: BackupError | null
  /** When the next daily backup is due, in ms since the epoch; null while they are off. */
  next: number | null
  /** The backups in the folder: how many and their bytes; null when it cannot be read. */
  stored: { count: number; bytes: number } | null
  restore: RestoreOutcome | null
}

/** A backup the user picked to restore, as main read and checked it. */
export interface RestoreCandidate {
  /** Names the file to `backup:restore`, so the page never sends a path. */
  token: string
  file: string
  /** When the backup was made, in ms since the epoch. */
  created: number
  /** The version of Kite that made it. */
  app: string
  files: number
  bytes: number
}

/** What picking a backup to restore came to; null when the dialog was cancelled. */
export type RestorePick =
  { kind: 'ok'; candidate: RestoreCandidate } | { kind: 'invalid'; message: string } | null
