import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GitTools } from '@shared/git'
import type { PrFlowState, RunCause } from '@shared/github-flow'
import type { Exec, ExecResult } from '../git/exec'
import type { GithubFlowFile, JsonFile, StoredPrFlow } from '../storage'
import { parseIncluded } from './gh-api'
import { FAST_MS, GithubFlow, MIN_INTERVAL_MS, nextDelay, SLOW_MS, type FlowTrigger } from './flow'
import greenJson from './fixtures/pr-green.json'
import failingJson from './fixtures/pr-failing.json'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const READY: GitTools = {
  git: { found: true, version: '2.50.0' },
  gh: { state: 'ready', version: '2.104.0', account: 'octocat' },
}
const GREEN_URL = 'https://github.com/octo-org/hello-world/pull/44'
const FAILING_URL = 'https://github.com/octo-org/hello-world/pull/43'
const REPO_INFO = JSON.stringify({
  default_branch: 'main',
  allow_squash_merge: true,
  allow_merge_commit: true,
  allow_rebase_merge: false,
})

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '', failure: null, message: '' }
}

function http(body: string, etag = 'W/"e1"'): string {
  return `HTTP/2.0 200 OK\nEtag: ${etag}\r\nContent-Type: application/json\r\n\r\n${body}`
}

type Answer = (args: string[]) => ExecResult | undefined

