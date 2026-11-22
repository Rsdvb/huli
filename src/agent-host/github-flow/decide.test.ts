import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isGithubEvent } from '@shared/github-flow'
import conflictJson from './fixtures/pr-conflict.json'
import failingJson from './fixtures/pr-failing.json'
import greenJson from './fixtures/pr-green.json'
import {
  advanceCursor,
  mergeDecision,
  mergeMethodOf,
  readyHead,
  remember,
  SEEN_KEPT,
  triggerFires,
  wakeMessage,
  watchEvents,
  type TriggerCursor,
} from './decide'
import {
  actionsJobOf,
  mapFlowPullRequest,
  mapRepoInfo,
  mapRestIssues,
  parseIncluded,
  type FlowPullRequest,
} from './gh-api'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const repo = { owner: 'octo-org', repo: 'hello-world' }
const idle = { busy: false, readyBefore: null, methods: null }

function pr(json: unknown, change: Partial<FlowPullRequest> = {}): FlowPullRequest {
  return { ...mapFlowPullRequest(json), ...change }
}

describe('reading what gh records', () => {
  it('maps a pull request that conflicts with its base', () => {
    const conflict = pr(conflictJson)
    expect(conflict).toMatchObject({
      number: 42,
      state: 'open',
      mergeable: 'conflicting',
      mergeState: 'DIRTY',
      review: 'review_required',
      author: 'octocat',
      base: 'main',
      head: 'kite/fix-login',
    })
    expect(conflict.headOid).toMatch(/^[0-9a-f]{40}$/)
    expect(conflict.checks.state).toBe('passing')
  })

  it('maps failing checks, a bot review and the comments', () => {
    const failing = pr(failingJson)
    expect(failing.checks.state).toBe('failing')
    expect(failing.checks.runs[0]).toMatchObject({
      name: 'Unit and Integration Tests / build (windows-latest)',
      outcome: 'failed',
    })
    expect(failing.reviews).toEqual([
      expect.objectContaining({ author: 'copilot-pull-request-reviewer', state: 'COMMENTED' }),
    ])
    expect(failing.comments.map((comment) => comment.author)).toEqual(['hubot', 'octocat'])
  })

  it('splits gh api --include output, a 304 included, and leaves pull requests out of issues', () => {
    const answer = parseIncluded(fixture('issues.http'))
    expect(answer?.status).toBe(200)
    expect(answer?.headers.get('etag')).toBe('W/"6c1f2a0b7d9e"')
    expect(answer?.headers.get('link')).toContain('rel="next"')
    const issues = mapRestIssues(JSON.parse(answer!.body), repo)
    expect(issues.map((issue) => issue.number)).toEqual([51, 50])
    expect(issues[0]).toMatchObject({
      url: 'https://github.com/octo-org/hello-world/issues/51',
      assignees: ['octocat'],
      labels: [
        { name: 'bug', color: 'd73a4a' },
        { name: 'kite', color: '0e8a16' },
      ],
      author: 'hubot',
    })
    expect(issues[1]?.body).toBe('')
    // gh ends the status line with LF and each header with CRLF, as recorded.
    const recorded = fixture('issues.http').replace(/\r?\n/g, (_, at: number) =>
      at === fixture('issues.http').indexOf('\n') ? '\n' : '\r\n',
    )
    const crlf = parseIncluded(recorded)
    expect(crlf?.headers.get('etag')).toBe('W/"6c1f2a0b7d9e"')
    expect(mapRestIssues(JSON.parse(crlf!.body), repo)).toHaveLength(2)
    expect(parseIncluded(fixture('not-modified.http'))?.status).toBe(304)
    expect(parseIncluded('gh: not json')).toBeNull()
  })

  it('reads the merge methods a repository allows, or none known for a reader', () => {
    expect(
      mapRepoInfo({
        default_branch: 'main',
        allow_squash_merge: false,
        allow_merge_commit: true,
        allow_rebase_merge: true,
      }),
    ).toEqual({ defaultBranch: 'main', methods: ['merge', 'rebase'] })
    expect(mapRepoInfo({ default_branch: 'trunk' })).toEqual({
      defaultBranch: 'trunk',
      methods: null,
    })
    expect(mergeMethodOf(null)).toBe('squash')
    expect(mergeMethodOf(['rebase'])).toBe('rebase')
    expect(mergeMethodOf([])).toBeNull()
  })

  it('finds the Actions run and job of a check', () => {
    expect(
      actionsJobOf('https://github.com/octo-org/hello-world/actions/runs/41720844033/job/12621'),
    ).toEqual({ run: '41720844033', job: '12621' })
    expect(actionsJobOf('https://ci.example.com/build/1')).toBeNull()
    expect(actionsJobOf(null)).toBeNull()
  })
})

