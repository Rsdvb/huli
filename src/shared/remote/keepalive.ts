// Keeping a connection's channel alive, from protocol version 3: a side that has heard nothing for
// a while asks with `ping`, the other answers `pong`, and silence after a ping ends the connection,
// which then drops as any other does. Both belong to the connection, not to the device session, so
// neither is counted, kept for resuming or acknowledged.
//
// A ping goes on the channel after whatever the side sent before it, and the other side can read
// it, or answer it, only once all of that has arrived: on a slow connection a large message takes
// longer than any answer's wait. So a ping's wait starts once it has left, and while what was sent
// before it is still leaving the connection counts as alive; anything at all from the other side
// answers a ping, and a side also pings when it has written nothing for a while, so the other side
// hears it while it only listens. None of this changes what goes on the wire.

/** The first version whose sides answer `ping` with `pong`. */
export const KEEPALIVE_VERSION = 3

/** Asks the other side to answer, after a quiet spell. */
export interface Ping {
  type: 'ping'
}

/** The answer to a ping. */
export interface Pong {
  type: 'pong'
}

export interface KeepaliveTimings {
  /** How long a side hears nothing before it pings. */
  quietMs: number
  /** How long it then waits for anything, once the ping left, before it gives the connection up. */
  answerMs: number
  /**
   * How long a ping still behind what its side sent before may see none of that leave before the
   * connection is given up; and how long it waits for an answer once it left behind a backlog,
   * which the network on the way may still hold ahead of it. STALL_MS when absent.
   */
  stallMs?: number
  /** The longest a ping waits for anything at all, however its sending goes. LIMIT_MS when absent. */
  limitMs?: number
}

/**
 * A device pings first, so on an idle connection one ping about every 10 s, and its answer, are all
 * that moves; the host pings only when its device has gone quiet longer.
 */
export const DEVICE_KEEPALIVE: KeepaliveTimings = { quietMs: 10_000, answerMs: 5_000 }
export const HOST_KEEPALIVE: KeepaliveTimings = { quietMs: 15_000, answerMs: 5_000 }

/** A link through a proxy carries a few MB a second, or less; a backlog leaves within this. */
export const STALL_MS = 15_000
export const LIMIT_MS = 60_000

/** Bytes waiting on the transport when a ping is written, past which it waits behind a backlog. */
const BACKLOG_BYTES = 16 * 1024
/** How often a ping behind a backlog looks whether that still leaves, at most. */
const STEP_MS = 1_000
/**
 * How late a check may run before it looks once more before giving up: a process that was busy or
 * asleep runs its timers before it reads what came meanwhile.
 */
const LATE_MS = 1_000
const GRACE_MS = 1_000

/** Whether `value` is a ping or a pong, which only the connection reads. */
export function keepaliveMessage(value: unknown): 'ping' | 'pong' | null {
  const type = (value as { type?: unknown } | null)?.type
  return type === 'ping' || type === 'pong' ? type : null
}

/** What a connection tells its keepalive of each transport message as it passes. */
export interface TrafficWatcher {
  /** A transport message came from the other side, before it is read. */
  heard(): void
  /** A transport message of `bytes` was handed to the transport. */
  wrote(bytes: number): void
}

export interface KeepaliveOptions extends KeepaliveTimings {
  /**
   * Sends a ping; a promise it returns settles once the ping was handed to the transport. `timed`
   * is false for one that went while the other side was sending, whose answer may wait behind
   * what it sends, so its round trip says nothing of the route.
   */
  ping(timed: boolean): Promise<unknown> | void
  /** Nothing came within `answerMs` of a ping: the connection is to be ended. */
  silent(): void
  /** The bytes handed to the transport that have not left yet, as `Transport.buffered` says. */
  buffered?: () => number
  /**
   * Pings also once nothing was written for `quietMs`, so a side that waits longer than this one
   * does, as an older host, hears it while it only listens to a long message.
   */
  speak?: boolean
  now?: () => number
}

/** The ping waiting for an answer. */
interface Out {
  /** When it was asked to go. */
  at: number
  /** The bytes written up to its end, once it was handed to the transport. */
  mark: number | null
  /** When it was seen to have left, from which its answer is waited for. */
  leftAt: number | null
  /** Whether it was written behind a backlog. */
  behind: boolean
  /** The bytes seen to have left at the last look, and when that last grew. */
  gone: number
  goneAt: number
  /** Whether a check that ran late gave it one more look. */
  graced: boolean
}