function harness(options: {
  flows?: { sessionId: string; flow: StoredPrFlow; busy?: boolean }[]
  triggers?: FlowTrigger[]
  answer?: Answer
}) {
  let time = START
  const timers: { run: () => void; at: number; id: number }[] = []
  let ids = 0
  const calls: string[][] = []
  const flows = options.flows ?? []
  const notes: { sessionId: string; severity: string; title: string; description?: string }[] = []
  const told: { sessionId: string; text: string }[] = []
  const states: { sessionId: string; state: PrFlowState | null }[] = []
  const fired: { routineId: string; cause: RunCause; context: string }[] = []
  const closed: string[] = []
  let saved: GithubFlowFile | null = null
  const exec: Exec = (file, args) => {
    calls.push([file, ...args])
    const answer = options.answer?.([...args])
    if (answer) return Promise.resolve(answer)
    if (args[0] === 'api' && args.at(-1) === 'repos/octo-org/hello-world') {
      return Promise.resolve(ok(http(REPO_INFO)))
    }
    if (args[0] === 'pr' && args[1] === 'merge') return Promise.resolve(ok(''))
    return Promise.resolve({
      code: 1,
      stdout: '',
      stderr: 'unexpected',
      failure: null,
      message: '',
    })
  }
  const file = {
    load: () => Promise.resolve({ version: 1, triggers: {} }),
    save: (data: GithubFlowFile) => {
      saved = data
    },
  } as unknown as JsonFile<GithubFlowFile>
  const flow = new GithubFlow({
    exec,
    home: '/home/me',
    tools: () => Promise.resolve(READY),
    repoOf: () => Promise.resolve({ owner: 'octo-org', repo: 'hello-world' }),
    sessions: {
      flows: () =>
        flows
          .filter((entry) => !entry.flow.ended)
          .map((entry) => ({
            sessionId: entry.sessionId,
            flow: entry.flow,
            folder: '/work/tree',
            busy: entry.busy ?? false,
            worktree: true,
          })),
      update: (sessionId, url, change) => {
        const entry = flows.find((item) => item.sessionId === sessionId)
        if (entry && entry.flow.url === url) entry.flow = change(entry.flow)
      },
      setState: (sessionId, state) => states.push({ sessionId, state }),
      note: (sessionId, severity, title, description) => {
        notes.push({ sessionId, severity, title, ...(description ? { description } : {}) })
        return Promise.resolve()
      },
      tell: (sessionId, text) => {
        told.push({ sessionId, text })
        return Promise.resolve(true)
      },
      closeMerged: (sessionId) =>
        Promise.resolve({
          removing: { branch: 'kite/fix-login' },
          kept: null,
          finish: () => {
            closed.push(sessionId)
            return Promise.resolve()
          },
        }),
    },
    routines: {
      triggers: () => options.triggers ?? [],
      idle: () => true,
      fire: (routineId, cause, context) => fired.push({ routineId, cause, context }),
    },
    file,
    log: () => {},
    now: () => time,
    timers: {
      set(run, ms) {
        const id = ++ids
        timers.push({ run, at: time + ms, id })
        return id
      },
      clear(handle) {
        const at = timers.findIndex((timer) => timer.id === handle)
        if (at >= 0) timers.splice(at, 1)
      },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  return {
    flow,
    calls,
    notes,
    told,
    states,
    fired,
    closed,
    flows,
    timers,
    saved: () => saved,
    /** Runs the next timer, moving the clock to it, and waits for its read. */
    async next(): Promise<number> {
      timers.sort((a, b) => a.at - b.at)
      const timer = timers.shift()
      if (!timer) throw new Error('no timer')
      const waited = timer.at - time
      time = timer.at
      timer.run()
      await settle()
      return waited
    },
    settle,
    advance(ms: number) {
      time += ms
    },
  }
}

const START = Date.parse('2026-11-21T00:00:00Z')

const autoMerge = (url: string): StoredPrFlow => ({ url, autoMerge: true, watch: false, seen: [] })

describe('the GitHub flow’s reads', () => {
  it('reads nothing and sets no timer while nothing is turned on', async () => {
    const h = harness({})
    await h.flow.refresh()
    expect(h.timers).toEqual([])
    expect(h.calls).toEqual([])
    expect(h.flow.watchedRepos()).toEqual([])
  })

  it('waits at least a minute between reads, longer while hidden or failing, at most 30 minutes', () => {
    expect(nextDelay(FAST_MS, 0, true)).toBe(MIN_INTERVAL_MS)
    expect(nextDelay(10, 0, true)).toBe(MIN_INTERVAL_MS)
    expect(nextDelay(SLOW_MS, 0, false)).toBe(SLOW_MS * 3)
    expect(nextDelay(FAST_MS, 3, true)).toBe(4 * 60_000)
    expect(nextDelay(FAST_MS, 20, true)).toBe(30 * 60_000)
  })

  it('merges a green pull request at its head, then notes it and archives the session', async () => {
    const h = harness({
      flows: [{ sessionId: 's1', flow: autoMerge(GREEN_URL) }],
      answer: (args) =>
        args[0] === 'pr' && args[1] === 'view' ? ok(JSON.stringify(greenJson)) : undefined,
    })
    await h.flow.refresh()
    expect(await h.next()).toBe(0)
    const merge = h.calls.find((call) => call[1] === 'pr' && call[2] === 'merge')
    expect(merge).toEqual([
      'gh',
      'pr',
      'merge',
      GREEN_URL,
      '--squash',
      '--match-head-commit',
      greenJson.headRefOid,
    ])
    expect(h.flows[0]?.flow.ended).toEqual({ state: 'merged' })
    expect(h.notes).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        severity: 'info',
        title: 'Merged pull request #44 (squash) once its checks passed',
        description: expect.stringContaining('kite/fix-login'),
      }),
    ])
    expect(h.closed).toEqual(['s1'])
    // Nothing left to read: the next plan drops the repository and its timer.
    await h.flow.refresh()
    expect(h.flow.watchedRepos()).toEqual([])
    expect(h.timers).toEqual([])
  })

  it('does not merge failing checks or while the agent works, and reads again in a minute', async () => {
    const h = harness({
      flows: [
        { sessionId: 's1', flow: autoMerge(FAILING_URL) },
        { sessionId: 's2', flow: autoMerge(GREEN_URL), busy: true },
      ],
      answer: (args) =>
        args[0] === 'pr' && args[1] === 'view'
          ? ok(JSON.stringify(args[2] === GREEN_URL ? greenJson : failingJson))
          : undefined,
    })
    await h.flow.refresh()
    await h.next()
    expect(h.calls.some((call) => call[2] === 'merge')).toBe(false)
    expect(h.states).toEqual(
      expect.arrayContaining([
        { sessionId: 's1', state: 'checks_failed' },
        { sessionId: 's2', state: 'waiting' },
      ]),
    )
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0]!.at - START).toBeGreaterThanOrEqual(SLOW_MS)
  })

  it('sends the ETag back and reuses the answer GitHub says did not change', async () => {
    let reads = 0
    const h = harness({
      flows: [{ sessionId: 's1', flow: autoMerge(GREEN_URL), busy: true }],
      answer: (args) => {
        if (args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify(greenJson))
        if (args[0] === 'api' && args.at(-1) === 'repos/octo-org/hello-world') {
          reads++
          if (reads === 1) return ok(http(REPO_INFO, 'W/"abc"'))
          expect(args).toContain('If-None-Match: W/"abc"')
          return {
            code: 1,
            stdout: fixture('not-modified.http'),
            stderr: 'gh: HTTP 304',
            failure: null,
            message: '',
          }
        }
        return undefined
      },
    })
    await h.flow.refresh()
    await h.next()
    expect(await h.next()).toBeGreaterThanOrEqual(MIN_INTERVAL_MS)
    expect(reads).toBe(2)
    expect(h.states.at(-1)).toEqual({ sessionId: 's1', state: 'waiting' })
  })

  it('backs off after failures and reads nothing while the computer sleeps', async () => {
    const h = harness({
      flows: [{ sessionId: 's1', flow: autoMerge(GREEN_URL) }],
      answer: (args) =>
        args[0] === 'pr'
          ? { code: 1, stdout: '', stderr: 'HTTP 502', failure: null, message: '' }
          : undefined,
    })
    await h.flow.refresh()
    await h.next()
    expect(await h.next()).toBe(FAST_MS)
    expect(await h.next()).toBe(2 * 60_000)
    h.flow.power('suspend')
    expect(h.timers).toEqual([])
    h.flow.power('resume')
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0]!.at).toBeGreaterThan(START)
  })

  it('tells the watching agent once of failed checks and a new comment', async () => {
    const watched: StoredPrFlow = { url: FAILING_URL, autoMerge: false, watch: true, seen: [] }
    const h = harness({
      flows: [{ sessionId: 's1', flow: watched }],
      answer: (args) => {
        if (args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify(failingJson))
        if (args[0] === 'api') return ok(http('[]'))
        return undefined
      },
    })
    await h.flow.refresh()
    await h.next()
    expect(h.told).toHaveLength(1)
    expect(h.told[0]!.text).toContain('build (windows-latest)')
    // Comments from before the watch began are not news.
    expect(h.told[0]!.text).not.toContain('bump the timeout')
    expect(h.notes[0]?.title).toBe('Told the agent about pull request #43: checks failed')
    expect(h.flows[0]!.flow.baselined).toBe(true)
    await h.next()
    expect(h.told).toHaveLength(1)
  })

  it('starts a routine’s run for an issue opened after it was armed, once', async () => {
    const listed = JSON.parse(parseIncluded(fixture('issues.http'))!.body) as Record<
      string,
      unknown
    >[]
    let issues = listed
    const h = harness({
      triggers: [
        {
          routineId: 'r-000000000001',
          projectPath: '/work',
          event: { kind: 'issue_opened', label: null },
        },
      ],
      answer: (args) =>
        args[0] === 'api' && String(args.at(-1)).startsWith('repos/octo-org/hello-world/issues?')
          ? ok(http(JSON.stringify(issues)))
          : undefined,
    })
    await h.flow.refresh()
    await h.next()
    expect(h.fired).toEqual([])
    issues = [
      { ...listed[0], number: 52, title: 'Crash on start', created_at: '2026-11-21T00:03:00Z' },
      ...listed,
    ]
    await h.next()
    expect(h.fired).toEqual([
      expect.objectContaining({
        routineId: 'r-000000000001',
        cause: {
          kind: 'issue_opened',
          title: '#52 Crash on start',
          url: 'https://github.com/octo-org/hello-world/issues/52',
        },
      }),
    ])
    expect(h.saved()?.triggers['r-000000000001']?.seen).toEqual(['issue:52'])
    await h.next()
    expect(h.fired).toHaveLength(1)
  })
})
