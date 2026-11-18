// Plan limits and token counts as the session screens say them, by the desktop's rules
// (features/sidebar/plan-usage.ts, lib/plan-limit.ts, lib/format.ts): the tightest window, the
// four usage levels, windows' names, when they reset, and counts in 万 and 亿 as a Chinese phone
// writes them.

import type {
  AgentAccount,
  AgentStatus,
  LimitsReason,
  PlanLimit,
  ProviderBalance,
} from '@shared/agent-host'
import { modelTitle } from '../../usage/modelTitle'
import type { Palette } from '../tokens'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The window to name for a plan: a reached one, else the fullest, else the first still current. */
export function tightestLimit(limits: readonly PlanLimit[], now = Date.now()): PlanLimit | null {
  const current = limits.filter((l) => l.resetsAt === null || l.resetsAt > now)
  const reached = current.find((l) => l.state === 'reached')
  if (reached) return reached
  const known = current.filter((l) => l.usedPercent !== null)
  const fullest = [...known].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0]
  return fullest ?? current[0] ?? null
}

/** A window used up and not yet reset. */
export function isExhausted(limit: PlanLimit, now = Date.now()): boolean {
  const used = limit.state === 'reached' || (limit.usedPercent ?? 0) >= 100
  return used && (limit.resetsAt === null || limit.resetsAt > now)
}

/** The window the status line names: a used-up one first, else the tightest with a percentage. */
export function shownLimit(limits: readonly PlanLimit[], now = Date.now()): PlanLimit | null {
  const limit = tightestLimit(limits, now)
  if (!limit) return null
  return limit.usedPercent !== null || isExhausted(limit, now) ? limit : null
}

export type UsageTone = 'low' | 'medium' | 'high' | 'critical'

/** Below 50% used, 50 to 79%, 80 to 94%, and from 95% or once the limit is reached. */
export function usageTone(limit: Pick<PlanLimit, 'usedPercent' | 'state'>): UsageTone {
  const used = Math.round(limit.usedPercent ?? 0)
  if (limit.state === 'reached' || used >= 95) return 'critical'
  if (used >= 80) return 'high'
  if (used >= 50) return 'medium'
  return 'low'
}

/** The context's colors, as the desktop's ring: green, blue, orange, red. */
export function toneColor(tone: UsageTone, c: Palette): string {
  return tone === 'critical'
    ? c.danger
    : tone === 'high'
      ? c.accent
      : tone === 'medium'
        ? c.tint
        : c.success
}

/** A plan window's color in a ring or a bar: the plan's own blue until it nears its end. */
export function limitColor(limit: Pick<PlanLimit, 'usedPercent' | 'state'>, c: Palette): string {
  const tone = usageTone(limit)
  return tone === 'critical' ? c.danger : tone === 'high' ? c.warning : c.tint
}

/** A window's percentage in text: quiet until it nears its end, as the desktop's LIMIT_TEXT. */
export function limitTextColor(
  limit: Pick<PlanLimit, 'usedPercent' | 'state'>,
  c: Palette,
  quiet: string,
): string {
  const tone = usageTone(limit)
  return tone === 'critical' ? c.danger : tone === 'high' ? c.warning : quiet
}

// As the desktop's zh-CN catalog names them (planWindowInText in host.json).
const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5 小时',
  seven_day: '每周',
  seven_day_opus: 'Opus 每周',
  seven_day_sonnet: 'Sonnet 每周',
  monthly: '每月',
  annual: '每年',
  overage: '额外用量',
  rolling: '5 小时',
  weekly: '每周',
}

/** An agent's own English label in Chinese where its shape is known: 「Fable 每周」「5 小时」. */
function labelName(label: string): string {
  const text = label.trim()
  const weekly = /^weekly(?: · (.+))?$/i.exec(text)
  if (weekly) return weekly[1] ? `${weekly[1]} 每周` : '每周'
  const span = /^(\d+)-(minute|hour|day)(?: · (.+))?$/i.exec(text)
  if (span) {
    const unit = { minute: '分钟', hour: '小时', day: '天' }[span[2]!.toLowerCase()]
    return `${span[3] ? `${span[3]} ` : ''}${span[1]} ${unit}`
  }
  if (/^monthly$/i.test(text)) return '每月'
  if (/^(annual|yearly)$/i.test(text)) return '每年'
  return text
}

/** A window's length by the end of its id: 「5 小时」「每周」「3 天」. */
function spanName(span: string): string {
  const named = WINDOW_NAMES[span]
  if (named) return named
  const counted = /^(\d+)_(minute|hour|day)$/.exec(span)
  const unit = { minute: '分钟', hour: '小时', day: '天' }[counted?.[2] ?? '']
  return counted && unit ? `${counted[1]} ${unit}` : span
}

