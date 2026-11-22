// Huli: keeps one platform's connection up: connects, waits for it to end, waits a growing while,
// and connects again, until stopped. Credentials the platform refused end the loop, since every
// try would fail alike; saving new ones starts the bridge again.

import type { ChatBridgeProblem } from '@shared/chat-bridge'
import { NetError, describe } from './net'
import { Backoff, RateLimited } from './pacing'
import { CredentialsRejected, type AdapterEvents } from './types'

/** A connection that stayed up this long was fine; the next drop waits the shortest time again. */
const STABLE_MS = 60_000

/** A refusal of the platform's that says what went wrong, which trying again does not mend. */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly problem: ChatBridgeProblem = 'rejected',
  ) {
    super(message)
    this.name = 'PlatformError'
  }
}

export class Lifeline {
  private stopped = true
  private wake: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly backoff = new Backoff()
  private abort: AbortController | null = null

  constructor(
    /** One connection: resolves when it ends, rejects when it could not be made or failed. */
    private readonly session: (signal: AbortSignal) => Promise<void>,
    private readonly events: AdapterEvents,
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.wake?.()
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.events.status('connecting')
      const abort = new AbortController()
      this.abort = abort
      const began = Date.now()
      let wait: number | null = null
      try {
        await this.session(abort.signal)
        if (this.stopped) return
        this.events.status('connecting', 'network', 'The connection closed')
      } catch (error) {
        if (this.stopped) return
        if (error instanceof CredentialsRejected) {
          this.events.status('error', 'credentials', describe(error))
          this.stopped = true
          return
        }
        if (error instanceof PlatformError && error.problem !== 'network') {
          this.events.status('error', error.problem, describe(error))
        } else {
          this.events.status('error', 'network', describe(error))
        }
        if (error instanceof RateLimited) wait = error.retryAfterMs
        if (!(error instanceof NetError) && !(error instanceof PlatformError)) {
          this.events.log('warn', `The connection failed: ${describe(error)}`)
        }
      } finally {
        abort.abort()
        this.abort = null
      }
      if (Date.now() - began > STABLE_MS) this.backoff.reset()
      await this.sleep(wait ?? this.backoff.next())
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null
        resolve()
      }
      this.timer = setTimeout(() => {
        this.timer = null
        this.wake?.()
      }, ms)
    })
  }
}

/** Resolves when the signal aborts. */
export function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
