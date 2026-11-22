import { describe, expect, it } from 'vitest'
import type { DigestedThreadEntry, ThreadEntry, ToolEntry } from './thread'
import {
  RECAP_AWAY_MS,
  SEEN_MARKS_KEPT,
  changedLines,
  parseSeenMarks,
  recapSince,
  replyLine,
  withSeen,
  type RecapThread,
} from './recap'

function thread(entries: (ThreadEntry | DigestedThreadEntry)[]): RecapThread {
  return {
    order: entries.map((e) => e.id),
    byId: Object.fromEntries(entries.map((e) => [e.id, e])),
  }
}

function tool(id: string, fields: Partial<ToolEntry>): ToolEntry {
  return {
    kind: 'tool',
    id,
    title: '',
    toolKind: 'other',
    status: 'completed',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...fields,
  }
}

const user = (id: string): ThreadEntry => ({ kind: 'user', id, content: [] })
const agent = (id: string, markdown: string): ThreadEntry => ({
  kind: 'agent',
  id,
  markdown,
  attachments: [],
  streaming: false,
})

const NOW = 10 * RECAP_AWAY_MS
const away = { now: NOW, older: false }
const left = (entry: string | null, ago = RECAP_AWAY_MS) => ({ at: NOW - ago, entry })

describe('recapSince', () => {
  const entries = [
    user('u1'),
    agent('a1', 'Seen before'),
    tool('e1', {
      toolKind: 'edit',
      content: [{ type: 'diff', path: '/p/a.ts', oldText: 'a\nb\nc', newText: 'a\nB\nB2\nc' }],
    }),
    tool('e2', {
      toolKind: 'edit',
      content: [{ type: 'diff', path: '/p/b.ts', oldText: null, newText: 'one\ntwo\n' }],
    }),
    tool('e3', {
      toolKind: 'edit',
      content: [{ type: 'diff', path: '/p/a.ts', oldText: 'x', newText: 'y' }],
    }),
    tool('x1', { toolKind: 'execute', rawInput: 'pnpm test' }),
    tool('x2', { toolKind: 'execute', status: 'failed' }),
    tool('x3', {
      toolKind: 'execute',
      status: 'cancelled',
      permissionResult: { optionId: 'no', kind: 'reject_once' },
      denied: { by: 'user' },
    }),
    tool('x4', {
      toolKind: 'execute',
      status: 'pending',
      permission: { requestId: 'r', options: [] },
    }),
    tool('x5', {
      toolKind: 'execute',
      permissionResult: { optionId: 'ok', kind: 'allow_once', by: 'risk' },
    }),
    agent('a2', '## Done\n\nAll **tests** pass, see [the log](https://example.com).'),
  ]

  it('sums up what happened after the entry the user left at', () => {
    expect(recapSince(thread(entries), left('a1'), away)).toEqual({
      from: 'e1',
      files: 2,
      added: 5,
      removed: 2,
      commands: 3,
      approvals: 2,
      waiting: 1,
      errors: 0,
      reply: 'Done',
      partial: false,
    })
  })

  it('shows nothing for an absence shorter than the threshold', () => {
    expect(recapSince(thread(entries), left('a1', RECAP_AWAY_MS - 1), away)).toBeNull()
  })

  it('shows nothing without a mark, or when nothing came after it', () => {
    expect(recapSince(thread(entries), null, away)).toBeNull()
    expect(recapSince(thread(entries), left('a2'), away)).toBeNull()
  })

  it('shows nothing when only messages came, with no work or reply', () => {
    expect(recapSince(thread([user('u1'), user('u2')]), left('u1'), away)).toBeNull()
  })

  it('counts from the start of the loaded pages when the mark lies on an older one', () => {
    const recap = recapSince(thread(entries.slice(5)), left('a1'), { now: NOW, older: true })
    expect(recap).toMatchObject({ from: 'x1', files: 0, commands: 3, partial: true })
  })

  it('places no one in a thread that no longer holds the mark and has no older pages', () => {
    expect(recapSince(thread(entries.slice(5)), left('a1'), away)).toBeNull()
  })

  it('counts everything in a thread left empty', () => {
    expect(recapSince(thread(entries), left(null), away)).toMatchObject({ from: 'u1', files: 2 })
  })

  it('reads the line counts of a digested diff, as a phone gets a long one', () => {
    const digested: DigestedThreadEntry = {
      ...tool('d1', { toolKind: 'edit' }),
      content: [
        { type: 'digest', of: 'diff', path: '/p/big.ts', size: 9000, added: 40, removed: 3 },
      ],
    }
    expect(recapSince(thread([user('u1'), digested]), left('u1'), away)).toMatchObject({
      files: 1,
      added: 40,
      removed: 3,
    })
  })

  it('leaves out edits that did not complete', () => {
    const failed = tool('f1', {
      toolKind: 'edit',
      status: 'failed',
      content: [{ type: 'diff', path: '/p/a.ts', oldText: 'a', newText: 'b' }],
    })
    expect(
      recapSince(thread([user('u1'), failed, agent('a', 'x')]), left('u1'), away),
    ).toMatchObject({ files: 0, added: 0, removed: 0 })
  })

  it('counts the errors that ended a turn', () => {
    const notice: ThreadEntry = {
      kind: 'notice',
      id: 'n1',
      severity: 'error',
      title: 'Failed',
      cause: 'turn_failed',
    }
    expect(recapSince(thread([user('u1'), notice]), left('u1'), away)).toMatchObject({ errors: 1 })
  })
})

