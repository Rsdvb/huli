import { describe, expect, it } from 'vitest'
import { parseAttention, parseProgress } from './notifications'

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
})
