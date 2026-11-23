import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TIDY, MERGED_QUIET_MS, TIDY_DAY_MS } from '@shared/session-tidy'
import {
  BUSY_RECHECK_MS,
  SessionTidy,
  settleAt,
  tidyStep,
  tidySummary,
  withActivity,
  withNever,
  withSettled,
  withSnooze,
  type StoredTidy,
  type TidyFacts,
  type TidyRecord,
} from './session-tidy'

const DAY = TIDY_DAY_MS
const facts = (over: Partial<TidyFacts> = {}): TidyFacts => ({
  listed: true,
  pinned: false,
  busy: false,
  updatedAt: 0,
  merged: null,
  ...over,
})
const PR = 'https://github.com/o/r/pull/7'

describe('Huli: when a session settles by itself', () => {
  it('settles an idle session after the days the settings give, measured from its activity', () => {
    expect(settleAt(undefined, facts({ updatedAt: 100 }), DEFAULT_TIDY)).toEqual({
      at: 100 + 7 * DAY,
      by: 'idle',
    })
    expect(
      settleAt(undefined, facts({ updatedAt: 100 }), { ...DEFAULT_TIDY, idleDays: 1 })?.at,
    ).toBe(100 + DAY)
  })

  it('settles a session whose pull request merged after an hour of quiet, once per pull request', () => {
    expect(settleAt(undefined, facts({ merged: PR }), DEFAULT_TIDY)).toEqual({
      at: MERGED_QUIET_MS,
      by: 'merged',
    })
    expect(settleAt({ merged: PR }, facts({ merged: PR }), DEFAULT_TIDY)?.by).toBe('idle')
    expect(settleAt(undefined, facts({ merged: PR }), { ...DEFAULT_TIDY, merged: false })?.by).toBe(
      'idle',
    )
  })

  it('leaves alone what the user keeps, what works, and everything while the rules are off', () => {
    const none = [
      settleAt(undefined, facts(), { ...DEFAULT_TIDY, autoSettle: false }),
      settleAt(undefined, facts({ listed: false }), DEFAULT_TIDY),
      settleAt(undefined, facts({ pinned: true }), DEFAULT_TIDY),
      settleAt(undefined, facts({ busy: true }), DEFAULT_TIDY),
      settleAt({ never: true }, facts(), DEFAULT_TIDY),
      settleAt({ keptAt: 5 }, facts(), DEFAULT_TIDY),
      settleAt({ snooze: { until: 9 } }, facts(), DEFAULT_TIDY),
      settleAt({ settled: { at: 1, by: 'user' } }, facts(), DEFAULT_TIDY),
    ]
    expect(none).toEqual(none.map(() => null))
  })
})

describe('Huli: a session tidy state over time', () => {
  it('ends a snooze whose time came, and is next due at the snooze otherwise', () => {
    const snoozed: StoredTidy = { snooze: { until: 50 } }
    expect(tidyStep(snoozed, facts({ updatedAt: 0 }), DEFAULT_TIDY, 10)).toEqual({
      tidy: snoozed,
      due: 50,
    })
    // Woken, the session is under the rules again, which settle it in a week.
    expect(tidyStep(snoozed, facts({ updatedAt: 0 }), DEFAULT_TIDY, 50)).toEqual({
      tidy: undefined,
      due: 7 * DAY,
    })
  })

  it('settles a session that is due, and remembers the pull request that settled it', () => {
    expect(tidyStep(undefined, facts(), DEFAULT_TIDY, 7 * DAY)).toEqual({
      tidy: { settled: { at: 7 * DAY, by: 'idle' } },
      due: null,
    })
    expect(
      tidyStep({ never: undefined }, facts({ merged: PR }), DEFAULT_TIDY, MERGED_QUIET_MS),
    ).toEqual({ tidy: { settled: { at: MERGED_QUIET_MS, by: 'merged' }, merged: PR }, due: null })
  })

  it('looks again later at a session found at work when it was due', () => {
    expect(tidyStep(undefined, facts(), DEFAULT_TIDY, 8 * DAY, () => true)).toEqual({
      tidy: undefined,
      due: 8 * DAY + BUSY_RECHECK_MS,
    })
  })

  it("takes the user's choices", () => {
    // A snooze takes the session out of settled; waking it leaves the rest.
    const snoozed = withSnooze({ settled: { at: 1, by: 'idle' }, never: true }, 90, true)
    expect(snoozed).toEqual({ snooze: { until: 90, reset: true }, never: true })
    expect(withSnooze(snoozed, null, false)).toEqual({ never: true })
    // Settling ends a snooze; bringing it back keeps the rules off until the next message.
    expect(withSettled({ snooze: { until: 90 }, keptAt: 3 }, true, 10)).toEqual({
      settled: { at: 10, by: 'user' },
    })
    expect(withSettled({ settled: { at: 10, by: 'user' } }, false, 20)).toEqual({ keptAt: 20 })
    expect(withSettled(undefined, false, 20)).toBeUndefined()
    // 永不收起 brings back a session a rule settled, never one the user settled.
    expect(withNever({ settled: { at: 1, by: 'idle' } }, true)).toEqual({ never: true })
    expect(withNever({ settled: { at: 1, by: 'user' } }, true)).toEqual({
      settled: { at: 1, by: 'user' },
      never: true,
    })
    expect(withNever({ never: true }, false)).toBeUndefined()
  })

  it('brings a session back when it needs the user, and under the rules again on a message', () => {
    const parked: StoredTidy = { snooze: { until: 90 }, keptAt: 4, merged: PR }
    expect(withActivity(parked, false)).toEqual({ keptAt: 4, merged: PR })
    expect(withActivity({ settled: { at: 1, by: 'user' }, keptAt: 4 }, true)).toBeUndefined()
    expect(withActivity(undefined, true)).toBeUndefined()
  })

  it('shows only what is set', () => {
    expect(tidySummary(undefined)).toEqual({})
    expect(tidySummary({ keptAt: 1, merged: PR })).toEqual({})
    expect(tidySummary({ snooze: { until: 5 }, never: true })).toEqual({
      snooze: { until: 5, reset: false },
      neverSettle: true,
    })
  })
})

