// The usage tab's lower sections: the year's activity, the filters, the trend, the breakdown by
// model or project, the facts and the token composition, the note on where the numbers come from,
// and the sheet that picks a custom range.

import { useMemo, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { UsageScope, UsageStatus, UsageSummary } from '@shared/usage'
import { Sheet, type SheetItem } from '../components/Sheet'
import { clockOf } from '../sessions'
import { AgentAvatar } from '../ui/AgentAvatar'
import { BottomSheet } from '../ui/BottomSheet'
import { PartsBar, StackedBarChart, type TipContent } from '../ui/charts'
import { haptic } from '../ui/haptics'
import { Heatmap, HeatLegend } from '../ui/Heatmap'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Pill } from '../ui/Pill'
import { Press } from '../ui/Press'
import { SectionHeader } from '../ui/SectionHeader'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Skeleton } from '../ui/Skeleton'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'
import {
  addDays,
  busiestWeekday,
  dayCount,
  figures,
  foldRows,
  FIRST_DAY,
  fromCache,
  heatLevels,
  metricKind,
  metricValue,
  modelRows,
  monthStartOf,
  presets,
  projectRows,
  sessionRows,
  streaks,
  tokenParts,
  type AgentFilter,
  type DayRange,
  type DayTotal,
  type Figures,
  type Metric,
  type MetricKind,
  type Preset,
  type TokenPart,
  type TrendBar,
  type TrendUnit,
} from './model'
import { modelTitle } from './modelTitle'
import {
  agoText,
  barText,
  basename,
  compact,
  dateText,
  dayText,
  metricText,
  metricWords,
  METRIC_NAMES,
  percent,
  priceDate,
  rangeText,
  tickText,
  UNIT_NAMES,
  weekdayName,
} from './text'

type AgentFn = (agentId: string) => string

/** Each agent's part of a day or bar, the most first, as a tooltip's rows. */
function splitRows(
  byAgent: Partial<Record<string, number>>,
  kind: MetricKind,
  colorOf: AgentFn,
  nameOf: AgentFn,
): TipContent['rows'] {
  const entries = Object.entries(byAgent).filter((e): e is [string, number] => (e[1] ?? 0) > 0)
  if (entries.length < 2) return undefined
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([agentId, value]) => ({
      key: agentId,
      color: colorOf(agentId),
      label: nameOf(agentId),
      value: metricText(kind, value),
    }))
}

function agentValues(day: DayTotal, metric: Metric, scope: UsageScope) {
  const values: Record<string, number> = {}
  for (const [agentId, parts] of Object.entries(day.agentParts)) {
    if (parts) values[agentId] = metricValue(parts, metric, scope) ?? 0
  }
  return values
}

