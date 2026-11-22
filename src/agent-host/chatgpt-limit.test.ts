// Huli: a ChatGPT plan's allowance that ran out, as each agent signed in with one reports it, and
// the limit pause it leads to.

import { describe, expect, it } from 'vitest'
import { agentError } from './agents'
import { chatgptLimitOf } from './chatgpt-limit'
import { AgentRequestError } from './connection'
import { isLimitStop, LIMIT_RESUME_TIMINGS, limitPause, resetOf } from './limit-resume'
import { turnError as openCodeError } from './opencode/connection'
import { turnError as piError } from './pi/connection'

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const UNKNOWN = { kind: 'unknown' } as const

const failed = (message: string, data?: unknown) =>
  agentError(new AgentRequestError('agent_error', message, null, data))

/** Codex 0.171's words for its plan limit, from its binary, with the ChatGPT usage page. */
const CODEX_SHARED =
  'You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:00 PM.'

describe('a ChatGPT plan’s allowance that ran out', () => {
  it('is OpenCode’s session error for it, with the wait its provider asked', () => {
    // OpenCode 2.3's `provider.chatgpt-limit`, for subscription_sharing_usage_limit_exceeded.
    const error = agentError(
      openCodeError({
        type: 'provider.chatgpt-limit',
        message: 'ChatGPT usage limit reached. Check ChatGPT Settings → Usage for details.',
        status: 429,
        retryAfterMs: 90 * MINUTE,
      }),
    )
    expect(chatgptLimitOf(error)).toBe('app')
    expect(isLimitStop(error, UNKNOWN)).toBe(true)
    expect(resetOf(error, UNKNOWN, NOW)).toBe(NOW + 90 * MINUTE)
  })

  it('is Pi’s words for the ChatGPT backend’s refusal, with its wait', () => {
    const error = agentError(
      piError('You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.'),
    )
    expect(chatgptLimitOf(error)).toBe('app')
    expect(isLimitStop(error, UNKNOWN)).toBe(true)
    expect(resetOf(error, UNKNOWN, NOW)).toBe(NOW + 42 * MINUTE)
  })

  it('is the error code itself, in any agent’s words or data, which names no reset', () => {
    const body =
      '429: {"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Usage limit reached"}}'
    const error = failed(body)
    expect(chatgptLimitOf(error)).toBe('app')
    expect(isLimitStop(error, UNKNOWN)).toBe(true)
    expect(resetOf(error, UNKNOWN, NOW)).toBeNull()
    expect(chatgptLimitOf(failed('Request failed', { body }))).toBe('app')
  })

  it('is Codex’s plan limit on the allowance ChatGPT shares, not a workspace’s', () => {
    const codex = failed(CODEX_SHARED, {
      codexErrorInfo: 'usageLimitExceeded',
      message: CODEX_SHARED,
    })
    expect(chatgptLimitOf(codex)).toBe('codex')
    expect(isLimitStop(codex, UNKNOWN)).toBe(true)
    // Codex's time of day is no reset; its pushed windows say when.
    expect(resetOf(codex, UNKNOWN, NOW)).toBeNull()
    const workspace = failed('Your workspace is out of credits. Add credits to continue.', {
      codexErrorInfo: 'usageLimitExceeded',
    })
    expect(chatgptLimitOf(workspace)).toBeNull()
    expect(isLimitStop(workspace, UNKNOWN)).toBe(true)
    expect(chatgptLimitOf(failed(CODEX_SHARED, { codexErrorInfo: 'serverOverloaded' }))).toBeNull()
  })

  it('is no other failure', () => {
    const rateLimit = agentError(
      openCodeError({ type: 'provider.rate-limit', message: 'Rate limited', status: 429 }),
    )
    expect(chatgptLimitOf(rateLimit)).toBeNull()
    expect(
      chatgptLimitOf(failed('You exceeded your current quota (insufficient_quota)')),
    ).toBeNull()
    expect(chatgptLimitOf(failed("You've hit your limit · resets 3pm"))).toBeNull()
    expect(
      chatgptLimitOf(
        agentError(
          new AgentRequestError('auth_required', 'subscription_sharing_usage_limit_exceeded'),
        ),
      ),
    ).toBeNull()
    // A wait in words that are not Pi's ChatGPT limit sets no reset.
    expect(resetOf(failed('Try again in ~5 min'), UNKNOWN, NOW)).toBeNull()
  })

  it('pauses until the wait it gave, or reads again later when it gave none', () => {
    const timings = LIMIT_RESUME_TIMINGS
    const known = agentError(
      openCodeError({
        type: 'provider.chatgpt-limit',
        message: 'ChatGPT usage limit reached.',
        retryAfterMs: 3 * 60 * MINUTE,
      }),
    )
    const pause = limitPause(
      { since: NOW, resetsAt: resetOf(known, UNKNOWN, NOW), checks: 0, taken: [] },
      NOW,
      timings,
    )
    expect(pause).toEqual({
      since: NOW,
      resetsAt: NOW + 3 * 60 * MINUTE,
      resumeAt: NOW + 3 * 60 * MINUTE + timings.marginMs,
      checks: 0,
    })
    const unknown = failed('subscription_sharing_usage_limit_exceeded')
    expect(
      limitPause(
        { since: NOW, resetsAt: resetOf(unknown, UNKNOWN, NOW), checks: 0, taken: [] },
        NOW,
        timings,
      ),
    ).toMatchObject({ resetsAt: null, resumeAt: NOW + timings.checkMs })
  })
})