describe('merging once the checks pass', () => {
  it('merges a green, approved, clean pull request at the head whose checks passed', () => {
    const green = pr(greenJson)
    expect(mergeDecision(green, idle)).toEqual({
      kind: 'merge',
      method: 'squash',
      headOid: green.headOid,
    })
    expect(mergeDecision(green, { ...idle, methods: ['merge', 'rebase'] })).toMatchObject({
      kind: 'merge',
      method: 'merge',
    })
  })

  it('waits for failing or running checks, a conflict, a change request, a review and the agent', () => {
    const green = pr(greenJson)
    expect(mergeDecision(pr(failingJson), idle)).toEqual({ kind: 'wait', state: 'checks_failed' })
    expect(mergeDecision(pr(conflictJson), idle)).toEqual({ kind: 'wait', state: 'conflict' })
    const pending = {
      ...green.checks,
      state: 'pending' as const,
      pending: 1,
    }
    expect(mergeDecision({ ...green, checks: pending }, idle)).toEqual({
      kind: 'wait',
      state: 'waiting',
    })
    expect(mergeDecision({ ...green, review: 'changes_requested' }, idle)).toEqual({
      kind: 'wait',
      state: 'changes_requested',
    })
    expect(mergeDecision({ ...green, mergeState: 'BLOCKED' }, idle)).toEqual({
      kind: 'wait',
      state: 'blocked',
    })
    expect(mergeDecision({ ...green, mergeState: 'BEHIND' }, idle).kind).toBe('wait')
    // Mergeable but with a check that is not required failing: not "checks pass".
    expect(mergeDecision({ ...green, mergeState: 'UNSTABLE' }, idle).kind).toBe('wait')
    expect(mergeDecision({ ...green, mergeable: 'unknown' }, idle).kind).toBe('wait')
    expect(mergeDecision({ ...green, state: 'draft' }, idle)).toEqual({
      kind: 'wait',
      state: 'blocked',
    })
    expect(mergeDecision(green, { ...idle, busy: true })).toEqual({
      kind: 'wait',
      state: 'waiting',
    })
  })

  it('needs two reads of the same head when the pull request has no checks at all', () => {
    const none = { state: 'none' as const, passed: 0, failed: 0, pending: 0, runs: [] }
    const bare = { ...pr(greenJson), checks: none }
    expect(mergeDecision(bare, idle).kind).toBe('wait')
    expect(readyHead(bare)).toBe(bare.headOid)
    expect(mergeDecision(bare, { ...idle, readyBefore: bare.headOid }).kind).toBe('merge')
    expect(mergeDecision(bare, { ...idle, readyBefore: 'f'.repeat(40) }).kind).toBe('wait')
    expect(readyHead(pr(greenJson))).toBeNull()
  })

  it('stops at a merged or closed pull request, and when no method is allowed', () => {
    const green = pr(greenJson)
    expect(mergeDecision({ ...green, state: 'merged' }, idle)).toEqual({
      kind: 'stop',
      state: 'merged',
    })
    expect(mergeDecision({ ...green, state: 'closed' }, idle)).toEqual({
      kind: 'stop',
      state: 'closed',
    })
    expect(mergeDecision(green, { ...idle, methods: [] })).toMatchObject({
      kind: 'stop',
      state: 'failed',
    })
  })
})