describe('changedLines', () => {
  it('counts a new file as all added', () => {
    expect(changedLines(null, 'a\nb\n')).toEqual({ added: 2, removed: 0 })
  })

  it('counts the lines a change replaced', () => {
    expect(changedLines('a\nb\nc\nd', 'a\nx\nd')).toEqual({ added: 1, removed: 2 })
    expect(changedLines('same', 'same')).toEqual({ added: 0, removed: 0 })
    expect(changedLines('a\nb', 'a\nb\nc')).toEqual({ added: 1, removed: 0 })
  })

  it('counts two changes apart as a diff does, not the lines between them', () => {
    expect(changedLines('a\nb\nc\nd\ne\nf', 'a\nB\nc\nd\ne\nF')).toEqual({ added: 2, removed: 2 })
  })

  it('bounds a change too large to diff by what lies between the shared ends', () => {
    const before = Array.from({ length: 900 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 900 }, (_, i) => `new ${i}`).join('\n')
    expect(changedLines(`top\n${before}\nend`, `top\n${after}\nend`)).toEqual({
      added: 900,
      removed: 900,
    })
  })
})

describe('replyLine', () => {
  it('takes the first line of text without its marks', () => {
    expect(replyLine('```ts\nconst a = 1\n```\n\n> **Fixed** the `bug` in _two_ places')).toBe(
      'Fixed the bug in two places',
    )
    expect(replyLine('- [x] Task one')).toBe('Task one')
    expect(replyLine('\n\n')).toBeNull()
  })

  it('cuts a long line', () => {
    expect(replyLine('x'.repeat(400))!.length).toBe(160)
  })
})

describe('seen marks', () => {
  it('keeps the most recently seen sessions past the limit', () => {
    let marks = {}
    for (let i = 0; i <= SEEN_MARKS_KEPT; i++)
      marks = withSeen(marks, `s${i}`, { at: i, entry: null })
    expect(Object.keys(marks)).toHaveLength(SEEN_MARKS_KEPT)
    expect(marks).not.toHaveProperty('s0')
    expect(marks).toHaveProperty(`s${SEEN_MARKS_KEPT}`)
  })

  it('drops what storage gave back malformed', () => {
    expect(
      parseSeenMarks({
        a: { at: 1, entry: 'e' },
        b: { at: 'x', entry: 'e' },
        c: { at: 2, entry: 3 },
        d: null,
        e: { at: 3, entry: null },
      }),
    ).toEqual({ a: { at: 1, entry: 'e' }, e: { at: 3, entry: null } })
    expect(parseSeenMarks([1])).toEqual({})
  })
})
