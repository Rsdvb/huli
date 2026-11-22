// The composer's menus of a session's options, as the desktop's control row has them
// (features/session/composer): the permission modes with their icons, and the model menu with its
// models and their descriptions, More models, the effort as one track, the agent's switches, every
// other option it reports under Options, Switch agent, where an agent and its model are picked
// together, and the plan's usage under them. A session and New session build them alike from the
// options they hold.

import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { needsNode } from '../manage/agents'
import type { AgentOptions, AgentStatus } from '@shared/agent-host'
import { isFullAccessMode, isStartMode } from '@shared/agents'
import { limitsForModel } from '@shared/plan-limits'
import { planQuota } from '@shared/plan-quota'
import { booleanConfigValue, isConfigValue, type ConfigOption } from '@shared/thread'
import { SegmentedControl } from '../ui/SegmentedControl'
import { AgentGlyph, G, Icon, type IconSpec } from '../ui/session/icons'
import {
  isExhausted,
  limitColor,
  planName,
  quotaText,
  shownLimit,
  tightestLimit,
  windowName,
} from '../ui/session/limits'
import { modelBlurb, optionDescription, optionName } from '../ui/session/optionText'
import type { MenuEntry, MenuPage } from '../ui/session/Popover'
import { UsageRing } from '../ui/session/StatusLine'
import type { Palette } from '../ui/tokens'

type Choice = NonNullable<ConfigOption['choices']>[number]
export type SelectOption = ConfigOption & { type: 'select'; choices: Choice[] }

export const isSelect = (o: ConfigOption | undefined): o is SelectOption =>
  !!o && o.type === 'select' && !!o.choices?.length

export function optionOf(
  config: readonly ConfigOption[],
  category: ConfigOption['category'],
): SelectOption | undefined {
  return config.find((o): o is SelectOption => o.category === category && isSelect(o))
}

/** The choice that stands for the value: an alias shows as the choice it names. */
export function shownChoice(option: SelectOption): Choice | undefined {
  const own = option.choices.find((c) => c.value === option.value)
  return (own?.shownAs ? option.choices.find((c) => c.value === own.shownAs) : undefined) ?? own
}

/** `provider/model` names show the model alone. */
export function modelName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1)
}

/** Another listed model of the same name, as one model on two routes is; its group then tells them apart. */
function twin(
  choices: readonly { name: string; shownAs?: string }[],
  choice: { name: string },
): boolean {
  const name = modelName(choice.name)
  return choices.some(
    (other) => other !== choice && !other.shownAs && modelName(other.name) === name,
  )
}

const MAIN_MODELS = 4

/** The current models and the older ones under More models; the first four when none is older. */
function splitModels(choices: Choice[]): { current: Choice[]; older: Choice[] } {
  const listed = choices.filter((c) => !c.shownAs)
  if (!listed.some((c) => c.older)) {
    return { current: listed.slice(0, MAIN_MODELS), older: listed.slice(MAIN_MODELS) }
  }
  return { current: listed.filter((c) => !c.older), older: listed.filter((c) => c.older) }
}

const isDefaultChoice = (c: { value: string; name: string }): boolean =>
  /^default$/i.test(c.value) || /^default\b/i.test(c.name)

// The providers' documented default effort, for an agent whose Default choice names none, as the
// desktop's levels.ts has them (platform.claude.com/docs/en/build-with-claude/effort).
const PROVIDER_DEFAULT_EFFORT: [pattern: RegExp, level: string][] = [
  [/claude-(opus|haiku)-5-5/, 'medium'],
  [/claude-/, 'high'],
]

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The effort's levels without the choice that leaves it to the agent, and the level shown as
 * chosen: that choice shows as the level its name says, else the level the model runs at as its
 * provider documents it, else the middle one.
 */
