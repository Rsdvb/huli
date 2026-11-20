import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_CHOICES, type NotificationChoices } from '@shared/remote/push'
import { Notifier, type Attention, type PushJob } from './notifier'

function setup(choices: Partial<NotificationChoices> = {}, showing = false) {
  const jobs: PushJob[] = []
  const notifier = new Notifier({
    devices: () => [
      {
        id: 'phone',
        push: {
          target: { apns: { token: 'a1'.repeat(32), environment: 'sandbox' } },
          choices: { ...DEFAULT_CHOICES, ...choices },
        },
      },
    ],
    showing: () => showing,
    send: (job) => jobs.push(job),
    mergeMs: 0,
  })
  return { notifier, jobs }
}

const attention = (kind: 'limit-resumed'): Attention => ({
  kind,
  sessionId: 's1',
  title: 'The plan is back, going on: Fix the parser',
  body: 'Sending the stopped message again.',
  inFront: false,
  devices: [],
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

it('pushes a turn that went on after its plan limit, opening the session', () => {
  for (const kind of ['limit-resumed'] as const) {
    const { notifier, jobs } = setup()
    notifier.attention(attention(kind))
    vi.advanceTimersByTime(10)
    expect(jobs.filter((job) => job.type === 'alert')).toMatchObject([
      { subject: 's1', event: { kind, sessionId: 's1' }, title: attention(kind).title },
    ])
  }
})

it("follows the device's choices: limits for one that went on", () => {
  const quiet = setup({ limits: false })
  quiet.notifier.attention(attention('limit-resumed'))
  vi.advanceTimersByTime(10)
  expect(quiet.jobs.filter((job) => job.type === 'alert')).toEqual([])

  const shown = setup({}, true)
  shown.notifier.attention(attention('limit-resumed'))
  vi.advanceTimersByTime(10)
  expect(shown.jobs.filter((job) => job.type === 'alert')).toEqual([])
})
