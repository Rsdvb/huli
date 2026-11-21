// DeepSeek's balance, for DeepSeek Harness on either of its routes. Its account sign-in reads the
// wallets and profile from DeepSeek Platform as dsh's own account module does
// (`@deepseek-ai/dsh-deepseek-account` 0.2.2-rc.5, MIT: `x-dsh-auth-token` on
// `/api/v0/users/get_user_summary` and `/auth-api/v0/users/current`, in Platform's envelope). An
// API key reads DeepSeek's public `/user/balance`. The credential goes to those origins alone and
// never into a result, a log or an error.

import type { ProviderBalance } from '@shared/agent-host'
import { object } from './common'
import { askVendor, UsageReadError, type SignInPlace } from './stored-sign-in'

const VENDOR = 'DeepSeek'
/** The Platform origin dsh signs in to, which every account grant names as its issuer. */
export const DEEPSEEK_PLATFORM = 'https://platform.deepseek.com'
export const DEEPSEEK_API = 'https://api.deepseek.com'
export const DEEPSEEK_ORIGINS = [DEEPSEEK_PLATFORM, DEEPSEEK_API] as const

/** The label every DeepSeek balance carries, as OpenCode's DeepSeek balance does. */
export const DEEPSEEK_BALANCE = 'Balance'

/** The dsh version these requests and replies were checked on. */
export const DEEPSEEK_ACCOUNT_VERSION = '0.2.2-rc.5'

/** Platform's code for a token it no longer accepts, which it may send with HTTP 200. */
const UNAUTHORIZED_CODE = 40003

/** The account grant dsh stores; only its token and issuer are read. */
export interface DeepSeekGrant {
  token: string
  issuer: string
}

/** The account's display identity, its contact masked by Platform as it answers. */
export interface DeepSeekProfile {
  name: string | null
  contact: string | null
}

