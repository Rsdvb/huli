import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Stall } from '@shared/supervisor'
import { threadFromSnapshot, type SessionView, type ThreadEntry } from '@shared/thread'
import { agentOutput, retrying, StallWatch, type StallState } from './stall-watch'

const MINUTE = 60_000

function watch(threshold = 10 * MINUTE) {
  const state: StallState = { running: true, waiting: false, retrying: false }
  const changes: (Stall | null)[] = []
  let minutes = threshold
  const watcher = new StallWatch({
    now: () => Date.now(),
    thresholdMs: () => minutes,
    state: () => state,
    changed: (_id, stall) => changes.push(stall),
  })
  return {
    watcher,
    state,
    changes,
    setThreshold: (ms: number) => {
      minutes = ms
      watcher.settingsChanged()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a running turn', () => {
  it('is flagged once it has said nothing for the threshold, and only once', () => {
    const { watcher, changes } = watch()
    const start = Date.now()
    watcher.turnStarted('s1')
    vi.advanceTimersByTime(10 * MINUTE - 1)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual([{ since: start, reason: 'silent' }])
    vi.advanceTimersByTime(60 * MINUTE)
    expect(changes).toHaveLength(1)
    expect(watcher.stallOf('s1')).toEqual({ since: start, reason: 'silent' })
  })

  it('counts its silence from its latest output', () => {
    const { watcher, changes } = watch()
    watcher.turnStarted('s1')
    vi.advanceTimersByTime(9 * MINUTE)
    watcher.output('s1')
    const quiet = Date.now()
    vi.advanceTimersByTime(9 * MINUTE)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(MINUTE)
    expect(changes).toEqual([{ since: quiet, reason: 'silent' }])
  })

  it('takes a burst of output for one, without timing each update', () => {
    const { watcher, changes } = watch()
    watcher.turnStarted('s1')
    vi.advanceTimersByTime(5 * MINUTE)
    watcher.output('s1')
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(5)
      watcher.output('s1')
    }
    vi.advanceTimersByTime(10 * MINUTE - 1000)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(changes).toHaveLength(1)
  })

  it('clears its flag as soon as output comes again, and may be flagged again later', () => {
    const { watcher, changes } = watch()
    watcher.turnStarted('s1')
    vi.advanceTimersByTime(10 * MINUTE)
    watcher.output('s1')
    const quiet = Date.now()
    expect(changes).toEqual([expect.objectContaining({ reason: 'silent' }), null])
    expect(watcher.stallOf('s1')).toBeNull()
    vi.advanceTimersByTime(10 * MINUTE)
    expect(changes.at(-1)).toEqual({ since: quiet, reason: 'silent' })
  })

  it('is never flagged while it waits for the user, and counts from when the wait ended', () => {
    const { watcher, state, changes } = watch()
    watcher.turnStarted('s1')
    vi.advanceTimersByTime(5 * MINUTE)
    state.waiting = true
    watcher.waitChanged('s1')
    vi.advanceTimersByTime(60 * MINUTE)
    expect(changes).toEqual([])
    state.waiting = false
    watcher.waitChanged('s1')
    const answered = Date.now()
    vi.advanceTimersByTime(10 * MINUTE - 1)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual([{ since: answered, reason: 'silent' }])
  })

  it('is not flagged while a wait it was not told of holds it', () => {
    const { watcher, state, changes } = watch()
    watcher.turnStarted('s1')
    state.waiting = true
    vi.advanceTimersByTime(30 * MINUTE)
    expect(changes).toEqual([])
  })

  it('says it keeps retrying when its latest update is a retry', () => {
    const { watcher, state, changes } = watch()
    watcher.turnStarted('s1')
    state.retrying = true
    vi.advanceTimersByTime(10 * MINUTE)
    expect(changes).toEqual([expect.objectContaining({ reason: 'retrying' })])
  })

  it('keeps waiting from Keep waiting, a full threshold again', () => {
    const { watcher, changes } = watch()
    watcher.turnStarted('s1')
    vi.advanceTimersByTime(10 * MINUTE)
    vi.advanceTimersByTime(3 * MINUTE)
    watcher.snooze('s1')
    const snoozed = Date.now()
    expect(changes.at(-1)).toBeNull()
    vi.advanceTimersByTime(10 * MINUTE - 1)
    expect(changes).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(changes.at(-1)).toEqual({ since: snoozed, reason: 'silent' })
  })

  it('stops being watched when it ends, its flag cleared', () => {
    const { watcher, changes } = watch()
    watcher.turnStarted('s1')
    vi.advanceTimersByTime(10 * MINUTE)
    watcher.turnEnded('s1')
    expect(changes).toEqual([expect.anything(), null])
    watcher.output('s1')
    vi.advanceTimersByTime(60 * MINUTE)
    expect(changes).toHaveLength(2)
  })

  it('stops being watched once the session says no turn runs', () => {
    const { watcher, state, changes } = watch()
    watcher.turnStarted('s1')
    state.running = false
    vi.advanceTimersByTime(60 * MINUTE)
    expect(changes).toEqual([])
    expect(watcher.stallOf('s1')).toBeNull()
  })

  it('is never flagged with the threshold at 0, and a flag clears when it is set so', () => {
    const off = watch(0)
    off.watcher.turnStarted('s1')
    vi.advanceTimersByTime(24 * 60 * MINUTE)
    expect(off.changes).toEqual([])

    const { watcher, changes, setThreshold } = watch()
    watcher.turnStarted('s1')
    vi.advanceTimersByTime(10 * MINUTE)
    setThreshold(0)
    expect(changes).toEqual([expect.anything(), null])
    vi.advanceTimersByTime(60 * MINUTE)
    expect(changes).toHaveLength(2)
  })

  it('is timed by a new threshold from its last output', () => {
    const { watcher, changes, setThreshold } = watch()
    const start = Date.now()
    watcher.turnStarted('s1')
    vi.advanceTimersByTime(6 * MINUTE)
    setThreshold(5 * MINUTE)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(0)
    expect(changes).toEqual([{ since: start, reason: 'silent' }])
  })
})

