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
