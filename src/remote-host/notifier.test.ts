import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionProgress } from '@shared/host-control'
import { DEFAULT_CHOICES, type DevicePush, type NotificationChoices } from '@shared/remote/push'
import { Notifier, type PushJob } from './notifier'

const APNS = 'a1'.repeat(32)
const START = 'c3'.repeat(32)
const FOLLOW = 'd4'.repeat(32)

const running = (overrides: Partial<SessionProgress> = {}): SessionProgress => ({
  title: 'Fix the login form',
  agent: 'Claude Code',
  phase: 'thinking',
  step: null,
  plan: { done: 1, total: 4, current: 'Write the test' },
  startedAt: 1_000,
  endedAt: null,
  subagents: 0,
  waiting: 0,
  ...overrides,
})

function setup(
  options: {
    choices?: Partial<NotificationChoices>
    activity?: NonNullable<DevicePush['target']>['activity']
    inFront?: boolean
  } = {},
) {
  let now = 10_000
  const jobs: PushJob[] = []
  const front = { value: options.inFront ?? false }
  const push: DevicePush = {
    target: {
      apns: { token: APNS, environment: 'sandbox' },
      ...(options.activity ? { activity: options.activity } : {}),
    },
    choices: { ...DEFAULT_CHOICES, ...options.choices },
  }
  const notifier = new Notifier({
    devices: () => [{ id: 'phone', push }],
    showing: () => false,
    inFront: () => front.value,
    send: (job) => jobs.push(job),
    now: () => now,
  })
  const progressJobs = () =>
    jobs.filter((job): job is Extract<PushJob, { type: 'progress' }> => job.type === 'progress')
  const advance = (ms: number) => {
    now += ms
    vi.advanceTimersByTime(ms)
  }
  return { notifier, jobs, progressJobs, push, front, advance, now: () => now }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a turn's Live Activity", () => {
  it('stays the device own while it is in front, and follows the turn once it is away', () => {
    const t = setup({ activity: { progress: { token: FOLLOW, sessionId: 's1' } }, inFront: true })
    t.notifier.setProgress({ s1: running() })
    expect(t.progressJobs()).toEqual([])
    // Leaving, the device showed the turn as it was: only what changes after is sent.
    t.front.value = false
    t.notifier.frontChanged('phone')
    expect(t.progressJobs()).toEqual([])
    t.advance(30_000)
    t.notifier.setProgress({ s1: running({ phase: 'command', step: 'pnpm test' }) })
    expect(t.progressJobs()).toMatchObject([
      {
        action: 'update',
        low: true,
        state: {
          sessionId: 's1',
          title: 'Fix the login form',
          agent: 'Claude Code',
          phase: 'command',
          step: 'pnpm test',
          plan: { done: 1, total: 4, current: 'Write the test' },
          startedAt: 1_000,
          subagents: 0,
          running: 1,
          waiting: 0,
        },
      },
    ])
  })

  it('sends what needs the user at once and spaces the rest out', () => {
    const t = setup({ activity: { progress: { token: FOLLOW, sessionId: 's1' } } })
    t.notifier.setProgress({ s1: running() })
    expect(t.progressJobs()).toHaveLength(1)
    expect(t.progressJobs()[0]).toMatchObject({ action: 'update', low: false })

    // Another phase waits for its gap, and only the latest goes.
    t.advance(2_000)
    t.notifier.setProgress({ s1: running({ phase: 'command', step: 'ls' }) })
    t.notifier.setProgress({ s1: running({ phase: 'edit', step: 'src/app.ts' }) })
    expect(t.progressJobs()).toHaveLength(1)
    t.advance(8_000)
    expect(t.progressJobs()).toHaveLength(2)
    expect(t.progressJobs()[1]).toMatchObject({ low: true, state: { phase: 'edit' } })

    // Another detail of the same phase waits longer.
    t.notifier.setProgress({ s1: running({ phase: 'edit', step: 'src/other.ts' }) })
    t.advance(10_000)
    expect(t.progressJobs()).toHaveLength(2)
    t.advance(10_000)
    expect(t.progressJobs()).toHaveLength(3)

    // A request that waits does not wait.
    t.notifier.setProgress({
      s1: running({ phase: 'approval', step: 'rm -rf build', waiting: 1 }),
    })
    expect(t.progressJobs()).toHaveLength(4)
    expect(t.progressJobs()[3]).toMatchObject({
      low: false,
      state: { phase: 'approval', running: 0, waiting: 1 },
    })
  })

  it('renews a state that did not change before it goes stale', () => {
    const t = setup({ activity: { progress: { token: FOLLOW, sessionId: 's1' } } })
    t.notifier.setProgress({ s1: running() })
    expect(t.progressJobs()).toHaveLength(1)
    t.advance(15 * 60_000)
    expect(t.progressJobs()).toHaveLength(2)
    expect(t.progressJobs()[1]).toMatchObject({ action: 'update', low: true, staleS: 1800 })
  })

  it('says only the phase and the counts to a device without details', () => {
    const t = setup({
      activity: { progress: { token: FOLLOW, sessionId: 's1' } },
      choices: { details: false },
    })
    t.notifier.setProgress({ s1: running({ phase: 'question', step: 'Tabs or spaces?' }) })
    const [job] = t.progressJobs()
    expect(job!.state).not.toHaveProperty('title')
    expect(job!.state).not.toHaveProperty('step')
    expect(job!.state.plan).toEqual({ done: 1, total: 4 })
    expect(job!.state).toMatchObject({ phase: 'question', agent: 'Claude Code' })
  })

  it('ends with how the turn ended and lets the token go', () => {
    const t = setup({ activity: { progress: { token: FOLLOW, sessionId: 's1' } } })
    t.notifier.setProgress({ s1: running() })
    t.advance(60_000)
    t.notifier.setProgress({ s1: running({ phase: 'error', endedAt: 70_000 }) })
    const last = t.progressJobs().at(-1)!
    expect(last).toMatchObject({
      action: 'end',
      low: false,
      lingerS: 900,
      state: { phase: 'error', endedAt: 70_000, running: 0 },
    })
    // The spent token, still in the target for a moment, is not followed again.
    const count = t.jobs.length
    t.notifier.setProgress({ s2: running() })
    t.advance(60_000)
    expect(t.progressJobs().slice(count)).toEqual([])
  })

  it('moves to the session that needs the user, and keeps a muted one off it', () => {
    const t = setup({
      activity: { progress: { token: FOLLOW, sessionId: 's1' } },
      choices: { muted: ['s3'] },
    })
    t.notifier.setProgress({
      s1: running(),
      s2: running({ title: 'Other', phase: 'approval', waiting: 1, startedAt: 500 }),
      s3: running({ title: 'Muted', phase: 'approval', waiting: 2, startedAt: 2_000 }),
    })
    expect(t.progressJobs()[0]!.state).toMatchObject({ sessionId: 's2', running: 1, waiting: 2 })
  })
})