export function Activity(props: {
  /** The read's days for the agents the filter keeps. */
  days: DayTotal[]
  heat: DayRange
  range: DayRange
  today: number
  metric: Metric
  scope: UsageScope
  colorOf: AgentFn
  nameOf: AgentFn
  /** The chosen period as the summary names it: 「本月」「11月」. */
  periodName?: string
}) {
  const { c } = useTokens()
  const { days, heat, range, today, metric, scope } = props
  const kind = metricKind(metric, scope)
  const heatDays = useMemo(
    () => days.filter((d) => d.day >= heat.from && d.day < heat.to),
    [days, heat.from, heat.to],
  )
  const values = useMemo(
    () => heatDays.map((d) => metricValue(d.parts, metric, scope) ?? 0),
    [heatDays, metric, scope],
  )
  const levels = useMemo(() => heatLevels(values), [values])
  // A single day says little of habits, so today's view counts the whole year.
  const counted = dayCount(range) > 1 ? range : heat
  const active = figures(days, counted)
  const runs = streaks(days, counted, today)
  const weekday = busiestWeekday(days, counted, FIRST_DAY, metric, scope)
  const facts = [
    `${counted === heat ? '过去一年' : ''}${active.days} 天里 ${active.activeDays} 天有用量`,
    runs.current > 0 ? `连续 ${runs.current} 天` : null,
    runs.longest
      ? `最长 ${runs.longest.days} 天（${
          runs.longest.days > 1
            ? `${dateText(runs.longest.from)} – ${dateText(runs.longest.to)}`
            : dateText(runs.longest.from)
        }）`
      : null,
    weekday ? `${weekdayName(weekday.weekday)}占 ${percent(weekday.share)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  // The chosen period's own figures, so a day, week, month or year on the year's grid says how
  // much it used; a single day has no average or busiest day to tell.
  const framed = periodFigures(days, range, today, metric, scope)
  const several = dayCount(range) > 1

  return (
    <>
      <SectionHeader
        title="活动"
        right={
          <Text style={[typeScale.footnote, { color: c.textTertiary }]}>过去一年 · 今天有描边</Text>
        }
      />
      {framed ? (
        <View
          style={styles.framed}
          accessible
          accessibilityLabel={`${props.periodName ?? '这段时间'}共${metricWords(kind, framed.total)}`}
        >
          <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
            {props.periodName ?? '这段时间'}共
          </Text>
          <Text style={[typeScale.headline, styles.tabular, { color: c.text }]}>
            {framed.total > 0 ? metricWords(kind, framed.total) : '没有用量'}
          </Text>
          {framed.total > 0 && several ? (
            <Text
              style={[typeScale.footnote, styles.tabular, styles.flex, { color: c.textSecondary }]}
              numberOfLines={2}
            >
              {[
                `日均 ${metricWords(kind, framed.average)}`,
                framed.peak
                  ? `最多 ${dateText(framed.peak.day)} ${metricWords(kind, framed.peak.value)}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          ) : null}
        </View>
      ) : null}
      <Heatmap
        days={heatDays.map((d) => d.day)}
        levels={levels}
        frame={dayCount(range) > 1 ? range : null}
        accessibilityLabel={`活动，过去一年每天的${METRIC_NAMES[kind]}。${facts}`}
        tip={(i) => {
          const day = heatDays[i]!
          const value = values[i]!
          return {
            title: dayText(day.day),
            value: value > 0 ? metricWords(kind, value) : '没有用量',
            rows: splitRows(agentValues(day, metric, scope), kind, props.colorOf, props.nameOf),
          }
        }}
      />
      <HeatLegend />
      <Text
        style={[typeScale.footnote, styles.tabular, styles.sentence, { color: c.textSecondary }]}
      >
        {facts}
      </Text>
    </>
  )
}

/** A period's total, its average over the days gone by and its busiest day. */
function periodFigures(
  days: readonly DayTotal[],
  range: DayRange,
  today: number,
  metric: Metric,
  scope: UsageScope,
): { total: number; average: number; peak: { day: number; value: number } | null } {
  let total = 0
  let count = 0
  let peak: { day: number; value: number } | null = null
  for (const d of days) {
    if (d.day < range.from || d.day >= range.to || d.day > today) continue
    const value = metricValue(d.parts, metric, scope) ?? 0
    total += value
    count += 1
    if (value > 0 && (!peak || value > peak.value)) peak = { day: d.day, value }
  }
  return { total, average: count > 0 ? total / count : 0, peak }
}

/** A chip that opens a list of choices: "所有 Agent ⌄". */
function Chip(props: { label: string; onPress(): void; accessibilityLabel: string }) {
  const { c } = useTokens()
  return (
    <Press
      onPress={() => {
        haptic.tap()
        props.onPress()
      }}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      style={styles.chip}
      containerStyle={styles.chipWrap}
    >
      <Text style={[typeScale.lead, styles.chipText, { color: c.text }]} numberOfLines={1}>
        {props.label}
      </Text>
      <Icon name="chevronDown" size={14} color={c.textSecondary} weight="semibold" />
    </Press>
  )
}

