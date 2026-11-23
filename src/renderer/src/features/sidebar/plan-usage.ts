import type { PlanLimit } from '@shared/agent-host'
import { backTime, resetTime } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { isUsedUp, showsReset } from '@renderer/lib/plan-limit'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type UsageTone = 'low' | 'medium' | 'high' | 'critical'

/**
 * A usage level, as the context's ring and percentage show it: below 50% used, 50 to 79%, 80 to
 * 94%, and from 95% or once the limit is reached. It goes by the whole percentage shown, so "80%"
 * never sits beside the level below. A plan limit's bar takes limitLevel instead.
 */
export function usageTone(limit: Pick<PlanLimit, 'usedPercent' | 'state'>): UsageTone {
  const used = Math.round(limit.usedPercent ?? 0)
  if (limit.state === 'reached' || used >= 95) return 'critical'
  if (used >= 80) return 'high'
  if (used >= 50) return 'medium'
  return 'low'
}

/** A percentage's text color at each usage level. */
export const USAGE_TONE_TEXT: Record<UsageTone, string> = {
  low: 'text-tertiary',
  medium: 'text-tertiary',
  high: 'text-warning',
  critical: 'text-danger',
}

/** Time left in its two largest units: "42m", "5h 12m", "1d 5h"; null once it has passed. */
export function countdown(ms: number): string | null {
  if (ms <= 0) return null
  if (ms < HOUR) {
    return i18n.t('sidebar:countdown.minutes', { count: Math.max(1, Math.floor(ms / MINUTE)) })
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes
      ? i18n.t('sidebar:countdown.hoursMinutes', { hours, minutes })
      : i18n.t('sidebar:countdown.hours', { count: hours })
  }
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  return hours
    ? i18n.t('sidebar:countdown.daysHours', { days, hours })
    : i18n.t('sidebar:countdown.days', { count: days })
}

/** Time left in its largest unit, rounded down, for a compact line: "40 min", "2 h", "3 d". */
function shortLeft(ms: number): string {
  if (ms < HOUR) return i18n.t('time.minutesShort', { count: Math.max(1, Math.floor(ms / MINUTE)) })
  if (ms < DAY) return i18n.t('time.hoursShort', { count: Math.floor(ms / HOUR) })
  return i18n.t('time.daysShort', { count: Math.floor(ms / DAY) })
}

/**
 * When a window near its end resets, for a compact line beside its figure: "resets in 2 h", or for
 * one used up, when it comes back, "back 2:40 AM". Null when the line says nothing of it: under
 * 80% used, or with no reset ahead.
 */
export function inlineReset(limit: PlanLimit, now: number): string | null {
  if (!showsReset(limit, now)) return null
  const at = limit.resetsAt!
  return isUsedUp(limit)
    ? i18n.t('planInline.back', { time: backTime(at, now) })
    : i18n.t('planInline.resets', { time: shortLeft(at - now) })
}

/**
 * When a plan window resets, worded the same on every surface: the time left within a day,
 * "Resets in 3h 26m", else when, "Resets Sat 5:00 AM".
 */
export function planReset(at: number, now = Date.now()): string {
  const left = at - now
  return left > 0 && left < DAY
    ? i18n.t('planReset.in', { time: countdown(left) })
    : i18n.t('planReset.at', { time: resetTime(at, now) })
}
