// OpenCode provider usage: the Console limits it reports itself, and the balance endpoints of the
// vendors whose keys it stores. Secrets stay in the request headers and never reach a result.

import type { AgentProvider, PlanLimit, ProviderBalance } from '@shared/agent-host'
import { amountLimit, readBody } from '../vendor-usage/common'
import { DEEPSEEK_API, parseDeepSeekKeyBalance } from '../vendor-usage/deepseek'
import { parseGlmQuotaLimits } from '../vendor-usage/glm'
import { parseKimiCodeUsage } from '../vendor-usage/kimi-code'
import { parseMiniMaxRemains } from '../vendor-usage/minimax-code'

export const USAGE_ERROR = 'Usage could not be read.'

export type ProviderUsage = NonNullable<AgentProvider['usage']>

export function unsupportedUsage(now: number): ProviderUsage {
  return { state: 'unsupported', limits: [], balances: [], observedAt: now, error: null }
}

export function failedUsage(now: number): ProviderUsage {
  return { state: 'error', limits: [], balances: [], observedAt: now, error: USAGE_ERROR }
}

function readyUsage(
  now: number,
  limits: PlanLimit[],
  balances: ProviderBalance[] = [],
): ProviderUsage {
  return { state: 'ready', limits, balances, observedAt: now, error: null }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function list(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A number, or a numeric string, as some billing APIs report amounts. */
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function percent(value: unknown): number | null {
  const parsed = num(value)
  return parsed === null ? null : Math.min(100, Math.max(0, parsed))
}

/** Unix seconds, Unix milliseconds or an RFC 3339 string, as milliseconds. */
function instant(value: unknown): number | null {
  const parsed = num(value)
  if (parsed !== null) return parsed < 1e12 ? parsed * 1000 : parsed
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function limitState(used: number, limited: boolean): PlanLimit['state'] {
  if (limited || used >= 100) return 'reached'
  return 'ok'
}

function limit(
  window: string,
  label: string,
  used: number,
  resetsAt: number | null,
  now: number,
  limited = false,
): PlanLimit {
  return {
    window,
    label,
    usedPercent: used,
    resetsAt,
    state: limitState(used, limited),
    observedAt: now,
  }
}

const WINDOWS = [
  ['rolling', 'Rolling'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
] as const

function goLimits(go: Record<string, unknown>, now: number): PlanLimit[] {
  const limits: PlanLimit[] = []
  for (const [window, label] of WINDOWS) {
    const meter = record(go[window])
    if (!meter) continue
    const used = percent(meter.percent)
    if (used === null) continue
    limits.push(limit(window, label, used, instant(meter.resetsAt), now, meter.limited === true))
  }
  return limits
}

/** The Go allowance and Console budgets from OpenCode's own usage route. */
export function mapNativeUsage(value: unknown, now: number): ProviderUsage {
  if (value === null) return unsupportedUsage(now)
  const body = record(value)
  if (!body) return failedUsage(now)
  const workspace = record(body.workspace)
  if (!workspace || typeof workspace.id !== 'string') return failedUsage(now)

  const limits: PlanLimit[] = []
  const go = record(body.go)
  if (go) limits.push(...goLimits(go, now))
  for (const item of list(body.budgets) ?? []) {
    const budget = record(item)
    if (!budget) continue
    const id = text(budget.id)
    const total = num(budget.limit)
    const spent = num(budget.spent)
    if (!id || total === null || total <= 0 || spent === null) continue
    limits.push(
      limit(
        `budget_${id}`,
        'Monthly budget',
        percent((spent / total) * 100) ?? 0,
        instant(budget.resetsAt),
        now,
      ),
    )
  }
  return readyUsage(now, limits)
}

interface Endpoint {
  url: string
  headers(key: string): Record<string, string>
  parse(body: unknown, now: number): ProviderUsage | null
}

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` }
}

function goEndpoint(): Endpoint {
  return {
    url: 'https://opencode.ai/zen/go/v1/usage',
    headers: bearer,
    parse(body, now) {
      const root = record(body)
      if (!root) return null
      const usage = record(root.usage) ?? root
      const limits: PlanLimit[] = []
      for (const [window, label] of WINDOWS) {
        const meter = record(usage[window] ?? usage[`${window}Usage`])
        if (!meter) continue
        const used = percent(meter.percent)
        if (used === null) continue
        const status = text(meter.status)
        limits.push(
          limit(
            window,
            label,
            used,
            instant(meter.resetsAt),
            now,
            status !== null && status !== 'ok' && status !== 'warning',
          ),
        )
      }
      return limits.length > 0 ? readyUsage(now, limits) : failedUsage(now)
    },
  }
}

/** DeepSeek's public `/user/balance`, read as DeepSeek Harness reads it: the granted part kept. */
function deepSeekEndpoint(): Endpoint {
  return {
    url: `${DEEPSEEK_API}/user/balance`,
    headers: bearer,
    parse(body, now) {
      const balances = parseDeepSeekKeyBalance(body)
      if (!balances) return null
      return balances.length > 0 ? readyUsage(now, [], balances) : failedUsage(now)
    },
  }
}

const cents = (amount: number): number => Math.round(amount * 100) / 100

/**
 * SiliconFlow's `/v1/user/info`, whose amounts are decimal strings: `totalBalance` all of it,
 * `chargeBalance` the topped-up part and `balance` the rest, which its console calls granted. Its
 * docs give the fields no meaning, so the granted part is told only when the three add up.
 */
export function parseSiliconFlowUser(
  body: unknown,
  currency: string,
  now: number,
): ProviderUsage | null {
  const root = record(body)
  if (!root || root.status === false) return null
  const code = num(root.code)
  if (code !== null && code !== 20000) return null
  const data = record(root.data)
  const total = num(data?.totalBalance)
  if (total === null) return null
  const paid = num(data?.chargeBalance)
  const rest = num(data?.balance)
  const granted =
    paid !== null && rest !== null && rest > 0 && Math.abs(paid + rest - total) < 0.005 ? rest : 0
  const balance: ProviderBalance = {
    label: 'Balance',
    amount: cents(total),
    currency,
    ...(granted > 0 ? { granted: cents(granted) } : {}),
  }
  return readyUsage(now, [], [balance])
}

function siliconFlowEndpoint(host: string, currency: string): Endpoint {
  return {
    url: `https://${host}/v1/user/info`,
    headers: bearer,
    parse: (body, now) => parseSiliconFlowUser(body, currency, now),
  }
}

function moonshotEndpoint(host: string, currency: string): Endpoint {
  return {
    url: `https://${host}/v1/users/me/balance`,
    headers: bearer,
    parse(body, now) {
      const root = record(body)
      if (!root) return null
      const code = num(root.code)
      if (code !== null && code !== 0) return null
      const data = record(root.data)
      const amount = num(data?.available_balance)
      if (amount === null) return null
      return readyUsage(now, [], [{ label: 'Balance', amount, currency }])
    },
  }
}

const OPENROUTER_RESETS = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
} as const satisfies Record<string, string>

/**
 * The key's own spending limit, from `/api/v1/key`, which any key may read. The account's credits
 * are only `/api/v1/credits`', which takes a management key that serves no model, so OpenCode
 * never holds one. A key without a limit has nothing to show.
 */
export function parseOpenRouterKey(body: unknown, now: number): ProviderUsage | null {
  const data = record(record(body)?.data)
  if (!data) return null
  if (data.limit === null) return readyUsage(now, [])
  const total = num(data.limit)
  const left = num(data.limit_remaining)
  if (total === null || left === null) return null
  if (total <= 0) return readyUsage(now, [])
  const reset = text(data.limit_reset)
  const period =
    reset !== null && Object.hasOwn(OPENROUTER_RESETS, reset)
      ? (reset as keyof typeof OPENROUTER_RESETS)
      : null
  const budget = (list(data.budgets) ?? []).map(record).find((item) => item?.scope === 'key_limit')
  const used = Math.max(0, total - left)
  return readyUsage(now, [
    amountLimit(
      period ?? 'key_limit',
      period ? OPENROUTER_RESETS[period] : 'Key limit',
      used,
      total,
      'USD',
      now,
      budget ? instant(budget.resets_at) : null,
    ),
  ])
}

function openRouterEndpoint(): Endpoint {
  return { url: 'https://openrouter.ai/api/v1/key', headers: bearer, parse: parseOpenRouterKey }
}

function glmEndpoint(host: string): Endpoint {
  return {
    // Z.ai and GLM take the key as the authorization value, with no scheme.
    url: `https://${host}/api/monitor/usage/quota/limit`,
    headers: (key) => ({ authorization: key }),
    parse(body, now) {
      const limits = parseGlmQuotaLimits(body, now)
      if (!limits) return null
      return limits.length > 0 ? readyUsage(now, limits) : unsupportedUsage(now)
    },
  }
}

function kimiEndpoint(host: string): Endpoint {
  return {
    url: `https://${host}/coding/v1/usages`,
    headers: bearer,
    parse(body, now) {
      const usage = parseKimiCodeUsage(body, now)
      if (!usage) return null
      return usage.limits.length > 0 || usage.balances.length > 0
        ? readyUsage(now, usage.limits, usage.balances)
        : unsupportedUsage(now)
    },
  }
}

function minimaxEndpoint(host: string): Endpoint {
  return {
    url: `https://${host}/v1/token_plan/remains`,
    headers: bearer,
    parse(body, now) {
      const usage = parseMiniMaxRemains(body, now)
      return usage ? readyUsage(now, usage.limits) : null
    },
  }
}

const ENDPOINTS: Record<string, Endpoint> = {
  'opencode-go': goEndpoint(),
  deepseek: deepSeekEndpoint(),
  moonshotai: moonshotEndpoint('api.moonshot.ai', 'USD'),
  'moonshotai-cn': moonshotEndpoint('api.moonshot.cn', 'CNY'),
  openrouter: openRouterEndpoint(),
  siliconflow: siliconFlowEndpoint('api.siliconflow.com', 'USD'),
  'siliconflow-cn': siliconFlowEndpoint('api.siliconflow.cn', 'CNY'),
  zai: glmEndpoint('api.z.ai'),
  'zai-coding-plan': glmEndpoint('api.z.ai'),
  zhipuai: glmEndpoint('open.bigmodel.cn'),
  'zhipuai-coding-plan': glmEndpoint('open.bigmodel.cn'),
  'kimi-code-plan-global': kimiEndpoint('api.kimi.ai'),
  'kimi-code-plan-cn': kimiEndpoint('api.kimi.com'),
  'minimax-coding-plan': minimaxEndpoint('api.minimax.io'),
  'minimax-cn-coding-plan': minimaxEndpoint('api.minimaxi.com'),
}

export function hasUsageEndpoint(providerId: string): boolean {
  return Object.hasOwn(ENDPOINTS, providerId)
}

const DEFAULT_TIMEOUT = 8_000

export interface UsageQuery {
  providerId: string
  key: string
  now: number
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  /** Extra request headers, such as the Console workspace. */
  headers?: Record<string, string>
  /** A 403 answer means the provider has nothing to show, not a failure. */
  forbidden?: 'unsupported'
}

/** Asks one vendor endpoint. A failure is one generic error, never the answer or the key. */
export async function readProviderUsage(query: UsageQuery): Promise<ProviderUsage> {
  if (!Object.hasOwn(ENDPOINTS, query.providerId) || query.key === '') {
    return unsupportedUsage(query.now)
  }
  const endpoint = ENDPOINTS[query.providerId]!
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), query.timeoutMs ?? DEFAULT_TIMEOUT)
  try {
    const response = await (query.fetch ?? globalThis.fetch)(endpoint.url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...endpoint.headers(query.key),
        ...query.headers,
      },
      redirect: 'error',
      signal: controller.signal,
    })
    if (response.status === 403 && query.forbidden === 'unsupported') {
      return unsupportedUsage(query.now)
    }
    if (!response.ok) return failedUsage(query.now)
    const body = JSON.parse(await readBody(response)) as unknown
    return endpoint.parse(body, query.now) ?? failedUsage(query.now)
  } catch {
    return failedUsage(query.now)
  } finally {
    clearTimeout(timer)
  }
}
