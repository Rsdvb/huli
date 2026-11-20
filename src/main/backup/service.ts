// Huli: the daily backup of the data folder, as main runs it. Main keeps the schedule and the
// record of the last runs (state.ts); each backup, check and restore runs in a utility process
// of its own (worker.ts), so main never waits on the files. Settings › Backup shows the status
// and asks for what the user does; the folder and the file to restore come from main's dialogs.

import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { type BrowserWindow, dialog, powerMonitor, shell, utilityProcess } from 'electron'
import type { BackupProblem, BackupStatus, RestorePick } from '@shared/backup'
import { logEnvironment } from '@shared/log/process-log'
import type { BackupSettings } from '@shared/settings'
import { t } from '../i18n'
import { readJsonFile, JsonFileWriter } from '../json-file'
import { createLogger } from '../log'
import { BACKUP_EXTENSION, backupStamp, SAFETY_PREFIX } from './names'
import type { BackupReply, BackupRequest, InspectAnswer, RestoreAnswer } from './protocol'
import type { BackupDone } from './run'
import { isOwed, nextDue } from './schedule'
import { EMPTY_STATE, parseState, PickedBackups, STATE_FILE, type StateFile } from './state'
import workerPath from './worker?modulePath'

const log = createLogger('backup')

/** The folder in Documents an installed app backs up into until the user picks another. */
export const DEFAULT_FOLDER_NAME = 'Kite 备份'
/** How long after the app starts a missed backup waits, so the start has the computer first. */
const START_DELAY_MS = 5 * 60 * 1000
/** How long a backup waits while the agent host moves its data, before it looks again. */
const MIGRATION_RETRY_MS = 10 * 60 * 1000
/** The longest a scheduled backup waits for a migration to end. */
const MAX_MIGRATION_WAIT_MS = 24 * 60 * 60 * 1000
/** The longest the timer sleeps before it looks at the clock again, as after a clock change. */
const RECHECK_MS = 60 * 60 * 1000

class WorkerFailure extends Error {
  constructor(
    readonly problem: BackupProblem,
    message: string,
  ) {
    super(message)
    this.name = 'WorkerFailure'
  }
}

export interface BackupServiceDeps {
  dataDir: string
  documentsDir: string
  /** An installed app backs up into Documents; a development run beside its own data folder. */
  packaged: boolean
  appVersion: string
  settings(): BackupSettings
  /** Keeps a folder the user picked in the settings. */
  setFolder(folder: string): void
  /** The agent host is starting or moving its data to a new format. */
  migrating(): boolean
  changed(status: BackupStatus): void
  /** Stops the hosts, runs `step`, then starts the app again, asking first as quitting does. */
  restart(step: () => Promise<void>): void
}

export class BackupService {
  private state: StateFile = { ...EMPTY_STATE }
  private readonly writer: JsonFileWriter
  private timer: NodeJS.Timeout | null = null
  private next: number | null = null
  private running = false
  private progress: number | null = null
  private stored: BackupStatus['stored'] = null
  private readonly startedAt = Date.now()
  private readonly picks = new PickedBackups()
  private loaded: Promise<void> | null = null
  /** When the scheduled backup began to wait for a migration. */
  private waitingSince: number | null = null

  constructor(private readonly deps: BackupServiceDeps) {
    this.writer = new JsonFileWriter(join(deps.dataDir, STATE_FILE), log)
  }

