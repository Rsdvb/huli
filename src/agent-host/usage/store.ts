// The host's side of the usage database: a promise API over the usage worker.

import type { Worker } from 'node:worker_threads'
import type { AgentId } from '@shared/thread'
import type { ClockRequest, ScanProgress, TokenParts } from '@shared/usage'
import { t } from '../i18n'
import type { LogFn } from '../storage'
import type { DbSummary, SourceMap, SourceStats, UsageDbStatus } from './db'
import type { UsageRow } from './model'
import type { ScanRequest, UsageReply, UsageRequest } from './protocol'
import type { ScanOutcome } from './service'

/** What the store needs of a worker, so tests can run the service in their own thread. */
export interface UsageWorker {
  postMessage(request: UsageRequest): void
  onMessage(listener: (reply: UsageReply) => void): void
  /** Called once when the worker stops, with the error that stopped it, if any. */
  onExit(listener: (error: Error | null) => void): void
  terminate(): Promise<unknown>
}

export type UsageWorkerFactory = (file: string) => UsageWorker

export function nodeUsageWorker(worker: Worker): UsageWorker {
  return {
    postMessage: (request) => worker.postMessage(request),
    onMessage: (listener) => worker.on('message', listener),
    onExit: (listener) => {
      let failure: Error | null = null
      worker.on('error', (error) => {
        failure = error
      })
      worker.on('exit', (code) =>
        listener(
          failure ??
            (code === 0 ? null : new Error(t('git.failure.exitCode', { code: String(code) }))),
        ),
      )
    },
    terminate: () => worker.terminate(),
  }
}

export interface UsageStoreOptions {
  file: string
  createWorker: UsageWorkerFactory
  log: LogFn
  onChanged(): void
  onProgress(progress: ScanProgress | null): void
  /** How the database opened after the worker restarted, or `unavailable` once it stays stopped. */
  onStatus(status: UsageDbStatus): void
  /** How long closing waits for the worker to fold the WAL before stopping it. */
  closeTimeoutMs?: number
  /** How long the worker may go without a request before it stops; the next one starts another. */
  idleMs?: number
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/** How many times a worker that stopped on its own is started again. */
const RESTARTS = 2
/**
 * A worker thread holds 15-20 MB however little it does, and the database is used in bursts: at
 * launch, at the end of a turn, while the usage page is open and for each scan.
 */
const IDLE_MS = 60_000
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

/** Why a worker started: the store's first, after one crashed, or after one went unused. */
type StartReason = 'first' | 'crash' | 'idle'

interface Live {
  worker: UsageWorker
  /** Stopped by the store for going unused, so its exit is no failure. */
  retired: boolean
}

export class UsageStore {
  /** How the database opened; `unavailable` when the worker never got that far. */
  readonly ready: Promise<UsageDbStatus>
  private settleReady: (status: UsageDbStatus) => void = () => {}
  /** The worker requests go to; null while none runs, after it went unused. */
  private live: Live | null
  private restarts = 0
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private stopped: string | null = null
  private closing: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** Workers stopping since they went unused, which closing waits for. */
  private readonly retiring = new Set<Promise<void>>()

  constructor(private readonly options: UsageStoreOptions) {
    this.ready = new Promise((resolve) => {
      this.settleReady = resolve
    })
    this.live = this.startWorker('first')
  }

