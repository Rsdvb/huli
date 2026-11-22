import { describe, expect, it } from 'vitest'
import {
  budgetSpent,
  canDispatch,
  canSend,
  cut,
  DEFAULT_MANAGER_LIMITS,
  DEFAULT_MANAGER_SETTINGS,
  effectiveManager,
  findWorker,
  firstLine,
  HELD_MAX,
  isSettled,
  managerMayAnswer,
  managerSettingsProblem,
  mergeDigest,
  projectManagerProblem,
  readManagerSettings,
  readOnlyDecision,
  readProjectManager,
  readStoredManager,
  readStoredWorker,
  restartPlan,
  RESUME_SPACING_MS,
  reviewNext,
  rosterProblem,
  verdictIn,
  workerId,
  workerProblem,
  type DispatchState,
  type LoopContext,
  type ManagerSettings,
  type RosterWorker,
} from './manager'

const worker = (over: Partial<RosterWorker> = {}): RosterWorker => ({
  id: 'w-0a1b2c3d',
  name: '写手',
  role: 'implement',
  agentId: 'codex',
  model: 'gpt-5.5',
  effort: 'high',
  profileId: null,
  mode: null,
  worktree: false,
  persona: '你写代码干净利落。',
  ...over,
})

const reviewer = worker({ id: 'w-11111111', name: '审阅', role: 'review', agentId: 'claude-code' })

const settings = (over: Partial<ManagerSettings> = {}): ManagerSettings => ({
  ...structuredClone(DEFAULT_MANAGER_SETTINGS),
  workers: [worker(), reviewer],
  reviewerId: reviewer.id,
  ...over,
})

describe('roster checks', () => {
  it('accepts a full entry', () => {
    expect(workerProblem(worker())).toBeNull()
  })

  it('refuses unknown fields, bad ids, names and roles', () => {
    expect(workerProblem({ ...worker(), extra: 1 })).toMatch(/unknown field/)
    expect(workerProblem(worker({ id: 'x' }))).toMatch(/id/)
    expect(workerProblem(worker({ name: '' }))).toMatch(/name/)
    expect(workerProblem(worker({ name: ' 写手' }))).toMatch(/name/)
    expect(workerProblem(worker({ name: 'a'.repeat(21) }))).toMatch(/name/)
    expect(workerProblem(worker({ name: 'a\nb' }))).toMatch(/name/)
    expect(workerProblem(worker({ role: 'boss' as never }))).toMatch(/role/)
    expect(workerProblem(worker({ agentId: 'not an agent' as never }))).toMatch(/agentId/)
  })

  it('counts a name in characters, not UTF-16 units', () => {
    expect(workerProblem(worker({ name: '🐱'.repeat(20) }))).toBeNull()
  })

  it('refuses empty optional strings, long personas and a reviewer with a worktree', () => {
    expect(workerProblem(worker({ model: '' }))).toMatch(/model/)
    expect(workerProblem(worker({ persona: 'x'.repeat(4001) }))).toMatch(/persona/)
    expect(workerProblem(worker({ role: 'review', worktree: true }))).toMatch(/worktree/)
    expect(workerProblem(worker({ role: 'other', worktree: true }))).toBeNull()
  })

  it('refuses repeated names ignoring case, repeated ids and a wrong reviewer', () => {
    const a = worker({ name: 'Writer' })
    const b = worker({ id: 'w-22222222', name: 'writer' })
    expect(rosterProblem([a, b], null)).toMatch(/repeats the name/)
    expect(rosterProblem([a, worker({ name: 'Other' })], null)).toMatch(/repeats the id/)
    expect(rosterProblem([a], 'w-99999999')).toMatch(/reviewerId/)
    expect(rosterProblem([a], a.id)).toMatch(/review role/)
    expect(rosterProblem([a, reviewer], reviewer.id)).toBeNull()
  })

  it('holds the roster to 12 entries', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      worker({ id: `w-${String(i).padStart(8, '0')}`, name: `w${i}` }),
    )
    expect(rosterProblem(many, null)).toMatch(/at most 12/)
    expect(rosterProblem(many.slice(0, 12), null)).toBeNull()
  })

  it('finds a worker by name ignoring case and spaces', () => {
    const roster = [worker({ name: 'Writer' })]
    expect(findWorker(roster, ' writer ')?.id).toBe('w-0a1b2c3d')
    expect(findWorker(roster, 'reviewer')).toBeUndefined()
  })

  it('makes ids from random bytes', () => {
    expect(workerId(new Uint8Array([0, 1, 171, 255, 9]))).toBe('w-0001abff')
  })
})