describe('what counts as output', () => {
  const session: SessionView = {
    id: 'k1',
    agentId: 'claude-code',
    projectPath: '/repo',
    acpSessionId: null,
    status: 'running',
    title: null,
    config: [],
    commands: [],
    usage: null,
    error: null,
    turnStartedAt: 1,
    turnStartUsed: null,
    createdAt: 1,
    updatedAt: 1,
    parentId: null,
    origin: 'user',
    subagent: null,
    routine: null,
    queue: [],
    queuePaused: false,
  }
  const retry: ThreadEntry = {
    kind: 'notice',
    id: 'n:retry:u1',
    severity: 'warning',
    title: 'Retrying (3/10) · service overloaded',
  }
  const thread = (entries: ThreadEntry[]) => threadFromSnapshot({ session, entries, seq: 0 })

  it("is anything the agent sends, a tool's progress that changes nothing shown too", () => {
    const empty = thread([])
    expect(agentOutput({ patches: [], effects: [] }, empty)).toBe(true)
    expect(
      agentOutput(
        { patches: [{ op: 'entry.appendText', id: 'a1', text: 'more' }], effects: [] },
        empty,
      ),
    ).toBe(true)
  })

  it("is not a retry's notice, which says the request failed again", () => {
    expect(
      agentOutput({ patches: [{ op: 'entry.add', entry: retry }], effects: [] }, thread([])),
    ).toBe(false)
    expect(
      agentOutput(
        {
          patches: [{ op: 'entry.update', id: retry.id, changes: { title: 'Retrying (4/10)' } }],
          effects: [],
        },
        thread([retry]),
      ),
    ).toBe(false)
  })

  it('tells a retry under way from one that went through', () => {
    expect(retrying(thread([retry]))).toBe(true)
    expect(retrying(thread([{ ...retry, severity: 'info' }]))).toBe(false)
    expect(
      retrying(
        thread([
          retry,
          { kind: 'agent', id: 'a1', markdown: 'Back.', attachments: [], streaming: true },
        ]),
      ),
    ).toBe(false)
  })
})
