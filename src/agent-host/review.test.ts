import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_FINDINGS,
  parseCodexReview,
  parseReviewAnswer,
  parseStoredReview,
  placeFinding,
  relativeFindingPath,
  type ReviewRun,
} from '@shared/review'
import type { SessionView, ThreadState } from '@shared/thread'
import { anchoredFindings, reviewMark, reviewReply } from './review'
import { changesStored, parseStoredSession, storedSession } from './threads/model'

const fence = '```'
const answer = (json: unknown, tag = 'kite-review'): string =>
  `Looked at the changes.\n\n${fence}${tag}\n${JSON.stringify(json)}\n${fence}\n`

describe('the paths a reviewer names', () => {
  it('keeps a path inside the session folder, relative to it', () => {
    expect(relativeFindingPath('src/a.ts', '/p')).toBe('src/a.ts')
    expect(relativeFindingPath('./src/../lib/b.ts', '/p')).toBe('lib/b.ts')
    expect(relativeFindingPath('/p/src/a.ts', '/p')).toBe('src/a.ts')
    expect(relativeFindingPath('E:\\work\\app\\src\\a.ts', 'e:/Work/App')).toBe('src/a.ts')
  })

  it('refuses a path that leaves the folder, or is no path', () => {
    expect(relativeFindingPath('../secret.txt', '/p')).toBeNull()
    expect(relativeFindingPath('src/../../etc/passwd', '/p')).toBeNull()
    expect(relativeFindingPath('/etc/passwd', '/p')).toBeNull()
    expect(relativeFindingPath('/p', '/p')).toBeNull()
    expect(relativeFindingPath('/pother/a.ts', '/p')).toBeNull()
    expect(relativeFindingPath('C:\\Windows\\win.ini', 'E:\\work')).toBeNull()
    expect(relativeFindingPath('c:', '/p')).toBeNull()
    expect(relativeFindingPath('src/a\u0000.ts', '/p')).toBeNull()
    expect(relativeFindingPath('', '/p')).toBeNull()
    expect(relativeFindingPath('a/'.repeat(600), '/p')).toBeNull()
  })
})

