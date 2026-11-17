import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHOICES, type NotificationChoices } from '@shared/remote/push'
import { parseAttention } from './notifications'
import { Notifier, type PushJob } from './notifier'

const base = { kind: 'permission', sessionId: 's1', title: 'Fix the form', body: 'Asks which' }

describe('parseAttention', () => {
  it('takes a question a notification may answer', () => {
    const attention = parseAttention({
      ...base,
      request: { id: 'r1', question: { choices: ['Tabs', 'Spaces'], text: true } },
    })
    expect(attention).toMatchObject({
      requestId: 'r1',
      question: { choices: ['Tabs', 'Spaces'], text: true },
    })
    expect(attention).not.toHaveProperty('actions')
  })

  it('drops a question that is not one, keeping the request', () => {
    const questions = [
      { choices: ['a', 'b', 'c', 'd', 'e'], text: false },
      { choices: ['x'.repeat(41)], text: false },
      { choices: [''], text: false },
      { choices: [1], text: false },
      { choices: [], text: false },
      { choices: ['a'] },
      'Tabs',
    ]
    for (const question of questions) {
      const attention = parseAttention({ ...base, request: { id: 'r1', question } })
      expect(attention).toMatchObject({ requestId: 'r1' })
      expect(attention).not.toHaveProperty('question')
    }
  })

  it('offers no question beside one-time answers', () => {
    const attention = parseAttention({
      ...base,
      request: {
        id: 'r1',
        allow: { optionId: 'allow', name: 'Allow' },
        question: { choices: ['Tabs'], text: false },
      },
    })
    expect(attention).toMatchObject({ actions: { allow: { optionId: 'allow', label: 'Allow' } } })
    expect(attention).not.toHaveProperty('question')
  })

  it('takes a plan limit by its agent and window, without a session', () => {
    const limit = { kind: 'plan-limit', title: 'Claude Code · 5-hour limit 92% used', body: 'Soon' }
    expect(parseAttention({ ...limit, agentId: 'claude-code', window: 'five_hour' })).toEqual({
      ...limit,
      agentId: 'claude-code',
      window: 'five_hour',
      inFront: false,
      devices: [],
    })
    expect(parseAttention({ ...limit, agentId: 'claude-code' })).toBeNull()
    expect(parseAttention({ ...limit, window: 'five_hour', sessionId: 's1' })).toBeNull()
    expect(parseAttention({ ...limit, agentId: 'claude-code', window: 'x'.repeat(201) })).toBeNull()
  })
})

describe('a plan limit on the devices', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const target = { apns: { token: 'ab'.repeat(32), environment: 'sandbox' as const } }

  function device(choices: Partial<NotificationChoices>) {
    const sent: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [
        { id: 'phone', push: { target, choices: { ...DEFAULT_CHOICES, ...choices } } },
      ],
      showing: () => false,
      send: (job) => sent.push(job),
      mergeMs: 10,
    })
    return { notifier, sent }
  }

  const attention = {
    kind: 'plan-limit' as const,
    agentId: 'claude-code',
    window: 'five_hour',
    title: 'Claude Code · 5-hour limit 92% used',
    body: 'Resets in 2 h',
    inFront: false,
    devices: [],
  }

  it('reaches a device that keeps the default choices, tagged by agent and window', () => {
    const { notifier, sent } = device({})
    notifier.attention(attention)
    vi.advanceTimersByTime(10)
    expect(sent).toEqual([
      {
        deviceId: 'phone',
        subject: 'limits:claude-code:five_hour',
        type: 'alert',
        event: { kind: 'plan-limit', agentId: 'claude-code', window: 'five_hour' },
        title: attention.title,
        body: attention.body,
      },
    ])
  })

  it('reaches no device that turned it off, nor one held back while the user is at the app', () => {
    const off = device({ limits: false })
    off.notifier.attention(attention)
    vi.advanceTimersByTime(10)
    expect(off.sent).toEqual([])

    const away = device({ onlyAway: true })
    away.notifier.setPresent(true)
    away.notifier.attention(attention)
    vi.advanceTimersByTime(10)
    expect(away.sent).toEqual([])
  })
})
