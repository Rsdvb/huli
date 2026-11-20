// The thread worker's low-priority care of the media: moving the bytes of version 9 out of the
// database into files, giving the space back, and sweeping away the bytes nothing names. Each step
// is short and runs only when no request came in a moment before, so the requests the worker
// answers never wait long behind it.

import { statSync } from 'node:fs'
import type { ThreadDb } from './db'

export interface UpkeepOptions {
  /** How long after the start the first step waits, so the first pages are read first. */
  startMs?: number
  /** How long the worker must have been free of requests before a step. */
  quietMs?: number
  /** The rest between steps. */
  restMs?: number
  /** How often the whole sweep runs again. */
  sweepEveryMs?: number
  /** A thread written more recently than this is left to its session. */
  settledMs?: number
  /** The rows and bytes one step of the move takes at most. */
  batchRows?: number
  batchBytes?: number
  /** The free pages one step gives back. */
  shrinkPages?: number
}

// A step of 1 MB took 30 ms on average and 270 ms at most on a copy of a 330 MB database, each
// file being flushed to disk; a shrink of 256 pages 33 ms at most.
const DEFAULTS: Required<UpkeepOptions> = {
  startMs: 10_000,
  quietMs: 250,
  restMs: 20,
  sweepEveryMs: 6 * 60 * 60 * 1000,
  settledMs: 24 * 60 * 60 * 1000,
  batchRows: 8,
  batchBytes: 1024 * 1024,
  shrinkPages: 256,
}

type Log = (level: 'info' | 'warn' | 'error', message: string) => void

type Step = () => Step | null

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

function fileSize(file: string): number {
  let size = 0
  for (const suffix of ['', '-wal']) {
    try {
      size += statSync(file + suffix).size
    } catch {
      // No WAL.
    }
  }
  return size
}

export class MediaUpkeep {
  private readonly options: Required<UpkeepOptions>
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastRequest = 0
  private stopped = false
  private next: Step | null = null
  /** A round of steps is queued or under way, as against the wait for the next sweep. */
  private pending = false
  /** Waiting for the round under way to end, for tests. */
  private idle: (() => void)[] = []

  constructor(
    private readonly db: ThreadDb,
    private readonly file: string,
    private readonly log: Log,
    private readonly now: () => number,
    options: UpkeepOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
  }

  start(): void {
    this.pending = true
    this.queue(() => this.moveStep(), this.options.startMs)
  }

  /** Called with each request, which the next step waits behind. */
  requested(): void {
    this.lastRequest = Date.now()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.next = null
    for (const done of this.idle.splice(0)) done()
  }

  /** Settles once the round under way ends, for tests. */
  settled(): Promise<void> {
    if (!this.pending || this.stopped) return Promise.resolve()
    return new Promise((resolve) => this.idle.push(resolve))
  }

  private queue(step: Step, delay = this.options.restMs): void {
    if (this.stopped) return
    this.next = step
    this.timer = setTimeout(() => this.tick(), delay)
    this.timer.unref?.()
  }

  private tick(): void {
    this.timer = null
    const step = this.next
    if (!step || this.stopped) return
    const quiet = this.options.quietMs - (Date.now() - this.lastRequest)
    if (quiet > 0) {
      this.queue(step, quiet)
      return
    }
    let following: Step | null
    try {
      following = step()
    } catch (error) {
      this.log('warn', `Media upkeep stopped this round: ${(error as Error).message}`)
      following = null
    }
    if (following) {
      this.queue(following)
      return
    }
    this.next = null
    this.pending = false
    for (const done of this.idle.splice(0)) done()
    this.queue(() => {
      this.pending = true
      return this.moveStep()
    }, this.options.sweepEveryMs)
  }

  // The move out of version 9's table, then the shrink.

  private moved = { rows: 0, bytes: 0, size: 0 }

  private moveStep(): Step | null {
    const left = this.db.legacyLeft()
    if (left.rows === 0) {
      if (this.moved.rows === 0) return this.sweepStart()
      return () => this.shrinkStep()
    }
    if (this.moved.rows === 0) {
      this.moved.size = fileSize(this.file)
      this.log(
        'info',
        `Moving ${left.rows} media (${mb(left.bytes)} MB) out of the thread database into files`,
      )
    }
    const { rows, bytes } = this.db.moveLegacy(this.options.batchRows, this.options.batchBytes)
    this.moved.rows += rows
    this.moved.bytes += bytes
    if (rows === 0) return null
    return () => this.moveStep()
  }

  private shrinkStep(): Step | null {
    const free = this.db.shrink(this.options.shrinkPages)
    if (free > 0) return () => this.shrinkStep()
    return () => this.foldStep(0)
  }

  /** Folds the WAL into the file, which cuts it to its pages; after the move, the sweep follows. */
  private foldStep(attempt: number): Step | null {
    if (!this.db.checkpoint() && attempt < 20) return () => this.foldStep(attempt + 1)
    if (this.moved.rows === 0) return null
    this.log(
      'info',
      `Moved ${this.moved.rows} media (${mb(this.moved.bytes)} MB) into files; the thread database went from ${mb(this.moved.size)} to ${mb(fileSize(this.file))} MB`,
    )
    this.moved = { rows: 0, bytes: 0, size: 0 }
    return this.sweepStart()
  }

  // The sweep: each settled thread's names, then the files.

  private sweepStart(): Step | null {
    const sessions = this.db.settledThreads(this.now() - this.options.settledMs)
    let pruned = 0
    const prune = (i: number): Step | null => {
      if (i >= sessions.length) return () => this.sweepFiles(pruned)
      pruned += this.db.pruneMedia(sessions[i]!)
      return () => prune(i + 1)
    }
    return () => prune(0)
  }

  private sweepFiles(pruned: number): Step | null {
    const { files, bytes } = this.db.sweepMedia()
    if (pruned > 0 || files > 0) {
      this.log(
        'info',
        `Media sweep: ${pruned} names no entry used, ${files} files (${mb(bytes)} MB) no thread named`,
      )
    }
    return this.db.shrink(this.options.shrinkPages) > 0 ? () => this.shrinkStep() : null
  }
}
