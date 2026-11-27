// Huli: the network traffic an agent's requests to its model make, estimated from the tokens it
// reports. Every request uploads the whole context again (prompt caching saves money, not bytes),
// so a long session's traffic grows with its context times its requests. Neither the Claude Agent
// SDK nor Codex's app-server tells the sizes of the requests themselves, so this is an estimate:
// the clients show it as approximate.

import type { SessionUsage, TokenTotals } from './thread'
import type { TokenParts } from './usage'

/** A request body's bytes per input token: about four characters of text, sent as JSON. */
export const UPLOAD_BYTES_PER_TOKEN = 4
/**
 * A streamed reply's bytes per output token: its text and the events that frame it, each a few
 * tokens wrapped in about a hundred bytes of JSON.
 */
export const DOWNLOAD_BYTES_PER_TOKEN = 16

/** Bytes sent to the model and received from it. */
export interface Traffic {
  up: number
  down: number
}

export function tokenTraffic(input: number, output: number): Traffic {
  return {
    up: Math.max(0, input) * UPLOAD_BYTES_PER_TOKEN,
    down: Math.max(0, output) * DOWNLOAD_BYTES_PER_TOKEN,
  }
}

/**
 * A session's traffic so far, from its token totals: all input of every request, cached or not,
 * went up, and its output came down. Null for an agent that reports no totals.
 */
export function sessionTraffic(tokens: TokenTotals | null | undefined): Traffic | null {
  if (!tokens) return null
  const input = tokens.input + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0)
  if (input <= 0 && tokens.output <= 0) return null
  return tokenTraffic(input, tokens.output)
}

/** The traffic of a sum of the usage page's rows. */
export function partsTraffic(
  parts: Pick<TokenParts, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>,
): Traffic {
  return tokenTraffic(parts.input + parts.cacheRead + parts.cacheWrite, parts.output)
}

/** What one request uploads with the context at `used` tokens. */
export function requestUpload(used: number): number {
  return Math.max(0, used) * UPLOAD_BYTES_PER_TOKEN
}

/** A context this large is large whatever the window. */
export const LARGE_CONTEXT_TOKENS = 300_000
/** Or a context that fills this share of its window... */
export const LARGE_CONTEXT_SHARE = 0.6
/** ...once it holds this many tokens, so a small window's context does not count as large. */
export const LARGE_CONTEXT_FLOOR = 100_000

/** Whether the session's context is large enough that each request uploads a lot. */
export function largeContext(
  usage: Pick<SessionUsage, 'used' | 'size'> | null | undefined,
): boolean {
  if (!usage || !(usage.used > 0)) return false
  if (usage.used >= LARGE_CONTEXT_TOKENS) return true
  return (
    usage.size > 0 &&
    usage.used >= LARGE_CONTEXT_FLOOR &&
    usage.used >= usage.size * LARGE_CONTEXT_SHARE
  )
}