describe('settings checks', () => {
  it('accepts the defaults and a full roster', () => {
    expect(managerSettingsProblem(DEFAULT_MANAGER_SETTINGS)).toBeNull()
    expect(managerSettingsProblem(settings())).toBeNull()
  })

  it('needs every field and refuses others', () => {
    const partial: Partial<ManagerSettings> = settings()
    delete partial.afterRestart
    expect(managerSettingsProblem(partial)).toMatch(/needs "afterRestart"/)
    expect(managerSettingsProblem({ ...settings(), more: true })).toMatch(/unknown field/)
  })

  it('checks limits within their ranges', () => {
    const limits = (over: object) => settings({ limits: { ...DEFAULT_MANAGER_LIMITS, ...over } })
    expect(managerSettingsProblem(limits({ concurrent: 0 }))).toMatch(/concurrent/)
    expect(managerSettingsProblem(limits({ concurrent: 7 }))).toMatch(/concurrent/)
    expect(managerSettingsProblem(limits({ turnsPerTask: 4 }))).toMatch(/turnsPerTask/)
    expect(managerSettingsProblem(limits({ reviewRounds: 1.5 }))).toMatch(/reviewRounds/)
    expect(managerSettingsProblem(limits({ tokenBudget: 5 }))).toMatch(/tokenBudget/)
    expect(managerSettingsProblem(limits({ tokenBudget: 2_000_000 }))).toBeNull()
  })

  it('checks the approvals choice and the suggestion', () => {
    expect(managerSettingsProblem(settings({ approvals: 'all' as never }))).toMatch(/approvals/)
    expect(
      managerSettingsProblem(
        settings({ suggestion: { agentId: 'claude-code', model: 'glm-5.3', profileId: 'p1' } }),
      ),
    ).toBeNull()
    expect(
      managerSettingsProblem(
        settings({ suggestion: { agentId: 'x y' as never, model: null, profileId: null } }),
      ),
    ).toMatch(/suggestion/)
  })

  it('reads stored settings, keeping what is valid', () => {
    const problems: string[] = []
    const read = readManagerSettings(
      {
        workers: [worker(), { bad: true }, worker({ id: 'w-33333333' }), reviewer],
        reviewerId: reviewer.id,
        autoReview: false,
        approvals: 'low',
        limits: { concurrent: 99 },
        afterRestart: 'tell',
      },
      problems,
    )
    expect(read.workers.map((item) => item.id)).toEqual(['w-0a1b2c3d', reviewer.id])
    expect(read.reviewerId).toBe(reviewer.id)
    expect(read.autoReview).toBe(false)
    expect(read.approvals).toBe('low')
    expect(read.limits).toEqual(DEFAULT_MANAGER_LIMITS)
    expect(read.afterRestart).toBe('tell')
    expect(problems).toHaveLength(3)
  })

  it('drops a reviewer that is gone or not a reviewer', () => {
    const read = readManagerSettings({ workers: [worker()], reviewerId: 'w-0a1b2c3d' }, [])
    expect(read.reviewerId).toBeNull()
    expect(readManagerSettings('nope', []).workers).toEqual([])
  })

  it('checks and reads a project override', () => {
    expect(projectManagerProblem({ workers: [worker()], reviewerId: null })).toBeNull()
    expect(projectManagerProblem({ workers: [worker()] })).toMatch(/needs/)
    expect(projectManagerProblem({ workers: [], reviewerId: null, extra: 1 })).toMatch(/unknown/)
    expect(
      readProjectManager({ workers: [worker(), 3], reviewerId: 'gone', approvals: 'low' }),
    ).toEqual({
      workers: [worker()],
      reviewerId: null,
      approvals: 'low',
    })
    expect(readProjectManager(null)).toBeNull()
  })

  it('takes a project override over the settings', () => {
    const own = worker({ id: 'w-44444444', name: '本项目写手' })
    const merged = effectiveManager(settings({ approvals: 'user' }), {
      workers: [own],
      reviewerId: null,
      approvals: 'low',
    })
    expect(merged.workers).toEqual([own])
    expect(merged.reviewerId).toBeNull()
    expect(merged.approvals).toBe('low')
    expect(merged.autoReview).toBe(true)
    expect(effectiveManager(settings(), null)).toEqual(settings())
  })
})

