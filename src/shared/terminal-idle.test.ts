import { describe, expect, it } from 'vitest'
import {
  MAX_CLOSED_OUTPUT,
  MAX_CLOSED_TERMINALS,
  MAX_CLOSED_TITLE,
  parseBusyTerminals,
  parseClosedTerminals,
} from './terminal-idle'

describe('closed idle terminals from the terminal host', () => {
  const closed = { title: 'pnpm test', idleMs: 600_000, output: 'passed\n%' }

  it('takes a list within the limits', () => {
    expect(parseClosedTerminals([closed, { ...closed, output: '' }])).toEqual([
      closed,
      { ...closed, output: '' },
    ])
    expect(parseClosedTerminals(Array(MAX_CLOSED_TERMINALS).fill(closed))).toHaveLength(
      MAX_CLOSED_TERMINALS,
    )
  })

  it.each([
    ['not a list', closed],
    ['an empty list', []],
    ['too many', Array(MAX_CLOSED_TERMINALS + 1).fill(closed)],
    ['no title', [{ ...closed, title: '' }]],
    ['a long title', [{ ...closed, title: 'x'.repeat(MAX_CLOSED_TITLE + 1) }]],
    ['a negative time', [{ ...closed, idleMs: -1 }]],
    ['a fractional time', [{ ...closed, idleMs: 1.5 }]],
    ['a time as text', [{ ...closed, idleMs: '600000' }]],
    ['long output', [{ ...closed, output: 'x'.repeat(MAX_CLOSED_OUTPUT + 1) }]],
    ['output that is not text', [{ ...closed, output: null }]],
    ['an entry that is not an object', [closed, 'x']],
  ])('refuses %s', (_, value) => {
    expect(parseClosedTerminals(value)).toBeNull()
  })
})

describe('busy terminals from the terminal host', () => {
  it('keeps the fields an older host leaves out absent, and drops a malformed one', () => {
    expect(
      parseBusyTerminals([
        { id: 't1', projectPath: '/p', title: 'pnpm dev' },
        {
          id: 't2',
          projectPath: '/p',
          title: 'vite',
          sessionId: 's1',
          name: 'Dev server',
          folder: '/p/web',
          opener: 'agent',
          since: 1000,
        },
        { id: 't3', projectPath: '/p', title: 'x', sessionId: 7, opener: 'root', since: 'now' },
        { id: 't4', projectPath: '/p' },
        null,
      ]),
    ).toEqual([
      { id: 't1', projectPath: '/p', title: 'pnpm dev' },
      {
        id: 't2',
        projectPath: '/p',
        title: 'vite',
        sessionId: 's1',
        name: 'Dev server',
        folder: '/p/web',
        opener: 'agent',
        since: 1000,
      },
      { id: 't3', projectPath: '/p', title: 'x' },
    ])
    expect(parseBusyTerminals('x')).toEqual([])
  })
})
