// Plan limits as the host's notifications word them: a window's name inside a sentence and when
// it resets.

import type { PlanAlert, PlanLimit } from '@shared/agent-host'
import { currentLocale, hasMessage, t } from './i18n'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/**
 * A plan-limit window's name inside a sentence: Kettu's for the windows it knows, else the agent's
 * own, with a per-model week as "Fable weekly" so it does not read as two windows.
 */
export function windowName(limit: Pick<PlanLimit, 'window' | 'label'>): string {
  for (const key of [`planWindowInText.${limit.window}`, `planWindow.${limit.window}`]) {
    if (hasMessage(key)) return (t as (key: string) => string)(key)
  }
  // Claude Code names a weekly limit per model, "Weekly · Fable", and Antigravity both its
  // windows per model group, in English.
  const weekly = /^Weekly · (.+)$/.exec(limit.label)
  if (weekly) return t('planWindowInText.weeklyOf', { model: weekly[1]! })
  const fiveHour = /^5-hour · (.+)$/.exec(limit.label)
  return fiveHour ? t('planWindowInText.fiveHourOf', { model: fiveHour[1]! }) : limit.label
}

/** When a window resets: the clock time today, with the weekday within six days, else the date. */
export function resetTime(at: number, now: number): string {
  const day = (time: number): number => new Date(time).setHours(0, 0, 0, 0)
  // Rounded, since a day across a clock change is not 24 hours.
  const days = Math.round((day(at) - day(now)) / DAY)
  const clock: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
  const options: Intl.DateTimeFormatOptions =
    days === 0
      ? clock
      : days > 0 && days <= 6
        ? { ...clock, weekday: 'short' }
        : { ...clock, month: 'short', day: 'numeric' }
  return new Intl.DateTimeFormat(currentLocale(), options).format(at)
}

/** Time left within a day, to the minute: "2 h 13 min", "40 min". */
function timeLeft(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / MINUTE))
  if (minutes < 60) return t('planAlert.minutes', { minutes })
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0
    ? t('planAlert.hoursOnly', { hours })
    : t('planAlert.hours', { hours, minutes: minutes % 60 })
}

/**
 * When a window near its end resets, or a used-up one comes back: the time left within a day,
 * else when, as "Resets in 2 h 13 min" or "Back Sat 5:00 AM".
 */
export function resetLine(resetsAt: number | null, out: boolean, now: number): string {
  if (resetsAt === null || resetsAt <= now) return t('planAlert.noReset')
  const left = resetsAt - now
  if (left < DAY)
    return t(out ? 'planAlert.backIn' : 'planAlert.resetsIn', { time: timeLeft(left) })
  return t(out ? 'planAlert.backAt' : 'planAlert.resetsAt', { time: resetTime(resetsAt, now) })
}

/** A plan alert's notification: the agent, the window and its use, then when it resets. */
export function alertText(alert: PlanAlert, now: number): { title: string; body: string } {
  const params = { agent: alert.agentName, limit: windowName(alert) }
  const out = alert.level === 100
  const title = out
    ? t('planAlert.out', params)
    : t('planAlert.near', { ...params, percent: Math.round(alert.usedPercent ?? alert.level) })
  return { title, body: resetLine(alert.resetsAt, out, now) }
}
