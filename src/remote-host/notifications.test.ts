import { describe, expect, it } from 'vitest'
import { parseAttention } from './notifications'

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