  /** Reads the record, then keeps the schedule; a resume from sleep looks at the clock again. */
  start(): void {
    this.loaded ??= readJsonFile(join(this.deps.dataDir, STATE_FILE)).then((read) => {
      if (read.kind === 'ok') this.state = parseState(read.value)
      else if (read.kind === 'unreadable') log.warn(`${STATE_FILE} is unreadable: ${read.reason}`)
      this.schedule()
      void this.refreshStored()
    })
    powerMonitor.on('resume', () => this.schedule())
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  flush(): Promise<void> {
    return this.writer.flush()
  }

  /** The folder backups go to now. */
  folder(): string {
    return this.deps.settings().folder ?? this.defaultFolder()
  }

  private defaultFolder(): string {
    if (this.deps.packaged) return join(this.deps.documentsDir, DEFAULT_FOLDER_NAME)
    // A development run, or an agent's test copy, never writes into the owner's Documents.
    return join(dirname(this.deps.dataDir), `${basename(this.deps.dataDir)} backups`)
  }

  status(): BackupStatus {
    const settings = this.deps.settings()
    return {
      folder: this.folder(),
      defaultFolder: settings.folder === null,
      running: this.running,
      progress: this.progress,
      last: this.state.last,
      error: this.state.error,
      next: settings.enabled ? this.next : null,
      stored: this.stored,
      restore: this.state.restore,
    }
  }

  /** The settings changed: the time or the switch moves the next run, the folder its count. */
  settingsChanged(): void {
    this.schedule()
    void this.refreshStored()
  }

  private changed(): void {
    this.deps.changed(this.status())
  }

  private save(): void {
    this.writer.schedule(this.state)
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const { enabled, time } = this.deps.settings()
    if (!enabled) {
      this.next = null
      this.changed()
      return
    }
    const now = Date.now()
    if (isOwed(now, time, this.state.lastAttempt)) {
      const at = Math.max(now, this.startedAt + START_DELAY_MS)
      this.next = at
      this.timer = setTimeout(() => void this.due(), at - now)
    } else {
      const at = nextDue(now, time)
      this.next = at
      this.timer = setTimeout(() => this.schedule(), Math.min(at - now, RECHECK_MS))
    }
    this.timer.unref?.()
    this.changed()
  }

  /**
   * The scheduled run, held while the agent host moves its data. A move that never ends holds
   * it a day at most: the copy is consistent mid-move too, only larger.
   */
  private async due(): Promise<void> {
    this.timer = null
    if (this.running) return
    const now = Date.now()
    if (this.deps.migrating() && now - (this.waitingSince ?? now) < MAX_MIGRATION_WAIT_MS) {
      this.waitingSince ??= now
      log.info('A data migration is running; the backup waits')
      this.next = now + MIGRATION_RETRY_MS
      this.timer = setTimeout(() => void this.due(), MIGRATION_RETRY_MS)
      this.timer.unref?.()
      this.changed()
      return
    }
    if (this.waitingSince !== null && this.deps.migrating()) {
      log.warn('A data migration has run for a day; backing up anyway')
    }
    this.waitingSince = null
    await this.run()
    this.schedule()
  }

  /** Backup now: starts one unless one runs; while the host migrates, says so instead. */
  runNow(): BackupStatus {
    if (this.running) return this.status()
    if (this.deps.migrating()) {
      this.state.error = { at: Date.now(), problem: 'migrating', message: null }
      this.save()
      this.changed()
      return this.status()
    }
    void this.run().then(() => this.schedule())
    return this.status()
  }

  private async run(): Promise<void> {
    this.running = true
    this.progress = null
    this.changed()
    const settings = this.deps.settings()
    try {
      const done = (await this.work(
        {
          op: 'backup',
          job: {
            dataDir: this.deps.dataDir,
            destDir: this.folder(),
            createDest: settings.folder === null,
            keep: settings.keep,
            app: this.deps.appVersion,
            platform: process.platform,
          },
        },
        (done, total) => {
          this.progress = total > 0 ? done / total : null
          this.changed()
        },
      )) as BackupDone
      this.state.last = {
        at: Date.now(),
        file: done.file,
        bytes: done.bytes,
        files: done.files,
        durationMs: done.durationMs,
      }
      this.state.error = null
      this.state.restore = null
      log.info(`Backed up to ${done.file}`)
    } catch (error) {
      const problem = error instanceof WorkerFailure ? error.problem : 'failed'
      this.state.error = { at: Date.now(), problem, message: (error as Error).message }
      log.warn(`The backup failed (${problem}): ${(error as Error).message}`)
    } finally {
      this.state.lastAttempt = Date.now()
      this.running = false
      this.progress = null
      this.save()
      await this.refreshStored()
      this.changed()
    }
  }

  /** How many backups the folder holds and their bytes; null when it cannot be read. */
  private async refreshStored(): Promise<void> {
    const folder = this.folder()
    try {
      const names = await readdir(folder)
      let count = 0
      let bytes = 0
      for (const name of names) {
        if (!backupStamp(name) && !backupStamp(name, SAFETY_PREFIX)) continue
        try {
          bytes += (await stat(join(folder, name))).size
          count++
        } catch {
          // Removed while it was counted.
        }
      }
      this.stored = { count, bytes }
    } catch {
      this.stored = null
    }
    this.changed()
  }

  /** Runs one request in a utility process of its own, which ends once it answered. */
  private work(
    request: BackupRequest,
    progress?: (done: number, total: number) => void,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = utilityProcess.fork(workerPath, [], {
        serviceName: 'Kite Backup',
        stdio: 'ignore',
        env: { ...process.env, ...logEnvironment() },
      })
      let settled = false
      const finish = (settle: () => void): void => {
        if (settled) return
        settled = true
        settle()
        child.kill()
      }
      child.on('message', (reply: BackupReply) => {
        if (reply.type === 'progress') progress?.(reply.done, reply.total)
        else if (reply.type === 'result') finish(() => resolve(reply.value))
        else finish(() => reject(new WorkerFailure(reply.problem, reply.message)))
      })
      child.once('exit', (code) =>
        finish(() =>
          reject(new WorkerFailure('failed', `The backup process stopped with code ${code}`)),
        ),
      )
      child.postMessage(request)
    })
  }

  /** Choose folder…: the folder dialog, whose pick the settings keep. */
  async chooseFolder(window: BrowserWindow | null): Promise<BackupStatus> {
    const options: Electron.OpenDialogOptions = {
      title: t('dialogs.chooseBackupFolder'),
      defaultPath: this.folder(),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const picked = result.canceled ? null : (result.filePaths[0] ?? null)
    if (picked) this.deps.setFolder(picked)
    return this.status()
  }

  /** Opens the folder in the file manager; the default one is made first if it is not there. */
  async openFolder(): Promise<void> {
    const folder = this.folder()
    if (this.deps.settings().folder === null) await mkdir(folder, { recursive: true })
    const error = await shell.openPath(folder)
    if (error) throw new Error(error)
  }

  /** Restore from backup…: the file dialog, then a check of the backup's manifest. */
  async pickRestore(window: BrowserWindow | null): Promise<RestorePick> {
    const options: Electron.OpenDialogOptions = {
      title: t('dialogs.chooseBackup'),
      defaultPath: this.folder(),
      filters: [{ name: t('dialogs.backupFiles'), extensions: [BACKUP_EXTENSION.slice(1)] }],
      properties: ['openFile', 'dontAddToRecent'],
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const file = result.canceled ? null : (result.filePaths[0] ?? null)
    if (!file) return null
    return this.inspectPicked(file)
  }

  /** The manifest's summary of a file the dialog picked, and the token that names it. */
  private async inspectPicked(file: string): Promise<RestorePick> {
    let answer: InspectAnswer
    try {
      answer = (await this.work({ op: 'inspect', file })) as InspectAnswer
    } catch (error) {
      return { kind: 'invalid', message: (error as Error).message }
    }
    return {
      kind: 'ok',
      candidate: {
        token: this.picks.add(file, Date.now()),
        file: basename(file),
        created: Date.parse(answer.created),
        app: answer.app,
        files: answer.files,
        bytes: answer.bytes,
      },
    }
  }

  /**
   * Restores the picked backup: the app stops its hosts as a restart does, asking first while
   * agents work, restores, and starts again; the next start says how it went.
   */
  restore(token: unknown): void {
    if (this.running) throw new Error('A backup is running; restore once it is done')
    const file = this.picks.take(token, Date.now())
    const name = basename(file)
    this.deps.restart(async () => {
      this.stop()
      const settings = this.deps.settings()
      try {
        const done = (await this.work({
          op: 'restore',
          job: {
            file,
            dataDir: this.deps.dataDir,
            safety: {
              destDir: this.folder(),
              createDest: settings.folder === null,
              app: this.deps.appVersion,
              platform: process.platform,
            },
          },
        })) as RestoreAnswer
        this.state.restore = {
          at: Date.now(),
          ok: true,
          from: name,
          safety: done.safety,
          message: null,
        }
        log.info(`Restored ${done.files} files from ${name}; the data before is in ${done.safety}`)
      } catch (error) {
        const message = (error as Error).message
        this.state.restore = { at: Date.now(), ok: false, from: name, safety: null, message }
        log.error(`The restore from ${name} failed: ${message}`)
        await dialog.showMessageBox({
          type: 'error',
          message: t('backup.restoreFailed'),
          detail: message,
          buttons: [t('backup.restartAnyway')],
          noLink: true,
        })
      }
      this.save()
      await this.writer.flush()
    })
  }
}