const state = (over: Partial<DispatchState> = {}): DispatchState => ({
  paused: false,
  stopped: false,
  task: { turns: 0, extraTurns: 0, tokens: 0 },
  limits: DEFAULT_MANAGER_LIMITS,
  working: [],
  held: 0,
  ...over,
})

const request = { writes: true, folder: '/p', ownWorktree: false }

describe('dispatch', () => {
  it('starts when nothing stands in the way', () => {
    expect(canDispatch(state(), request)).toEqual({ kind: 'start' })
  })

  it('refuses when stopped or paused, stopped first', () => {
    expect(canDispatch(state({ stopped: true, paused: true }), request)).toEqual({
      kind: 'refuse',
      code: 'stopped',
    })
    expect(canDispatch(state({ paused: true }), request)).toEqual({
      kind: 'refuse',
      code: 'paused',
    })
  })

  it('refuses once the turns or tokens are spent, counting extra turns', () => {
    expect(canDispatch(state({ task: { turns: 30, extraTurns: 0, tokens: 0 } }), request)).toEqual({
      kind: 'refuse',
      code: 'turns',
    })
    expect(canDispatch(state({ task: { turns: 30, extraTurns: 10, tokens: 0 } }), request)).toEqual(
      {
        kind: 'start',
      },
    )
    const budget = { ...DEFAULT_MANAGER_LIMITS, tokenBudget: 100_000 }
    expect(
      canDispatch(
        state({ limits: budget, task: { turns: 1, extraTurns: 0, tokens: 100_000 } }),
        request,
      ),
    ).toEqual({ kind: 'refuse', code: 'tokens' })
    expect(budgetSpent({ turns: 0, extraTurns: 0, tokens: 99_999 }, budget)).toBeNull()
  })

  it('holds when every slot works', () => {
    const working = [1, 2, 3].map((n) => ({ id: `s${n}`, folder: `/f${n}`, writes: false }))
    expect(canDispatch(state({ working }), request)).toEqual({ kind: 'hold', reason: 'slots' })
  })

  it('holds a writer whose folder another writer works in, unless it has its own worktree', () => {
    const working = [{ id: 's1', folder: '/p', writes: true }]
    expect(canDispatch(state({ working }), request)).toEqual({ kind: 'hold', reason: 'folder' })
    expect(canDispatch(state({ working }), { ...request, ownWorktree: true })).toEqual({
      kind: 'start',
    })
    expect(canDispatch(state({ working }), { ...request, writes: false })).toEqual({
      kind: 'start',
    })
    const reader = [{ id: 's1', folder: '/p', writes: false }]
    expect(canDispatch(state({ working: reader }), request)).toEqual({ kind: 'start' })
  })

  it('refuses rather than holds past the held limit', () => {
    const working = [1, 2, 3].map((n) => ({ id: `s${n}`, folder: '/x', writes: false }))
    expect(canDispatch(state({ working, held: HELD_MAX }), request)).toEqual({
      kind: 'refuse',
      code: 'held',
    })
  })

  it('lets a message into a working worker, and holds an idle one to the limits', () => {
    const working = [1, 2, 3].map((n) => ({ id: `s${n}`, folder: '/x', writes: false }))
    expect(canSend(state({ working }), { ...request, workerId: 's1', working: true })).toEqual({
      kind: 'send',
    })
    expect(canSend(state({ working }), { ...request, workerId: 's9', working: false })).toEqual({
      kind: 'refuse',
      code: 'slots',
    })
    // The worker's own slot is not another's.
    expect(
      canSend(state({ working: working.slice(0, 2) }), {
        ...request,
        workerId: 's1',
        working: false,
      }),
    ).toEqual({ kind: 'send' })
    expect(canSend(state({ paused: true }), { ...request, workerId: 's1', working: true })).toEqual(
      {
        kind: 'refuse',
        code: 'paused',
      },
    )
  })
})

