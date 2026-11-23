import type { AgentStatus, SessionSummary } from './agent-host'
import { planQuota } from './plan-quota'

// Huli: tidying the session list (会话整理). A session snoozed until a time, or until its agent's
// plan resets, leaves the active list and comes back then, or as soon as it needs the user. One
// settled, by the user or by the rules in the settings (idle for some days, its pull request
// merged), waits in a group of its own until the user brings it back or writes to it.

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** How many idle days the settings may choose before a session settles by itself. */
export const SETTLE_DAYS = [1, 3, 7, 14, 30] as const
export type SettleDays = (typeof SETTLE_DAYS)[number]

/** Settings > General's rules for settling sessions by themselves. */
export interface TidySettings {
  /** Sessions settle by themselves by the rules below. */
  autoSettle: boolean
  /** Days without activity after which an idle session settles. */
  idleDays: SettleDays
  /** A session whose pull request merged settles once it has been quiet a while. */
  merged: boolean
}

export const DEFAULT_TIDY: TidySettings = { autoSettle: true, idleDays: 7, merged: true }

export function isSettleDays(value: unknown): value is SettleDays {
  return (SETTLE_DAYS as readonly unknown[]).includes(value)
}

/** The furthest ahead a session may be snoozed. */
export const MAX_SNOOZE_MS = 366 * DAY_MS

/** How long a session whose pull request merged stays quiet before it settles. */
export const MERGED_QUIET_MS = HOUR_MS

export const TIDY_DAY_MS = DAY_MS

/** A session snoozed until `until`; `reset` when that is its agent's plan reset. */
export interface SessionSnooze {
  until: number
  reset: boolean
}

/** Who settled a session: the user, or a rule of the settings. */
export type SettledBy = 'user' | 'idle' | 'merged'

export interface SessionSettled {
  at: number
  by: SettledBy
}

/** What a snooze may be set to: a time, the agent's plan reset, or null to wake it now. */
export type SnoozeUntil = number | 'reset' | null

/** Whether a session the sidebar lists is out of its active list: snoozed or settled. */
export function isParked(summary: {
  snooze?: SessionSnooze | null
  settled?: SessionSettled | null
}): boolean {
  return !!summary.snooze || !!summary.settled
}

/** The snooze menu's quick choices, as the desktop's menu and the phone's list them. */
export type SnoozePreset = 'hour' | 'tonight' | 'tomorrow' | 'monday'

/** The hour "tonight" means, and the one a morning choice comes back at. */
export const TONIGHT_HOUR = 20
export const MORNING_HOUR = 9

/**
 * The quick choices from `now`, each with when it comes back in local time: an hour on, tonight at
 * 20:00 while that is more than an hour away, tomorrow at 9:00, and next Monday at 9:00.
 */
export function snoozePresets(now: number): { preset: SnoozePreset; until: number }[] {
  const at = (days: number, hour: number): number => {
    const date = new Date(now)
    date.setDate(date.getDate() + days)
    date.setHours(hour, 0, 0, 0)
    return date.getTime()
  }
  const out: { preset: SnoozePreset; until: number }[] = [{ preset: 'hour', until: now + HOUR_MS }]
  const tonight = at(0, TONIGHT_HOUR)
  if (tonight - now > HOUR_MS) out.push({ preset: 'tonight', until: tonight })
  out.push({ preset: 'tomorrow', until: at(1, MORNING_HOUR) })
  // Sunday is 0: the Monday after today, a week on from a Monday.
  const toMonday = (8 - new Date(now).getDay()) % 7 || 7
  if (toMonday > 1) out.push({ preset: 'monday', until: at(toMonday, MORNING_HOUR) })
  return out
}

/** How long after a plan's reset a session snoozed until it comes back, as limit pauses wait. */
export const RESET_MARGIN_MS = 60_000

/**
 * When the session's agent's plan comes back, as 额度恢复后 snoozes it: a minute after the reset
 * of its paused turn, of the window that ended its last turn, or of its agent's used-up windows;
 * null when no reset is known.
 */
export function planReturns(
  summary: Pick<SessionSummary, 'limitPause' | 'lastTurn'>,
  agent: Pick<AgentStatus, 'limits' | 'balances'> | undefined,
  now: number,
): number | null {
  const quota = agent ? planQuota(agent, now) : null
  const reset =
    summary.limitPause?.resetsAt ??
    summary.lastTurn?.limit?.resetsAt ??
    (quota?.kind === 'out' || quota?.kind === 'extra' ? quota.resetsAt : null)
  return reset !== null && reset > now ? reset + RESET_MARGIN_MS : null
}
