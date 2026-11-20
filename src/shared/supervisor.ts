// Huli: what keeps an eye on a session's turn for the user: a turn its agent's plan limit stopped
// goes on by itself once the plan resets, and a turn that has said nothing for a while is flagged
// as possibly stuck. Its records, views and summaries carry these.

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

/** Why a running turn looks stuck: it has said nothing, or keeps retrying a failed request. */
export type StallReason = 'silent' | 'retrying'

/** A running turn that has produced no output for a while. */
export interface Stall {
  /** Since when nothing came: the turn's start, its last output or the end of a wait. */
  since: number
  reason: StallReason
}

/** What the user can do about a stuck turn: stop it, stop and go on again, or keep waiting. */
export const STALL_ACTIONS = ['stop', 'retry', 'wait'] as const
export type StallAction = (typeof STALL_ACTIONS)[number]

/** What the user can do about a limit pause: drop it, or go on now without waiting. */
export const LIMIT_PAUSE_ACTIONS = ['cancel', 'now'] as const
export type LimitPauseAction = (typeof LIMIT_PAUSE_ACTIONS)[number]

/** The minutes of silence after which a running turn counts as stuck; 0 turns it off. */
export const STALL_MINUTES = [0, 5, 10, 15, 20, 30, 60] as const
export type StallMinutes = (typeof STALL_MINUTES)[number]

/** The longest text a session sends to go on. */
export const RESUME_TEXT_CHARS = 2000

/** The settings for both, in Settings > General. */
export interface SupervisorSettings {
  /** A turn a plan limit stopped goes on by itself once the plan resets. */
  resumeAfterLimit: boolean
  /** What goes to the agent then, when the turn had done some work; empty for the default. */
  resumeText: string
  /** A running turn silent this long is flagged; 0 never. */
  stallMinutes: StallMinutes
}

export const DEFAULT_SUPERVISOR: SupervisorSettings = {
  resumeAfterLimit: true,
  resumeText: '',
  stallMinutes: 10,
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