export function levelsOf(
  effort: SelectOption,
  model?: string,
): { levels: Choice[]; shown: string | undefined } {
  const levels = effort.choices.filter((c) => !isDefaultChoice(c))
  const value = String(effort.value)
  if (levels.some((l) => l.value === value)) return { levels, shown: value }
  const fallback = effort.choices.find(isDefaultChoice)
  const said = `${fallback?.name ?? ''} ${fallback?.description ?? ''}`.toLowerCase()
  const named = fallback
    ? [...levels]
        .sort((a, b) => b.name.length - a.name.length)
        .find((l) => new RegExp(`\\b${escapeRegExp(l.name.toLowerCase())}\\b`).test(said))
    : undefined
  const id = model?.toLowerCase() ?? ''
  const documented = PROVIDER_DEFAULT_EFFORT.find(([pattern]) => pattern.test(id))?.[1]
  const provider = levels.find((l) => l.value === documented)
  return {
    levels,
    shown: (named ?? provider ?? levels[Math.floor((levels.length - 1) / 2)])?.value,
  }
}

export type ModeLook = 'asks' | 'edits' | 'plan' | 'auto' | 'full'

export const MODE_ICON: Record<ModeLook, IconSpec> = {
  asks: G.shield,
  edits: G.pencil,
  plan: G.eye,
  auto: G.shieldCheck,
  full: G.shieldAlert,
}

const LOOKS: Record<string, ModeLook> = {
  default: 'asks',
  'read-only': 'asks',
  'workspace-write': 'edits',
  acceptEdits: 'edits',
  'accept-edits': 'edits',
  plan: 'plan',
  auto: 'auto',
  agent: 'auto',
}

export function modeLook(value: string | undefined): ModeLook {
  if (isFullAccessMode(value)) return 'full'
  return (value !== undefined && Object.hasOwn(LOOKS, value) && LOOKS[value]) || 'asks'
}

/** What the menus change a session's or a new session's options through. */
export interface ConfigControl {
  config: ConfigOption[]
  /** A turn runs, so options that change only between turns wait. */
  running: boolean
  set(option: ConfigOption, value: string | boolean): void
}

const BETWEEN_TURNS = '仅在两轮对话之间可更改'

export function modePage(control: ConfigControl): MenuPage | null {
  const mode = optionOf(control.config, 'mode')
  if (!mode) return null
  const locked = !!mode.idleOnly && control.running
  const current = shownChoice(mode)?.value
  const listed = mode.choices.filter((c) => !c.shownAs)
  const safe = listed.filter((c) => !isFullAccessMode(c.value))
  const full = listed.filter((c) => isFullAccessMode(c.value))
  const row = (choice: Choice): MenuEntry => ({
    key: choice.value,
    label: optionName(choice.name),
    icon: MODE_ICON[modeLook(choice.value)],
    ...(choice.description ? { subtitle: optionDescription(choice.description) } : {}),
    checked: choice.value === current,
    destructive: isFullAccessMode(choice.value),
    disabled: locked,
    onPress: () => control.set(mode, choice.value),
  })
  return {
    entries: [
      ...safe.map(row),
      ...(full.length > 0 && safe.length > 0 ? [{ kind: 'divider' as const, key: 'full' }] : []),
      ...full.map(row),
    ],
    ...(locked ? { footer: `权限模式${BETWEEN_TURNS}` } : {}),
  }
}

const isFast = (o: ConfigOption) => /fast/i.test(o.id)
const isUltracode = (o: ConfigOption) => /ultracode/i.test(o.id)

export interface ModelMenuContext {
  agentId: string
  agent: AgentStatus | undefined
  c: Palette
  /** Where Switch agent leads, or null where no other agent can take over. */
  switchAgent: { disabled: boolean; hint?: string } | null
  /** The plan's line at the end opens the plan's usage. */
  onUsage?: () => void
  /** What a change of model, effort or fast mode costs while the prompt cache is warm. */
  cacheNote?: string | null
  /** Huli: the API profile the session runs with, whose row leads to the `profiles` page. */
  profile?: { label: string; disabled?: boolean; hint?: string } | null
}

