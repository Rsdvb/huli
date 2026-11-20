// A Doubao session's options, which each turn's command line carries: its model and that model's
// reasoning level, as `model list --json` gives them for the account, and its permission mode.

import type { ConfigOption } from '@shared/thread'
import { t } from '../i18n'
import { EFFORTS, MODES, type Mode } from './args'
import type { ListedModel } from './protocol'

export const CONFIG = { mode: 'mode', model: 'model', effort: 'effort' } as const

/** A model the account can run, as the model menu offers it. */
export interface ModelChoice {
  id: string
  name: string
  default: boolean
  efforts: readonly string[]
  /** The level a session starts it on; null when it has none. */
  effort: string | null
}

const MODE_KEYS = {
  ask_always: 'askAlways',
  ask_risky: 'askRisky',
  always_allow: 'alwaysAllow',
} as const satisfies Record<Mode, string>

/** The models `model list --json` printed, in its order; null for output that holds none. */
export function parseModels(stdout: string): ModelChoice[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  const result = (parsed as { result?: { type?: unknown; models?: unknown } } | null)?.result
  if (result?.type !== 'model_list' || !Array.isArray(result.models)) return null
  const choices: ModelChoice[] = []
  for (const raw of result.models as ListedModel[]) {
    if (typeof raw?.id !== 'string' || raw.id === '' || choices.some((c) => c.id === raw.id))
      continue
    const efforts = Array.isArray(raw.efforts)
      ? raw.efforts.filter((e): e is string => (EFFORTS as readonly string[]).includes(e))
      : []
    const effort =
      typeof raw.default_effort === 'string' && efforts.includes(raw.default_effort)
        ? raw.default_effort
        : (efforts[0] ?? null)
    choices.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
      default: raw.is_default === true,
      efforts,
      effort,
    })
  }
  return choices
}

/** The model a new session starts on: the account's default, else the first. */
export function startModel(models: readonly ModelChoice[]): ModelChoice | null {
  return models.find((model) => model.default) ?? models[0] ?? null
}

export interface Choices {
  /** A listed model's id; null until the account's models are known, for its default. */
  model: string | null
  effort: string | null
  mode: Mode
}

function levelName(level: string): string {
  return (EFFORTS as readonly string[]).includes(level)
    ? t(`doubao.effort.${level as (typeof EFFORTS)[number]}`)
    : level
}

export function configOptions(choices: Choices, models: readonly ModelChoice[]): ConfigOption[] {
  const options: ConfigOption[] = [
    {
      id: CONFIG.mode,
      name: t('doubao.mode.name'),
      category: 'mode',
      type: 'select',
      value: choices.mode,
      choices: MODES.map((mode) => ({
        value: mode,
        name: t(`doubao.mode.${MODE_KEYS[mode]}`),
        description: t(`doubao.mode.${MODE_KEYS[mode]}Description`),
      })),
    },
  ]
  const model = models.find((choice) => choice.id === choices.model)
  if (models.length > 0 && choices.model !== null) {
    options.push({
      id: CONFIG.model,
      name: t('doubao.model'),
      category: 'model',
      type: 'select',
      value: choices.model,
      choices: models.map((choice) => ({
        value: choice.id,
        name: choice.name,
        modelId: choice.id,
      })),
      idleOnly: true,
    })
  }
  if (model && model.efforts.length > 0 && choices.effort !== null) {
    options.push({
      id: CONFIG.effort,
      name: t('doubao.effort.name'),
      category: 'thought_level',
      type: 'select',
      value: choices.effort,
      choices: model.efforts.map((effort) => ({ value: effort, name: levelName(effort) })),
      idleOnly: true,
    })
  }
  return options
}