describe('watching a pull request for its agent', () => {
  it('tells of failing checks, a review and a reviewer comment once each, not the author’s', () => {
    const failing = pr(failingJson)
    const first = watchEvents(failing, new Set(), true)
    expect(first.events.map((event) => event.key)).toEqual([
      `checks:${failing.headOid}`,
      `review:${failing.reviews[0]!.id}`,
      'comment:IC_kwDOA1',
    ])
    const seen = new Set(first.events.map((event) => event.key))
    expect(watchEvents(failing, seen, true).events).toEqual([])
    // A new head with checks failing again is a new event.
    const pushed = { ...failing, headOid: 'a'.repeat(40) }
    expect(watchEvents(pushed, seen, true).events.map((event) => event.key)).toEqual([
      `checks:${'a'.repeat(40)}`,
    ])
  })

  it('takes reviews and comments from before the watch as seen, but tells of failures', () => {
    const failing = pr(failingJson)
    const { events, quiet } = watchEvents(failing, new Set(), false)
    expect(events.map((event) => event.kind)).toEqual(['checks_failed'])
    expect(quiet).toEqual([`review:${failing.reviews[0]!.id}`, 'comment:IC_kwDOA1'])
  })

  it('tells of a conflict once per head, and nothing once merged or closed', () => {
    const conflict = pr(conflictJson)
    expect(watchEvents(conflict, new Set(), true).events).toEqual([
      { key: `conflict:${conflict.headOid}`, kind: 'conflict' },
    ])
    expect(watchEvents({ ...pr(failingJson), state: 'merged' }, new Set(), true).events).toEqual([])
  })

  it('writes one message with the failed checks, the log command, conflicts and reviews', () => {
    const failing = pr(failingJson)
    const { events } = watchEvents(failing, new Set(), true)
    const message = wakeMessage(failing, events, {
      conflicts: null,
      lineComments: [
        {
          author: 'copilot-pull-request-reviewer',
          path: 'build.go',
          line: 12,
          body: 'This never returns.',
          createdAt: 0,
        },
      ],
    })
    expect(message).toContain('#43')
    expect(message).toContain(failing.url)
    expect(message).toContain('build (windows-latest)')
    expect(message).toContain('gh run view 41720844033 --job 126212878432 --log-failed')
    expect(message).toContain('build.go:12: This never returns.')
    expect(message).toContain('> Could you also bump the timeout?')
    const conflict = pr(conflictJson)
    const told = wakeMessage(conflict, watchEvents(conflict, new Set(), true).events, {
      conflicts: ['src/login.ts', 'README.md'],
      lineComments: [],
    })
    expect(told).toContain('- src/login.ts\n- README.md')
  })

  it('remembers at most the newest keys', () => {
    const many = Array.from({ length: SEEN_KEPT + 5 }, (_, i) => `k${i}`)
    const kept = remember([], many)
    expect(kept).toHaveLength(SEEN_KEPT)
    expect(kept.at(-1)).toBe(`k${SEEN_KEPT + 4}`)
    expect(remember(['a', 'b'], ['a'])).toEqual(['b', 'a'])
  })
})

