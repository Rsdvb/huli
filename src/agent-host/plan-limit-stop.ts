// A turn the agent's plan refused because a usage window ran out, rather than for any other fault:
// Codex says so in its error's `codexErrorInfo`, Claude Code in the error of the message it adds,
// whose words also name it when that error is missing.

import type { HostError } from './errors'

/** Claude Code's words for a used-up window, compared without case. */
const PHRASES = [
  /usage limit reached/,
  /hit your (?:usage )?limit/,
  /(?:5-hour|weekly|opus|sonnet|session) limit reached/,
]

const CODEX_USAGE_LIMIT = 'usageLimitExceeded'
const CLAUDE_RATE_LIMIT = 'rate_limit'

export function isPlanLimitStop(error: Pick<HostError, 'code' | 'message' | 'data'>): boolean {
  if (error.code !== 'agent_error') return false
  const data = (error.data as { data?: unknown } | undefined)?.data
  if (typeof data === 'object' && data !== null) {
    const { codexErrorInfo, failure } = data as { codexErrorInfo?: unknown; failure?: unknown }
    if (codexErrorInfo === CODEX_USAGE_LIMIT || failure === CLAUDE_RATE_LIMIT) return true
  }
  const text = error.message.toLowerCase()
  return PHRASES.some((phrase) => phrase.test(text))
}
