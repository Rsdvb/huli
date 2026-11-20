// Huli: what main asks the backup's utility process, one request per process, and its answers.

import type { BackupProblem } from '@shared/backup'
import type { BackupJob } from './run'
import type { RestoreJob } from './restore'

export type BackupRequest =
  | { op: 'backup'; job: Omit<BackupJob, 'now' | 'progress'> }
  | { op: 'inspect'; file: string }
  | { op: 'restore'; job: Omit<RestoreJob, 'progress'> }

/** What `inspect` answers: the manifest's summary. */
export interface InspectAnswer {
  created: string
  app: string
  files: number
  bytes: number
}

/** What `restore` answers: the files put in place and the safety copy's file name. */
export interface RestoreAnswer {
  files: number
  safety: string
}

export type BackupReply =
  | { type: 'progress'; phase: 'backup' | 'check' | 'safety' | 'swap'; done: number; total: number }
  | { type: 'result'; value: unknown }
  | { type: 'error'; problem: BackupProblem; message: string }
