import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlanLimit } from '@shared/agent-host'
import { planQuota } from '@shared/plan-quota'
import {
  applyPatches,
  threadFromSnapshot,
  type ConfigOption,
  type SessionView,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import { agentError } from './agents'
import { CLAUDE_CODE } from './catalog'
import { claudeSdkDriver } from './claude/driver'
import type { SdkMessage } from './claude/sdk'
import { mapRateLimits as codexLimits } from './codex/account'
import type { RateLimitSnapshot } from './codex/protocol'
import { AgentRequestError, type PermissionAnswer, type SessionTarget } from './connection'
import fixtures from './fixtures/plan-limit-stops.json'
import {
  checkDelay,
  isLimitStop,
  LIMIT_RESUME_TIMINGS,
  limitPause,
  resetInMessage,
  resetOf,
  resumeKind,
  sessionQuota,
  staggered,
  stillOut,
} from './limit-resume'
import { newTurnScope, type MapperEffect, type MapperOutput } from './session-updates'
import { parseSessionsFile } from './storage'
import { FakeChild, FakeClaudeSdk } from './testing/fake-claude-sdk'

const NOW = 1_800_000_000_000
const RESET = 1_800_018_000_000
const MINUTE = 60_000

const session: SessionView = {
  id: 'k1',
  agentId: 'claude-code',
  projectPath: '/repo',
  acpSessionId: null,
  status: 'ready',
  title: null,
  config: [],
  commands: [],
  usage: null,
  error: null,
  turnStartedAt: null,
  turnStartUsed: null,
  createdAt: 1,
  updatedAt: 1,
  parentId: null,
  origin: 'user',
  subagent: null,
  routine: null,
  queue: [],
  queuePaused: false,
}

const failed = (message: string, data?: unknown) =>
  agentError(new AgentRequestError('agent_error', message, null, data))

const limit = (changes: Partial<PlanLimit>): PlanLimit => ({
  window: 'five_hour',
  label: '5-hour',
  usedPercent: 100,
  resetsAt: RESET,
  state: 'reached',
  observedAt: NOW,
  ...changes,
})

class Target implements SessionTarget {
  thread: ThreadState = threadFromSnapshot({ session, entries: [], seq: 0 })
  readonly effects: MapperEffect[] = []
  private readonly scope = newTurnScope()
  private counter = 0
  context() {
    return {
      thread: this.thread,
      replaying: false,
      cancelling: false,
      scope: this.scope,
      now: NOW,
      nextId: () => `e:${++this.counter}`,
      sessionIdFor: (id: string) => `kite-${id}`,
    }
  }
  apply(output: MapperOutput): void {
    this.thread = applyPatches(this.thread, output.patches)
    this.effects.push(...output.effects)
  }
  requestPermission(): Promise<PermissionAnswer> {
    return new Promise(() => {})
  }
  send(): void {}
  startMode(): string | null {
    return null
  }
}

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Claude Code through the SDK driver, its SDK a stand-in that plays what a test scripts. */
async function claude() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kite-limit-'))
  dirs.push(dir)
  const entry = path.join(dir, 'sdk.mjs')
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '0.3.314' }))
  const sdk = new FakeClaudeSdk()
  const driver = claudeSdkDriver(async () => sdk)
  await driver.load?.()
  const connection = driver.connect({
    def: CLAUDE_CODE,
    hooks: { traffic: () => {}, account: () => {}, ignored: () => {}, log: () => {} },
    spec: {
      command: entry,
      args: [],
      env: { CLAUDE_CODE_EXECUTABLE: '/opt/claude/bin/claude' },
      shell: false,
      display: { command: entry, args: [], env: {} },
    },
    env: { PATH: '/usr/bin', HOME: '/home/ada' },
    spawn: () => new FakeChild() as never,
  })
  await connection.initialize('1.0.0')
  const target = new Target()
  const { sessionId } = await connection.newSession('/repo')
  connection.register(sessionId, target)
  return { sdk, connection, target, sessionId }
}

