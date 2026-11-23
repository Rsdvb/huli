// Huli: a Codex turn refused because the model provider's quota or balance ran out, when Codex
// runs on an API key or another provider rather than a ChatGPT plan. Codex reports such a refusal
// as `usageLimitExceeded`, the code of a ChatGPT plan's used-up window, so Kite would wait for a
// reset that never comes; it is a matter of billing with the provider instead.

import type { AgentAccount } from '@shared/agent-host'
import type { JsonValue } from './protocol'

const CODEX_USAGE_LIMIT = 'usageLimitExceeded'
const PAYMENT_REQUIRED = 402

/** Providers' own words for an empty balance or quota, compared without case. */
const BILLING_WORDS =
  /insufficient[ _](?:balance|quota|credits?)|credit balance is too low|exceeded your current quota|quota exceeded|arrearage|account balance|余额不足|欠费/i

/** The HTTP status a `codexErrorInfo` variant carries, if any. */
export function errorStatus(info: JsonValue | null): number | undefined {
  if (typeof info !== 'object' || info === null || Array.isArray(info)) return undefined
  const status = (Object.values(info)[0] as { httpStatusCode?: unknown } | undefined)
    ?.httpStatusCode
  return typeof status === 'number' ? status : undefined
}

/**
 * Whether a failed turn is the provider refusing for want of quota or balance. Only off a ChatGPT
 * plan, whose `usageLimitExceeded` is a window that resets.
 */
export function isProviderQuota(
  account: AgentAccount | null,
  info: JsonValue | null,
  text: string,
): boolean {
  if (!account || account.kind === 'account') return false
  return (
    info === CODEX_USAGE_LIMIT || errorStatus(info) === PAYMENT_REQUIRED || BILLING_WORDS.test(text)
  )
}

/** A provider's name from Codex's effective configuration, as `config/read` gives it. */
export function providerName(
  config: Record<string, unknown> | null,
  account: AgentAccount | null,
): string | null {
  if (account?.kind === 'external') return account.label
  const id = typeof config?.model_provider === 'string' ? config.model_provider : 'openai'
  const providers = config?.model_providers
  const entry =
    typeof providers === 'object' && providers !== null
      ? (providers as Record<string, unknown>)[id]
      : undefined
  const name = (entry as { name?: unknown } | undefined)?.name
  if (typeof name === 'string' && name.trim() !== '') return name.trim()
  return id === 'openai' ? 'OpenAI' : id
}
