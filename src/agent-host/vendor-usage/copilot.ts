// Copilot CLI's `account.getQuota`, as the schema of `@github/copilot-sdk` 1.0.33 and 1.0.34 (CLI
// 1.0.112 to 1.0.114) types it: `quotaSnapshots` keyed by quota type, each with
// `entitlementRequests`, `usedRequests` and the ISO 8601 `resetDate`. Replies that pass GitHub's
// own `quota_snapshots` through, with `quota_reset_date` beside them, read too.

import { amountLimit, number, object, time, type VendorUsage } from './common'
import { requestOverStdio } from './stdio-rpc'

export function parseCopilotQuota(value: unknown, now: number): VendorUsage | null {
  const body = object(value)
  if (!body) return null
  const quota =
    object(body.quotaSnapshots) ?? object(body.quota_snapshots) ?? object(body.quota) ?? body
  const premium = object(quota.premium_interactions) ?? object(quota.premiumRequests)
  const credits = object(quota.ai_credits) ?? object(quota.aiCredits)
  const selected = premium ?? credits
  if (!selected) return null
  // An unlimited entitlement has no window to fill.
  if (selected.isUnlimitedEntitlement === true || selected.unlimited === true) {
    return { limits: [], balances: [] }
  }
  const total = number(
    selected.entitlementRequests ?? selected.entitlement ?? selected.total ?? selected.limit,
  )
  const used =
    number(selected.usedRequests ?? selected.used ?? selected.consumed) ??
    (() => {
      const remaining = number(selected.quota_remaining)
      return total !== null && remaining !== null ? total - remaining : null
    })()
  if (used === null || total === null || total <= 0) return null
  const resetsAt =
    time(selected.resetDate) ?? time(body.quota_reset_date_utc) ?? time(body.quota_reset_date)
  return {
    limits: [
      amountLimit(
        'monthly',
        'Monthly',
        used,
        total,
        premium ? 'requests' : 'credits',
        now,
        resetsAt,
      ),
    ],
    balances: [],
  }
}

export async function readCopilotQuota(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<VendorUsage | null> {
  const reply = await requestOverStdio(command, args, env, [
    {
      method: 'connect',
      params: { clientInfo: { name: 'Kettu', version: '0.1.0' }, supportedTaskKinds: ['agent'] },
    },
    { method: 'account.getQuota' },
  ])
  return parseCopilotQuota(reply, now)
}