/** Huli: the name a session's API profile goes by; the agent's own sign-in for null. */
export function profileLabel(agent: AgentStatus | undefined, profileId: string | null): string {
  if (profileId === null) return '自己的登录'
  return agent?.profiles?.items.find((p) => p.id === profileId)?.name ?? '配置已删除'
}

/**
 * Huli: the agent's API profiles and its own sign-in, to run a session with; the chosen one is
 * checked and the default named.
 */
export function profilesPage(
  agent: AgentStatus | undefined,
  current: string | null,
  onChoose: (profileId: string | null) => void,
): MenuPage {
  const profiles = agent?.profiles
  const defaultId = profiles?.defaultId ?? null
  return {
    title: 'API 配置',
    entries: [
      {
        key: 'profile:own',
        label: `${agent?.harnessName ?? 'Agent'} 自己的登录`,
        ...(defaultId === null ? { subtitle: '默认' } : {}),
        checked: current === null,
        onPress: () => onChoose(null),
      },
      ...(profiles?.items ?? []).map((profile) => ({
        key: `profile:${profile.id}`,
        label: profile.name,
        subtitle: [PRESET_NAMES[profile.preset], profile.id === defaultId ? '默认' : null]
          .filter(Boolean)
          .join(' · '),
        checked: current === profile.id,
        onPress: () => onChoose(profile.id),
      })),
    ],
    footer: '在电脑的「设置 › 智能体」里添加或修改 API 配置',
  }
}

const PRESET_NAMES: Record<string, string> = {
  anthropic: 'Anthropic 官方（Console API 额度）',
  zhipu: '智谱 GLM 编程套餐',
  zai: 'Z.ai GLM 编程套餐（国际）',
  kimi: 'Kimi（月之暗面）',
  'kimi-intl': 'Kimi（月之暗面国际站）',
  deepseek: 'DeepSeek',
  bailian: '阿里云百炼 Coding Plan',
  ark: '火山方舟 Coding Plan',
  minimax: 'MiniMax',
  'minimax-intl': 'MiniMax（国际站）',
  custom: '自定义',
}

/** The select options the composer has no control of its own for, which the menu lists as Options. */
export function otherOptions(config: readonly ConfigOption[]): SelectOption[] {
  const mode = optionOf(config, 'mode')
  const model = optionOf(config, 'model')
  const effort = optionOf(config, 'thought_level')
  return config.filter(
    (o): o is SelectOption => isSelect(o) && o !== mode && o !== model && o !== effort,
  )
}

/** The model the effort's default stands for: its id where the agent names one. */
function modelKey(config: readonly ConfigOption[]): string | undefined {
  const model = optionOf(config, 'model')
  if (!model) return undefined
  return shownChoice(model)?.modelId ?? String(model.value)
}

// The window height, in points, from which the model menu has room for a line under each model:
// an iPhone Pro Max's 956, but not an SE's 667 or a mini's 812.
const ROOMY_HEIGHT = 850

const EFFORT_HINT = '强度越高，思考越久，消耗的套餐额度也越多'