  private startWorker(reason: StartReason): Live {
    const { options } = this
    const worker = options.createWorker(options.file)
    const live: Live = { worker, retired: false }
    worker.onMessage((reply) => {
      switch (reply.type) {
        case 'ready':
          // After a crash the manager reads its figures again; after a worker went unused only
          // a database that no longer opens is news.
          if (reason === 'crash' || (reason === 'idle' && !opens(reply.status))) {
            options.onStatus(reply.status)
          }
          this.settleReady(reply.status)
          break
        case 'log':
          options.log(reply.level, `Usage: ${reply.message}`)
          break
        case 'progress':
          options.onProgress(reply.progress)
          break
        case 'changed':
          options.onChanged()
          break
        case 'result':
          this.settle(reply.id)?.resolve(reply.value)
          break
        case 'error':
          this.settle(reply.id)?.reject(new Error(reply.message))
          break
      }
    })
    worker.onExit((error) => {
      if (this.closing) {
        this.settleReady('unavailable')
        return
      }
      if (live.retired || live !== this.live) return
      const reason = error
        ? t('usage.workerStoppedWith', { error: error.message })
        : t('usage.workerStopped')
      // What it was doing is lost; the next scan reads from the cursors it committed.
      this.failPending(reason)
      options.onProgress(null)
      if (this.restarts < RESTARTS) {
        this.restarts++
        options.log('warn', `${reason}; starting it again`)
        this.live = this.startWorker('crash')
        return
      }
      options.log('error', reason)
      this.live = null
      this.stop(reason)
      this.settleReady('unavailable')
      options.onStatus('unavailable')
    })
    return live
  }

  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id)
    this.pending.delete(id)
    if (this.pending.size === 0) this.armIdle()
    return pending
  }

  /** Stops the worker once it has gone `idleMs` without a request. */
  private armIdle(): void {
    if (!this.live || this.stopped || this.closing) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.retire()
    }, this.options.idleMs ?? IDLE_MS)
    this.idleTimer.unref?.()
  }

  private retire(): void {
    const live = this.live
    if (!live || this.pending.size > 0 || this.stopped || this.closing) return
    live.retired = true
    this.live = null
    const done: Promise<void> = this.closeWorker(live).finally(() => this.retiring.delete(done))
    this.retiring.add(done)
  }

  /** Folds the WAL into the file, waiting at most `closeTimeoutMs`, and stops the worker. */
  private async closeWorker(live: Live): Promise<void> {
    const id = this.nextId++
    const closed = new Promise<'closed'>((resolve) => {
      const done = (): void => resolve('closed')
      this.pending.set(id, { resolve: done, reject: done })
    })
    live.worker.postMessage({ op: 'close', id })
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.options.closeTimeoutMs ?? 2_000)
    })
    const outcome = await Promise.race([closed, timeout])
    if (timer) clearTimeout(timer)
    if (outcome === 'timeout') {
      this.pending.delete(id)
      if (this.pending.size === 0) this.armIdle()
      this.options.log('warn', 'The usage database did not close in time; stopping its worker')
    }
    await live.worker.terminate()
  }

  private stop(reason: string): void {
    this.stopped = reason
    this.failPending(reason)
  }

  private failPending(reason: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(reason))
    this.pending.clear()
  }

  private request<T>(request: WithoutId<UsageRequest>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error(this.stopped))
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const live = (this.live ??= this.startWorker('idle'))
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    })
    live.worker.postMessage({ ...request, id } as UsageRequest)
    return promise
  }

  write(rows: UsageRow[]): Promise<number> {
    return this.request({ op: 'write', rows })
  }

  summary(
    dayStarts: number[],
    from: number,
    to: number,
    sources: SourceMap,
    clock?: ClockRequest,
  ): Promise<DbSummary> {
    return this.request({ op: 'summary', dayStarts, from, to, sources, clock })
  }

  totals(
    from: number,
    to: number,
    sources: SourceMap,
  ): Promise<(TokenParts & { agentId: AgentId })[]> {
    return this.request({ op: 'totals', from, to, sources })
  }

  stats(): Promise<SourceStats[]> {
    return this.request({ op: 'stats' })
  }

  /** Reads what is new in the agents' logs; waits for a scan already running. */
  scan(request: ScanRequest): Promise<ScanOutcome> {
    return this.request({ op: 'scan', ...request })
  }

  /** Stops the scan in progress, which then resolves as cancelled. */
  cancel(): Promise<void> {
    // A worker that stopped for going unused was running no scan.
    if (!this.live) return Promise.resolve()
    return this.request({ op: 'cancel' })
  }

  removeLogs(agentId: AgentId): Promise<void> {
    return this.request({ op: 'removeLogs', agentId })
  }

  clearRecord(): Promise<void> {
    return this.request({ op: 'clearRecord' })
  }

  /** Stops any scan, folds the WAL into the file and stops the worker. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = null
      const live = this.live
      if (live && !this.stopped) {
        const closed = this.request<null>({ op: 'close' }).catch((error: unknown) => {
          this.options.log('warn', `Closing the usage database failed: ${(error as Error).message}`)
        })
        let timer: ReturnType<typeof setTimeout> | null = null
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.options.closeTimeoutMs ?? 2_000)
        })
        const outcome = await Promise.race([closed, timeout])
        if (timer) clearTimeout(timer)
        if (outcome === 'timeout') {
          this.options.log('warn', 'The usage database did not close in time; stopping its worker')
        }
      }
      this.stop('The usage store is closed')
      await Promise.all([live?.worker.terminate(), ...this.retiring])
    })()
    return this.closing
  }
}

const opens = (status: UsageDbStatus): boolean => status !== 'unavailable' && status !== 'newer'
