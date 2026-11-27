// A Claude Code session's options: its permission mode, model, effort and fast mode, with the ids
// and values the ACP adapter gave them, so the values a thread stored still apply.

import { canonicalClaudeModel } from '@shared/agents'
import type { ConfigOption } from '@shared/thread'
import { effortLevelName } from '../effort'
import { t } from '../i18n'
import { isBuiltInStyle, styleDescription, styleName } from './output-styles'
import type { ModelInfo, PermissionMode } from './sdk'

export const OPTION_IDS = {
  mode: 'mode',
  model: 'model',
  effort: 'effort',
  fast: 'fast',
  ultracode: '__ultracode',
  outputStyle: '__outputStyle',
} as const

export const DEFAULT_MODEL = 'default'
export const DEFAULT_EFFORT = 'default'

const MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
] as const satisfies readonly PermissionMode[]

type KnownMode = (typeof MODES)[number]

function known(mode: string): mode is KnownMode {
  return (MODES as readonly string[]).includes(mode)
}

/** The mode's name in the host's language, or in English where `translate` is `tEnglish`. */
export function modeName(mode: string, translate: typeof t = t): string {
  return known(mode) ? translate(`claude.mode.${mode}.name`) : mode
}

/** What a mode does, as the mode menu says it. */
export function modeDescription(mode: string, translate: typeof t = t): string | undefined {
  return known(mode) ? translate(`claude.mode.${mode}.description`) : undefined
}

/** The modes a session offers; bypass only where Claude Code allows it. */
export function availableModes(allowBypass: boolean): PermissionMode[] {
  return MODES.filter((id) => allowBypass || id !== 'bypassPermissions')
}

export interface SessionChoices {
  mode: string
  model: string
  effort: string
  fast: boolean
  ultracode: boolean | 'default'
  /** Huli: the output style in use; null while Claude Code has named none. */
  outputStyle?: string | null
}

/**
 * Huli: Claude Code's output styles as an option of the session's menu, the one in use among the
 * ones it lists; null when it lists none.
 */
export function outputStyleOption(
  styles: readonly string[],
  value: string | null | undefined,
): ConfigOption | null {
  if (styles.length === 0 || !value) return null
  const listed = styles.includes(value) ? styles : [...styles, value]
  return {
    id: OPTION_IDS.outputStyle,
    name: t('claude.option.outputStyle'),
    description: t('claude.option.outputStyleDescription'),
    category: 'other',
    type: 'select',
    value,
    choices: listed.map((name) => {
      const description = styleDescription(name)
      return {
        value: name,
        name: styleName(name),
        ...(description ? { description } : {}),
        ...(isBuiltInStyle(name) ? {} : { group: t('claude.outputStyle.custom') }),
      }
    }),
    place: 'menu',
  }
}

/** Kettu's ultracode switch; `default` inherits the value Claude Code resolves. */
export function ultracodeOption(
  value: boolean | 'default' = 'default',
  defaultValue: boolean | null = null,
): ConfigOption {
  return {
    id: OPTION_IDS.ultracode,
    name: 'Ultracode',
    description: t('session.ultracodeDescription'),
    category: 'other',
    type: 'boolean',
    value,
    defaultValue,
    indicator: true,
    idleOnly: true,
  }
}

/** The model a value names, the default model's entry for `default`. */
export function modelInfo(models: readonly ModelInfo[], value: string): ModelInfo | undefined {
  return models.find((model) => model.value === value)
}

/** Whether a row names a model by an alias, such as `fable`, that stands for another id. */
function isAlias(model: ModelInfo): boolean {
  return (
    model.value !== DEFAULT_MODEL && !!model.resolvedModel && model.resolvedModel !== model.value
  )
}

/** Keeps the aliases a list names, by alias, so a later list that leaves one out can name it. */
export function rememberAliases(models: readonly ModelInfo[], into: Map<string, ModelInfo>): void {
  for (const model of models) if (isAlias(model)) into.set(model.value, model)
}