/** The model menu's first page; null when the agent reports no model, effort or switch. */
export function modelPage(control: ConfigControl, context: ModelMenuContext): MenuPage | null {
  const model = optionOf(control.config, 'model')
  const effort = optionOf(control.config, 'thought_level')
  const switches = control.config.filter((o) => o.type === 'boolean')
  const others = otherOptions(control.config)
  if (!model && !effort && switches.length === 0 && others.length === 0 && !context.switchAgent) {
    return null
  }
  const entries: MenuEntry[] = []
  const lead = <AgentGlyph agentId={context.agentId} harness={context.agent?.harnessId} size={18} />

  if (model) {
    const locked = !!model.idleOnly && control.running
    const current = shownChoice(model)
    const { current: main, older } = splitModels(model.choices)
    // A small phone's menu holds the models by name alone; a tall one has room for a line each.
    const roomy = Dimensions.get('window').height >= ROOMY_HEIGHT
    const listed = current && !main.includes(current) ? [...main, current] : main
    for (const choice of listed) {
      entries.push({
        key: `model:${choice.value}`,
        label: optionName(modelName(choice.name)),
        lead,
        ...(locked
          ? { subtitle: BETWEEN_TURNS }
          : choice.group && twin(model.choices, choice)
            ? { subtitle: choice.group }
            : roomy && modelBlurb(choice)
              ? { subtitle: modelBlurb(choice)! }
              : {}),
        checked: choice.value === current?.value,
        disabled: locked,
        onPress: () => control.set(model, choice.value),
      })
    }
    if (older.length > 0) {
      entries.push({
        key: 'more',
        label: '更多模型',
        icon: G.more,
        detail: String(older.length),
        page: 'more',
      })
    }
  }

  if (effort) {
    const locked = !!effort.idleOnly && control.running
    const { levels, shown } = levelsOf(effort, modelKey(control.config))
    if (levels.length > 0) {
      const hint = locked ? BETWEEN_TURNS : EFFORT_HINT
      entries.push({ kind: 'divider', key: 'effort-rule', title: '推理强度' })
      entries.push({
        kind: 'custom',
        key: 'effort',
        picker: {
          label: '推理强度',
          options: levels.map((l) => ({ key: l.value, label: optionName(l.name) })),
          value: shown ?? '',
          onChange: (value) => control.set(effort, value),
          disabled: locked,
          hint,
        },
        node: (
          <View
            style={[styles.effort, locked && { opacity: 0.4 }]}
            pointerEvents={locked ? 'none' : 'auto'}
            accessibilityLabel="推理强度"
            accessibilityHint={hint}
          >
            <SegmentedControl
              segments={levels.map((l) => ({ key: l.value, label: optionName(l.name) }))}
              value={shown ?? ''}
              onChange={(value) => control.set(effort, value)}
            />
            <Text style={[styles.hint, { color: context.c.textTertiary }]}>{hint}</Text>
          </View>
        ),
      })
    }
  }

  // The switches and every other option the agent reports go under one 选项 row, so the menu
  // fits a small phone's screen without scrolling; the switches that are on show beside it.
  const options = optionEntries(control)
  if (options.length > 0) {
    const on = switches.filter((o) => booleanConfigValue(o) === true)
    entries.push({ kind: 'divider', key: 'options-rule' })
    entries.push({
      key: 'options',
      label: '选项',
      icon: G.sliders,
      ...(on.length > 0 ? { detail: on.map((o) => optionName(o.name)).join('、') } : {}),
      page: `option:${ALL_OPTIONS}`,
    })
  }

  if (context.profile) {
    entries.push({ kind: 'divider', key: 'profiles-rule' })
    entries.push({
      key: 'profiles',
      label: 'API 配置',
      icon: G.layers,
      detail: context.profile.label,
      ...(context.profile.hint ? { subtitle: context.profile.hint } : {}),
      disabled: !!context.profile.disabled,
      page: 'profiles',
    })
  }

  if (context.switchAgent) {
    entries.push({ kind: 'divider', key: 'agents-rule' })
    entries.push({
      key: 'agents',
      label: '换 Agent…',
      icon: G.swap,
      ...(context.switchAgent.hint ? { subtitle: context.switchAgent.hint } : {}),
      disabled: context.switchAgent.disabled,
      page: 'agents',
    })
  }

  // Only the windows that hold back the chosen model, as the desktop's tray warns about.
  const held = context.agent ? limitsForModel(context.agent.limits, model) : []
  const limit = context.agent ? shownLimit(held) : null
  const out = !!limit && isExhausted(limit)
  const usedUp = context.agent
    ? quotaText(planQuota({ ...context.agent, limits: held }, Date.now()))
    : null
  const footer = [
    planName(context.agent?.account ?? null),
    limit
      ? out
        ? (usedUp ?? `${windowName(limit)}限额已用完`)
        : `${windowName(limit)}限额已用 ${Math.round(limit.usedPercent ?? 0)}%`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const note = context.cacheNote ? { footer: context.cacheNote } : {}
  if (!footer) return { entries, ...note }
  const onUsage = context.onUsage
  if (!onUsage) {
    return { entries, footer: [footer, context.cacheNote].filter(Boolean).join('\n') }
  }
  // The plan's line opens its usage, so it is a row of its own rather than the page's footer.
  const { c } = context
  entries.push({ kind: 'divider', key: 'usage-rule' })
  entries.push({
    kind: 'custom',
    key: 'usage',
    // A system menu cannot draw the ring: the line is a row there, opening the same usage.
    row: { key: 'usage', label: footer, icon: G.timer, onPress: onUsage },
    node: (
      <Pressable
        onPress={onUsage}
        accessibilityRole="button"
        accessibilityLabel={`${footer}，查看套餐用量`}
        style={({ pressed }) => [styles.usage, pressed && { backgroundColor: c.fill }]}
      >
        {limit && (
          <UsageRing
            percent={out ? 100 : (limit.usedPercent ?? 0)}
            color={limitColor(limit, c)}
            track={c.fillStrong}
            size={14}
          />
        )}
        <Text
          style={[styles.usageText, { color: out ? c.danger : c.textSecondary }]}
          numberOfLines={2}
        >
          {footer}
        </Text>
        <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
      </Pressable>
    ),
  })
  return { entries, ...note }
}

/** The page id of 选项 itself, beside the pages of each option's choices. */
const ALL_OPTIONS = '*'

/** 选项's rows: the agent's switches, one line each, then its other options, each a page. */
function optionEntries(control: ConfigControl): MenuEntry[] {
  const entries: MenuEntry[] = []
  for (const option of control.config.filter((o) => o.type === 'boolean')) {
    const locked = !!option.idleOnly && control.running
    entries.push({
      key: `switch:${option.id}`,
      label: optionName(option.name),
      icon: isFast(option) ? G.bolt : isUltracode(option) ? G.layers : G.gear,
      ...(locked ? { subtitle: BETWEEN_TURNS } : {}),
      toggle: booleanConfigValue(option) === true,
      disabled: locked,
      onPress: () => control.set(option, booleanConfigValue(option) !== true),
    })
  }
  for (const option of otherOptions(control.config)) {
    const locked = !!option.idleOnly && control.running
    const choice = shownChoice(option)
    entries.push({
      key: `option:${option.id}`,
      label: optionName(option.name),
      icon: G.sliders,
      ...(locked
        ? { subtitle: BETWEEN_TURNS }
        : choice
          ? { detail: optionName(modelName(choice.name)) }
          : {}),
      disabled: locked,
      page: `option:${option.id}`,
    })
  }
  return entries
}

/** The choices of one of the Options, from the model menu; 选项 itself for `ALL_OPTIONS`. */
export function optionPage(control: ConfigControl, id: string): MenuPage | null {
  if (id === ALL_OPTIONS) {
    const entries = optionEntries(control)
    return entries.length > 0 ? { title: '选项', entries } : null
  }
  const option = otherOptions(control.config).find((o) => o.id === id)
  if (!option) return null
  const locked = !!option.idleOnly && control.running
  const current = shownChoice(option)?.value
  return {
    title: optionName(option.name),
    entries: option.choices
      .filter((choice) => !choice.shownAs)
      .map((choice) => ({
        key: choice.value,
        label: optionName(modelName(choice.name)),
        ...(choice.description ? { subtitle: optionDescription(choice.description) } : {}),
        checked: choice.value === current,
        disabled: locked,
        onPress: () => control.set(option, choice.value),
      })),
    ...(locked ? { footer: `${optionName(option.name)}${BETWEEN_TURNS}` } : {}),
  }
}

export function moreModelsPage(control: ConfigControl, agentId: string): MenuPage {
  const model = optionOf(control.config, 'model')
  const older = model ? splitModels(model.choices).older : []
  const current = model ? shownChoice(model)?.value : undefined
  const locked = !!model?.idleOnly && control.running
  return {
    title: '更多模型',
    entries: older.map((choice) => ({
      key: choice.value,
      label: optionName(modelName(choice.name)),
      ...(modelBlurb(choice) ? { subtitle: modelBlurb(choice)! } : {}),
      lead: <AgentGlyph agentId={agentId} size={18} />,
      checked: choice.value === current,
      disabled: locked,
      onPress: () => model && control.set(model, choice.value),
    })),
    empty: '没有更多模型',
  }
}

// The categories whose last chosen values carry over to the next session, as the host keeps them.
const REMEMBERED: ReadonlySet<ConfigOption['category']> = new Set([
  'model',
  'model_config',
  'thought_level',
])

/** The mode option the agent's start mode is set on, and that mode, when it offers it. */
function startModeOf(entry: AgentOptions): { optionId: string; value: string } | null {
  if (!isStartMode(entry.agentId, entry.startMode)) return null
  const option = optionOf(entry.config, 'mode')
  return option && isConfigValue(option, entry.startMode)
    ? { optionId: option.id, value: entry.startMode }
    : null
}

/**
 * The options a new session with the agent starts with, as the desktop's New session works them out
 * (features/session/new-session/start-options.ts): the agent's own values, then those remembered
 * from earlier sessions, then the start mode, then what the user picked here. The effort is the one
 * the chosen model offered when last seen.
 */
export function startConfig(
  entry: AgentOptions,
  picks: Record<string, string | boolean>,
): ConfigOption[] {
  const start = startModeOf(entry)
  const valueOf = (option: ConfigOption): string | boolean => {
    const pick = picks[option.id]
    if (pick !== undefined && isConfigValue(option, pick)) return pick
    if (start?.optionId === option.id) return start.value
    const remembered = REMEMBERED.has(option.category) ? entry.remembered[option.id] : undefined
    if (remembered !== undefined && isConfigValue(option, remembered)) return remembered
    return option.value
  }
  const model = optionOf(entry.config, 'model')
  const modelValue = model ? valueOf(model) : null
  return entry.config.map((option) => {
    const base =
      option.category === 'thought_level' && typeof modelValue === 'string'
        ? (entry.levels[modelValue] ?? option)
        : option
    return { ...base, value: valueOf(base) }
  })
}

/**
 * Why a new session starts with another value than the one it would have kept, in the desktop's
 * words (newSession.startNotice): a model or option remembered from earlier sessions that the
 * agent no longer offers.
 */
export function startNotices(
  entry: AgentOptions,
  picks: Record<string, string | boolean>,
  agent: string,
): string[] {
  const started = new Map(startConfig(entry, picks).map((o) => [o.id, o]))
  return entry.config.flatMap((option) => {
    if (!REMEMBERED.has(option.category) || picks[option.id] !== undefined) return []
    const wanted = entry.remembered[option.id]
    if (wanted === undefined || isConfigValue(option, wanted)) return []
    const now = started.get(option.id)
    const nameOf = (value: string | boolean | undefined) => {
      const choice = now?.choices?.find((c) => c.value === value)
      return choice ? optionName(modelName(choice.name)) : String(value ?? '')
    }
    const actual = nameOf(now?.value)
    return option.category === 'model'
      ? [`${agent} 已不再提供 ${String(wanted)}，将使用 ${actual} 启动。`]
      : [
          `${agent} 已不再提供 ${optionName(option.name)} ${String(wanted)}，将使用 ${actual} 启动。`,
        ]
  })
}

/** What `sessions.create` takes: the start values that differ from the agent's own. */
export function startValues(
  entry: AgentOptions,
  picks: Record<string, string | boolean>,
): Record<string, string | boolean> {
  const defaults = new Map(entry.provisional ? [] : entry.config.map((o) => [o.id, o.value]))
  const start = startModeOf(entry)
  const values: Record<string, string | boolean> = {}
  for (const option of startConfig(entry, picks)) {
    const picked = start?.optionId === option.id && picks[option.id] === option.value
    if (picked || defaults.get(option.id) !== option.value) values[option.id] = option.value
  }
  return values
}

/**
 * What an agent needs before it can start, as the desktop's agent menu says it
 * (new-session/start-options.ts): Node.js, its own program updated, its install to finish, a
 * failed start looked at, or a sign-in. The phone does all but the install's wait on the agent's
 * or harness's page, which `openNeed` opens.
 */
export type AgentNeed = 'node' | 'update' | 'installing' | 'failed' | 'sign-in' | null

export function agentNeed(agent: AgentStatus): AgentNeed {
  if (needsNode(agent)) return 'node'
  if (agent.cli?.installed?.problem?.kind === 'too-old') return 'update'
  if (agent.state === 'installing') return 'installing'
  if (agent.state === 'failed') return 'failed'
  return agent.signIn === 'required' ? 'sign-in' : null
}

/** What a menu row of an agent that needs something says, with where a tap takes it. */
const NEED_ROW: Record<NonNullable<AgentNeed>, string> = {
  node: '需要 Node.js · 点按去安装',
  update: '需要更新 · 点按去更新',
  installing: '正在安装…',
  failed: '出错 · 点按查看',
  'sign-in': '需要登录 · 点按去登录',
}

/** Opens the page where the phone gives the agent what it needs: its own, or its harness's. */
export function openNeed(agent: AgentStatus, need: NonNullable<AgentNeed>): void {
  if (need === 'update' || need === 'installing') {
    router.push({ pathname: '/settings/harness', params: { id: agent.harnessId } })
  } else {
    router.push({ pathname: '/settings/agent', params: { id: agent.id } })
  }
}

/**
 * The agents a menu lists: added, not hidden or turned off, installed, or found but too old, which
 * shows as needing an update.
 */
export function usableAgents(agents: Map<string, AgentStatus>): AgentStatus[] {
  return [...agents.values()].filter(
    (a) =>
      a.registered !== false &&
      !a.hidden &&
      !a.disabled &&
      !a.uninstalled &&
      (!['not-installed', 'node-missing', 'node-outdated'].includes(a.state) ||
        agentNeed(a) === 'update'),
  )
}

/** The agents a menu leaves out while they wait for Node.js, which New session lists to install. */
export function waitingForNode(agents: Map<string, AgentStatus>): AgentStatus[] {
  return [...agents.values()].filter(
    (a) => a.registered !== false && !a.hidden && !a.disabled && !a.uninstalled && needsNode(a),
  )
}

/** Whether a session can start with the agent now. */
export function canStart(agent: AgentStatus): boolean {
  const need = agentNeed(agent)
  // Huli: one signed out whose new sessions run on an API profile starts them with its key.
  return need === null || (need === 'sign-in' && !!agent.profiles?.defaultId)
}

/** The model an agent's next session starts with, from the options its last one reported. */
function defaultChoice(options: AgentOptions | undefined): Choice | null {
  if (!options) return null
  const model = optionOf(options.config, 'model')
  if (!model) return null
  const value = options.remembered[model.id] ?? model.value
  return model.choices.find((c) => c.value === value) ?? shownChoice(model) ?? null
}

export interface AgentMenuProps {
  agents: AgentStatus[]
  current: string | null
  /** The chosen agent's model, checked among its models. */
  currentModel?: string | null
  options: AgentOptions[] | null
  error: string | null
  onRetry(): void
  /** An agent and one of its models together, or with null its default model. */
  onChoose(agent: AgentStatus, model: string | null): void
  footer: string
  title: string
  c: Palette
}

/**
 * The agents to choose, each leading to its models so an agent and a model are picked at once;
 * one that cannot start says why. `agent:<id>` is an agent's page of models.
 */
export function agentsPage(props: AgentMenuProps): MenuPage {
  const { c } = props
  return {
    title: props.title,
    loading: props.options === null && !props.error,
    entries: props.agents.map((agent): MenuEntry => {
      const need = agentNeed(agent)
      const entry = props.options?.find((o) => o.agentId === agent.id)
      const model = defaultChoice(entry)
      const models = entry ? (optionOf(entry.config, 'model')?.choices.length ?? 0) : 0
      const limit = tightestLimit(agent.limits)
      const left =
        limit?.usedPercent != null ? Math.max(0, 100 - Math.round(limit.usedPercent)) : null
      // A used-up plan says when it comes back, or that extra usage pays on, in place of its share.
      const quota = planQuota(agent, Date.now())
      const usedUp = quotaText(quota)
      const subtitle = need ? NEED_ROW[need] : model ? optionName(modelName(model.name)) : undefined
      return {
        key: agent.id,
        label: agent.name,
        lead: <AgentGlyph agentId={agent.id} harness={agent.harnessId} size={20} />,
        ...(subtitle ? { subtitle } : {}),
        ...(!need && (usedUp || (left !== null && limit))
          ? { belowText: usedUp ?? `剩余 ${left}%` }
          : {}),
        below:
          !need && usedUp ? (
            <Text
              style={[
                styles.leftText,
                styles.quota,
                { color: quota.kind === 'out' ? c.danger : c.warning },
              ]}
            >
              {usedUp}
            </Text>
          ) : !need && left !== null && limit ? (
            <View style={styles.left}>
              <UsageRing
                percent={limit.usedPercent ?? 0}
                color={limitColor(limit, c)}
                track={c.fillStrong}
                size={15}
              />
              <Text style={[styles.leftText, { color: c.textSecondary }]}>剩余 {left}%</Text>
            </View>
          ) : undefined,
        // An agent that leads to its models has no check of its own, so the current one says so.
        ...(need === null && models > 1
          ? { page: `agent:${agent.id}`, ...(agent.id === props.current ? { detail: '当前' } : {}) }
          : { checked: agent.id === props.current }),
        disabled: need === 'installing',
        onPress: () => (need ? openNeed(agent, need) : props.onChoose(agent, null)),
      }
    }),
    error: props.error,
    onRetry: props.onRetry,
    footer: props.footer,
    empty: '没有别的 Agent 可以接手',
  }
}

/** One agent's models, the current first and the older after them, to pick with the agent. */
export function agentModelsPage(props: AgentMenuProps, agentId: string): MenuPage | null {
  const agent = props.agents.find((a) => a.id === agentId)
  const entry = props.options?.find((o) => o.agentId === agentId)
  const model = entry ? optionOf(entry.config, 'model') : undefined
  if (!agent || !model) return null
  const chosen =
    agentId === props.current ? (props.currentModel ?? defaultChoice(entry)?.value) : null
  const { current, older } = splitModels(model.choices)
  const lead = <AgentGlyph agentId={agent.id} harness={agent.harnessId} size={18} />
  const row = (choice: Choice): MenuEntry => ({
    key: choice.value,
    label: optionName(modelName(choice.name)),
    lead,
    ...(choice.description ? { subtitle: optionDescription(choice.description) } : {}),
    checked: choice.value === chosen,
    onPress: () => props.onChoose(agent, choice.value),
  })
  return {
    title: agent.name,
    entries: [
      ...current.map(row),
      ...(older.length > 0
        ? [{ kind: 'divider' as const, key: 'older', title: '更多模型' }, ...older.map(row)]
        : []),
    ],
  }
}

const styles = StyleSheet.create({
  effort: { paddingHorizontal: 4, paddingVertical: 4, gap: 6 },
  hint: { fontSize: 12, lineHeight: 16, paddingHorizontal: 8 },
  left: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  leftText: { fontSize: 13, fontVariant: ['tabular-nums'] },
  quota: { marginTop: 3 },
  usage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  usageText: { flex: 1, fontSize: 12.5, lineHeight: 17, fontVariant: ['tabular-nums'] },
})
