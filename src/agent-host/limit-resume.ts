// Huli: a turn its agent's plan limit stopped goes on by itself once the plan resets. These are the
// decisions behind it: whether a failure was the plan's limit, when the plan comes back, when each
// paused session goes on, and what it sends then. The session manager keeps the pauses and timers.

import type { AgentStatus } from '@shared/agent-host'
import { limitsForModel } from '@shared/plan-limits'
import { planQuota, type PlanQuota } from '@shared/plan-quota'
import type { LimitPause } from '@shared/supervisor'
import { retryableTurn, type ConfigOption, type ThreadState } from '@shared/thread'
import { chatgptLimitOf, chatgptResetOf } from './chatgpt-limit'
import type { HostError } from './errors'
import { isOutOfCredit } from './out-of-credit'
import { isPlanLimitStop } from './plan-limit-stop'

export interface LimitResumeTimings {
  /** How long after the reset a session goes on, so the plan has surely come back. */
  marginMs: number
  /** How far apart the sessions that go on at one reset start. */
  gapMs: number
  /** The first wait before the limits are read again when the reset is not known; it doubles. */
  checkMs: number
  /** The longest such wait. */
  maxCheckMs: number
  /** How long after the host starts a pause whose time passed meanwhile goes on. */
  startupMs: number
}

export const LIMIT_RESUME_TIMINGS: LimitResumeTimings = {
  marginMs: 60_000,
  gapMs: 20_000,
  checkMs: 10 * 60_000,
  maxCheckMs: 60 * 60_000,
  startupMs: 30_000,
}

/**
 * Google's words for a used-up quota, as the Gemini API and the agents built on it pass them on,
 * compared without case: the API's RESOURCE_EXHAUSTED and Code Assist's "exhausted your capacity".
 */
const QUOTA_PHRASES = [
  /resource[ _]exhausted/,
  /resource has been exhausted/,
  /exhausted your (?:capacity|quota)/,
  /quota (?:exceeded|will reset)/,
]

/** Where the agent's plan stands for the session's model: its windows that hold that model back. */
export function sessionQuota(
  status: Pick<AgentStatus, 'limits' | 'balances'>,
  config: readonly ConfigOption[],
  now: number,
): PlanQuota {
  const model = config.find((option) => option.category === 'model')
  return planQuota(status, now, limitsForModel(status.limits, model))
}

/**
 * Whether a failed turn stopped at the plan's limit: Claude Code and Codex say so themselves, an
 * ACP agent's words name a used-up quota, an agent on a ChatGPT plan hit its allowance, or the
 * agent's own limits show the model's window used up. Credit that ran out is no limit that resets.
 */
export function isLimitStop(
  error: Pick<HostError, 'code' | 'message' | 'data'>,
  quota: PlanQuota,
): boolean {
  if (error.code !== 'agent_error' || isOutOfCredit(error)) return false
  if (isPlanLimitStop(error) || chatgptLimitOf(error) || quota.kind === 'out') return true
  const text = error.message.toLowerCase()
  return QUOTA_PHRASES.some((phrase) => phrase.test(text))
}

/**
 * When the plan comes back by the failure's own words: Claude Code's `usage limit reached|<epoch
 * seconds>`, or Gemini's "reset after 2h5m30s". Null when they name no time.
 */
export function resetInMessage(message: string, now: number): number | null {
  const epoch = /usage limit reached\|(\d{10})\b/i.exec(message)
  if (epoch) return Number(epoch[1]) * 1000
  const after = /reset after ((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i.exec(message)
  if (!after?.[1]) return null
  const part = (unit: string): number =>
    Number(new RegExp(`([\\d.]+)${unit}`).exec(after[1]!)?.[1] ?? 0)
  const ms = ((part('h') * 60 + part('m')) * 60 + part('s')) * 1000
  return ms > 0 ? now + Math.ceil(ms) : null
}

/**
 * When the plan comes back: the failure's own account first, a ChatGPT plan's wait or the reset in
 * its words, else the agent's used-up window.
 */
export function resetOf(
  error: Pick<HostError, 'code' | 'message' | 'data'>,
  quota: PlanQuota,
  now: number,
): number | null {
  return (
    (chatgptLimitOf(error) ? chatgptResetOf(error, now) : null) ??
    resetInMessage(error.message, now) ??
    (quota.kind === 'out' ? quota.resetsAt : null)
  )
}

/**
 * The first moment from `at` that is `gapMs` from each of `taken`, so sessions that go on at one
 * reset start a little apart rather than all at once.
 */
export function staggered(at: number, taken: readonly number[], gapMs: number): number {
  let slot = at
  for (const other of [...taken].sort((a, b) => a - b)) {
    if (other <= slot - gapMs) continue
    if (other >= slot + gapMs) break
    slot = other + gapMs
  }
  return slot
}

/** How long to wait before reading the limits again, after `checks` that found no reset. */
export function checkDelay(checks: number, timings: LimitResumeTimings): number {
  return Math.min(timings.checkMs * 2 ** Math.min(checks, 16), timings.maxCheckMs)
}

/**
 * The pause of a session whose plan comes back at `resetsAt`: it goes on a margin after it, apart
 * from the other paused sessions' times in `taken`. A reset not known, or one already past that
 * the plan still refuses, waits longer after each check instead of guessing.
 */
export function limitPause(
  input: { since: number; resetsAt: number | null; checks: number; taken: readonly number[] },
  now: number,
  timings: LimitResumeTimings,
): LimitPause {
  const { since, checks, taken } = input
  const resetsAt = input.resetsAt !== null && input.resetsAt > now ? input.resetsAt : null
  const resumeAt =
    resetsAt === null
      ? now + checkDelay(checks, timings)
      : staggered(resetsAt + timings.marginMs, taken, timings.gapMs)
  return { since, resetsAt, resumeAt, checks }
}

/**
 * What a check at the pause's time finds: the plan still used up until a later reset, or with no
 * reset it says, so the session waits on; null when it may go on. A plan whose use is not known
 * goes on and finds out by trying.
 */
export function stillOut(quota: PlanQuota, now: number): { resetsAt: number | null } | null {
  if (quota.kind !== 'out') return null
  return { resetsAt: quota.resetsAt !== null && quota.resetsAt > now ? quota.resetsAt : null }
}

/**
 * How a paused session goes on: with the prompts queued behind it, with its stopped message again
 * when the turn did nothing but fail, or by asking the agent to carry on.
 */
export type ResumeKind = 'queue' | 'resend' | 'continue'

export function resumeKind(thread: Pick<ThreadState, 'order' | 'byId' | 'session'>): ResumeKind {
  if (thread.session.queue.length > 0) return 'queue'
  const failed = retryableTurn(thread)
  return failed && didNothing(thread, failed.prompt.id) ? 'resend' : 'continue'
}

/** Whether the agent wrote, thought, planned or ran nothing after the message `entryId`. */
export function didNothing(thread: Pick<ThreadState, 'order' | 'byId'>, entryId: string): boolean {
  const at = thread.order.indexOf(entryId)
  if (at < 0) return false
  return thread.order.slice(at + 1).every((id) => {
    const kind = thread.byId[id]?.kind
    return kind !== 'agent' && kind !== 'thought' && kind !== 'tool' && kind !== 'plan'
  })
}