export function Filters(props: {
  agents: readonly string[]
  agent: AgentFilter
  onAgent(agent: AgentFilter): void
  /** Whether the computer counts its agents' logs, so the source can be chosen. */
  fromComputer: boolean
  scope: UsageScope
  onScope(scope: UsageScope): void
  hostName: string
  metric: Metric
  onMetric(metric: Metric): void
  nameOf: AgentFn
}) {
  const [open, setOpen] = useState<'agent' | 'scope' | 'metric' | null>(null)
  const pick =
    <T,>(apply: (value: T) => void, value: T) =>
    () => {
      haptic.select()
      apply(value)
    }
  // A chosen agent stays a choice once its usage is gone.
  const choices =
    props.agent === 'all' || props.agents.includes(props.agent)
      ? props.agents
      : [...props.agents, props.agent]
  const agentName = props.agent === 'all' ? '所有 Agent' : props.nameOf(props.agent)
  const scopeName = props.scope === 'computer' ? props.hostName : '仅纸鸢'
  const requests = METRIC_NAMES[metricKind('requests', props.scope)]
  const metricName =
    props.metric === 'tokens' ? 'Token' : props.metric === 'cost' ? '费用' : requests

  const items: Record<'agent' | 'scope' | 'metric', SheetItem[]> = {
    agent: [
      {
        key: 'all',
        label: '所有 Agent',
        checked: props.agent === 'all',
        onPress: pick(props.onAgent, 'all' as AgentFilter),
      },
      ...choices.map((id) => ({
        key: id,
        label: props.nameOf(id),
        checked: props.agent === id,
        onPress: pick(props.onAgent, id as AgentFilter),
      })),
    ],
    scope: [
      {
        key: 'computer',
        label: props.hostName,
        detail: '纸鸢和各 Agent 自己的日志，包括在终端里的使用',
        checked: props.scope === 'computer',
        onPress: pick(props.onScope, 'computer' as UsageScope),
      },
      {
        key: 'kettu',
        label: '仅纸鸢',
        detail: '只算纸鸢运行的轮次',
        checked: props.scope === 'kettu',
        onPress: pick(props.onScope, 'kettu' as UsageScope),
      },
    ],
    metric: [
      {
        key: 'tokens',
        label: 'Token',
        checked: props.metric === 'tokens',
        onPress: pick(props.onMetric, 'tokens' as Metric),
      },
      {
        key: 'requests',
        label: requests,
        checked: props.metric === 'requests',
        onPress: pick(props.onMetric, 'requests' as Metric),
      },
      {
        key: 'cost',
        label: '费用',
        detail: '按 API 价格估算',
        checked: props.metric === 'cost',
        onPress: pick(props.onMetric, 'cost' as Metric),
      },
    ],
  }
  const titles = { agent: '按 Agent 筛选', scope: '统计来源', metric: '图表显示' }

  return (
    <>
      <SectionHeader title="筛选" />
      <View style={styles.chips}>
        <Chip
          label={agentName}
          onPress={() => setOpen('agent')}
          accessibilityLabel={`Agent：${agentName}`}
        />
        {props.fromComputer && (
          <Chip
            label={scopeName}
            onPress={() => setOpen('scope')}
            accessibilityLabel={`来源：${scopeName}`}
          />
        )}
        <Chip
          label={metricName}
          onPress={() => setOpen('metric')}
          accessibilityLabel={`图表显示：${metricName}`}
        />
      </View>
      <Sheet
        visible={open !== null}
        title={open ? titles[open] : undefined}
        items={open ? items[open] : []}
        onClose={() => setOpen(null)}
      />
    </>
  )
}

/** Where ticks go under `n` bars: a week apart for days, else about four. */
function tickIndices(unit: TrendUnit, n: number): number[] {
  const step = unit === 'hour' ? 6 : unit === 'day' && n > 14 ? 7 : Math.max(1, Math.ceil(n / 4))
  const out: number[] = []
  for (let i = 0; i < n; i += step) out.push(i)
  return out
}

