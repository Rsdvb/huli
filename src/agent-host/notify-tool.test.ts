import { describe, expect, it } from 'vitest'
import type { Caller } from './artifacts/tools'
import {
  NOTE_BODY_CHARS,
  NOTE_TITLE_CHARS,
  NoteLimiter,
  NOTIFY_TOOL,
  NotifyTools,
  parseNote,
  type Note,
} from './notify-tool'

const caller = (sessionId: string) => ({ sessionId, project: '/p' }) as Caller

describe('parseNote', () => {
  it('keeps one line of plain text, without control or reordering marks', () => {
    const note = parseNote({
      title: ' Build\n\tdone\u0007 ',
      body: 'All ‮tests‬ passed\u0000.\r\nNext: ship.',
    })
    expect(note).toEqual({ title: 'Build done', body: 'All tests passed. Next: ship.' })
  })

  it('cuts a long title or body, and takes no body as empty', () => {
    const note = parseNote({ title: '长'.repeat(200), body: 'x'.repeat(2000) })
    expect([...note.title]).toHaveLength(NOTE_TITLE_CHARS)
    expect(note.title.endsWith('…')).toBe(true)
    expect(note.body).toHaveLength(NOTE_BODY_CHARS)
    expect(parseNote({ title: 'T' }).body).toBe('')
  })

  it('refuses what is not a note', () => {
    expect(() => parseNote(null)).toThrow()
    expect(() => parseNote(['T'])).toThrow()
    expect(() => parseNote({ body: 'B' })).toThrow()
    expect(() => parseNote({ title: ' ​\n' })).toThrow()
    expect(() => parseNote({ title: 'T', body: 7 })).toThrow()
    expect(() => parseNote({ title: 'T', sessionId: 'other' })).toThrow()
  })
})

describe('NoteLimiter', () => {
  it('lets a session send 3 a minute, then says how long to wait', () => {
    let now = 1_000_000
    const limiter = new NoteLimiter(undefined, () => now)
    for (let i = 0; i < 3; i++) {
      expect(limiter.take('s1').ok).toBe(true)
      now += 1000
    }
    const refused = limiter.take('s1')
    expect(refused).toEqual({ ok: false, retryMs: 57_000 })
    // Another session has its own count.
    expect(limiter.take('s2').ok).toBe(true)
    now += 57_000
    expect(limiter.take('s1').ok).toBe(true)
  })

  it('holds a session to 30 an hour however slowly it sends', () => {
    let now = 0
    const limiter = new NoteLimiter(undefined, () => now)
    for (let i = 0; i < 30; i++) {
      expect(limiter.take('s1').ok).toBe(true)
      now += 61_000
    }
    const refused = limiter.take('s1')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.retryMs).toBe(3_600_000 - 30 * 61_000)
    now = 3_600_000
    expect(limiter.take('s1').ok).toBe(true)
  })

  it('counts no refused call', () => {
    let now = 0
    const limiter = new NoteLimiter(undefined, () => now)
    for (let i = 0; i < 3; i++) limiter.take('s1')
    for (let i = 0; i < 10; i++) expect(limiter.take('s1').ok).toBe(false)
    now = 60_000
    expect(limiter.take('s1').ok).toBe(true)
  })
})

describe('NotifyTools', () => {
  it("raises the caller's own note until the limit, then refuses without raising it", () => {
    const raised: [string, Note][] = []
    const tools = new NotifyTools({
      notify: (sessionId, note) => {
        raised.push([sessionId, note])
        return 'sent'
      },
      now: () => 0,
    })
    for (let i = 0; i < 3; i++) {
      expect(tools.call(caller('s1'), NOTIFY_TOOL, { title: `T${i}` }).isError).toBeUndefined()
    }
    const refused = tools.call(caller('s1'), NOTIFY_TOOL, { title: 'T3' })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({ code: 'limited' })
    expect(raised.map(([id, note]) => `${id}:${note.title}`)).toEqual(['s1:T0', 's1:T1', 's1:T2'])
  })

  it('refuses a bad note and a session it does not hold', () => {
    const tools = new NotifyTools({ notify: () => 'none' })
    expect(tools.call(caller('s1'), NOTIFY_TOOL, { title: '' }).structuredContent).toMatchObject({
      code: 'invalid',
    })
    expect(tools.call(caller('s1'), NOTIFY_TOOL, { title: 'T' }).structuredContent).toMatchObject({
      code: 'not_found',
    })
  })
})