describe('a turn stopped at the plan limit', () => {
  it("is Claude Code's, from its rate limit event, message and result", async () => {
    const { sdk, connection, target, sessionId } = await claude()
    sdk.script = (query) => {
      query.running()
      const [event, assistant, result] = fixtures['claude-code'].messages.map(
        (message) => ({ ...message, session_id: query.sessionId }) as unknown as SdkMessage,
      )
      query.emit(event!, assistant!)
      query.finish(result as Extract<SdkMessage, { type: 'result' }>)
    }
    const error = await connection
      .prompt(sessionId, [{ type: 'text', text: 'go on' }])
      .then(() => null)
      .catch((reason: unknown) => agentError(reason))
    expect(error).toMatchObject({ code: 'agent_error' })
    // The event's window is what the agent's limits keep, which says when the plan is back.
    const limits = target.effects.flatMap((effect) =>
      effect.kind === 'limit' ? [effect.limit] : [],
    )
    expect(limits).toMatchObject([{ window: 'five_hour', state: 'reached', resetsAt: RESET }])
    const quota = planQuota({ limits }, NOW)
    expect(isLimitStop(error!, quota)).toBe(true)
    expect(resetOf(error!, quota, NOW)).toBe(RESET)
  })

  it("is Claude Code 1's, with the reset in its words", () => {
    const error = failed(fixtures['claude-code-1'].message)
    expect(isLimitStop(error, { kind: 'unknown' })).toBe(true)
    expect(resetInMessage(error.message, NOW)).toBe(RESET)
  })

  it("is Codex's, from its error and the rate limits it pushed", () => {
    const [limits, , completed] = fixtures.codex.notifications
    const turnError = (
      completed!.params as {
        turn: { error: { message: string; codexErrorInfo: string; additionalDetails: null } }
      }
    ).turn.error
    // As the Codex connection fails the turn: its details, else its message, and the error info.
    const error = failed(turnError.additionalDetails ?? turnError.message, {
      codexErrorInfo: turnError.codexErrorInfo,
      message: turnError.message,
    })
    const windows = codexLimits(
      (limits!.params as { rateLimits: RateLimitSnapshot }).rateLimits,
      NOW,
    )
    const quota = planQuota({ limits: windows }, NOW)
    expect(isLimitStop(error, quota)).toBe(true)
    expect(resetOf(error, quota, NOW)).toBe(RESET)
  })

  it("is an ACP agent's that names a used-up quota, with a reset when it gives one", () => {
    const [capacity, exhausted] = fixtures.gemini.errors
    const first = failed(capacity!.message)
    expect(isLimitStop(first, { kind: 'unknown' })).toBe(true)
    expect(resetInMessage(first.message, NOW)).toBe(NOW + (2 * 60 + 5) * MINUTE + 30_000)
    const second = failed(exhausted!.message)
    expect(isLimitStop(second, { kind: 'unknown' })).toBe(true)
    expect(resetInMessage(second.message, NOW)).toBeNull()
  })

  it("is any agent's whose own limits show the model's window used up", () => {
    const quota = planQuota({ limits: [limit({})] }, NOW)
    expect(isLimitStop(failed('Something went wrong'), quota)).toBe(true)
    expect(isLimitStop(failed('Something went wrong'), { kind: 'unknown' })).toBe(false)
  })

  it('is no credit that ran out, sign-in or other failure', () => {
    const out = planQuota({ limits: [limit({})] }, NOW)
    expect(isLimitStop(failed('Credit balance is too low'), out)).toBe(false)
    expect(
      isLimitStop(agentError(new AgentRequestError('auth_required', 'usage limit reached')), out),
    ).toBe(false)
    expect(
      isLimitStop(failed('Busy', { codexErrorInfo: 'serverOverloaded' }), { kind: 'unknown' }),
    ).toBe(false)
  })

  it("counts only the windows that hold back the session's model", () => {
    const model: ConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      value: 'sonnet',
      choices: [
        { value: 'opus', name: 'Opus' },
        { value: 'sonnet', name: 'Sonnet' },
      ],
    }
    const opusWeek = limit({ window: 'seven_day_opus', label: 'Weekly · Opus' })
    expect(sessionQuota({ limits: [opusWeek] }, [model], NOW).kind).not.toBe('out')
    expect(sessionQuota({ limits: [opusWeek] }, [{ ...model, value: 'opus' }], NOW)).toMatchObject({
      kind: 'out',
      resetsAt: RESET,
    })
  })
})

