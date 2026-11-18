// Codex's account and plan limits in Kettu's terms, with the labels codex-acp gave them.

import type { AgentAccount, PlanLimit, ProviderBalance, ResetCredits } from '@shared/agent-host'
import { t } from '../i18n'
import type {
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from './protocol'

const PLANS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
}

function planName(plan: string | null | undefined): string | null {
  if (!plan || plan === 'unknown') return null
  return PLANS[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1)
}

export function mapAccount(response: GetAccountResponse): AgentAccount {
  const account = response.account
  if (!account) {
    return response.requiresOpenaiAuth
      ? { kind: 'none', label: t('codex.account.none'), email: null }
      : { kind: 'gateway', label: t('codex.account.gateway'), email: null }
  }
  switch (account.type) {
    case 'chatgpt': {
      const plan = planName(account.planType)
      return { kind: 'account', label: plan ? `ChatGPT ${plan}` : 'ChatGPT', email: account.email }
    }
    case 'apiKey':
      return { kind: 'api_key', label: t('codex.account.apiKey'), email: null }
    case 'amazonBedrock':
      return { kind: 'external', label: 'AWS Bedrock', email: null }
    case 'gcp':
      return { kind: 'external', label: 'Google Cloud', email: null }
    default:
      return { kind: 'external', label: (account as { type: string }).type, email: null }
  }
}

const DAY_MINUTES = 24 * 60
const DEFAULT_POOL = 'codex'

/** A window's id and label by its length, as Codex's own `/status` names it. */
function windowOf(minutes: number | null): { window: string; label: string } | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null
  if (minutes === 300) return { window: 'five_hour', label: t('planWindow.five_hour') }
  if (minutes === 7 * DAY_MINUTES) return { window: 'seven_day', label: t('planWindow.seven_day') }
  if (minutes < 60) return { window: `${minutes}_minute`, label: `${minutes}-minute` }
  if (minutes < DAY_MINUTES) {
    const hours = Math.round(minutes / 60)
    return { window: `${hours}_hour`, label: `${hours}-hour` }
  }
  if (minutes < 7 * DAY_MINUTES) {
    const days = Math.round(minutes / DAY_MINUTES)
    return { window: `${days}_day`, label: `${days}-day` }
  }
  if (minutes <= 31 * DAY_MINUTES) return { window: 'monthly', label: t('planWindow.monthly') }
  return { window: 'annual', label: t('planWindow.annual') }
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

function mapWindow(
  window: RateLimitWindow | null,
  pool: string | null,
  model: string | null,
  now: number,
): PlanLimit | null {
  if (!window) return null
  const named = windowOf(window.windowDurationMins)
  if (!named) return null
  const used = Math.min(100, Math.max(0, window.usedPercent))
  return {
    window: pool ? `${slug(pool)}_${named.window}` : named.window,
    label: pool ? `${named.label} · ${pool}` : named.label,
    usedPercent: used,
    resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
    state: used >= 100 ? 'reached' : 'ok',
    observedAt: now,
    ...(pool && model ? { models: [model] } : {}),
  }
}

/**
 * The windows of one limit pool; pools other than Codex's own are named in the label, and list the
 * model the pool counts when Codex names one, so a client can tell which model each pool holds.
 */
export function mapRateLimits(snapshot: RateLimitSnapshot, now: number): PlanLimit[] {
  const id = snapshot.limitId ?? DEFAULT_POOL
  const pool = id === DEFAULT_POOL ? null : (snapshot.limitName ?? id)
  const model = snapshot.normalModelSlug?.trim() || null
  return [snapshot.primary, snapshot.secondary]
    .map((window) => mapWindow(window, pool, model, now))
    .filter((limit) => limit !== null)
}

/**
 * What a limits read says beside the windows: the credits balance that pays once a window runs
 * out, as an extra usage balance, and the reset credits. An older Codex reports no reset credits,
 * which leaves them null rather than none.
 */
export function mapPlanExtras(
  response: GetAccountRateLimitsResponse,
  snapshots: readonly RateLimitSnapshot[],
): { balances: ProviderBalance[]; resetCredits: ResetCredits | null } {
  const credits = [response.rateLimits, ...snapshots].find((s) => s?.credits)?.credits
  const amount = credits?.hasCredits && !credits.unlimited ? Number(credits.balance) : NaN
  const balances: ProviderBalance[] = Number.isFinite(amount)
    ? [{ label: 'Extra usage', amount, currency: 'credits' }]
    : []
  const summary = response.rateLimitResetCredits
  const resetCredits: ResetCredits | null = summary
    ? {
        available: Math.max(0, Math.floor(summary.availableCount)),
        credits: (summary.credits ?? [])
          .filter((credit) => credit.status === 'available')
          .map((credit) => ({
            id: credit.id,
            title: credit.title ?? null,
            description: credit.description ?? null,
            expiresAt: credit.expiresAt ? credit.expiresAt * 1000 : null,
          })),
      }
    : null
  return { balances, resetCredits }
}
