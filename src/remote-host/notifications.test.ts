import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHOICES, type NotificationChoices } from '@shared/remote/push'
import { parseAttention, parseProgress } from './notifications'
import { Notifier, type PushJob } from './notifier'

describe('parseProgress', () => {
  const entry = {
    title: 'Fix the form',
    agent: 'Codex',
    phase: 'command',
    step: 'pnpm test',
    plan: { done: 1, total: 2, current: null },
    startedAt: 1000,
    endedAt: null,
    subagents: 1,
    waiting: 0,
  }

  it('takes the sessions at work as the agent host sends them', () => {
    expect(parseProgress({ s1: entry })).toEqual({ s1: entry })
    expect(parseProgress({})).toEqual({})
  })

  it('refuses a message with any entry that is not one', () => {
    for (const bad of [
      { ...entry, phase: 'dancing' },
      { ...entry, title: 'x'.repeat(4001) },
      { ...entry, startedAt: -1 },
      { ...entry, subagents: 1.5 },
      { ...entry, plan: { done: 3, total: 2, current: null } },
      { ...entry, plan: 'half' },
      { ...entry, waiting: undefined },
    ]) {
      expect(parseProgress({ s1: bad })).toBeNull()
    }
    expect(parseProgress({ '': entry })).toBeNull()
    expect(parseProgress([entry])).toBeNull()
    expect(parseProgress(null)).toBeNull()
  })

  it('keeps a session id a key, whatever it is', () => {
    const parsed = parseProgress(JSON.parse(`{"__proto__": ${JSON.stringify(entry)}}`))!
    expect(Object.getPrototypeOf(parsed)).toBeNull()
    expect(parsed['__proto__']).toEqual(entry)
  })
})

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
    // The host's notice, whose key names the account, then the window.
    const notice = { ...limit, agentId: 'claude-code', level: 'near', usedPercent: 92 }
    expect(
      parseAttention({ ...notice, key: 'claude-code:me@example.com:five_hour' }),
    ).toMatchObject({ agentId: 'claude-code', window: 'five_hour' })
    expect(parseAttention({ ...notice, key: 'claude-code:me@example.com:' })).toBeNull()
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
