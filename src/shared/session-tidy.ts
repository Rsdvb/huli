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
