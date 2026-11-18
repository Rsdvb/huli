import { describe, expect, it } from 'vitest'
import { agentError } from './agents'
import { AgentRequestError } from './connection'
import { isPlanLimitStop } from './plan-limit-stop'

const failed = (message: string, data?: unknown) =>
  agentError(new AgentRequestError('agent_error', message, null, data))

describe('isPlanLimitStop', () => {
  it("knows Codex's used-up plan by its error info", () => {
    expect(
      isPlanLimitStop(
        failed('Upgrade', { codexErrorInfo: 'usageLimitExceeded', message: 'Quota exceeded' }),
      ),
    ).toBe(true)
    expect(isPlanLimitStop(failed('Busy', { codexErrorInfo: 'serverOverloaded' }))).toBe(false)
  })

  it("knows Claude Code's by the error of its message, or by its words", () => {
    expect(isPlanLimitStop(failed('Limit', { failure: 'rate_limit' }))).toBe(true)
    expect(isPlanLimitStop(failed("You've hit your limit · resets 3pm (Europe/Berlin)"))).toBe(true)
    expect(isPlanLimitStop(failed('Claude AI usage limit reached|1760000000'))).toBe(true)
    expect(isPlanLimitStop(failed('5-hour limit reached ∙ resets 2am'))).toBe(true)
    expect(isPlanLimitStop(failed('Credit balance is too low', { failure: 'billing_error' }))).toBe(
      false,
    )
  })

  it('takes no other failure for one', () => {
    expect(isPlanLimitStop(failed('Something went wrong'))).toBe(false)
    expect(
      isPlanLimitStop(agentError(new AgentRequestError('auth_required', 'usage limit reached'))),
    ).toBe(false)
  })
})