describe('GitHub events that start a routine', () => {
  const armed: TriggerCursor = {
    signature: 's',
    armedAt: Date.parse('2026-11-19T12:00:00Z'),
    baselined: false,
    seen: [],
  }
  const issues = mapRestIssues(JSON.parse(parseIncluded(fixture('issues.http'))!.body), repo).map(
    (issue) => ({ ...issue, labels: issue.labels.map((label) => label.name) }),
  )

  it('runs for issues opened after the trigger was armed, with the label when one is set', () => {
    const all = triggerFires(
      { kind: 'issue_opened', label: null },
      { kind: 'issue_opened', issues },
      armed,
    )
    expect(all.fires.map((fire) => fire.key)).toEqual(['issue:51'])
    expect(all.fires[0]?.cause).toEqual({
      kind: 'issue_opened',
      title: '#51 Login times out on slow networks',
      url: 'https://github.com/octo-org/hello-world/issues/51',
    })
    expect(all.fires[0]?.context).toContain('Throttle the network')
    const labelled = triggerFires(
      { kind: 'issue_opened', label: 'KITE' },
      { kind: 'issue_opened', issues },
      { ...armed, armedAt: 0 },
    )
    expect(labelled.fires.map((fire) => fire.key)).toEqual(['issue:51'])
    const after = advanceCursor(armed, { kind: 'issue_opened', label: null }, all.quiet, [
      'issue:51',
    ])
    expect(
      triggerFires({ kind: 'issue_opened', label: null }, { kind: 'issue_opened', issues }, after)
        .fires,
    ).toEqual([])
  })

  it('takes failing checks that were there when armed as the state things are in', () => {
    const failing = pr(failingJson)
    const snapshot = {
      kind: 'checks_failed' as const,
      prs: [
        {
          url: failing.url,
          number: 43,
          title: failing.title,
          headOid: failing.headOid,
          checks: failing.checks,
        },
      ],
    }
    const first = triggerFires({ kind: 'checks_failed' }, snapshot, armed)
    expect(first.fires).toEqual([])
    expect(first.quiet).toEqual([`checks:43:${failing.headOid}`])
    const cursor = advanceCursor(armed, { kind: 'checks_failed' }, first.quiet, [])
    const pushed = { ...snapshot, prs: [{ ...snapshot.prs[0]!, headOid: 'b'.repeat(40) }] }
    const next = triggerFires({ kind: 'checks_failed' }, pushed, cursor)
    expect(next.fires.map((fire) => fire.key)).toEqual([`checks:43:${'b'.repeat(40)}`])
    expect(next.fires[0]?.context).toContain('build (windows-latest)')
  })

  it('runs once per push after the first read, and again for a branch put back', () => {
    const event = { kind: 'pushed' as const, branch: 'main' }
    const at = (oid: string) => ({ kind: 'pushed' as const, branch: 'main', oid })
    const first = triggerFires(event, at('1'.repeat(40)), armed)
    expect(first.fires).toEqual([])
    let cursor = advanceCursor(armed, event, first.quiet, [])
    expect(triggerFires(event, at('1'.repeat(40)), cursor).fires).toEqual([])
    const second = triggerFires(event, at('2'.repeat(40)), cursor)
    expect(second.fires.map((fire) => fire.key)).toEqual([`push:${'2'.repeat(40)}`])
    cursor = advanceCursor(cursor, event, second.quiet, [second.fires[0]!.key])
    expect(cursor.seen).toEqual([`push:${'2'.repeat(40)}`])
    expect(triggerFires(event, at('1'.repeat(40)), cursor).fires).toHaveLength(1)
  })

  it('runs once per branch tip that falls behind, not for one behind when armed', () => {
    const event = { kind: 'behind' as const, branch: 'release' }
    const at = (oid: string, behind: number) => ({
      kind: 'behind' as const,
      branch: 'release',
      base: 'main',
      oid,
      behind,
    })
    const first = triggerFires(event, at('1'.repeat(40), 3), armed)
    expect(first.fires).toEqual([])
    const cursor = advanceCursor(armed, event, first.quiet, [])
    expect(triggerFires(event, at('2'.repeat(40), 0), cursor).fires).toEqual([])
    const behind = triggerFires(event, at('2'.repeat(40), 2), cursor)
    expect(behind.fires[0]?.cause.title).toBe('release is 2 commits behind main')
  })

  it('accepts only the events and fields a routine may name', () => {
    expect(isGithubEvent({ kind: 'issue_opened', label: null })).toBe(true)
    expect(isGithubEvent({ kind: 'issue_opened', label: 'good first issue' })).toBe(true)
    expect(isGithubEvent({ kind: 'issue_opened', label: 'a,b' })).toBe(false)
    expect(isGithubEvent({ kind: 'pr_opened' })).toBe(true)
    expect(isGithubEvent({ kind: 'pr_opened', extra: 1 })).toBe(false)
    expect(isGithubEvent({ kind: 'pushed', branch: 'feature/x' })).toBe(true)
    for (const branch of ['', '-x', 'a..b', 'a b', 'a/', 'x.lock', 'a~1']) {
      expect(isGithubEvent({ kind: 'behind', branch })).toBe(false)
    }
    expect(isGithubEvent({ kind: 'deploy' })).toBe(false)
  })
})