describe('settling', () => {
  const idle = { turn: false, waiting: 0, queued: 0, queuePaused: false, limitPaused: false }

  it('settles only with nothing running, waiting or going on', () => {
    expect(isSettled(idle)).toBe(true)
    expect(isSettled({ ...idle, turn: true })).toBe(false)
    expect(isSettled({ ...idle, waiting: 1 })).toBe(false)
    expect(isSettled({ ...idle, queued: 1 })).toBe(false)
    expect(isSettled({ ...idle, queued: 1, queuePaused: true })).toBe(true)
    expect(isSettled({ ...idle, limitPaused: true })).toBe(false)
  })
})

describe('review loop', () => {
  const ctx = (over: Partial<LoopContext> = {}): LoopContext => ({
    enabled: true,
    reviewer: true,
    rounds: 3,
    budget: true,
    paused: false,
    stopped: false,
    detached: false,
    ...over,
  })
  const done = { who: 'implementer' as const, status: 'done' as const, verdict: null }
  const review = (verdict: 'approve' | 'changes' | null, status = 'done' as const) => ({
    who: 'reviewer' as const,
    status,
    verdict,
  })

  it('starts round 1 when an implementation is done', () => {
    expect(reviewNext(null, done, ctx())).toEqual({ kind: 'review', round: 1 })
  })

  it('does not start without the loop, a reviewer, budget, or a finished implementation', () => {
    expect(reviewNext(null, done, ctx({ enabled: false }))).toEqual({ kind: 'none' })
    expect(reviewNext(null, done, ctx({ reviewer: false }))).toEqual({ kind: 'none' })
    expect(reviewNext(null, done, ctx({ budget: false }))).toEqual({ kind: 'none' })
    expect(reviewNext(null, { ...done, status: 'failed' }, ctx())).toEqual({ kind: 'none' })
    expect(reviewNext(null, review('approve'), ctx())).toEqual({ kind: 'none' })
    expect(reviewNext(null, done, ctx({ detached: true }))).toEqual({ kind: 'none' })
  })

  it('waits while paused', () => {
    expect(reviewNext(null, done, ctx({ paused: true }))).toEqual({ kind: 'wait' })
    const fixing = { round: 2, state: 'fixing' as const }
    expect(reviewNext(fixing, done, ctx({ paused: true }))).toEqual({ kind: 'wait' })
  })

  it('finishes approved, or sends changes back with the next round', () => {
    const reviewing = { round: 1, state: 'reviewing' as const }
    expect(reviewNext(reviewing, review('approve'), ctx())).toEqual({
      kind: 'finish',
      state: 'approved',
    })
    expect(reviewNext(reviewing, review('changes'), ctx())).toEqual({ kind: 'fix', round: 2 })
  })

  it('goes back to review once the implementer fixed it', () => {
    expect(reviewNext({ round: 2, state: 'fixing' }, done, ctx())).toEqual({
      kind: 'review',
      round: 2,
    })
  })

  it('runs a whole loop: changes, fix, changes, fix, approve', () => {
    let loop: { round: number; state: 'reviewing' | 'fixing' } = { round: 1, state: 'reviewing' }
    const steps = [review('changes'), done, review('changes'), done, review('approve')]
    const actions = steps.map((event) => {
      const action = reviewNext(loop, event, ctx())
      if (action.kind === 'fix') loop = { round: action.round, state: 'fixing' }
      if (action.kind === 'review') loop = { round: action.round, state: 'reviewing' }
      return action.kind === 'finish' ? action.state : action.kind
    })
    expect(actions).toEqual(['fix', 'review', 'fix', 'review', 'approved'])
    expect(loop.round).toBe(3)
  })

  it('stops at the last round', () => {
    expect(reviewNext({ round: 3, state: 'reviewing' }, review('changes'), ctx())).toEqual({
      kind: 'finish',
      state: 'out_of_rounds',
    })
    expect(
      reviewNext({ round: 1, state: 'reviewing' }, review('changes'), ctx({ rounds: 1 })),
    ).toEqual({ kind: 'finish', state: 'out_of_rounds' })
  })

  it('fails on a failed turn or a review without a verdict', () => {
    expect(reviewNext({ round: 1, state: 'reviewing' }, review(null), ctx())).toEqual({
      kind: 'finish',
      state: 'failed',
    })
    expect(
      reviewNext({ round: 1, state: 'reviewing' }, review('approve', 'failed' as never), ctx()),
    ).toEqual({
      kind: 'finish',
      state: 'failed',
    })
    expect(
      reviewNext({ round: 2, state: 'fixing' }, { ...done, status: 'blocked' }, ctx()),
    ).toEqual({
      kind: 'finish',
      state: 'failed',
    })
  })

  it('stops when stopped, taken over or out of budget', () => {
    const fixing = { round: 2, state: 'fixing' as const }
    expect(reviewNext(fixing, done, ctx({ stopped: true }))).toEqual({
      kind: 'finish',
      state: 'stopped',
    })
    expect(reviewNext(fixing, done, ctx({ detached: true }))).toEqual({
      kind: 'finish',
      state: 'stopped',
    })
    expect(reviewNext(fixing, done, ctx({ budget: false }))).toEqual({
      kind: 'finish',
      state: 'stopped',
    })
    expect(
      reviewNext({ round: 1, state: 'reviewing' }, review('changes'), ctx({ budget: false })),
    ).toEqual({
      kind: 'finish',
      state: 'stopped',
    })
  })

  it('ignores the other side and an ended loop', () => {
    expect(reviewNext({ round: 1, state: 'reviewing' }, done, ctx())).toEqual({ kind: 'none' })
    expect(reviewNext({ round: 2, state: 'fixing' }, review('approve'), ctx())).toEqual({
      kind: 'none',
    })
    expect(reviewNext({ round: 2, state: 'approved' }, done, ctx())).toEqual({ kind: 'none' })
  })
})

