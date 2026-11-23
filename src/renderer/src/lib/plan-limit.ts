import type { PlanLimit } from '@shared/agent-host'
import type { LimitLevel } from '@shared/plan-limits'

export { limitLevel, type LimitLevel } from '@shared/plan-limits'

/** From this whole percentage used, compact lines say when a window resets beside its figure. */
export const RESET_SHOWN_AT = 80

/** A window used up: reached, or at 100% by the whole percentage shown. */
export function isUsedUp(limit: Pick<PlanLimit, 'usedPercent' | 'state'>): boolean {
  return limit.state === 'reached' || Math.round(limit.usedPercent ?? 0) >= 100
}

/**
 * Whether a compact line says when the window resets: from 80% used, or used up, while its reset
 * is still ahead. Under that, the reset stays in the details.
 */
export function showsReset(
  limit: Pick<PlanLimit, 'usedPercent' | 'state' | 'resetsAt'>,
  now: number,
): boolean {
  if (limit.resetsAt === null || limit.resetsAt <= now) return false
  return isUsedUp(limit) || Math.round(limit.usedPercent ?? 0) >= RESET_SHOWN_AT
}

/** Whether plan limits show the share used or the share left. */
export type LimitView = 'used' | 'left'

/** The percentage a window shows, from its whole percentage used; used and left add up to 100. */
export function shownPercent(used: number, view: LimitView): number {
  return view === 'left' ? Math.max(0, 100 - used) : used
}

/** A window's percentage as the view shows it; null when the window reports none. */
export function limitPercent(
  limit: Pick<PlanLimit, 'usedPercent'>,
  view: LimitView,
): number | null {
  return limit.usedPercent === null ? null : shownPercent(Math.round(limit.usedPercent), view)
}

/**
 * A model group's name as a card line shows it: without the "Models" every group of Antigravity's
 * ends in, and its "and" in the interface's language, e.g. "Claude 和 GPT".
 */
export function groupName(model: string, and: string): string {
  return model.replace(/\s+models?$/i, '').replace(/\s+and\s+/i, ` ${and.trim()} `)
}

/** A limit bar's fill at each level. */
export const LIMIT_FILL: Record<LimitLevel, string> = {
  ok: 'bg-limit-ok',
  warn: 'bg-limit-warn',
  bad: 'bg-limit-bad',
}

/** A limit ring's color at each level, drawn with `currentColor`. */
export const LIMIT_STROKE: Record<LimitLevel, string> = {
  ok: 'text-limit-ok',
  warn: 'text-limit-warn',
  bad: 'text-limit-bad',
}

/** A limit's percentage at each level: the bar colors are too light for text. */
export const LIMIT_TEXT: Record<LimitLevel, string> = {
  ok: 'text-tertiary',
  warn: 'text-warning',
  bad: 'text-danger',
}