describe('Huli: the tidy timer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  interface Rec extends TidyRecord {
    updatedAt: number
  }

  function harness(records: Rec[], on = true) {
    let now = 0
    const touched: string[] = []
    const saved: string[] = []
    const tidy = new SessionTidy<Rec>({
      now: () => now,
      on: () => on,
      settings: () => ({ ...DEFAULT_TIDY, idleDays: 1 }),
      records: () => records,
      facts: (record) => facts({ updatedAt: record.updatedAt }),
      working: () => false,
      save: (record) => saved.push(record.id),
      touch: (id) => touched.push(id),
    })
    return {
      tidy,
      touched,
      saved,
      advance(ms: number) {
        now += ms
        vi.advanceTimersByTime(ms)
      },
    }
  }

  const record = (id: string, over: Partial<Rec> = {}): Rec => ({
    id,
    parentId: null,
    origin: 'user',
    updatedAt: 0,
    ...over,
  })

  it('wakes a snooze and settles an idle session each at its moment, on one timer', () => {
    vi.useFakeTimers()
    const snoozed = record('a', { tidy: { snooze: { until: 1_000 } }, updatedAt: DAY })
    const idle = record('b')
    const child = record('c', { parentId: 'b' })
    const h = harness([snoozed, idle, child])
    h.tidy.start(10)
    expect(vi.getTimerCount()).toBe(1)
    h.advance(10)
    expect(h.touched).toEqual([])
    h.advance(990)
    expect(snoozed.tidy).toBeUndefined()
    expect(h.touched).toEqual(['a'])
    expect(vi.getTimerCount()).toBe(1)
    h.advance(DAY - 1_000)
    expect(idle.tidy).toEqual({ settled: { at: DAY, by: 'idle' } })
    expect(child.tidy).toBeUndefined()
    expect(h.touched).toEqual(['a', 'b'])
    h.tidy.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('moves its timer earlier for a change that falls due sooner', () => {
    vi.useFakeTimers()
    const later = record('a', { tidy: { snooze: { until: 5_000 } }, updatedAt: DAY })
    const sooner = record('b', { updatedAt: DAY })
    const h = harness([later, sooner])
    h.tidy.sweep()
    sooner.tidy = { snooze: { until: 100 } }
    h.tidy.check(sooner)
    expect(vi.getTimerCount()).toBe(1)
    h.advance(100)
    expect(sooner.tidy).toBeUndefined()
    expect(later.tidy).toEqual({ snooze: { until: 5_000 } })
  })

  it('runs nothing while the feature is off', () => {
    vi.useFakeTimers()
    const h = harness([record('x')], false)
    h.tidy.start(0)
    h.advance(2 * DAY)
    expect(h.touched).toEqual([])
    h.tidy.check(record('y'))
    expect(vi.getTimerCount()).toBe(0)
  })
})
