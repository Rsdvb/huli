// Huli: what keeps an eye on a session's turn for the user: a turn its agent's plan limit stopped
// goes on by itself once the plan resets. Its records, views and summaries carry it.

/** A session its agent's plan limit stopped, waiting to go on by itself. */
export interface LimitPause {
  /** When the turn stopped. */
  since: number
  /** When the used-up window resets, as the agent said; null while that is not known. */
  resetsAt: number | null
  /** When the session goes on, or reads its agent's limits again while `resetsAt` is null. */
  resumeAt: number
  /** Reads and tries that found the plan still used up, which space the next ones further apart. */
  checks: number
}

/** What the user can do about a limit pause: drop it, or go on now without waiting. */
export const LIMIT_PAUSE_ACTIONS = ['cancel', 'now'] as const
export type LimitPauseAction = (typeof LIMIT_PAUSE_ACTIONS)[number]

/** The longest text a session sends to go on. */
export const RESUME_TEXT_CHARS = 2000

/** Its settings, in Settings > General. */
export interface SupervisorSettings {
  /** A turn a plan limit stopped goes on by itself once the plan resets. */
  resumeAfterLimit: boolean
  /** What goes to the agent then, when the turn had done some work; empty for the default. */
  resumeText: string
}

export const DEFAULT_SUPERVISOR: SupervisorSettings = {
  resumeAfterLimit: true,
  resumeText: '',
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** A stored or sent limit pause, or null for one that is malformed. */
export function limitPauseOf(value: unknown): LimitPause | null {
  if (typeof value !== 'object' || value === null) return null
  const { since, resetsAt, resumeAt, checks } = value as Record<string, unknown>
  if (!isTime(since) || !isTime(resumeAt) || !(resetsAt === null || isTime(resetsAt))) return null
  if (typeof checks !== 'number' || !Number.isInteger(checks) || checks < 0) return null
  return { since, resetsAt, resumeAt, checks }
}