/**
 * The pool of a Codex window outside its default one, `<pool>_seven_day` labelled `Weekly ·
 * <pool>`: the pool's id, its name, the model it counts when Codex names one, and the window's
 * length. Null for any other window.
 */
export function limitPool(
  limit: PlanLimit,
): { id: string; name: string; span: string; models: string[] } | null {
  const ids = /^(.+)_(five_hour|seven_day|\d+_(?:minute|hour|day)|monthly|annual)$/.exec(
    limit.window,
  )
  const label = /^.+? · (.+)$/.exec(limit.label.trim())
  if (!ids || !label) return null
  const models = limit.models ?? []
  const name = models.length ? models.map(modelTitle).join('、') : label[1]!
  return { id: ids[1]!, name, span: ids[2]!, models }
}

/** A window's name: 「每周」「Fable 每周」, or the agent's own label for one the phone does not know. */
export function windowName(limit: PlanLimit): string {
  const known = WINDOW_NAMES[limit.window]
  if (known) return known
  const pool = limitPool(limit)
  if (pool) return `${pool.name} ${spanName(pool.span)}`
  return limit.models?.length ? limit.models.join('、') : labelName(limit.label)
}

/** The model a per-model window counts: 「Weekly · Fable」 gives Fable. */
function modelOf(limit: PlanLimit): string | null {
  if (limit.window === 'seven_day_opus') return 'Opus'
  if (limit.window === 'seven_day_sonnet') return 'Sonnet'
  const pool = limitPool(limit)
  if (pool) return pool.name
  const named = /^(?:Weekly|\d+-(?:minute|hour|day)) · (.+)$/i.exec(limit.label.trim())
  return named?.[1] ?? (limit.models?.length ? limit.models.join('、') : null)
}

/** A window's name where room is short, as the status line and the rings: 「每周」「Fable」. */
export function windowShort(limit: PlanLimit): string {
  return modelOf(limit) ?? windowName(limit)
}

/** The plan's name with its tier: 「Claude Max 5x」. */
export function planName(account: AgentAccount | null): string | null {
  if (!account?.label) return null
  return account.tier ? `${account.label} ${account.tier}` : account.label
}

/** 「92.9万」「6.3亿」「4766」. */
export function tokensText(n: number): string {
  const trim = (value: number) => {
    const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1)
    return text.replace(/\.0$/, '')
  }
  if (n >= 1e8) return `${trim(n / 1e8)}亿`
  if (n >= 1e4) return `${trim(n / 1e4)}万`
  return String(Math.round(n))
}

/** 「$172.10」「¥12.00」, or the amount and its currency's code. */
export function moneyText(amount: number, currency: string): string {
  const sign: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', JPY: '¥' }
  const symbol = sign[currency.toUpperCase()]
  return symbol ? `${symbol}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`
}

const AMOUNT_UNITS: Record<string, string> = { credits: '积分', requests: '高级请求' }

/** A window counted in units rather than a share: 「120 / 500 积分」. */
export function amountText(amount: NonNullable<PlanLimit['amount']>): string {
  if (/^[A-Z]{3}$/.test(amount.unit)) {
    return `${moneyText(amount.used, amount.unit)} / ${moneyText(amount.total, amount.unit)}`
  }
  const n = (v: number) => String(Math.round(v * 100) / 100)
  return `${n(amount.used)} / ${n(amount.total)} ${AMOUNT_UNITS[amount.unit] ?? amount.unit}`
}

/** A balance beside the windows: its name and its amount, 「额外用量」「$12.40」. */
export function balanceText(balance: ProviderBalance): { name: string; value: string } {
  const name =
    balance.label === 'Prepaid balance'
      ? '预付余额'
      : balance.label === 'Extra usage'
        ? '额外用量'
        : balance.label
  const value = /^[A-Z]{3}$/.test(balance.currency)
    ? moneyText(balance.amount, balance.currency)
    : `${Math.round(balance.amount * 100) / 100} ${AMOUNT_UNITS[balance.currency] ?? balance.currency}`
  return { name, value }
}