/**
 * The list with each alias it once had back in its place. Claude Code lists the model a session
 * runs under the name it runs it by, so a session resumed on Fable 5.2 lists `claude-fable-5-2`
 * where a new session lists `fable`. The alias goes back to its row, and the full id follows it
 * as a row of its own, shown as the alias, so every session lists the model under both names.
 */
export function restoreAliases(
  models: readonly ModelInfo[],
  aliases: ReadonlyMap<string, ModelInfo>,
): ModelInfo[] {
  let list: ModelInfo[] = [...models]
  for (const alias of aliases.values()) {
    if (list.some((model) => model.value === alias.value)) continue
    if (list.some((model) => isAlias(model) && model.resolvedModel === alias.resolvedModel))
      continue
    const at = list.findIndex(
      (model) =>
        model.value !== DEFAULT_MODEL &&
        model.value === alias.resolvedModel &&
        (model.resolvedModel ?? model.value) === model.value,
    )
    if (at < 0) continue
    const row = list[at]!
    list = [
      ...list.slice(0, at),
      { ...row, value: alias.value, resolvedModel: row.value },
      ...list.slice(at + 1),
      row,
    ]
  }
  return list
}

/**
 * The row of the model an alias the list leaves out stands for, when no row says so: the first
 * whose name starts with the alias's word, as `Fable 5.2` does for `fable`, since Claude Code puts
 * the model it lists under its full id in its alias's place.
 */
function namedBy(models: readonly ModelInfo[], alias: string): ModelInfo | undefined {
  if (!/^[a-z]+$/i.test(alias)) return undefined
  const word = alias.toLowerCase()
  return models.find(
    (model) =>
      model.value !== DEFAULT_MODEL && model.displayName.split(/\s+/)[0]?.toLowerCase() === word,
  )
}