describe('when a paused session goes on', () => {
  const timings = LIMIT_RESUME_TIMINGS

  it('a margin after the reset, apart from the other paused sessions', () => {
    const at = RESET + timings.marginMs
    expect(limitPause({ since: NOW, resetsAt: RESET, checks: 0, taken: [] }, NOW, timings)).toEqual(
      { since: NOW, resetsAt: RESET, resumeAt: at, checks: 0 },
    )
    const taken = [at, at + timings.gapMs, at + 10 * timings.gapMs]
    expect(
      limitPause({ since: NOW, resetsAt: RESET, checks: 0, taken }, NOW, timings).resumeAt,
    ).toBe(at + 2 * timings.gapMs)
    expect(staggered(at, [at - timings.gapMs, at + timings.gapMs], timings.gapMs)).toBe(at)
    expect(staggered(at, [at + 1], timings.gapMs)).toBe(at + 1 + timings.gapMs)
  })

  it('reads the limits again, ever further apart, when the reset is not known', () => {
    expect(limitPause({ since: NOW, resetsAt: null, checks: 0, taken: [] }, NOW, timings)).toEqual({
      since: NOW,
      resetsAt: null,
      resumeAt: NOW + 10 * MINUTE,
      checks: 0,
    })
    expect([0, 1, 2, 3, 10].map((checks) => checkDelay(checks, timings) / MINUTE)).toEqual([
      10, 20, 40, 60, 60,
    ])
    // A reset already past that the plan still refuses is no reset to wait for.
    expect(
      limitPause({ since: NOW, resetsAt: NOW - MINUTE, checks: 1, taken: [] }, NOW, timings),
    ).toMatchObject({ resetsAt: null, resumeAt: NOW + 20 * MINUTE })
  })

  it('waits on while the plan is still used up, and goes on once it is not', () => {
    expect(stillOut(planQuota({ limits: [limit({})] }, NOW), NOW)).toEqual({ resetsAt: RESET })
    expect(stillOut(planQuota({ limits: [limit({ resetsAt: null })] }, NOW), NOW)).toEqual({
      resetsAt: null,
    })
    // The window reset: its reading no longer counts.
    expect(stillOut(planQuota({ limits: [limit({})] }, RESET + 1), RESET + 1)).toBeNull()
    expect(stillOut({ kind: 'open', usedPercent: 12 }, NOW)).toBeNull()
    expect(stillOut({ kind: 'unknown' }, NOW)).toBeNull()
  })
})

describe('how a paused session goes on', () => {
  const user = (id: string): ThreadEntry => ({
    kind: 'user',
    id,
    content: [{ type: 'text', text: 'go' }],
    at: NOW,
  })
  const stopped: ThreadEntry = {
    kind: 'notice',
    id: 'n1',
    severity: 'error',
    title: 'The turn failed',
    cause: 'turn_failed',
    planLimit: true,
  }
  const reply: ThreadEntry = {
    kind: 'agent',
    id: 'a1',
    markdown: 'Reading.',
    attachments: [],
    streaming: false,
  }
  const thread = (entries: ThreadEntry[], queued = 0) =>
    threadFromSnapshot({
      session: {
        ...session,
        queue: Array.from({ length: queued }, (_, i) => ({
          id: `q${i}`,
          content: [{ type: 'text' as const, text: `next ${i}` }],
          at: NOW,
        })),
        queuePaused: queued > 0,
      },
      entries,
      seq: 0,
    })

  it('sends its message again when the turn did nothing but fail', () => {
    expect(resumeKind(thread([user('u1'), stopped]))).toBe('resend')
  })

  it('asks the agent to carry on after work it did', () => {
    expect(resumeKind(thread([user('u1'), reply, stopped]))).toBe('continue')
  })

  it('sends what was queued behind it first', () => {
    expect(resumeKind(thread([user('u1'), stopped], 1))).toBe('queue')
    expect(resumeKind(thread([user('u1'), reply, stopped], 2))).toBe('queue')
  })
})

describe('a stored limit pause', () => {
  const record = {
    id: 's1',
    agentId: 'codex',
    acpSessionId: 'thread-1',
    projectPath: '/repo',
    title: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastViewedAt: null,
    parentId: null,
    origin: 'user',
    description: null,
    branch: null,
  }

  it("outlasts a restart with the session's own choice", () => {
    const pause = { since: NOW, resetsAt: RESET, resumeAt: RESET + MINUTE, checks: 2 }
    const file = parseSessionsFile({
      sessions: [{ ...record, limitPause: pause, autoResume: false }],
    })
    expect(file).toMatchObject({ sessions: [{ id: 's1', limitPause: pause, autoResume: false }] })
  })

  it('is dropped when it does not read, and the session stays stopped', () => {
    for (const limitPause of [
      { since: NOW, resetsAt: 'soon', resumeAt: RESET, checks: 0 },
      { since: NOW, resetsAt: null, resumeAt: RESET, checks: -1 },
      { since: NOW, resetsAt: null, checks: 0 },
      'paused',
    ]) {
      const file = parseSessionsFile({ sessions: [{ ...record, limitPause, autoResume: 'yes' }] })
      expect(typeof file).toBe('object')
      const [stored] = (file as unknown as { sessions: Record<string, unknown>[] }).sessions
      expect(stored).not.toHaveProperty('limitPause')
      expect(stored).not.toHaveProperty('autoResume')
    }
  })
})