/** 「凌晨 2:40」. */
function clock(at: number): string {
  const d = new Date(at)
  const h = d.getHours()
  const part = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${part} ${hour}:${String(d.getMinutes()).padStart(2, '0')}`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** When it comes: today's clock time, the weekday within six days, else the date. */
export function whenText(at: number, now: number): string {
  const days = daysBetween(now, at)
  if (days === 0) return clock(at)
  if (days === 1) return `明天 ${clock(at)}`
  if (days > 1 && days <= 6) return `${WEEKDAYS[new Date(at).getDay()]} ${clock(at)}`
  const d = new Date(at)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** Time left in its two largest units: 「42 分」「2 小时 13 分」「3 天 5 小时」. */
export function leftText(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MINUTE))} 分钟`
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR)
    const m = Math.floor((ms % HOUR) / MINUTE)
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`
  }
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  return h ? `${d} 天 ${h} 小时` : `${d} 天`
}

/** 「2 小时 13 分后重置」within a day, else 「周三 凌晨 2:40 重置」. */
export function resetText(at: number, now = Date.now()): string {
  const left = at - now
  if (left <= 0) return '已重置'
  return left < DAY ? `${leftText(left)}后重置` : `${whenText(at, now)} 重置`
}

/** When a used-up window opens again, short: 「2 小时后恢复」「周三恢复」. */
export function backText(at: number | null, now = Date.now()): string {
  if (at === null) return '已用完'
  const left = at - now
  if (left <= 0) return '已恢复'
  if (left < HOUR) return `${Math.max(1, Math.floor(left / MINUTE))} 分钟后恢复`
  if (left < DAY) return `${Math.floor(left / HOUR)} 小时后恢复`
  const d = new Date(at)
  const days = daysBetween(now, at)
  if (days === 1) return '明天恢复'
  return days <= 6 ? `${WEEKDAYS[d.getDay()]}恢复` : `${d.getMonth() + 1}月${d.getDate()}日恢复`
}

/** From this whole percentage used, a compact line says when the window resets, as the desktop's. */
export const RESET_SHOWN_AT = 80

/**
 * When a window near its end resets, for a compact line right after its figure: 「2 小时后重置」,
 * or for one used up, when it comes back, 「凌晨 2:40 恢复」. Null under 80% used or with no reset
 * ahead, when the reset stays in the details.
 */
export function inlineReset(limit: PlanLimit, now = Date.now()): string | null {
  const at = limit.resetsAt
  if (at === null || at <= now) return null
  if (isExhausted(limit, now)) return `${whenText(at, now)} 恢复`
  if (Math.round(limit.usedPercent ?? 0) < RESET_SHOWN_AT) return null
  const left = at - now
  if (left < HOUR) return `${Math.max(1, Math.floor(left / MINUTE))} 分钟后重置`
  if (left < DAY) return `${Math.floor(left / HOUR)} 小时后重置`
  return `${Math.floor(left / DAY)} 天后重置`
}

/** Calendar days from `from` to `to`, rounded across a change of daylight saving time. */
function daysBetween(from: number, to: number): number {
  return Math.round((new Date(to).setHours(0, 0, 0, 0) - new Date(from).setHours(0, 0, 0, 0)) / DAY)
}

/** When the limits were read: 「刚刚读取」「12 分钟前读取」「昨天 晚上 9:57 读取」. */
export function readText(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return '刚刚读取'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前读取`
  if (delta < 6 * HOUR) return `${Math.floor(delta / HOUR)} 小时前读取`
  const days = daysBetween(at, now)
  if (days === 0) return `${clock(at)} 读取`
  if (days === 1) return `昨天 ${clock(at)} 读取`
  const d = new Date(at)
  return `${d.getMonth() + 1}月${d.getDate()}日读取`
}

const REASONS: Record<LimitsReason, string> = {
  'vendor-disallows': '服务商不允许读取套餐用量。',
  'harness-does-not-offer': '这个 Agent 不报告套餐限额。',
  'administrator-managed': '额度由管理员管理。',
  'model-provider-managed': '额度由模型服务商管理。',
  'not-yet-supported': '暂时还读不到这个 Agent 的套餐用量。',
  'console-managed': '用 API 密钥登录，用量请到服务商的控制台查看。',
}

/** Whether Huli can ask the agent for its limits now. */
export function canReadLimits(agent: AgentStatus): boolean {
  return (
    agent.capabilities.reports &&
    agent.signIn !== 'required' &&
    agent.state !== 'not-installed' &&
    !agent.disabled
  )
}

/** Why an agent shows no limits, in a sentence. */
export function limitsWhy(agent: AgentStatus): string {
  if (agent.limitsReason) return REASONS[agent.limitsReason]
  if (agent.account && agent.account.kind !== 'account' && agent.account.kind !== 'none') {
    return '这个账号没有套餐限额，按用量计费。'
  }
  if (agent.signIn === 'required' && agent.capabilities.reports) return '登录后才能读到套餐用量。'
  return agent.capabilities.reports ? '还没有读到套餐用量。' : '这个 Agent 不报告套餐限额。'
}

/** The newest reading of an agent's limits, or 0. */
export function limitsReadAt(agent: AgentStatus): number {
  return Math.max(0, ...agent.limits.map((l) => l.observedAt))
}