describe('read-only guard', () => {
  it('allows reads and the project checks, refuses changes, asks about the rest', () => {
    expect(readOnlyDecision({ level: 'low', reason: 'readProject' }, 'read')).toBe('allow')
    expect(readOnlyDecision({ level: 'low', reason: 'readCommand' }, 'execute')).toBe('allow')
    expect(readOnlyDecision({ level: 'low', reason: 'projectCheck' }, 'execute')).toBe('allow')
    expect(readOnlyDecision({ level: 'medium', reason: 'editProject' }, 'execute')).toBe('deny')
    expect(readOnlyDecision({ level: 'high', reason: 'delete' }, 'execute')).toBe('deny')
    expect(readOnlyDecision({ level: 'high', reason: 'unparsed' }, 'execute')).toBe('deny')
    expect(readOnlyDecision({ level: 'medium', reason: 'gitWrite' }, 'execute')).toBe('deny')
    expect(readOnlyDecision({ level: 'medium', reason: 'network' }, 'fetch')).toBe('ask')
    expect(readOnlyDecision({ level: 'medium', reason: 'mcp' }, 'other')).toBe('ask')
    expect(readOnlyDecision(null, 'other')).toBe('ask')
  })

  it('refuses edit, delete and move calls whatever their risk says', () => {
    expect(readOnlyDecision({ level: 'low', reason: 'readProject' }, 'edit')).toBe('deny')
    expect(readOnlyDecision(null, 'delete')).toBe('deny')
    expect(readOnlyDecision(null, 'move')).toBe('deny')
  })

  it('lets the manager answer only low requests, only when allowed', () => {
    expect(managerMayAnswer('low', 'low')).toBe(true)
    expect(managerMayAnswer('low', 'medium')).toBe(false)
    expect(managerMayAnswer('low', 'high')).toBe(false)
    expect(managerMayAnswer('low', null)).toBe(false)
    expect(managerMayAnswer('user', 'low')).toBe(false)
  })
})

