// Huli: how fast a chat bridge writes, within each platform's published limits, and how it waits
// to connect again after a drop. A timer runs only while a message waits for its turn or a
// reconnect is due; an idle bridge has none. See tools/huli/README.md (Chat apps).

/** A platform's limits on the bot's messages. */
export interface PaceRules {
  /** The least time between two messages to one chat. */
  chatGapMs: number
  /** The most messages to one chat in a minute; 0 for no such limit. */
  chatPerMinute: number
  /** The least time between any two messages of the bot. */
  gapMs: number
}

/** The platform said to wait before sending again, as Telegram's 429 does. */
export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Rate limited for ${Math.round(retryAfterMs / 1000)} s`)
    this.name = 'RateLimited'
  }
}

/** How many times one message is tried after the platform said to wait. */
const RATE_LIMIT_TRIES = 3
/** The longest wait a platform's answer may impose before the message is given up. */
const MAX_RETRY_AFTER_MS = 5 * 60_000
/** How many messages may wait; past it the oldest are dropped, a flood the chat could not read. */
const MAX_WAITING = 200

interface Item {
  chat: string
  task: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  tries: number
}

export interface Clock {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
}

/** Sends one message at a time, in order, each when the rules allow it. */
export class Pacer {
  private readonly queue: Item[] = []
  private readonly sentTo = new Map<string, number[]>()
  private lastSent = Number.NEGATIVE_INFINITY
  private pausedUntil = 0
  private timer: unknown = null
  private running = false
  private stopped = false

  constructor(
    private readonly rules: PaceRules,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  /** Runs `task`, which sends one message to `chat`, once its turn comes. */
  send<T>(chat: string, task: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('The bridge stopped'))
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        chat,
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
        tries: 0,
      })
      while (this.queue.length > MAX_WAITING) {
        this.queue.shift()!.reject(new Error('Too many messages waiting'))
      }
      this.pump()
    })
  }

  /** Drops what waits, as when the bridge stops. */
  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    for (const item of this.queue.splice(0)) item.reject(new Error('The bridge stopped'))
  }

  /** When the next message may go to `chat`, by the rules and the messages sent so far. */
  private readyAt(chat: string, now: number): number {
    let at = Math.max(this.pausedUntil, this.lastSent + this.rules.gapMs)
    const sent = (this.sentTo.get(chat) ?? []).filter((time) => time > now - 60_000)
    this.sentTo.set(chat, sent)
    const last = sent.at(-1)
    if (last !== undefined) at = Math.max(at, last + this.rules.chatGapMs)
    if (this.rules.chatPerMinute > 0 && sent.length >= this.rules.chatPerMinute) {
      at = Math.max(at, sent[sent.length - this.rules.chatPerMinute]! + 60_000)
    }
    return at
  }

  private pump(): void {
    if (this.running || this.timer !== null || this.stopped) return
    const item = this.queue[0]
    if (!item) {
      for (const [chat, sent] of this.sentTo) {
        if (sent.every((time) => time <= this.clock.now() - 60_000)) this.sentTo.delete(chat)
      }
      return
    }
    const now = this.clock.now()
    const at = this.readyAt(item.chat, now)
    if (at > now) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null
        this.pump()
      }, at - now)
      return
    }
    this.queue.shift()
    this.running = true
    const sentAt = now
    this.lastSent = sentAt
    this.sentTo.get(item.chat)!.push(sentAt)
    item.tries++
    void item.task().then(
      (value) => {
        this.running = false
        item.resolve(value)
        this.pump()
      },
      (error: unknown) => {
        this.running = false
        if (
          error instanceof RateLimited &&
          item.tries < RATE_LIMIT_TRIES &&
          error.retryAfterMs <= MAX_RETRY_AFTER_MS &&
          !this.stopped
        ) {
          this.pausedUntil = this.clock.now() + error.retryAfterMs
          this.queue.unshift(item)
        } else item.reject(error)
        this.pump()
      },
    )
  }
}

/** Waits that grow from a second to five minutes, each a little shorter or longer at random. */
export class Backoff {
  private attempt = 0

  constructor(
    private readonly baseMs = 1_000,
    private readonly maxMs = 5 * 60_000,
    private readonly random: () => number = Math.random,
  ) {}

  next(): number {
    const plain = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 30)
    return Math.round(plain * (0.8 + 0.4 * this.random()))
  }

  reset(): void {
    this.attempt = 0
  }
}
