// Huli: a turn that stopped because the ChatGPT plan an agent signs in with has no allowance left
// for it. `app`: another app's "Sign in with ChatGPT" use, OpenCode's or Pi's, past its weekly cap
// in ChatGPT's App limits or the plan's own; `codex`: Codex's plan limit, which since December
// draws on the allowance ChatGPT and Codex share. Each agent says so in its own way, matched
// narrowly: anything else is no such stop.

import type { HostError } from './errors'

export type ChatgptLimit = 'app' | 'codex'

/** OpenAI's error code for an app's use of a ChatGPT plan past its limit (HTTP 429). */
const SHARING_LIMIT = 'subscription_sharing_usage_limit_exceeded'
/** OpenCode's session error for that code, whatever the provider error carried it. */
const OPENCODE_TYPE = 'provider.chatgpt-limit'
/** Pi's own words for any 429 of the ChatGPT backend its `openai-codex` provider reaches. */
const PI_WORDS = /\byou have hit your chatgpt usage limit\b/i
/** Pi's wait, when the backend gave a reset: "Try again in ~42 min." */
const PI_WAIT = /\btry again in ~?(\d+(?:\.\d+)?) ?min\b/i
const CODEX_USAGE_LIMIT = 'usageLimitExceeded'
/** Codex's plan limit names ChatGPT's usage page; a workspace's credits or cap are no plan's. */
const CODEX_CHATGPT = /chatgpt\.com\//i
const CODEX_WORKSPACE = /\bworkspace\b|\bspend cap\b/i

type Failure = Pick<HostError, 'code' | 'message' | 'data'>

function fieldsOf(error: Failure): Record<string, unknown> {
  const data = (error.data as { data?: unknown } | undefined)?.data
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {}
}

export function chatgptLimitOf(error: Failure): ChatgptLimit | null {
  if (error.code !== 'agent_error') return null
  const fields = fieldsOf(error)
  const text = [error.message, ...Object.values(fields)]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
  if (fields.type === OPENCODE_TYPE || text.includes(SHARING_LIMIT)) return 'app'
  if (PI_WORDS.test(error.message)) return 'app'
  const codex = fields.codexErrorInfo === CODEX_USAGE_LIMIT
  return codex && CODEX_CHATGPT.test(text) && !CODEX_WORKSPACE.test(text) ? 'codex' : null
}

/**
 * When the allowance comes back by the failure's own account: OpenCode's `retryAfterMs`, counted
 * from the failure, or Pi's "Try again in ~N min". Null when it gives none: the code alone says
 * nothing of when, since an app's weekly cap and the plan's own windows reset apart.
 */
export function chatgptResetOf(error: Failure, now: number): number | null {
  const wait = fieldsOf(error).retryAfterMs
  if (typeof wait === 'number' && Number.isFinite(wait) && wait > 0) return now + Math.ceil(wait)
  const minutes = PI_WAIT.exec(error.message)?.[1]
  const ms = minutes ? Number(minutes) * 60_000 : 0
  return ms > 0 ? now + Math.ceil(ms) : null
}