describe('restart plan', () => {
  const manager = {
    id: 'm',
    stopped: false,
    paused: false,
    afterRestart: 'resume' as const,
    concurrent: 2,
  }
  const owed = (id: string, over = {}) => ({
    id,
    managerId: 'm',
    owed: true,
    running: false,
    detached: false,
    resumedAt: null,
    ...over,
  })

  it('resumes owed workers up to the slots and holds the rest', () => {
    expect(restartPlan([owed('a'), owed('b'), owed('c')], [manager], 1_000)).toEqual({
      resume: ['a', 'b'],
      hold: ['c'],
      tell: [],
    })
  })

  it('leaves alone what is not owed, runs, was taken over or belongs to a stopped manager', () => {
    const workers = [
      owed('a', { owed: false }),
      owed('b', { running: true }),
      owed('c', { detached: true }),
      owed('d', { managerId: 'gone' }),
    ]
    expect(restartPlan(workers, [manager], 1_000)).toEqual({ resume: [], hold: [], tell: [] })
    expect(restartPlan([owed('a')], [{ ...manager, stopped: true }], 1_000).resume).toEqual([])
    expect(restartPlan([owed('a')], [{ ...manager, paused: true }], 1_000).resume).toEqual([])
  })

  it('tells instead of resuming when set so, or when resumed a moment ago', () => {
    expect(restartPlan([owed('a')], [{ ...manager, afterRestart: 'tell' }], 1_000).tell).toEqual([
      'a',
    ])
    const now = 50 * 60_000
    expect(restartPlan([owed('a', { resumedAt: now - 60_000 })], [manager], now).tell).toEqual([
      'a',
    ])
    expect(
      restartPlan([owed('a', { resumedAt: now - RESUME_SPACING_MS })], [manager], now).resume,
    ).toEqual(['a'])
  })
})

describe('digests and text', () => {
  it('merges a worker into a waiting digest, the newest last', () => {
    const a = { sessionId: 'a', name: '写手', status: 'done' as const, line: 'x' }
    const b = { sessionId: 'b', name: '杂活', status: 'failed' as const, line: 'y' }
    const a2 = { ...a, status: 'approved' as const, line: 'z', round: 2 }
    expect(mergeDigest(mergeDigest(mergeDigest([], a), b), a2)).toEqual([b, a2])
  })

  it('holds a digest to 12 items', () => {
    let items: ReturnType<typeof mergeDigest> = []
    for (let i = 0; i < 15; i++) {
      items = mergeDigest(items, { sessionId: `s${i}`, name: 'n', status: 'done', line: '' })
    }
    expect(items).toHaveLength(12)
    expect(items[0]!.sessionId).toBe('s3')
  })

  it('cuts by characters with an ellipsis', () => {
    expect(cut('你好世界', 4)).toBe('你好世界')
    expect(cut('你好世界啊', 4)).toBe('你好世…')
    expect(firstLine('\n\n  first line  \nsecond', 100)).toBe('first line')
  })

  it('reads a verdict line from a reply, the last one winning', () => {
    expect(verdictIn('Looks fine.\nVERDICT: APPROVE')).toBe('approve')
    expect(verdictIn('verdict：changes\n…\nVerdict: **approve**')).toBe('approve')
    expect(verdictIn('I approve of this')).toBeNull()
  })
})

