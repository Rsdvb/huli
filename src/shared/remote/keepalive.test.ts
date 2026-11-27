// The keepalive's clock: when it pings, how long a ping waits for an answer once it left, behind
// what its side sent before, and when a connection is given up.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Keepalive, type KeepaliveTimings } from './keepalive'

const TIMINGS: KeepaliveTimings = {
  quietMs: 10_000,
  answerMs: 5_000,
  stallMs: 15_000,
  limitMs: 60_000,
}
/** A ping's transport message: a 256-byte frame and its tag. */
const PING = 272

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * A connection's keepalive over a transport whose `buffered` the test sets; each ping is written
 * as a channel writes it, a moment after it is asked for, or once `hold` lets it.
 */
function watched(options: { speak?: boolean; hold?: boolean } = {}) {
  const t = {
    buffered: 0,
    pings: 0,
    /** Whether each ping's round trip times the route. */
    timed: [] as boolean[],
    silent: false,
    held: [] as (() => void)[],
  }
  const keepalive: Keepalive = new Keepalive({
    ...TIMINGS,
    ...(options.speak ? { speak: true } : {}),
    ping: (timed) => {
      t.pings++
      t.timed.push(timed)
      return new Promise<void>((resolve) => {
        const write = (): void => {
          keepalive.wrote(PING)
          t.buffered += PING
          resolve()
        }
        if (options.hold) t.held.push(write)
        else queueMicrotask(write)
      })
    },
    silent: () => (t.silent = true),
    buffered: () => t.buffered,
    now: () => Date.now(),
  })
  /** Sends `bytes` the other side will take long to read. */
  const send = (bytes: number): void => {
    keepalive.wrote(bytes)
    t.buffered += bytes
  }
  /** `bytes` of what waited leave every `everyMs` for `forMs`. */
  const drain = async (bytes: number, everyMs: number, forMs: number): Promise<void> => {
    for (let spent = 0; spent < forMs; spent += everyMs) {
      await vi.advanceTimersByTimeAsync(everyMs)
      t.buffered = Math.max(0, t.buffered - bytes)
    }
  }
  return Object.assign(t, { keepalive, send, drain })
}

describe('a keepalive on an idle connection', () => {
  it('pings after a quiet spell and gives up a connection that stays silent', async () => {
    const t = watched()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(t.pings).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.pings).toBe(1)
    expect(t.timed).toEqual([true])
    // The ping left at once; the transport drains it.
    t.buffered = 0
    await vi.advanceTimersByTimeAsync(4_999)
    expect(t.silent).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.silent).toBe(true)
  })

  it('keeps a connection that answers, and pings again after the next quiet spell', async () => {
    const t = watched()
    await vi.advanceTimersByTimeAsync(10_000)
    t.buffered = 0
    await vi.advanceTimersByTimeAsync(300)
    t.keepalive.heard()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(t.pings).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.pings).toBe(2)
    expect(t.silent).toBe(false)
  })

  it('looks once more before giving up when its check ran late, as after a busy spell', async () => {
    const t = watched()
    await vi.advanceTimersByTimeAsync(10_000)
    t.buffered = 0
    // The process was busy: the clock went on past the answer's wait without the timer firing.
    vi.setSystemTime(Date.now() + 8_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.silent).toBe(false)
    // What came meanwhile is read before the second look.
    t.keepalive.heard()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.silent).toBe(false)
  })
})

describe('a keepalive behind its own large send', () => {
  it('waits while what went before its ping leaves, then for the answer', async () => {
    const t = watched()
    t.send(8 * 1024 * 1024)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.pings).toBe(1)
    // 8 MiB at 200 KiB a second: 41 s before the ping leaves, eight times its wait.
    await t.drain(100 * 1024, 500, 42_000)
    expect(t.silent).toBe(false)
    expect(t.buffered).toBe(0)
    // The network on the way may hold more ahead of the ping: it waits longer than its wait.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.silent).toBe(false)
    // The answer came: the next ping waits for the next quiet spell.
    t.keepalive.heard()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(t.silent).toBe(false)
    expect(t.pings).toBe(1)
  })

  it('gives up once nothing of what went before its ping leaves for the stall', async () => {
    const t = watched()
    t.send(8 * 1024 * 1024)
    await vi.advanceTimersByTimeAsync(10_000)
    await t.drain(100 * 1024, 500, 5_000)
    expect(t.silent).toBe(false)
    // The network went: nothing more leaves.
    await vi.advanceTimersByTimeAsync(14_000)
    expect(t.silent).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.silent).toBe(true)
  })

  it('gives up after the limit with nothing heard, however its sending goes', async () => {
    const t = watched()
    t.send(64 * 1024 * 1024)
    await vi.advanceTimersByTimeAsync(10_000)
    await t.drain(100 * 1024, 500, 59_000)
    expect(t.silent).toBe(false)
    await t.drain(100 * 1024, 500, 2_000)
    expect(t.silent).toBe(true)
  })

  it('counts its wait from when the channel handed its ping on', async () => {
    const t = watched({ hold: true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.pings).toBe(1)
    // The channel is still busy with a message before the ping, which leaves meanwhile.
    for (let spent = 0; spent < 8_000; spent += 500) {
      t.send(50 * 1024)
      await vi.advanceTimersByTimeAsync(500)
      t.buffered = 0
    }
    expect(t.silent).toBe(false)
    t.held.shift()!()
    t.buffered = 0
    await vi.advanceTimersByTimeAsync(4_900)
    expect(t.silent).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.silent).toBe(true)
  })
})

describe('a keepalive while a long message comes in', () => {
  it('stays quiet while it hears, unless it speaks', async () => {
    const quiet = watched()
    const speaking = watched({ speak: true })
    for (let spent = 0; spent < 30_000; spent += 1_000) {
      quiet.keepalive.heard()
      speaking.keepalive.heard()
      await vi.advanceTimersByTimeAsync(1_000)
      quiet.buffered = 0
      speaking.buffered = 0
    }
    expect(quiet.pings).toBe(0)
    // Every ten seconds without a word of its own, so the other side hears it; their answers wait
    // behind what the other side sends, so they time nothing.
    expect(speaking.pings).toBe(3)
    expect(speaking.timed).toEqual([false, false, false])
    expect(speaking.silent).toBe(false)
  })
})