/** Where a session at its default effort takes the level from, before the model's own default. */
export interface InheritedEffort {
  /** `CLAUDE_CODE_EFFORT_LEVEL`. */
  env?: string
  /** The settings' `modelSettings`, whose entries may save a level per model. */
  modelSettings?: unknown
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']

// Claude Code's documented default effort per model (code.claude.com/docs/en/model-config).
const MODEL_DEFAULT_EFFORT: [pattern: RegExp, level: string][] = [
  [/(opus|sonnet|haiku)-5-5/, 'medium'],
  [/opus-4-7/, 'xhigh'],
]
const DOCUMENTED_DEFAULT_EFFORT = 'high'

function savedEffort(modelSettings: unknown, model: ModelInfo): string | undefined {
  if (!modelSettings || typeof modelSettings !== 'object') return undefined
  const wanted = new Set(
    [model.value, model.resolvedModel ?? model.value].map(canonicalClaudeModel),
  )
  for (const [key, entry] of Object.entries(modelSettings)) {
    if (!wanted.has(canonicalClaudeModel(key)) || !entry || typeof entry !== 'object') continue
    const level = (entry as { effortLevel?: unknown }).effortLevel
    if (typeof level === 'string') return level
  }
  return undefined
}

/**
 * The level a session that picked none runs at, as Claude Code resolves it: the environment, then
 * the level saved for the model, then the model's documented default, run as the highest level
 * the model offers at or below it.
 */
export function effortInEffect(
  model: ModelInfo,
  levels: readonly string[],
  inherited: InheritedEffort,
): string {
  const resolved = canonicalClaudeModel(model.resolvedModel ?? model.value)
  const wanted =
    [inherited.env, savedEffort(inherited.modelSettings, model)].find(
      (level) => level !== undefined && EFFORT_ORDER.includes(level),
    ) ??
    MODEL_DEFAULT_EFFORT.find(([pattern]) => pattern.test(resolved))?.[1] ??
    DOCUMENTED_DEFAULT_EFFORT
  if (levels.includes(wanted)) return wanted
  const rank = EFFORT_ORDER.indexOf(wanted)
  const below = levels.filter((level) => {
    const at = EFFORT_ORDER.indexOf(level)
    return at >= 0 && at <= rank
  })
  return below.at(-1) ?? levels[0]!
}

export function buildConfig(
  models: readonly ModelInfo[],
  choices: SessionChoices,
  modes: readonly string[],
  ultracodeDefault: boolean | null = null,
  inherited: InheritedEffort = {},
): ConfigOption[] {
  const options: ConfigOption[] = [
    {
      id: OPTION_IDS.mode,
      name: t('claude.option.mode'),
      description: t('claude.option.modeDescription'),
      category: 'mode',
      type: 'select',
      value: choices.mode,
      choices: MODES.filter((mode) => modes.includes(mode)).map((mode) => ({
        value: mode,
        name: modeName(mode),
        description: modeDescription(mode),
      })),
    },
  ]
  if (models.length > 0) {
    // Default, and a full id such as `claude-fable-5-2` that Claude Code lists beside its alias,
    // show as the alias, such as `opus` or `fable`, that resolves to the same model. Which models
    // are older is left to the menus, which compare versions within a family.
    const aliases = models.filter(
      (m) => m.value !== DEFAULT_MODEL && m.resolvedModel && m.resolvedModel !== m.value,
    )
    const aliasOf = (value: string) => aliases.find((a) => a.resolvedModel === value)
    const listed: NonNullable<ConfigOption['choices']> = models.map((model) => {
      const same =
        model.value === DEFAULT_MODEL
          ? aliases.find((a) => a.resolvedModel === model.resolvedModel)
          : aliasOf(model.value)
      const modelId =
        model.resolvedModel ?? (model.value === DEFAULT_MODEL ? undefined : model.value)
      return {
        value: model.value,
        name: model.displayName,
        ...(modelId ? { modelId } : {}),
        ...(model.description ? { description: model.description } : {}),
        ...(same ? { shownAs: same.value } : {}),
      }
    })
    // A model the settings name that the list leaves out still shows as the one in use, under the
    // name of the row of the same model: an alias for a full id, or a full id for an alias.
    if (!listed.some((choice) => choice.value === choices.model)) {
      const same = aliasOf(choices.model)
      const named = same ? undefined : namedBy(models, choices.model)
      const row = same ?? named
      listed.push({
        value: choices.model,
        name: row?.displayName ?? choices.model,
        ...(same ? { modelId: choices.model, shownAs: same.value } : {}),
        ...(named ? { modelId: named.resolvedModel ?? named.value, shownAs: named.value } : {}),
      })
    }
    options.push({
      id: OPTION_IDS.model,
      name: t('claude.option.model'),
      description: t('claude.option.modelDescription'),
      category: 'model',
      type: 'select',
      value: choices.model,
      choices: listed,
    })
  }
  const current = modelInfo(models, choices.model)
  const levels = current?.supportsEffort ? (current.supportedEffortLevels ?? []) : []
  if (current && levels.length > 0) {
    // A session at its default shows the level that default runs at; there is no Default level.
    options.push({
      id: OPTION_IDS.effort,
      name: t('claude.option.effort'),
      description: t('claude.option.effortDescription'),
      category: 'thought_level',
      type: 'select',
      value: levels.includes(choices.effort)
        ? choices.effort
        : effortInEffect(current, levels, inherited),
      choices: levels.map((level) => ({ value: level, name: effortLevelName(level) })),
    })
  }
  if (current?.supportsFastMode) {
    options.push({
      id: OPTION_IDS.fast,
      name: t('claude.option.fast'),
      description: t('claude.option.fastDescription'),
      category: 'model_config',
      type: 'boolean',
      value: choices.fast,
    })
  }
  options.push(ultracodeOption(choices.ultracode, ultracodeDefault))
  return options
}

/** The settings' model, as the model option's value. */
export function settingsModel(models: readonly ModelInfo[], model: unknown): string {
  if (typeof model !== 'string' || model === '') return DEFAULT_MODEL
  return models.find((item) => item.value === model)?.value ?? model
}