describe("a turn's Live Activity started by push", () => {
  it('starts once per turn while the device is away, for a device that asked', () => {
    const t = setup({ activity: { start: START }, choices: { liveProgress: true } })
    t.notifier.setProgress({ s1: running({ startedAt: 10_000 }) })
    expect(t.progressJobs()).toMatchObject([{ action: 'start', state: { sessionId: 's1' } }])
    t.advance(2 * 60_000)
    t.notifier.setProgress({ s1: running({ startedAt: 10_000, phase: 'command' }) })
    expect(t.progressJobs()).toHaveLength(1)

    // Its token arrives: it carries on from what it started with.
    t.push.target!.activity = { start: START, progress: { token: FOLLOW, sessionId: 's1' } }
    t.notifier.deviceChanged()
    expect(t.progressJobs().at(-1)).toMatchObject({ action: 'update', state: { phase: 'command' } })
  })

  it('starts none for an older device, for a user at the computer or for a turn begun in front', () => {
    const old = setup({ activity: { start: START } })
    old.notifier.setProgress({ s1: running({ startedAt: 10_000 }) })
    expect(old.jobs).toEqual([])

    const present = setup({ activity: { start: START }, choices: { liveProgress: true } })
    present.notifier.setPresent(true)
    present.notifier.setProgress({ s1: running({ startedAt: 10_000 }) })
    expect(present.progressJobs()).toEqual([])

    const front = setup({
      activity: { start: START },
      choices: { liveProgress: true },
      inFront: true,
    })
    front.notifier.setProgress({ s1: running({ startedAt: 9_000 }) })
    front.advance(1_000)
    front.front.value = false
    front.notifier.frontChanged('phone')
    expect(front.progressJobs()).toEqual([])
    front.advance(120_000)
    front.notifier.setProgress({
      s1: running({ startedAt: 9_000 }),
      s2: running({ startedAt: front.now() }),
    })
    expect(front.progressJobs()).toMatchObject([{ action: 'start', state: { sessionId: 's2' } }])
  })

  it('starts none for a turn whose activity the user removed', () => {
    const t = setup({
      activity: { start: START, progress: { token: FOLLOW, sessionId: 's1' } },
      choices: { liveProgress: true },
    })
    t.notifier.setProgress({ s1: running({ startedAt: 10_000 }) })
    expect(t.progressJobs()).toMatchObject([{ action: 'update' }])
    t.notifier.progressGone('phone')
    t.push.target!.activity = { start: START }
    t.notifier.deviceChanged()
    t.advance(120_000)
    t.notifier.setProgress({ s1: running({ startedAt: 10_000, phase: 'edit' }) })
    expect(t.progressJobs()).toHaveLength(1)
  })

  it('keeps the activity of what waits from starting beside it', () => {
    const t = setup({ activity: { start: START }, choices: { liveProgress: true } })
    t.notifier.setProgress({ s1: running({ startedAt: 10_000, phase: 'approval', waiting: 1 }) })
    t.notifier.setWaiting({ s1: ['r1'] })
    t.notifier.attention({
      kind: 'permission',
      sessionId: 's1',
      requestId: 'r1',
      title: 'Fix',
      body: 'Wants to run ls',
      inFront: false,
      devices: [],
    })
    t.advance(5_000)
    expect(t.jobs.filter((job) => job.type === 'activity')).toEqual([])
    expect(t.progressJobs()).toHaveLength(1)
  })
})
