// The composer's menus of a session's options, as the desktop's control row has them
// (features/session/composer): the permission modes with their icons, and the model menu with its
// models, More models, the effort as one track, the agent's switches, Switch agent and the plan's
// usage under them. A session and New session build them alike from the options they hold.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentOptions, AgentStatus } from '@shared/agent-host'
import { isFullAccessMode, isStartMode } from '@shared/agents'
import { limitsForModel } from '@shared/plan-limits'
import { booleanConfigValue, isConfigValue, type ConfigOption } from '@shared/thread'
import { SegmentedControl } from '../ui/SegmentedControl'
import { AgentGlyph, G, Icon, type IconSpec } from '../ui/session/icons'
import {
  isExhausted,
  limitColor,
  planName,
  shownLimit,
  tightestLimit,
  windowName,
} from '../ui/session/limits'
import { optionDescription, optionName } from '../ui/session/optionText'
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

/**
 * The effort's levels without the choice that leaves it to the agent, and the level shown as
 * chosen: that choice shows as the level its name says, else the middle one.
 */
function levelsOf(effort: SelectOption): { levels: Choice[]; shown: string | undefined } {
  const levels = effort.choices.filter((c) => !isDefaultChoice(c))
  const value = String(effort.value)
  if (levels.some((l) => l.value === value)) return { levels, shown: value }
  const fallback = effort.choices.find(isDefaultChoice)
  const said = `${fallback?.name ?? ''} ${fallback?.description ?? ''}`.toLowerCase()
  const named = [...levels]
    .sort((a, b) => b.name.length - a.name.length)
    .find((l) => said.includes(l.name.toLowerCase()))
  return { levels, shown: (named ?? levels[Math.floor((levels.length - 1) / 2)])?.value }
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

const BETWEEN_TURNS = '这一轮结束后才能改'

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

function switchHint(option: ConfigOption, locked: boolean): string | undefined {
  if (locked) return BETWEEN_TURNS
  if (option.value !== 'default') {
    return option.description ? optionDescription(option.description) : undefined
  }
  return option.defaultValue === true
    ? '跟随 Agent 的设置：开'
    : option.defaultValue === false
      ? '跟随 Agent 的设置：关'
      : '跟随 Agent 的设置'
}

export interface ModelMenuContext {
  agentId: string
  agent: AgentStatus | undefined
  c: Palette
  /** Where Switch agent leads, or null where no other agent can take over. */
  switchAgent: { disabled: boolean; hint?: string } | null
  /** The plan's line at the end opens the plan's usage. */
  onUsage?: () => void
}

/** The model menu's first page; null when the agent reports no model, effort or switch. */
export function modelPage(control: ConfigControl, context: ModelMenuContext): MenuPage | null {
  const model = optionOf(control.config, 'model')
  const effort = optionOf(control.config, 'thought_level')
  const switches = control.config.filter((o) => o.type === 'boolean')
  if (!model && !effort && switches.length === 0 && !context.switchAgent) return null
  const entries: MenuEntry[] = []
  const lead = <AgentGlyph agentId={context.agentId} harness={context.agent?.harnessId} size={18} />

  if (model) {
    const locked = !!model.idleOnly && control.running
    const current = shownChoice(model)
    const { current: main, older } = splitModels(model.choices)
    const listed = current && !main.includes(current) ? [...main, current] : main
    for (const choice of listed) {
      entries.push({
        key: `model:${choice.value}`,
        label: optionName(modelName(choice.name)),
        lead,
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
    const { levels, shown } = levelsOf(effort)
    if (levels.length > 0) {
      if (entries.length > 0) entries.push({ kind: 'divider', key: 'effort-rule' })
      entries.push({
        kind: 'custom',
        key: 'effort',
        picker: {
          label: optionName(effort.name),
          options: levels.map((l) => ({ key: l.value, label: optionName(l.name) })),
          value: shown ?? '',
          onChange: (value) => control.set(effort, value),
          disabled: locked,
        },
        node: (
          <View
            style={[styles.effort, locked && { opacity: 0.4 }]}
            pointerEvents={locked ? 'none' : 'auto'}
            accessibilityLabel={effort.name}
          >
            <SegmentedControl
              segments={levels.map((l) => ({ key: l.value, label: optionName(l.name) }))}
              value={shown ?? ''}
              onChange={(value) => control.set(effort, value)}
            />
          </View>
        ),
      })
    }
  }

  for (const option of switches) {
    const locked = !!option.idleOnly && control.running
    const hint = switchHint(option, locked)
    entries.push({
      key: `switch:${option.id}`,
      label: optionName(option.name),
      icon: isFast(option) ? G.bolt : isUltracode(option) ? G.layers : G.gear,
      ...(hint ? { subtitle: hint } : {}),
      toggle: booleanConfigValue(option) === true,
      disabled: locked,
      onPress: () => control.set(option, booleanConfigValue(option) !== true),
    })
  }

  if (context.switchAgent) {
    entries.push({
      key: 'agents',
      label: '切换 Agent…',
      icon: G.swap,
      ...(context.switchAgent.hint ? { subtitle: context.switchAgent.hint } : {}),
      disabled: context.switchAgent.disabled,
      page: 'agents',
    })
  }

  // Only the windows that hold back the chosen model, as the desktop's tray warns about.
  const limit = context.agent ? shownLimit(limitsForModel(context.agent.limits, model)) : null
  const out = !!limit && isExhausted(limit)
  const footer = [
    planName(context.agent?.account ?? null),
    limit
      ? out
        ? `${windowName(limit)}限额已用完`
        : `${windowName(limit)}限额已用 ${Math.round(limit.usedPercent ?? 0)}%`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
  if (!footer) return { entries }
  const onUsage = context.onUsage
  if (!onUsage) return { entries, footer }
  // The plan's line opens its usage, so it is a row of its own rather than the page's footer.
  const { c } = context
  entries.push({ kind: 'divider', key: 'usage-rule' })
  entries.push({
    kind: 'custom',
    key: 'usage',
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
  return { entries }
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
      ...(choice.description ? { subtitle: choice.description } : {}),
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

/** The agents that could run a session: added, installed, not hidden or turned off. */
export function usableAgents(agents: Map<string, AgentStatus>): AgentStatus[] {
  return [...agents.values()].filter(
    (a) =>
      a.registered !== false &&
      !a.hidden &&
      !a.disabled &&
      !a.uninstalled &&
      !['not-installed', 'node-missing', 'node-outdated'].includes(a.state),
  )
}

/** An agent's default model by name, from the options its last new session reported. */
function defaultModel(options: AgentOptions | undefined): string | null {
  if (!options) return null
  const model = optionOf(options.config, 'model')
  if (!model) return null
  const value = options.remembered[model.id] ?? model.value
  const choice = model.choices.find((c) => c.value === value) ?? shownChoice(model)
  return choice ? optionName(modelName(choice.name)) : null
}

export function agentsPage(props: {
  agents: AgentStatus[]
  current: string | null
  options: AgentOptions[] | null
  error: string | null
  onRetry(): void
  onChoose(agent: AgentStatus): void
  footer: string
  c: Palette
}): MenuPage {
  const { c } = props
  return {
    title: '切换 Agent',
    loading: props.options === null && !props.error,
    entries: props.agents.map((agent) => {
      const model = defaultModel(props.options?.find((o) => o.agentId === agent.id))
      const limit = tightestLimit(agent.limits)
      const left =
        limit?.usedPercent != null ? Math.max(0, 100 - Math.round(limit.usedPercent)) : null
      return {
        key: agent.id,
        label: agent.name,
        lead: <AgentGlyph agentId={agent.id} harness={agent.harnessId} size={20} />,
        ...(model ? { subtitle: model } : {}),
        below:
          left !== null && limit ? (
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
        checked: agent.id === props.current,
        disabled: agent.signIn === 'required',
        onPress: () => props.onChoose(agent),
      }
    }),
    error: props.error,
    onRetry: props.onRetry,
    footer: props.footer,
    empty: '没有别的 Agent 可以接手',
  }
}

const styles = StyleSheet.create({
  effort: { paddingHorizontal: 4, paddingVertical: 4 },
  left: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  leftText: { fontSize: 13, fontVariant: ['tabular-nums'] },
  usage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  usageText: { flex: 1, fontSize: 12.5, lineHeight: 17, fontVariant: ['tabular-nums'] },
})