describe('stored records', () => {
  it('reads a manager field back, dropping bad parts', () => {
    const stored = readStoredManager(
      {
        autoReview: true,
        approvals: 'low',
        task: {
          since: 5,
          turns: 3,
          extraTurns: 'x',
          tokens: 100,
          cost: 0.5,
          unpriced: 1,
          wakes: 2,
        },
        paused: true,
        held: [
          {
            id: 'h1',
            workerId: 'w-0a1b2c3d',
            name: '写手',
            title: 't',
            kind: 'implement',
            prompt: 'p',
            at: 1,
          },
          { id: 'bad' },
        ],
        loops: [
          {
            id: 'l1',
            implementerId: 's1',
            reviewerId: null,
            round: 1,
            state: 'reviewing',
            startedAt: 2,
          },
          { id: 'l2', state: 'nope' },
        ],
        answers: [{ at: 1, workerId: 's1', name: '杂活', what: 'pnpm test', allowed: true }],
        digest: 'q1',
      },
      9,
    )
    expect(stored).toEqual({
      autoReview: true,
      approvals: 'low',
      task: { since: 5, turns: 3, extraTurns: 0, tokens: 100, cost: 0.5, unpriced: 1, wakes: 2 },
      paused: true,
      held: [
        {
          id: 'h1',
          workerId: 'w-0a1b2c3d',
          name: '写手',
          title: 't',
          kind: 'implement',
          prompt: 'p',
          at: 1,
        },
      ],
      loops: [
        {
          id: 'l1',
          implementerId: 's1',
          reviewerId: null,
          round: 1,
          state: 'reviewing',
          startedAt: 2,
        },
      ],
      answers: [{ at: 1, workerId: 's1', name: '杂活', what: 'pnpm test', allowed: true }],
      digest: 'q1',
    })
  })

  it('takes a manager field without a task or lists as a new one', () => {
    expect(readStoredManager({ autoReview: false }, 7)).toEqual({
      autoReview: false,
      approvals: 'user',
      task: { since: 7, turns: 0, extraTurns: 0, tokens: 0, cost: 0, unpriced: 0, wakes: 0 },
      held: [],
      loops: [],
      answers: [],
    })
    expect(readStoredManager({ approvals: 'low' }, 7)).toBeNull()
    expect(readStoredManager(null, 7)).toBeNull()
  })

  it('reads a worker field back with its report', () => {
    const raw = {
      managerId: 'm1',
      workerId: 'w-0a1b2c3d',
      name: '写手',
      role: 'implement',
      kind: 'implement',
      title: '修复时钟',
      base: 'abc123',
      owed: 10,
      interjected: ['a', 3, 'b', 'c', 'd'],
      tokens: 1200,
      cost: 0.02,
      report: {
        at: 11,
        status: 'done',
        by: 'tool',
        summary: '改好了',
        changed: [{ path: 'src/a.ts', added: 3, removed: 1 }, { path: '' }],
        verdict: 'changes',
        findings: [
          { level: 'must', file: 'src/a.ts', line: 4, text: 'null' },
          { level: 'x', text: 'y' },
        ],
      },
    }
    expect(readStoredWorker(raw)).toEqual({
      managerId: 'm1',
      workerId: 'w-0a1b2c3d',
      name: '写手',
      role: 'implement',
      kind: 'implement',
      title: '修复时钟',
      base: 'abc123',
      owed: 10,
      interjected: ['b', 'c', 'd'],
      tokens: 1200,
      cost: 0.02,
      report: {
        at: 11,
        status: 'done',
        by: 'tool',
        summary: '改好了',
        changed: [{ path: 'src/a.ts', added: 3, removed: 1 }],
        verdict: 'changes',
        findings: [{ level: 'must', file: 'src/a.ts', line: 4, text: 'null' }],
      },
    })
  })

  it('refuses a worker field without its manager or with a bad role', () => {
    const base = {
      managerId: 'm1',
      workerId: 'w-0a1b2c3d',
      name: 'n',
      role: 'implement',
      kind: 'review',
      title: '',
    }
    expect(readStoredWorker(base)).not.toBeNull()
    expect(readStoredWorker({ ...base, managerId: '' })).toBeNull()
    expect(readStoredWorker({ ...base, role: 'boss' })).toBeNull()
    expect(readStoredWorker({ ...base, report: { status: 'nope' } })?.report).toBeUndefined()
  })
})