describe("a reply to Kite's review prompt", () => {
  it('reads the findings of its kite-review block, worst first', () => {
    const parsed = parseReviewAnswer(
      answer({
        summary: 'Two problems.',
        findings: [
          { severity: 'low', title: 'Name is vague', file: 'src/a.ts', line: 3 },
          {
            severity: 'P0',
            title: 'Null user\nsecond line',
            detail: 'It throws.',
            path: 'src/b.ts',
            line: 10,
            endLine: 12,
          },
        ],
      }),
      '/p',
    )
    expect(parsed).toEqual({
      summary: 'Two problems.',
      findings: [
        {
          severity: 'critical',
          title: 'Null user',
          body: 'It throws.',
          path: 'src/b.ts',
          start: 10,
          end: 12,
        },
        { severity: 'low', title: 'Name is vague', body: '', path: 'src/a.ts', start: 3, end: 3 },
      ],
      dropped: 0,
    })
  })

  it('drops each finding that does not pass, and keeps the rest', () => {
    const parsed = parseReviewAnswer(
      answer({
        findings: [
          { severity: 'high', title: 'Escapes', file: '../../etc/passwd', line: 1 },
          { severity: 'urgent', title: 'Unknown severity', file: 'a.ts', line: 1 },
          { severity: 'high', title: '', file: 'a.ts', line: 1 },
          { severity: 'high', title: 'No line', file: 'a.ts' },
          { severity: 'high', title: 'Line zero', file: 'a.ts', line: 0 },
          { severity: 'high', title: 'Fraction', file: 'a.ts', line: 1.5 },
          { severity: 'high', title: 'Text line', file: 'a.ts', line: '4' },
          { severity: 'high', title: 7, file: 'a.ts', line: 1 },
          'not an object',
          null,
          { severity: 'high', title: 'Kept', file: 'a.ts', line: 2, endLine: 1 },
          { severity: 'high', title: 'Kept', file: 'a.ts', line: 2 },
        ],
      }),
      '/p',
    )
    expect(parsed?.findings.map((f) => [f.title, f.start, f.end])).toEqual([['Kept', 2, 2]])
    expect(parsed?.dropped).toBe(11)
  })

  it('takes nothing but the fields it knows from a finding', () => {
    const text = `${fence}kite-review\n{"findings": [{"__proto__": {"polluted": true}, "severity": "medium", "title": "Proto", "file": "a.ts", "line": 5, "state": "dismissed", "id": "x"}]}\n${fence}`
    const [finding] = parseReviewAnswer(text, '/p')!.findings
    expect(finding).toEqual({
      severity: 'medium',
      title: 'Proto',
      body: '',
      path: 'a.ts',
      start: 5,
      end: 5,
    })
    expect(Object.getPrototypeOf(finding)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('cuts long text, a span past its first line, and the list at its most', () => {
    const many = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => ({
      severity: 'medium',
      title: `T${i}`,
      file: 'a.ts',
      line: i + 1,
    }))
    const parsed = parseReviewAnswer(
      answer({
        summary: 's'.repeat(5_000),
        findings: [
          {
            severity: 'high',
            title: 't'.repeat(500),
            detail: 'd'.repeat(9_000),
            file: 'b.ts',
            line: 1,
            endLine: 99_999,
          },
          ...many,
        ],
      }),
      '/p',
    )!
    expect(parsed.findings).toHaveLength(MAX_FINDINGS)
    expect(parsed.dropped).toBe(6)
    const [first] = parsed.findings
    expect(first!.title).toHaveLength(160)
    expect(first!.body).toHaveLength(2000)
    expect(first!.end).toBe(2001)
    expect(parsed.summary).toHaveLength(1000)
  })

  it('reads a json block or a bare object, and nothing from a reply without one', () => {
    expect(parseReviewAnswer(answer({ findings: [] }, 'json'), '/p')).toEqual({
      summary: null,
      findings: [],
      dropped: 0,
    })
    expect(parseReviewAnswer('{"findings": []}', '/p')?.findings).toEqual([])
    expect(parseReviewAnswer('No problems found.', '/p')).toBeNull()
    expect(parseReviewAnswer(`${fence}kite-review\n{"findings": [}\n${fence}`, '/p')).toBeNull()
    expect(parseReviewAnswer(answer({ summary: 'no list' }), '/p')).toBeNull()
    expect(parseReviewAnswer(answer({ findings: 'x' }), '/p')).toBeNull()
    expect(parseReviewAnswer('x'.repeat(300_000), '/p')).toBeNull()
  })

  it('takes the last kite-review block over an earlier example', () => {
    const text =
      answer({ findings: [{ severity: 'low', title: 'Example', file: 'a.ts', line: 1 }] }) +
      answer({ findings: [{ severity: 'high', title: 'Real', file: 'a.ts', line: 2 }] })
    expect(parseReviewAnswer(text, '/p')?.findings.map((f) => f.title)).toEqual(['Real'])
  })
})

describe("Codex's review", () => {
  const review = [
    'The change breaks the empty list.',
    '',
    'Full review comments:',
    '',
    '- [P1] Handle an empty list \u2014 /work/app/src/list.ts:10-12',
    '  `first()` reads index 0 of a list',
    '  that can be empty.',
    '',
    '- [P3] Name the flag \u2014 /work/app/src/flags.ts:4-4',
    '  It reads as a typo.',
    '',
    '- [P0] Outside \u2014 /etc/passwd:1-1',
    '  Nothing to see.',
    '',
    '- Untagged \u2014 /work/app/src/a.ts:7-7',
  ].join('\n')

  it('reads each item, its priority as severity, its path under the folder', () => {
    expect(parseCodexReview(review, '/work/app')).toEqual({
      summary: 'The change breaks the empty list.',
      findings: [
        {
          severity: 'high',
          title: 'Handle an empty list',
          body: '`first()` reads index 0 of a list\nthat can be empty.',
          path: 'src/list.ts',
          start: 10,
          end: 12,
        },
        {
          severity: 'medium',
          title: 'Untagged',
          body: '',
          path: 'src/a.ts',
          start: 7,
          end: 7,
        },
        {
          severity: 'low',
          title: 'Name the flag',
          body: 'It reads as a typo.',
          path: 'src/flags.ts',
          start: 4,
          end: 4,
        },
      ],
      dropped: 1,
    })
  })

  it('reads one comment, Windows paths, and a review with none', () => {
    const one = [
      'Looks fine overall.',
      '',
      'Review comment:',
      '',
      '- [P2] Close the file \u2014 C:\\work\\app\\src\\io.ts:3-5',
      '  It leaks.',
    ].join('\r\n')
    expect(parseCodexReview(one, 'c:\\Work\\App').findings).toEqual([
      {
        severity: 'medium',
        title: 'Close the file',
        body: 'It leaks.',
        path: 'src/io.ts',
        start: 3,
        end: 5,
      },
    ])
    expect(parseCodexReview('No issues found.', '/p')).toEqual({
      summary: 'No issues found.',
      findings: [],
      dropped: 0,
    })
    expect(parseCodexReview('Reviewer failed to output a response.', '/p').summary).toBeNull()
  })
})

function run(fields: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'r1',
    source: 'prompt',
    mode: 'inline',
    status: 'done',
    startedAt: 1,
    endedAt: 2,
    summary: 'ok',
    error: null,
    findings: [
      {
        id: 'f1',
        severity: 'high',
        title: 'T',
        body: 'B',
        path: 'src/a.ts',
        start: 3,
        end: 4,
        anchor: 'const a = 1',
        state: 'open',
      },
    ],
    dropped: 0,
    ...fields,
  }
}

function view(fields: Partial<SessionView> = {}): SessionView {
  return {
    id: 's',
    agentId: 'codex',
    projectPath: '/p',
    acpSessionId: 'a',
    status: 'ready',
    title: 'T',
    config: [],
    commands: [],
    usage: null,
    error: null,
    turnStartedAt: null,
    turnStartUsed: null,
    createdAt: 0,
    updatedAt: 0,
    parentId: null,
    origin: 'user',
    subagent: null,
    routine: null,
    queue: [],
    queuePaused: false,
    ...fields,
  }
}

describe('the stored review', () => {
  it('goes with the thread and comes back as it was', () => {
    const stored = storedSession(view({ review: run() }))
    expect(changesStored({ review: run() })).toBe(true)
    expect(parseStoredSession(JSON.parse(JSON.stringify(stored)))?.review).toEqual(run())
  })

  it('reads a session stored before reviews, or a damaged review, as none', () => {
    const old = JSON.parse(JSON.stringify(storedSession(view()))) as Record<string, unknown>
    delete old.review
    expect(parseStoredSession(old)?.review).toBeNull()
    expect(parseStoredReview({ ...run(), source: 'gemini' })).toBeNull()
    expect(parseStoredReview({ ...run(), findings: 'x' })).toBeNull()
    expect(parseStoredReview('review')).toBeNull()
  })

  it('drops damaged findings alone, and reads a review cut off by a restart as stopped', () => {
    const good = run().findings[0]!
    const parsed = parseStoredReview({
      ...run({ status: 'running', endedAt: null }),
      findings: [
        good,
        { ...good, id: 'f2', start: 0 },
        { ...good, id: 'f3', end: 1 },
        { ...good, id: 'f4', state: 'fixed' },
        { ...good, id: 'f5', severity: 'urgent' },
        { ...good, id: '' },
        { ...good, id: 'f6', anchor: 4 },
      ],
      dropped: -1,
    })
    expect(parsed?.status).toBe('stopped')
    expect(parsed?.findings).toEqual([good])
    expect(parsed?.dropped).toBe(0)
  })
})

describe("a finding's place in the file as it is now", () => {
  const finding = { start: 3, end: 4, anchor: 'return x' }
  it('stays where its line still reads the same, follows it, or is outdated', () => {
    expect(placeFinding(finding, ['a', 'b', '  return x', 'c'])).toEqual({
      start: 3,
      end: 4,
      moved: false,
    })
    expect(placeFinding(finding, ['return x', 'a', 'b', 'c', 'd', 'return x'])).toEqual({
      start: 1,
      end: 2,
      moved: true,
    })
    expect(placeFinding(finding, ['a', 'b', 'c'])).toBeNull()
    expect(placeFinding({ ...finding, anchor: null }, ['a', 'b', 'c'])).toEqual({
      start: 3,
      end: 3,
      moved: false,
    })
    expect(placeFinding({ ...finding, anchor: null }, ['a'])).toBeNull()
  })
})

describe('what the host keeps of a review', () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it('anchors each finding to its line, and none to a file outside or missing', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'kite-review-'))
    const root = path.join(dir, 'app')
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'a.ts'), 'one\r\n  two  \r\n\r\nfour\n')
    await writeFile(path.join(dir, 'outside.ts'), 'secret\n')
    const base = { severity: 'high' as const, title: 'T', body: '' }
    const findings = await anchoredFindings(
      {
        summary: null,
        dropped: 0,
        findings: [
          { ...base, path: 'src/a.ts', start: 2, end: 2 },
          { ...base, path: 'src/a.ts', start: 3, end: 3 },
          { ...base, path: 'src/gone.ts', start: 1, end: 1 },
          { ...base, path: '../outside.ts', start: 1, end: 1 },
        ],
      },
      root,
    )
    expect(findings.map((f) => [f.id, f.anchor, f.state])).toEqual([
      ['f1', 'two', 'open'],
      ['f2', null, 'open'],
      ['f3', null, 'open'],
      ['f4', null, 'open'],
    ])
  })

  it("reads the reply to the prompt that carries the review's mark", () => {
    const thread: ThreadState = {
      session: view(),
      order: ['u1', 'a1', 'u2', 'a2', 't', 'a3'],
      byId: {
        u1: { kind: 'user', id: 'u1', content: [{ type: 'text', text: 'Hi' }] },
        a1: { kind: 'agent', id: 'a1', markdown: 'Before', attachments: [], streaming: false },
        u2: {
          kind: 'user',
          id: 'u2',
          content: [{ type: 'text', text: `Review ${reviewMark('r1')}` }],
          kettu: true,
        },
        a2: { kind: 'agent', id: 'a2', markdown: 'Reading', attachments: [], streaming: false },
        t: { kind: 'thought', id: 't', markdown: 'hmm', streaming: false },
        a3: { kind: 'agent', id: 'a3', markdown: 'Found', attachments: [], streaming: false },
      },
    }
    expect(reviewReply(thread, 'r1')).toBe('Reading\n\nFound')
    expect(reviewReply(thread, 'r2')).toBeNull()
  })
})
