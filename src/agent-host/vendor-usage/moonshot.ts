// Huli: Moonshot's (Kimi's) account balance for an API key, from its documented
// `GET /v1/users/me/balance` (https://platform.kimi.com/docs/api/balance in CNY on api.moonshot.cn,
// https://platform.kimi.ai/docs/api/balance in USD on api.moonshot.ai). The key goes to that
// origin alone and never into a result, a log or an error.

import type { ProviderBalance } from '@shared/agent-host'
import { number, object } from './common'
import { askVendor, UsageReadError, type SignInPlace } from './stored-sign-in'

const VENDOR = 'Moonshot'

export const MOONSHOT_ORIGINS = {
  cn: { origin: 'https://api.moonshot.cn', currency: 'CNY' },
  intl: { origin: 'https://api.moonshot.ai', currency: 'USD' },
} as const

export type MoonshotRegion = keyof typeof MOONSHOT_ORIGINS

const cents = (amount: number): number => Math.round(amount * 100) / 100

/**
 * The balance of a `/v1/users/me/balance` reply: what is available, with the voucher part as
 * granted; null when the reply is not one. Its amounts carry no currency, which the site sets.
 */
export function parseMoonshotBalance(
  value: unknown,
  region: MoonshotRegion,
): ProviderBalance[] | null {
  const root = object(value)
  if (!root || root.status === false) return null
  if (root.code !== undefined && number(root.code) !== 0) return null
  const data = object(root.data)
  const available = number(data?.available_balance)
  if (available === null) return null
  const voucher = number(data?.voucher_balance) ?? 0
  return [
    {
      label: 'Balance',
      amount: cents(available),
      currency: MOONSHOT_ORIGINS[region].currency,
      ...(voucher > 0 ? { granted: cents(voucher) } : {}),
    },
  ]
}

/** Reads an API key's balance from Moonshot's site for the region. */
export async function readMoonshotBalance(
  place: SignInPlace,
  key: string,
  region: MoonshotRegion,
): Promise<ProviderBalance[]> {
  const { origin } = MOONSHOT_ORIGINS[region]
  const reply = await askVendor(
    {
      vendor: VENDOR,
      origins: [origin],
      url: `${origin}/v1/users/me/balance`,
      headers: { authorization: `Bearer ${key}` },
    },
    place,
  )
  const balances = parseMoonshotBalance(reply, region)
  if (!balances) throw new UsageReadError(`${VENDOR} sent no balance`)
  return balances
}