/** A decimal string or number as Platform and the API send amounts, such as "0E-16". */
function decimal(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function currencyOf(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Cents are what both replies are kept to; Platform sends sixteen places. */
const cents = (amount: number): number => Math.round(amount * 100) / 100

/** A balance per currency: all of it, and the part DeepSeek granted rather than the user paid. */
function balance(currency: string, total: number, granted: number): ProviderBalance {
  return {
    label: DEEPSEEK_BALANCE,
    amount: cents(total),
    currency,
    ...(granted > 0 ? { granted: cents(granted) } : {}),
  }
}

/**
 * The balances of the public `/user/balance` reply, one per currency; null when it is not one.
 * `total_balance` is the granted and the topped-up parts together.
 */
export function parseDeepSeekKeyBalance(value: unknown): ProviderBalance[] | null {
  const infos = object(value)?.balance_infos
  if (!Array.isArray(infos)) return null
  const balances: ProviderBalance[] = []
  for (const item of infos) {
    const info = object(item)
    const currency = currencyOf(info?.currency)
    const total = decimal(info?.total_balance)
    if (!currency || total === null) continue
    balances.push(balance(currency, total, decimal(info?.granted_balance) ?? 0))
  }
  return balances
}

/**
 * What Platform's envelope carries: `biz_data` when both codes are 0. A token it no longer accepts
 * is a refusal, as a 401 is; any other answer is not one this read knows.
 */
function envelope(value: unknown): unknown {
  const root = object(value)
  if (root?.code === UNAUTHORIZED_CODE) {
    throw new UsageReadError(`${VENDOR} did not accept the stored sign-in`, 401)
  }
  const data = object(root?.data)
  if (root?.code !== 0 || data?.biz_code !== 0) {
    throw new UsageReadError(`${VENDOR} sent an answer this version cannot read`)
  }
  return data.biz_data
}

/**
 * The wallets of a `get_user_summary` reply, one balance per currency: the topped-up wallet and
 * the bonus wallet together, the bonus as the granted part. Null when the reply holds no wallets.
 */
export function parseDeepSeekWallets(value: unknown): ProviderBalance[] | null {
  const summary = object(envelope(value))
  const normal = summary?.normal_wallets
  const bonus = summary?.bonus_wallets
  if (!Array.isArray(normal) || !Array.isArray(bonus)) return null
  const totals = new Map<string, { paid: number; granted: number }>()
  const add = (wallets: unknown[], part: 'paid' | 'granted'): void => {
    for (const item of wallets) {
      const wallet = object(item)
      const currency = currencyOf(wallet?.currency)
      const amount = decimal(wallet?.balance)
      if (!currency || amount === null) continue
      const total = totals.get(currency) ?? { paid: 0, granted: 0 }
      total[part] += amount
      totals.set(currency, total)
    }
  }
  add(normal, 'paid')
  add(bonus, 'granted')
  return [...totals].map(([currency, { paid, granted }]) =>
    balance(currency, paid + granted, granted),
  )
}

/**
 * The name and contact of a `users/current` reply, as dsh shows them: the phone, else the email.
 * Everything else it holds, a token among it, is left unread.
 */
export function parseDeepSeekProfile(value: unknown): DeepSeekProfile | null {
  const user = object(envelope(value))
  if (!user) return null
  return {
    name: text(object(user.id_profile)?.name),
    contact: text(user.mobile) ?? text(user.mobile_number) ?? text(user.email),
  }
}

/** Platform's client headers, as dsh's own web client sends them for its account page. */
function clientHeaders(version: string, locale: string, now: number): Record<string, string> {
  return {
    'x-client-bundle-id': '',
    'x-client-platform': 'web',
    'x-client-version': version,
    'x-client-locale': locale.toLowerCase().startsWith('zh') ? 'zh_CN' : 'en_US',
    'x-client-timezone-offset': String(-new Date(now).getTimezoneOffset() * 60),
  }
}

export interface DeepSeekAccountRead {
  balances: ProviderBalance[]
  /** Asked only when `profile` was; null when its read failed. */
  profile?: DeepSeekProfile | null
}

/**
 * Reads the account's wallets, and its profile when asked, with dsh's stored account grant. A
 * grant some other Platform issued, or one of dsh's development mock, is never sent.
 */
export async function readDeepSeekAccount(
  place: SignInPlace,
  grant: DeepSeekGrant,
  options: { profile: boolean; version: string; locale: string },
): Promise<DeepSeekAccountRead> {
  if (grant.issuer !== DEEPSEEK_PLATFORM || grant.token.startsWith('dsh_mock_')) {
    throw new UsageReadError(`${VENDOR}'s sign-in is not for ${DEEPSEEK_PLATFORM}`)
  }
  const ask = (route: string): Promise<unknown> =>
    askVendor(
      {
        vendor: VENDOR,
        origins: [DEEPSEEK_PLATFORM],
        url: `${DEEPSEEK_PLATFORM}${route}`,
        headers: {
          ...clientHeaders(options.version, options.locale, place.now),
          'x-dsh-auth-token': grant.token,
        },
      },
      place,
    )
  const balances = parseDeepSeekWallets(await ask('/api/v0/users/get_user_summary'))
  if (!balances) throw new UsageReadError(`${VENDOR} sent no balance`)
  if (!options.profile) return { balances }
  // The name is worth a try only: the balance stands without it.
  const profile = await ask('/auth-api/v0/users/current')
    .then(parseDeepSeekProfile)
    .catch(() => null)
  return { balances, profile }
}

/** Reads an API key's balance from DeepSeek's public endpoint. */
export async function readDeepSeekKeyBalance(
  place: SignInPlace,
  key: string,
): Promise<ProviderBalance[]> {
  const reply = await askVendor(
    {
      vendor: VENDOR,
      origins: [DEEPSEEK_API],
      url: `${DEEPSEEK_API}/user/balance`,
      headers: { authorization: `Bearer ${key}` },
    },
    place,
  )
  const balances = parseDeepSeekKeyBalance(reply)
  if (!balances) throw new UsageReadError(`${VENDOR} sent no balance`)
  return balances
}