/**
 * Watches one connection. Hearing something only notes the time, so a busy connection costs no
 * timer; the one timer checks what was heard since the ping, and a check that runs late, as in a
 * background tab or after a busy spell, looks once more before it ends a connection, so what came
 * meanwhile is read first.
 */
export class Keepalive implements TrafficWatcher {
  private heardAt: number
  private wroteAt: number
  private written = 0
  private out: Out | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private dueAt = 0
  private stopped = false
  private readonly stallMs: number
  private readonly limitMs: number

  constructor(private readonly options: KeepaliveOptions) {
    this.heardAt = this.now()
    this.wroteAt = this.heardAt
    this.stallMs = options.stallMs ?? Math.max(STALL_MS, options.answerMs)
    this.limitMs = options.limitMs ?? Math.max(LIMIT_MS, this.stallMs + options.answerMs)
    this.schedule(options.quietMs)
  }

  /** Something came from the other side. */
  heard(): void {
    this.heardAt = this.now()
  }

  /** This side handed `bytes` to the transport. */
  wrote(bytes: number): void {
    this.written += bytes
    this.wroteAt = this.now()
  }

  /**
   * Pings now unless a ping is out, as after the network changed under the connection; silence
   * then ends it as after any ping.
   */
  pingNow(): void {
    if (this.stopped || this.out !== null) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.sendPing(true)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** What the transport holds that has not left; a carrier that cannot tell holds nothing. */
  private buffered(): number {
    const bytes = this.options.buffered?.() ?? 0
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  }

  /** The bytes that have left so far, as far as the transport tells. */
  private gone(): number {
    return this.written - this.buffered()
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    const delay = Math.max(0, ms)
    this.dueAt = this.now() + delay
    this.timer = setTimeout(() => this.check(), delay)
  }

  private sendPing(timed: boolean): void {
    const at = this.now()
    const out: Out = {
      at,
      mark: null,
      leftAt: null,
      behind: false,
      gone: this.gone(),
      goneAt: at,
      graced: false,
    }
    this.out = out
    const sent = this.options.ping(timed) as Promise<unknown> | undefined
    // A send that failed ends the connection anyway.
    const placed = (): void => this.placed(out)
    if (sent) sent.then(placed, placed)
    else placed()
    this.schedule(this.options.answerMs)
  }

  /** The ping was handed to the transport: it has left once everything written so far has. */
  private placed(out: Out): void {
    if (this.out !== out || this.stopped) return
    out.mark = this.written
    if (this.buffered() > BACKLOG_BYTES) out.behind = true
    else out.leftAt = this.now()
  }

  private check(): void {
    this.timer = null
    if (this.stopped) return
    const now = this.now()
    const late = now - this.dueAt > LATE_MS
    const out = this.out
    if (out) {
      if (this.heardAt >= out.at) this.out = null
      else return this.awaitAnswer(out, now, late)
    }
    const { quietMs } = this.options
    const unheard = now - this.heardAt
    const quiet = Math.max(unheard, this.options.speak ? now - this.wroteAt : 0)
    if (quiet >= quietMs) return this.sendPing(unheard >= quietMs)
    this.schedule(quietMs - quiet)
  }

  private awaitAnswer(out: Out, now: number, late: boolean): void {
    const { answerMs } = this.options
    const limit = out.at + this.limitMs
    if (now >= limit) return this.giveUp(out, late)
    if (out.leftAt === null && out.mark !== null && this.gone() >= out.mark) out.leftAt = now
    if (out.leftAt === null) {
      // Behind what was sent before it: the connection is alive while that leaves.
      const gone = this.gone()
      if (gone > out.gone) {
        out.gone = gone
        out.goneAt = now
      }
      const stalled = out.goneAt + this.stallMs
      if (now >= stalled) return this.giveUp(out, late)
      const step = Math.min(answerMs, STEP_MS)
      return this.schedule(Math.min(stalled, limit, now + step) - now)
    }
    const answered = Math.min(
      limit,
      out.leftAt + (out.behind ? Math.max(answerMs, this.stallMs) : answerMs),
    )
    if (now >= answered) return this.giveUp(out, late)
    this.schedule(answered - now)
  }

  private giveUp(out: Out, late: boolean): void {
    if (late && !out.graced) {
      out.graced = true
      return this.schedule(Math.min(this.options.answerMs, GRACE_MS))
    }
    this.options.silent()
  }
}
