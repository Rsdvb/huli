// Which of an agent's plan-limit windows hold back one of its models.

import type { PlanLimit } from './agent-host'
import type { ConfigOption } from './thread'

const words = (...texts: (string | undefined)[]): Set<string> =>
  new Set(
    texts
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  )

const has = (own: Set<string>, name: string): boolean =>
  [...words(name)].every((word) => own.has(word))

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const COUNTED_MS = { minute: 60_000, hour: HOUR_MS, day: DAY_MS } as const

/**
 * Huli: how long a window counts use, by its name: five hours, a day, a week, a year, or a month
 * for a monthly window and any Kite does not know. OpenCode's carry their provider before a colon.
 */
export function windowPeriod(window: string): number {
  const own = window.slice(window.indexOf(':') + 1)
  if (own === 'five_hour' || own === 'rolling' || own.startsWith('five_hour_')) return 5 * HOUR_MS
  if (own === 'daily') return DAY_MS
  if (own === 'seven_day' || own === 'weekly' || own.startsWith('seven_day_')) return 7 * DAY_MS
  if (own === 'annual') return 366 * DAY_MS
  const counted = /^(\d+)_(minute|hour|day)$/.exec(own)
  if (counted) return Number(counted[1]) * COUNTED_MS[counted[2] as keyof typeof COUNTED_MS]
  return 31 * DAY_MS
}

/**
 * Huli: whether a window's reading still holds at `now`: until its reset, or, for one whose vendor
 * names no reset, for one period from when it was read, after which its use belongs to a period
 * gone by and its block no longer stands.
 */
export function limitHolds(
  limit: Pick<PlanLimit, 'window' | 'resetsAt' | 'observedAt'>,
  now: number,
): boolean {
  if (limit.resetsAt !== null) return limit.resetsAt > now
  return now - limit.observedAt < windowPeriod(limit.window)
}

/** Huli: whether a window has no reset and its reading is a period old: it is shown no more. */
export function limitOutlived(
  limit: Pick<PlanLimit, 'window' | 'resetsAt' | 'observedAt'>,
  now: number,
): boolean {
  return limit.resetsAt === null && !limitHolds(limit, now)
}

// A window named for a model or a group of models, such as Claude Code's `seven_day_opus` or
// Antigravity's `five_hour_claude_and_gpt_models`.
const SCOPED = /^(?:seven_day|five_hour)_(.+?)(?:_models)?$/

/**
 * The windows that hold back the model `model` has chosen. A per-model window, such as
 * `seven_day_fable`, counts only on a model that names it, so a used-up Fable week does not stop
 * Opus, and a group's, such as `five_hour_claude_and_gpt_models`, on a model naming one of its
 * families; a window naming none of the menu's models counts for all of them, and so does every
 * window when the model is not known. A group's window that lists its models counts only on
 * them, unless no group lists the chosen model.
 */
export function limitsForModel(
  limits: readonly PlanLimit[],
  model: ConfigOption | undefined,
): PlanLimit[] {
  const choices = model?.choices ?? []
  const current = choices.find((c) => c.value === model?.value)
  if (!current) return [...limits]
  const known = words(...choices.flatMap((c) => [c.value, c.name, c.modelId]))
  const own = words(current.value, current.name, current.modelId, current.description)
  const grouped = limits.some((limit) => limit.models?.some((name) => has(own, name)))
  return limits.filter((limit) => {
    if (limit.models?.length) return !grouped || limit.models.some((name) => has(own, name))
    const scope = SCOPED.exec(limit.window)?.[1]
    const named = (scope?.split('_and_') ?? [])
      .map((part) => part.split('_'))
      .filter((names) => names.every((name) => known.has(name)))
    if (named.length === 0) return true
    return named.some((names) => names.every((name) => own.has(name)))
  })
}
