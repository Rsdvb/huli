import { describe, expect, it } from 'vitest'
import type { DigestedThreadEntry, ThreadEntry, ToolEntry } from './thread'
import {
  NOT_VISITED,
  RECAP_AWAY_MS,
  SEEN_MARKS_KEPT,
  changedLines,
  parseSeenMarks,
  recapSince,
  recapStep,
  replyLine,
  seenBook,
  withSeen,
  type RecapEvent,
  type RecapThread,
  type RecapVisit,
  type SeenMark,
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

describe('recapStep', () => {
  const MIN = 60_000
  const run = (id: string) => tool(id, { toolKind: 'execute' })
  // The thread as it stands at each moment of the visit.
  const t0 = [user('u1'), agent('a1', 'Started')]
  const t1 = [...t0, run('x1'), run('x2'), agent('a2', 'Watched this one')]
  const t2 = [...t1, run('x3'), agent('a3', 'Done while away')]
  const t3 = [...t2, run('x4'), run('x5'), agent('a4', 'Second absence')]

  function walk(steps: [RecapEvent, ThreadEntry[], number][]): RecapVisit[] {
    let visit: RecapVisit = NOT_VISITED
    const seen: RecapVisit[] = []
    for (const [event, entries, minutes] of steps) {
      visit = recapStep(visit, event, thread(entries), { now: minutes * MIN, older: false })
      seen.push(visit)
    }
    return seen
  }

  it('counts the time in view as seen and recaps only what came while away', () => {
    const [, , , back] = walk([
      ['view', t0, 0],
      // Watched for an hour as the agent worked, then the app went to the back.
      ['leave', t1, 60],
      ['leave', t1, 61],
      ['view', t2, 100],
    ])
    expect(back!.shown).toMatchObject({ from: 'x3', commands: 1, reply: 'Done while away' })
    expect(back!.mark).toEqual({ at: 100 * MIN, entry: 'a3' })
  })

  it('shows nothing after a short absence, though work went on', () => {
    const [, , back] = walk([
      ['view', t0, 0],
      ['leave', t1, 60],
      ['view', t2, 60 + 29],
    ])
    expect(back!.shown).toBeNull()
    expect(back!.mark).toEqual({ at: 89 * MIN, entry: 'a3' })
  })

  it('never measures an absence from before the user last looked', () => {
    // A view while in view, as the app back from an overlay it never left the session for.
    const [, again] = walk([
      ['view', t0, 0],
      ['view', t2, 120],
    ])
    expect(again!.shown).toBeNull()
    expect(again!.mark).toEqual({ at: 0, entry: 'a1' })
  })

  it('keeps a recap put away once done with, until the next absence brings new work', () => {
    const steps = walk([
      ['view', t0, 0],
      ['leave', t1, 10],
      ['view', t2, 50],
      ['done', t2, 51],
      ['leave', t2, 52],
      ['view', t2, 52 + 5],
      ['leave', t2, 60],
      // Away long enough, but nothing new.
      ['view', t2, 120],
      ['leave', t2, 121],
      ['view', t3, 200],
    ])
    expect(steps[2]!.shown).toMatchObject({ commands: 1 })
    expect(steps[3]).toEqual({ mark: { at: 51 * MIN, entry: 'a3' }, inView: true, shown: null })
    expect(steps[5]!.shown).toBeNull()
    expect(steps[7]!.shown).toBeNull()
    expect(steps[9]!.shown).toMatchObject({ from: 'x4', commands: 2, reply: 'Second absence' })
  })

  it('puts the recap away on leaving, the user having had it in view', () => {
    const [, , back, left] = walk([
      ['view', t0, 0],
      ['leave', t1, 10],
      ['view', t2, 50],
      ['leave', t2, 51],
    ])
    expect(back!.shown).not.toBeNull()
    expect(left).toEqual({ mark: { at: 51 * MIN, entry: 'a3' }, inView: false, shown: null })
  })

  it('takes a stored mark from an earlier run as where the user left', () => {
    const stored: RecapVisit = { ...NOT_VISITED, mark: { at: 0, entry: 'a2' } }
    const back = recapStep(stored, 'view', thread(t2), { now: 40 * MIN, older: false })
    expect(back.shown).toMatchObject({ from: 'x3', commands: 1 })
  })

  it('changes nothing when done with no recap on show', () => {
    const [viewed, done] = walk([
      ['view', t0, 0],
      ['done', t1, 5],
    ])
    expect(done).toBe(viewed)
  })
})

describe('seenBook', () => {
  function storage(stored: unknown, { failRead = false } = {}) {
    const written: Record<string, SeenMark>[] = []
    let release = (): void => {}
    const reading = new Promise<void>((resolve) => (release = resolve))
    let writing = 0
    let mostAtOnce = 0
    return {
      written,
      release: () => release(),
      mostAtOnce: () => mostAtOnce,
      read: async () => {
        await reading
        if (failRead) throw new Error('unreadable')
        return stored
      },
      write: async (marks: Record<string, SeenMark>) => {
        writing++
        mostAtOnce = Math.max(mostAtOnce, writing)
        await Promise.resolve()
        written.push({ ...marks })
        writing--
      },
    }
  }

  it('gives back a mark set after the stored ones were read', async () => {
    const store = storage({ s1: { at: 1, entry: 'e1' } })
    store.release()
    const book = seenBook(store)
    expect(await book.get('s1')).toEqual({ at: 1, entry: 'e1' })
    await book.set('s1', { at: 2, entry: 'e2' })
    expect(await book.get('s1')).toEqual({ at: 2, entry: 'e2' })
    await book.set('s1', { at: 3, entry: 'e3' })
    expect(await book.get('s1')).toEqual({ at: 3, entry: 'e3' })
  })

  it('keeps a mark set while the stored ones are read over its stored one, and the rest', async () => {
    const store = storage({ s1: { at: 1, entry: 'old' }, s2: { at: 1, entry: 'other' } })
    const book = seenBook(store)
    const written = book.set('s1', { at: 5, entry: 'new' })
    await Promise.resolve()
    expect(store.written).toHaveLength(0)
    store.release()
    await written
    expect(await book.get('s1')).toEqual({ at: 5, entry: 'new' })
    expect(store.written.at(-1)).toEqual({
      s1: { at: 5, entry: 'new' },
      s2: { at: 1, entry: 'other' },
    })
  })

  it('writes one at a time, the last write holding the latest marks', async () => {
    const store = storage({})
    store.release()
    const book = seenBook(store)
    await book.get('s1')
    const writes = [1, 2, 3, 4].map((at) => book.set('s1', { at, entry: `e${at}` }))
    await Promise.all(writes)
    expect(store.mostAtOnce()).toBe(1)
    expect(store.written.at(-1)).toEqual({ s1: { at: 4, entry: 'e4' } })
    expect(store.written.length).toBeLessThan(4)
  })

  it('starts empty from storage it cannot read', async () => {
    const store = storage(null, { failRead: true })
    store.release()
    const book = seenBook(store)
    expect(await book.get('s1')).toBeNull()
    await book.set('s1', { at: 1, entry: null })
    expect(store.written.at(-1)).toEqual({ s1: { at: 1, entry: null } })
  })

  it('writes nothing once closed', async () => {
    const store = storage({})
    store.release()
    const book = seenBook(store)
    await book.get('s1')
    book.close()
    await book.set('s1', { at: 1, entry: null })
    expect(store.written).toHaveLength(0)
  })
})