export function Trend(props: {
  unit: TrendUnit | null
  bars: TrendBar[]
  series: string[]
  kind: MetricKind
  rangeLabel: string
  loading: boolean
  error: string | null
  onRetry(): void
  colorOf: AgentFn
  nameOf: AgentFn
}) {
  const { c } = useTokens()
  const [selected, setSelected] = useState<number | null>(null)
  const { unit, bars, kind } = props
  const chosen = selected !== null && selected < bars.length ? selected : null
  const total = bars.reduce((sum, bar) => sum + bar.total, 0)
  const peak = bars.reduce<number | null>(
    (best, bar, i) =>
      bar.total > 0 && (best === null || bar.total > bars[best]!.total) ? i : best,
    null,
  )

  let body
  if (props.error) {
    body = <SectionError message={props.error} onRetry={props.onRetry} />
  } else if (props.loading || unit === null) {
    body = <Skeleton height={150} radius={radius.sm} />
  } else if (total <= 0) {
    body = <EmptyNote text="这段时间没有用量。" />
  } else {
    body = (
      <>
        <StackedBarChart
          height={150}
          grid={[0.5, 1]}
          bars={bars.map((bar) => ({
            key: String(bar.from),
            segments: props.series.map((agentId) => ({
              key: agentId,
              value: bar.byAgent[agentId] ?? 0,
              color: props.colorOf(agentId),
            })),
          }))}
          ticks={Object.fromEntries(
            tickIndices(unit, bars.length).map((i) => [i, tickText(unit, bars[i]!.from)]),
          )}
          selected={chosen}
          onSelect={setSelected}
          tip={(i) => {
            const bar = bars[i]!
            return {
              title: barText(unit, bar.from, bar.to),
              value: bar.total > 0 ? metricWords(kind, bar.total) : '没有用量',
              rows: splitRows(bar.byAgent, kind, props.colorOf, props.nameOf),
            }
          }}
          describe={(i) => {
            const bar = bars[i]!
            return `${barText(unit, bar.from, bar.to)}，${bar.total > 0 ? metricWords(kind, bar.total) : '没有用量'}`
          }}
          accessibilityLabel={`趋势，${UNIT_NAMES[unit]}，${props.rangeLabel}，共 ${metricWords(kind, total)}${
            peak !== null
              ? `，最多的是 ${barText(unit, bars[peak]!.from, bars[peak]!.to)}，${metricWords(kind, bars[peak]!.total)}`
              : ''
          }`}
        />
        {props.series.length > 0 && (
          <View style={styles.trendLegend}>
            {props.series.map((agentId) => (
              <View key={agentId} style={styles.legendItem}>
                <View style={[styles.swatch, { backgroundColor: props.colorOf(agentId) }]} />
                <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                  {props.nameOf(agentId)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </>
    )
  }

  return (
    <>
      <SectionHeader
        title="趋势"
        right={
          <Text
            style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}
            numberOfLines={1}
          >
            {chosen !== null && unit !== null
              ? `${barText(unit, bars[chosen]!.from, bars[chosen]!.to)} · ${metricText(kind, bars[chosen]!.total)}`
              : unit !== null
                ? UNIT_NAMES[unit]
                : ''}
          </Text>
        }
      />
      {body}
    </>
  )
}

type Grouping = 'model' | 'project'

const GROUPINGS = [
  { key: 'model', label: '模型' },
  { key: 'project', label: '项目' },
] as const

export function Breakdown(props: {
  summary: UsageSummary
  agent: AgentFilter
  metric: Metric
  scope: UsageScope
}) {
  const { c } = useTokens()
  const [grouping, setGrouping] = useState<Grouping>('model')
  const kind = metricKind(props.metric, props.scope)
  const all = useMemo(
    () =>
      grouping === 'model'
        ? modelRows(props.summary, props.agent, props.metric, props.scope)
        : projectRows(props.summary, props.agent, basename, props.metric, props.scope),
    [grouping, props.summary, props.agent, props.metric, props.scope],
  )
  const { rows, rest } = foldRows(all)
  const sum = all.reduce((total, row) => total + (row.value ?? 0), 0)
  const max = Math.max(0, ...all.map((row) => row.value ?? 0))
  const lines = [
    ...rows.map((row) => ({
      key: row.key,
      name:
        row.name === null
          ? grouping === 'model'
            ? '未知模型'
            : '无项目'
          : grouping === 'model'
            ? modelTitle(row.name)
            : row.name,
      value: row.value,
    })),
    ...(rest ? [{ key: '__rest', name: `其他 ${rest.count} 个`, value: rest.value }] : []),
  ]
  return (
    <>
      <SectionHeader
        title="明细"
        right={
          <View style={styles.grouping}>
            <SegmentedControl<Grouping>
              segments={GROUPINGS}
              value={grouping}
              onChange={setGrouping}
            />
          </View>
        }
      />
      {lines.length === 0 ? (
        <EmptyNote text="这段时间没有用量。" />
      ) : (
        <View style={styles.rows}>
          {lines.map((line) => {
            const share = line.value !== null && sum > 0 ? line.value / sum : null
            const fill = line.value !== null && max > 0 ? line.value / max : 0
            return (
              <View
                key={line.key}
                style={styles.row}
                accessible
                accessibilityLabel={`${line.name}，${percent(share)}，${metricWords(kind, line.value)}`}
              >
                <Text
                  style={[typeScale.rowTitle, styles.rowName, { color: c.text }]}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {line.name}
                </Text>
                <View style={[styles.track, { backgroundColor: c.fill }]}>
                  {fill > 0 && (
                    <View
                      style={[
                        styles.fill,
                        { backgroundColor: c.tint, width: `${Math.max(fill * 100, 2)}%` },
                      ]}
                    />
                  )}
                </View>
                <Text style={[typeScale.callout, styles.rowShare, { color: c.text }]}>
                  {percent(share)}
                </Text>
                <Text
                  style={[typeScale.callout, styles.rowValue, { color: c.textSecondary }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {metricText(kind, line.value)}
                </Text>
              </View>
            )
          })}
        </View>
      )}
    </>
  )
}

/** The range's largest sessions in the metric; each opens its session. Hidden for an older Kettu. */
export function TopSessions(props: {
  summary: UsageSummary
  agent: AgentFilter
  metric: Metric
  scope: UsageScope
  nameOf: AgentFn
}) {
  const { c } = useTokens()
  const kind = metricKind(props.metric, props.scope)
  const rows = useMemo(
    () => sessionRows(props.summary, props.agent, props.metric, props.scope),
    [props.summary, props.agent, props.metric, props.scope],
  )
  if (!rows) return null
  const max = rows[0]?.value ?? 0
  return (
    <>
      <SectionHeader title={kind === 'cost' ? '花费最多的会话' : '用量最多的会话'} />
      {rows.length === 0 ? (
        <EmptyNote text={`这段时间没有能按${METRIC_NAMES[kind]}排的会话。`} />
      ) : (
        <View style={styles.sessions}>
          {rows.map(({ session, value }, i) => {
            const { sessionId } = session
            // A session run outside 纸鸢 has no title; its last use tells one from the next.
            const title =
              sessionId !== null
                ? session.title || '无标题会话'
                : session.lastAt
                  ? `终端里的会话 · ${dateText(session.lastAt)} ${clockOf(session.lastAt)}`
                  : '不是在纸鸢里运行的会话'
            const project =
              session.project !== null && !session.scratch ? basename(session.project) : '无项目'
            const meta = `${props.nameOf(session.agentId)} · ${project}`
            const fill = max > 0 ? value / max : 0
            return (
              <Press
                key={i}
                disabled={sessionId === null}
                scale={false}
                onPress={() => {
                  if (sessionId === null) return
                  haptic.tap()
                  router.push(`/session/${sessionId}`)
                }}
                accessibilityRole={sessionId === null ? undefined : 'button'}
                accessibilityLabel={`第 ${i + 1} 名，${title}，${meta}，${metricWords(kind, value)}`}
                style={styles.session}
              >
                <AgentAvatar
                  agentId={session.agentId}
                  name={props.nameOf(session.agentId)}
                  size={28}
                />
                <View style={styles.flex}>
                  <View style={styles.sessionHead}>
                    <Text
                      style={[
                        typeScale.rowTitle,
                        styles.flex,
                        { color: sessionId === null ? c.textSecondary : c.text },
                      ]}
                      numberOfLines={1}
                    >
                      {title}
                    </Text>
                    <Text style={[typeScale.callout, styles.tabular, { color: c.text }]}>
                      {metricText(kind, value)}
                    </Text>
                  </View>
                  <Text
                    style={[typeScale.footnote, { color: c.textSecondary }]}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    {meta}
                  </Text>
                  <View style={[styles.sessionTrack, { backgroundColor: c.fill }]}>
                    {fill > 0 && (
                      <View
                        style={[
                          styles.sessionFill,
                          { backgroundColor: c.tint, width: `${Math.max(fill * 100, 2)}%` },
                        ]}
                      />
                    )}
                  </View>
                </View>
              </Press>
            )
          })}
        </View>
      )}
    </>
  )
}

const PART_NAMES: Record<TokenPart, string> = {
  cacheRead: '缓存读取',
  cacheWrite: '缓存写入',
  input: '输入',
  output: '输出',
  reasoning: '推理',
}
const PART_ORDER: TokenPart[] = ['cacheRead', 'cacheWrite', 'input', 'output', 'reasoning']
const PART_SHADES: Record<TokenPart, number> = {
  cacheRead: 0.32,
  cacheWrite: 0.5,
  input: 0.7,
  reasoning: 0.82,
  output: 0.95,
}

export function Facts(props: { facts: Figures; tokenFacts: Figures; kind: MetricKind }) {
  const { c } = useTokens()
  const { facts, tokenFacts, kind } = props
  const cache = fromCache(tokenFacts.parts)
  const parts = tokenParts(tokenFacts.parts, tokenFacts.tokens).sort(
    (a, b) => PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part),
  )
  const lines = [
    {
      key: 'average',
      label: `每天平均 · ${facts.activeDays} 天活跃`,
      value: metricText(kind, facts.average),
    },
    facts.peak && {
      key: 'peak',
      label: `最忙一天 · ${dateText(facts.peak.day)}`,
      value: metricText(kind, facts.peak.total),
    },
    tokenFacts.cacheShare !== null && {
      key: 'cache',
      label: '来自提示缓存',
      value: percent(tokenFacts.cacheShare),
    },
    tokenFacts.priced &&
      tokenFacts.parts.cacheSaved > 0 && {
        key: 'saved',
        label: '提示缓存省下（按 API 价格）',
        value: metricText('cost', tokenFacts.parts.cacheSaved),
      },
  ].filter((line): line is { key: string; label: string; value: string } => !!line)

  return (
    <>
      <SectionHeader title="数据" />
      <View style={styles.facts}>
        {lines.map((line) => (
          <View
            key={line.key}
            style={styles.fact}
            accessible
            accessibilityLabel={`${line.label}，${line.value}`}
          >
            <Text
              style={[typeScale.body, styles.flex, { color: c.textSecondary }]}
              numberOfLines={1}
            >
              {line.label}
            </Text>
            <Text style={[typeScale.body, styles.tabular, { color: c.text }]}>{line.value}</Text>
          </View>
        ))}
      </View>
      {tokenFacts.tokens > 0 && (
        <View
          style={styles.composition}
          accessible
          accessibilityLabel={`token 构成：${parts
            .map((p) => `${PART_NAMES[p.part]} ${compact(p.tokens)}，${percent(p.share)}`)
            .join('；')}`}
        >
          <View style={styles.compositionHead}>
            <Text style={[typeScale.footnote, styles.flex, { color: c.textSecondary }]}>
              token 构成
            </Text>
            {cache.perHundred !== null && (
              <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                <Text style={[styles.tabular, { color: c.text, fontWeight: '600' }]}>
                  {cache.perHundred}%
                </Text>{' '}
                从提示缓存读取
              </Text>
            )}
          </View>
          <PartsBar
            height={8}
            parts={parts.map((p) => ({
              key: p.part,
              value: p.tokens,
              color: c.text,
              opacity: PART_SHADES[p.part],
            }))}
          />
          <View style={styles.partGrid}>
            {parts.map((p) => (
              <View key={p.part} style={styles.partItem}>
                <View
                  style={[styles.swatch, { backgroundColor: c.text, opacity: PART_SHADES[p.part] }]}
                />
                <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                  {PART_NAMES[p.part]}
                </Text>
                <Text
                  style={[typeScale.footnote, styles.tabular, styles.partValue, { color: c.text }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {compact(p.tokens)} · {percent(p.share)}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </>
  )
}

export function Footnote(props: {
  status: UsageStatus
  scope: UsageScope
  hostName: string
  pricesAsOf: string
}) {
  const { c } = useTokens()
  const synced = props.status.logs.reduce<number | null>(
    (latest, log) =>
      log.syncedAt !== null && (latest === null || log.syncedAt > latest) ? log.syncedAt : latest,
    null,
  )
  const source = props.status.unavailable
    ? '电脑上的用量记录打不开，数字可能不全。'
    : props.scope === 'computer'
      ? `读自 ${props.hostName} 上 Agent 的日志，${
          props.status.scanning
            ? '正在同步'
            : synced !== null
              ? `${agoText(synced)}同步`
              : '还没同步过'
        }。`
      : '只统计在纸鸢里运行的对话。'
  return (
    <Text style={[typeScale.footnote, styles.footnote, { color: c.textTertiary }]}>
      {source}
      {` 费用按 ${priceDate(props.pricesAsOf)} 的 API 价格估算；用订阅时这不是你实际付的钱。`}
    </Text>
  )
}

/** A read in progress on the computer: how much of the logs is done. */
export function ScanNote(props: { status: UsageStatus }) {
  const { c } = useTokens()
  const scan = props.status.scanning
  if (!scan) return null
  const share = scan.bytes > 0 ? scan.doneBytes / scan.bytes : 0
  return (
    <View style={[styles.scan, { backgroundColor: c.fill }]} accessibilityRole="progressbar">
      <ActivityIndicator size="small" color={c.textSecondary} />
      <Text style={[typeScale.footnote, styles.flex, { color: c.textSecondary }]}>
        正在读取电脑上的 Agent 日志… {Math.round(share * 100)}%
      </Text>
    </View>
  )
}

export function SectionError(props: { message: string; onRetry(): void }) {
  const { c } = useTokens()
  return (
    <View style={[styles.error, { backgroundColor: c.removedBg }]} accessibilityRole="alert">
      <Icon name="warning" size={16} color={c.danger} />
      <Text style={[typeScale.footnote, styles.flex, { color: c.text }]} numberOfLines={3}>
        没能读到：{props.message}
      </Text>
      <Pill label="重试" tone="tint" size="sm" onPress={props.onRetry} />
    </View>
  )
}

export function EmptyNote(props: { text: string }) {
  const { c } = useTokens()
  return (
    <Text style={[typeScale.callout, styles.emptyNote, { color: c.textTertiary }]}>
      {props.text}
    </Text>
  )
}

const PRESET_NAMES: Record<Preset['id'], string> = {
  yesterday: '昨天',
  thisWeek: '本周',
  lastWeek: '上周',
  thisMonth: '本月',
  lastMonth: '上月',
  thisYear: '今年',
}
const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日']

/** A month at a time: tap the first day, then the last; days with usage carry a dot. */
export function RangeSheet(props: {
  visible: boolean
  onClose(): void
  today: number
  /** The range shown now, both ends included, to start from. */
  initial: { from: number; to: number } | null
  used: ReadonlySet<number>
  onApply(from: number, to: number): void
}) {
  const { c } = useTokens()
  const [start, setStart] = useState<number | null>(props.initial?.from ?? null)
  const [end, setEnd] = useState<number | null>(props.initial?.to ?? null)
  const [month, setMonth] = useState(monthStartOf(props.initial?.to ?? props.today))
  const [opened, setOpened] = useState(false)
  if (props.visible !== opened) {
    setOpened(props.visible)
    if (props.visible) {
      setStart(props.initial?.from ?? null)
      setEnd(props.initial?.to ?? null)
      setMonth(monthStartOf(props.initial?.to ?? props.today))
    }
  }

  const date = new Date(month)
  const lead = (date.getDay() - FIRST_DAY + 7) % 7
  const length = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length }, (_, i) => addDays(month, i)),
  ]
  const thisMonth = monthStartOf(props.today)
  const shift = (n: number) => {
    haptic.select()
    setMonth(new Date(date.getFullYear(), date.getMonth() + n, 1).getTime())
  }
  const choose = (day: number) => {
    haptic.select()
    if (start === null || end !== null) {
      setStart(day)
      setEnd(null)
    } else if (day < start) {
      setStart(day)
    } else setEnd(day)
  }
  const last = end ?? start
  const apply = (from: number, to: number) => {
    haptic.tap()
    props.onApply(from, to)
    props.onClose()
  }

  return (
    <BottomSheet visible={props.visible} onClose={props.onClose} title="选择日期范围">
      <View style={styles.presets}>
        {presets(props.today, FIRST_DAY).map((preset) => (
          <Pill
            key={preset.id}
            label={PRESET_NAMES[preset.id]}
            tone={start === preset.from && last === preset.to ? 'tint' : 'fill'}
            onPress={() => apply(preset.from, preset.to)}
          />
        ))}
      </View>
      <View style={[styles.calendar, { backgroundColor: c.fill }]}>
        <View style={styles.monthHead}>
          <IconButton
            icon="chevronLeft"
            tone="plain"
            size={36}
            label="上个月"
            onPress={() => shift(-1)}
          />
          <Text style={[typeScale.headline, styles.flex, styles.centerText, { color: c.text }]}>
            {date.getFullYear()}年{date.getMonth() + 1}月
          </Text>
          <IconButton
            icon="chevronRight"
            tone="plain"
            size={36}
            label="下个月"
            disabled={month >= thisMonth}
            onPress={() => shift(1)}
          />
        </View>
        <View style={styles.week}>
          {WEEK_HEAD.map((d) => (
            <Text
              key={d}
              style={[
                typeScale.caption,
                styles.dayCell,
                styles.centerText,
                { color: c.textTertiary },
              ]}
            >
              {d}
            </Text>
          ))}
        </View>
        <View style={styles.week}>
          {cells.map((day, i) => {
            if (day === null) return <View key={`b${i}`} style={styles.dayCell} />
            const future = day > props.today
            const edge = day === start || day === last
            const inside = start !== null && last !== null && day > start && day < last
            return (
              <Press
                key={day}
                disabled={future}
                scale={false}
                onPress={() => choose(day)}
                accessibilityRole="button"
                accessibilityLabel={`${dayText(day)}${props.used.has(day) ? '，有用量' : ''}`}
                accessibilityState={{ selected: edge || inside, disabled: future }}
                containerStyle={styles.dayCell}
                style={[
                  styles.day,
                  edge && { backgroundColor: c.tint },
                  inside && { backgroundColor: c.tintSoft },
                ]}
              >
                <Text
                  style={[
                    typeScale.callout,
                    styles.tabular,
                    {
                      color: edge ? c.onAccent : future ? c.textTertiary : c.text,
                      fontWeight: day === props.today ? '700' : '400',
                    },
                  ]}
                >
                  {new Date(day).getDate()}
                </Text>
                <View
                  style={[
                    styles.dot,
                    {
                      backgroundColor: props.used.has(day)
                        ? edge
                          ? c.onAccent
                          : c.tint
                        : 'transparent',
                    },
                  ]}
                />
              </Press>
            )
          })}
        </View>
      </View>
      <Text style={[typeScale.footnote, styles.centerText, { color: c.textSecondary }]}>
        {start === null
          ? '点一天作为开始，再点一天作为结束。'
          : `${rangeText(start, addDays(last!, 1))} · ${dayCount({ from: start, to: addDays(last!, 1) })} 天`}
      </Text>
      <Press
        disabled={start === null}
        onPress={() => start !== null && apply(start, last!)}
        accessibilityRole="button"
        style={[styles.apply, { backgroundColor: c.tint }]}
      >
        <Text style={[typeScale.body, { color: c.onAccent, fontWeight: '600' }]}>完成</Text>
      </Press>
    </BottomSheet>
  )
}

/** The rest of the tab's sections while their first read is on its way. */
export function SectionsSkeleton() {
  return (
    <View style={styles.skeleton} accessibilityLabel="正在加载">
      <Skeleton width="30%" height={18} />
      <Skeleton height={112} radius={radius.sm} />
      <Skeleton width="30%" height={18} />
      <Skeleton height={150} radius={radius.sm} />
      <Skeleton width="30%" height={18} />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height={20} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  framed: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: space.sm,
    marginBottom: space.sm,
  },
  flex: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  centerText: { textAlign: 'center' },
  sentence: { marginTop: space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.xl, rowGap: space.sm },
  chipWrap: { maxWidth: '60%' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  chipText: { flexShrink: 1 },
  trendLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg, marginTop: space.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  grouping: { width: 160 },
  rows: { gap: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowName: { width: '32%' },
  track: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, minWidth: 6 },
  rowShare: { width: 44, textAlign: 'right', fontVariant: ['tabular-nums'] },
  rowValue: { width: 64, textAlign: 'right', fontVariant: ['tabular-nums'] },
  sessions: { gap: space.lg },
  session: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  sessionHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  sessionTrack: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: space.xs },
  sessionFill: { height: 4, borderRadius: 2, minWidth: 4 },
  facts: { gap: space.md },
  fact: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  composition: { gap: space.sm + 2, marginTop: space.xl },
  compositionHead: { flexDirection: 'row', alignItems: 'center' },
  partGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.xs, columnGap: space.lg },
  partItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    width: '47%',
    flexGrow: 1,
  },
  partValue: { flex: 1, textAlign: 'right' },
  footnote: { paddingTop: space.xxl },
  scan: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    marginTop: space.lg,
  },
  error: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
  },
  emptyNote: { paddingVertical: space.lg },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  calendar: { borderRadius: radius.lg, padding: space.sm },
  monthHead: { flexDirection: 'row', alignItems: 'center' },
  week: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 2 },
  day: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 4, height: 4, borderRadius: 2, marginTop: 1 },
  apply: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    minHeight: 52,
  },
  skeleton: { gap: space.lg, paddingTop: space.xxl },
})
