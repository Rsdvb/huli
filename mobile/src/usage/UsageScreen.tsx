// Usage: a sentence on the period, each agent's plan limits as rings, then the period's tokens,
// requests and estimated cost, its share by agent, its spread over the hours of the day, the
// year's activity, the filters, the trend, the breakdown by model or project, the facts and the
// token composition, as the computer counts them.

import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import { ActivityIndicator, Animated, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useIsFocused, useLocalSearchParams } from 'expo-router'
import type { AgentStatus, LimitsReason, PlanLimit } from '@shared/agent-host'
import type { UsageScope } from '@shared/usage'
import { TopBar, useScrollTopOnTabPress } from '../components/shell'
import { useActiveHost, useAgents, useHostState, useMaybeLink } from '../host'
import { clockOf, errorText } from '../sessions'
import { agentColor } from '../ui/agent-marks'
import { AgentAvatar } from '../ui/AgentAvatar'
import { Card } from '../ui/Card'
import { BarChart, ConcentricRings, Donut, Ring } from '../ui/charts'
import { EmptyState } from '../ui/EmptyState'
import { haptic } from '../ui/haptics'
import { useContentWidth } from '../ui/layout'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { Press } from '../ui/Press'
import { Screen } from '../ui/Screen'
import { useCollapsingHeader } from '../ui/ScrollHeader'
import { usePullRefresh } from '../ui/PullRefresh'
import { SectionHeader } from '../ui/SectionHeader'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Skeleton } from '../ui/Skeleton'
import {
  radius,
  space,
  TAB_BAR_CLEARANCE,
  type as typeScale,
  useTokens,
  type Palette,
} from '../ui/tokens'
import {
  addDays,
  agentTotals,
  CLOCK_DAYS,
  dayTotals,
  figures,
  FIRST_DAY,
  heatmapRange,
  hourBars,
  hourSplit,
  hourValues,
  metricKind,
  metricValue,
  oneDay,
  periodOf,
  seriesOf,
  trend,
  type AgentFilter,
  type Metric,
  type PeriodUnit,
  type RangeChoice,
} from './model'
import {
  Activity,
  Breakdown,
  EmptyNote,
  Facts,
  Filters,
  Footnote,
  RangeSheet,
  ScanNote,
  SectionError,
  SectionsSkeleton,
  TopSessions,
  Trend,
} from './sections'
import {
  compact,
  grouped,
  hourName,
  metricText,
  metricWords,
  money,
  percent,
  rangeText,
} from './text'
import { useUsage } from './useUsage'
import { inlineReset, isExhausted } from '../ui/session/limits'
import { useTicking } from '../ui/session/ticking'

type Period = PeriodUnit | 'all'

const PERIODS = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
  { key: 'year', label: '年' },
  { key: 'all', label: '全部' },
] as const

const NEAR_WORDS: Record<PeriodUnit, [string, string]> = {
  day: ['今天', '昨天'],
  week: ['本周', '上周'],
  month: ['本月', '上月'],
  year: ['今年', '去年'],
}

const UNIT_WORDS: Record<PeriodUnit, string> = { day: '天', week: '周', month: '月', year: '年' }

/** How the page names a period: 今天, 上周, 2025年10月. */
function periodWord(unit: PeriodUnit, step: number, today: number, near = true): string {
  if (near && (step === 0 || step === -1)) return NEAR_WORDS[unit][-step]!
  const { from, to } = periodOf(unit, step, today)
  const d = new Date(from)
  const sameYear = d.getFullYear() === new Date(today).getFullYear()
  switch (unit) {
    case 'day':
    case 'week':
      return rangeText(from, to)
    case 'month':
      return sameYear ? `${d.getMonth() + 1}月` : `${d.getFullYear()}年${d.getMonth() + 1}月`
    case 'year':
      return `${d.getFullYear()}年`
  }
}

const WINDOWS: Record<string, string> = {
  five_hour: '5 小时',
  seven_day: '每周',
  seven_day_opus: '每周 · Opus',
  seven_day_sonnet: '每周 · Sonnet',
  monthly: '每月',
  annual: '每年',
  overage: '额外用量',
}

/** How the summary sentence names a window: 本周的 37%. */
const WINDOW_SPANS: Record<string, string> = {
  five_hour: '这 5 小时',
  seven_day: '本周',
  seven_day_opus: '本周 Opus',
  seven_day_sonnet: '本周 Sonnet',
  monthly: '本月',
  annual: '今年',
}

const REASONS: Record<LimitsReason, string> = {
  'vendor-disallows': '服务商不提供套餐额度的读取。',
  'harness-does-not-offer': '这个 Agent 不报告套餐额度。',
  'administrator-managed': '额度由管理员管理。',
  'model-provider-managed': '额度由模型服务商管理。',
  'not-yet-supported': '暂不支持读取这个 Agent 的额度。',
  'console-managed': '用 API 密钥登录，用量请到服务商控制台查看。',
}

const DONUT_UNITS = { tokens: 'token', requests: '次请求', turns: '轮', cost: '估算费用' } as const

function limitLabel(limit: PlanLimit): string {
  const known = WINDOWS[limit.window]
  if (known) return known
  const weekly = /^Weekly · (.+)$/.exec(limit.label)
  if (weekly) return `每周 · ${weekly[1]}`
  const fiveHour = /^5-hour · (.+)$/.exec(limit.label)
  return fiveHour ? `5 小时 · ${fiveHour[1]}` : limit.label
}

function limitColor(c: Palette, limit: PlanLimit): string {
  const used = limit.usedPercent ?? 0
  if (limit.state === 'reached' || used >= 90) return c.danger
  if (limit.state === 'warning' || used >= 75) return c.warning
  return c.tint
}

export default function UsageScreen() {
  const { c } = useTokens()
  const link = useMaybeLink()
  const agents = useAgents()
  const state = useHostState()
  const host = useActiveHost()
  const header = useCollapsingHeader()
  const pull = usePullRefresh(() => usage.sync(), header)
  const insets = useSafeAreaInsets()
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null)
  const [choice, setChoice] = useState<RangeChoice>({ kind: 'day', step: 0 })
  const [lastPeriod, setLastPeriod] = useState<Period>('day')
  const [wanted, setWanted] = useState<UsageScope>('computer')
  const [agent, setAgent] = useState<AgentFilter>('all')
  const [metric, setMetric] = useState<Metric>('tokens')
  const [picking, setPicking] = useState(false)
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())
  const [limitErrors, setLimitErrors] = useState<Record<string, string>>({})
  const [hour, setHour] = useState<number | null>(null)
  const connected = state.kind === 'connected'

  // A session's plan usage leads here filtered to its agent; `at` tells one visit from the next.
  const params = useLocalSearchParams<{ agent?: string; at?: string }>()
  useEffect(() => {
    if (!params.agent) return
    setHour(null)
    setAgent(params.agent)
    scroll.current?.scrollTo({ y: 0, animated: false })
  }, [params.agent, params.at])
  const focused = useIsFocused()
  const usage = useUsage(link, connected, choice, wanted, focused)
  const { read } = usage
  const hostName = host?.name ?? '电脑'

  useScrollTopOnTabPress((y) => scroll.current?.scrollTo({ y, animated: true }), header)

  const refreshLimits = (agent: AgentStatus) => {
    if (!link) return
    setRefreshing((set) => new Set(set).add(agent.id))
    setLimitErrors((errors) => {
      const next = { ...errors }
      delete next[agent.id]
      return next
    })
    link
      .request('agents.refreshLimits', { agentId: agent.id, force: true, ask: true })
      .catch((failure: unknown) =>
        setLimitErrors((errors) => ({ ...errors, [agent.id]: errorText(failure) })),
      )
      .finally(() =>
        setRefreshing((set) => {
          const next = new Set(set)
          next.delete(agent.id)
          return next
        }),
      )
  }

  const readable = (a: AgentStatus) =>
    a.capabilities.reports && a.signIn !== 'required' && a.state !== 'not-installed'

  // The agents with a plan to show: those reporting limits, or able to, or saying why not.
  const planAgents = useMemo(
    () =>
      [...agents.values()].filter(
        (a) =>
          a.registered !== false &&
          !a.uninstalled &&
          (a.limits.length > 0 ||
            (!a.hidden && !a.disabled && (a.capabilities.reports || !!a.limitsReason))),
      ),
    [agents],
  )

  const hoursRead = usage.hours
  const derived = useMemo(() => {
    if (!read) return null
    const { summary, starts, range, scope, today } = read
    const days = dayTotals(summary, starts, agent)
    const single = oneDay(range)
    const hours = hoursRead && hoursRead.key === read.key ? hoursRead : null
    const trendData = single
      ? hours && {
          unit: 'hour' as const,
          bars: hourBars(
            dayTotals(hours.summary, hours.starts, agent),
            hours.starts,
            metric,
            scope,
          ),
        }
      : trend(
          days,
          range,
          FIRST_DAY,
          metric,
          scope,
          read.choice.kind === 'year' ? 'month' : undefined,
        )
    return {
      kind: metricKind(metric, scope),
      days,
      single,
      facts: figures(days, range, metric, scope),
      tokenFacts: figures(days, range),
      byMetric: agentTotals(days, range, metric, scope),
      byTokens: agentTotals(days, range, 'tokens', scope),
      hourly: hourValues(summary.clock, agent, metric, scope),
      heat: heatmapRange(today, FIRST_DAY),
      trend: trendData,
      series: trendData ? seriesOf(trendData.bars, summary.agents) : [],
      used: new Set(
        dayTotals(summary, starts, 'all')
          .filter((d) => d.total > 0)
          .map((d) => d.day),
      ),
    }
  }, [read, hoursRead, agent, metric])

  // Series slots follow the agent's place in the summary's own agent list, so a period with fewer
  // agents never repaints the rest.
  const colorOf = (agentId: string) => {
    const order: readonly string[] = read?.summary.agents ?? []
    const slot = Math.max(0, order.indexOf(agentId))
    return agentColor(agentId, c.series[slot % c.series.length]!)
  }
  const nameOf = (agentId: string) => agents.get(agentId)?.name ?? agentId

  // The plan window nearest its limit, for the summary's second line.
  const tightest = (() => {
    let best: { agent: AgentStatus; limit: PlanLimit } | null = null
    for (const agent of planAgents) {
      for (const limit of agent.limits) {
        if (limit.usedPercent === null) continue
        if (!best || limit.usedPercent > (best.limit.usedPercent ?? 0)) best = { agent, limit }
      }
    }
    return best
  })()
  const observed = Math.max(0, ...planAgents.flatMap((a) => a.limits.map((l) => l.observedAt)))
  const anyRefreshing = refreshing.size > 0

  const width = useContentWidth()
  const cardWidth = (width - space.xl * 2 - space.md) / 2

  const choosePeriod = (next: Period) => {
    setHour(null)
    setLastPeriod(next)
    setChoice(next === 'all' ? { kind: 'all' } : { kind: next, step: 0 })
  }

  // ‹ and › move a calendar period back and forth, never past the current one.
  const stepPeriod = (by: number) => {
    if (choice.kind === 'all' || choice.kind === 'custom') return
    const step = Math.min(0, choice.step + by)
    if (step === choice.step) return
    haptic.tap()
    setHour(null)
    setChoice({ kind: choice.kind, step })
  }

  const planSection = planAgents.length > 0 && (
    <>
      <SectionHeader
        title="套餐限额"
        count={planAgents.length}
        right={
          <Press
            onPress={() => {
              haptic.tap()
              planAgents.filter(readable).forEach(refreshLimits)
            }}
            disabled={anyRefreshing || !connected}
            accessibilityRole="button"
            accessibilityLabel="刷新套餐限额"
            hitSlop={8}
            style={styles.readAt}
          >
            <Text style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}>
              {observed > 0 ? `读取于 ${clockOf(observed)}` : '还没读过'}
            </Text>
            {anyRefreshing ? (
              <ActivityIndicator size="small" color={c.textTertiary} />
            ) : (
              <Icon name="refresh" size={14} color={c.textTertiary} />
            )}
          </Press>
        }
      />
      <View style={styles.grid}>
        {planAgents.map((agent) => (
          <PlanCard
            key={agent.id}
            agent={agent}
            width={cardWidth}
            refreshing={refreshing.has(agent.id)}
            error={limitErrors[agent.id] ?? agent.limitsError ?? null}
            readable={readable(agent)}
            onPress={() => router.push({ pathname: '/plan/[id]', params: { id: agent.id } })}
          />
        ))}
      </View>
    </>
  )

  const body = () => {
    if (!connected && !read) {
      return (
        <EmptyState icon="chart" title="连上电脑后才能看用量" message="用量由电脑上的纸鸢统计。" />
      )
    }
    if (!read && usage.error) {
      return (
        <EmptyState
          tone="error"
          icon="warning"
          title="没能读到用量"
          message={usage.error}
          action={{ label: '重试', onPress: () => void usage.load() }}
        />
      )
    }
    if (!read || !derived) {
      return (
        <>
          <UsageSkeleton />
          {planSection}
          <SectionsSkeleton />
        </>
      )
    }
    const { range, scope, summary, status, today } = read
    const { kind, facts, tokenFacts } = derived
    const custom = choice.kind === 'custom'
    const customLabel =
      choice.kind === 'custom' ? rangeText(choice.from, addDays(choice.to, 1)) : ''
    const readChoice = read.choice
    const periodName =
      readChoice.kind === 'custom'
        ? rangeText(range.from, range.to)
        : readChoice.kind === 'all'
          ? '至今'
          : periodWord(readChoice.kind, readChoice.step, today)
    const stepping = choice.kind !== 'custom' && choice.kind !== 'all' ? choice : null
    // The navigator names the period, and under 今天 or 上周 also its dates.
    const shownWord = stepping ? periodWord(stepping.kind, stepping.step, today) : ''
    const shownDates =
      stepping && stepping.step >= -1 ? periodWord(stepping.kind, stepping.step, today, false) : ''
    const top = derived.byTokens[0]
    const requests = metricValue(tokenFacts.parts, 'requests', scope) ?? 0
    const waiting = usage.loading && read.key !== usage.key
    const rangeLabel = rangeText(range.from, range.to)
    const clockLabel = derived.single ? `最近 ${CLOCK_DAYS} 天` : rangeLabel
    const hourly = derived.hourly
    const busiest = hourly.reduce(
      (best, v, i) => (v > 0 && (best < 0 || v > hourly[best]!) ? i : best),
      -1,
    )
    const never = summary.first === null && tokenFacts.tokens === 0
    const filters = (
      <Filters
        agents={summary.agents}
        agent={agent}
        onAgent={(next) => {
          setHour(null)
          setAgent(next)
        }}
        fromComputer={status.fromComputer}
        scope={scope}
        onScope={setWanted}
        hostName={hostName}
        metric={metric}
        onMetric={(next) => {
          setHour(null)
          setMetric(next)
        }}
        nameOf={nameOf}
      />
    )
    const footnote = (
      <Footnote status={status} scope={scope} hostName={hostName} pricesAsOf={summary.pricesAsOf} />
    )

    return (
      <>
        <View style={styles.summary} accessibilityRole="header">
          <View style={styles.sentence}>
            {top && <AgentAvatar agentId={top.agentId} name={nameOf(top.agentId)} size={30} />}
            <Text style={[typeScale.lead, styles.flex, { color: c.text }]}>
              {tokenFacts.tokens > 0
                ? agent === 'all'
                  ? `${periodName} ${derived.byTokens.length} 个 Agent 用了 ${compact(tokenFacts.tokens)} token。`
                  : `${periodName} ${nameOf(agent)} 用了 ${compact(tokenFacts.tokens)} token。`
                : `${periodName}还没有用量。`}
            </Text>
          </View>
          {tightest && (
            <View style={styles.sentence}>
              <Text style={[typeScale.lead, { color: c.textSecondary }]}>
                {tightest.agent.account?.label ?? tightest.agent.name} 已用
              </Text>
              <Ring
                size={22}
                stroke={4}
                progress={(tightest.limit.usedPercent ?? 0) / 100}
                color={limitColor(c, tightest.limit)}
              />
              <Text style={[typeScale.lead, styles.flex, { color: c.textSecondary }]}>
                {WINDOW_SPANS[tightest.limit.window] ?? limitLabel(tightest.limit)}的{' '}
                {Math.round(tightest.limit.usedPercent ?? 0)}%。
              </Text>
            </View>
          )}
        </View>

        {planSection}

        <View style={styles.periodRow}>
          <View style={styles.flex}>
            {custom ? (
              <View style={styles.customRow}>
                <Pill
                  tone="tint"
                  size="lg"
                  label={customLabel}
                  onPress={() => setPicking(true)}
                  accessibilityLabel={`日期范围：${customLabel}，点按更改`}
                />
                <Pill
                  tone="fill"
                  size="lg"
                  onPress={() => choosePeriod(lastPeriod)}
                  accessibilityLabel="清除日期范围"
                  leading={
                    <Icon name="close" size={14} color={c.textSecondary} weight="semibold" />
                  }
                />
              </View>
            ) : (
              <SegmentedControl segments={PERIODS} value={choice.kind} onChange={choosePeriod} />
            )}
          </View>
          <Press
            onPress={() => {
              haptic.tap()
              setPicking(true)
            }}
            accessibilityRole="button"
            accessibilityLabel="选择日期范围"
            style={[styles.calendar, { backgroundColor: custom ? c.tintSoft : c.fill }]}
          >
            <Icon name="calendar" size={20} color={custom ? c.tint : c.text} />
          </Press>
        </View>
        {stepping && (
          <View style={styles.stepRow}>
            <Press
              onPress={() => stepPeriod(-1)}
              accessibilityRole="button"
              accessibilityLabel={`上一${UNIT_WORDS[stepping.kind]}`}
              hitSlop={8}
              style={[styles.stepButton, { backgroundColor: c.fill }]}
            >
              <Icon name="chevronLeft" size={16} color={c.text} weight="semibold" />
            </Press>
            <View style={styles.stepLabel} accessible accessibilityRole="text">
              <Text style={[typeScale.headline, { color: c.text }]} numberOfLines={1}>
                {shownWord}
              </Text>
              {shownDates !== '' && (
                <Text
                  style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}
                  numberOfLines={1}
                >
                  {shownDates}
                </Text>
              )}
            </View>
            <Press
              onPress={() => stepPeriod(1)}
              disabled={stepping.step >= 0}
              accessibilityRole="button"
              accessibilityLabel={`下一${UNIT_WORDS[stepping.kind]}`}
              hitSlop={8}
              style={[
                styles.stepButton,
                { backgroundColor: c.fill, opacity: stepping.step >= 0 ? 0.35 : 1 },
              ]}
            >
              <Icon name="chevronRight" size={16} color={c.text} weight="semibold" />
            </Press>
          </View>
        )}

        {usage.error ? (
          <View style={styles.inlineError}>
            <SectionError message={usage.error} onRetry={() => void usage.load()} />
          </View>
        ) : null}
        <ScanNote status={status} />

        {never ? (
          <>
            <EmptyState
              icon="chart"
              title={status.scanning ? '正在读取日志…' : '还没有用量'}
              message={
                scope === 'kettu' && status.fromComputer
                  ? '只算纸鸢运行的对话时还没有用量；在筛选里换成电脑上的全部日志试试。'
                  : status.fromComputer
                    ? `在 ${hostName} 上用 Agent 写代码之后，token、请求和费用会出现在这里。`
                    : `纸鸢会记下它运行的每一轮对话。要算上之前和在终端里的使用，请在 ${hostName} 的 设置 › 用量 里打开「统计本机用量」。`
              }
            />
            {status.fromComputer && filters}
            {footnote}
          </>
        ) : (
          <View style={{ opacity: waiting ? 0.5 : 1 }} accessibilityState={{ busy: waiting }}>
            <View style={styles.stats}>
              <Stat
                value={compact(tokenFacts.tokens)}
                label="Token"
                note={
                  tokenFacts.parts.cacheRead > 0
                    ? `${compact(tokenFacts.parts.cacheRead)} 来自缓存`
                    : undefined
                }
              />
              <Stat
                value={grouped(requests)}
                label={metricKind('requests', scope) === 'turns' ? '轮' : '请求'}
                note={derived.single ? undefined : `${tokenFacts.activeDays} 天有用量`}
              />
              <Stat
                value={money(tokenFacts.priced ? tokenFacts.parts.cost : null)}
                label="估算费用"
                note="按 API 价格"
              />
            </View>

            {derived.byMetric.length > 0 && (
              <>
                <SectionHeader title="按 Agent" />
                <View
                  style={styles.byAgent}
                  accessible
                  accessibilityLabel={`按 Agent：${derived.byMetric
                    .map(
                      (a) =>
                        `${nameOf(a.agentId)} ${metricWords(kind, a.value)}，${percent(a.value / facts.total)}`,
                    )
                    .join('；')}`}
                >
                  <Donut
                    size={132}
                    stroke={18}
                    segments={derived.byMetric.map((a) => ({
                      key: a.agentId,
                      value: a.value,
                      color: colorOf(a.agentId),
                    }))}
                  >
                    <Text
                      style={[typeScale.headline, styles.tabular, { color: c.text }]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                    >
                      {metricText(kind, facts.total)}
                    </Text>
                    <Text style={[typeScale.caption, { color: c.textSecondary }]}>
                      {DONUT_UNITS[kind]}
                    </Text>
                  </Donut>
                  <View style={styles.legend}>
                    {derived.byMetric.slice(0, 6).map((a) => (
                      <View key={a.agentId} style={styles.legendRow}>
                        <View style={[styles.swatch, { backgroundColor: colorOf(a.agentId) }]} />
                        <Text
                          style={[typeScale.callout, styles.flex, { color: c.text }]}
                          numberOfLines={1}
                        >
                          {nameOf(a.agentId)}
                        </Text>
                        <Text style={[typeScale.callout, styles.tabular, { color: c.text }]}>
                          {metricText(kind, a.value)}
                        </Text>
                        <Text
                          style={[typeScale.footnote, styles.percent, { color: c.textSecondary }]}
                        >
                          {percent(facts.total > 0 ? a.value / facts.total : null)}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              </>
            )}

            <SectionHeader
              title="按小时"
              right={
                <Text
                  style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}
                  numberOfLines={1}
                >
                  {hour !== null
                    ? `${hourName(hour)} · ${metricText(kind, hourly[hour] ?? 0)}`
                    : busiest >= 0
                      ? `${clockLabel} · 最忙 ${hourName(busiest)}`
                      : clockLabel}
                </Text>
              }
            />
            {busiest >= 0 ? (
              <>
                <Text
                  style={[
                    typeScale.caption,
                    styles.tabular,
                    { color: c.textTertiary, marginBottom: space.xs },
                  ]}
                >
                  {metricText(kind, Math.max(...hourly))}
                </Text>
                <BarChart
                  values={hourly}
                  height={120}
                  grid={[0.5, 1]}
                  emphasis={busiest}
                  selected={hour}
                  onSelect={setHour}
                  labels={{ 0: '0时', 6: '6时', 12: '12时', 18: '18时', 23: '24时' }}
                  tip={(i) => ({
                    title: `${hourName(i)} · ${clockLabel}`,
                    value: hourly[i]! > 0 ? metricWords(kind, hourly[i]!) : '没有用量',
                    rows: (() => {
                      const split = hourSplit(summary.clock, i, agent, metric, scope)
                      return split.length > 1
                        ? split.map((s) => ({
                            key: s.agentId,
                            color: colorOf(s.agentId),
                            label: nameOf(s.agentId),
                            value: metricText(kind, s.value),
                          }))
                        : undefined
                    })(),
                  })}
                  describe={(i) =>
                    `${hourName(i)}，${hourly[i]! > 0 ? metricWords(kind, hourly[i]!) : '没有用量'}`
                  }
                  accessibilityLabel={`按小时，${clockLabel}，最忙的是${hourName(busiest)}`}
                />
              </>
            ) : (
              <EmptyNote text="这段时间没有用量。" />
            )}

            <Activity
              days={derived.days}
              heat={derived.heat}
              range={range}
              today={today}
              metric={metric}
              scope={scope}
              colorOf={colorOf}
              nameOf={nameOf}
              periodName={periodName}
            />

            {filters}

            <Trend
              unit={derived.trend?.unit ?? null}
              bars={derived.trend?.bars ?? []}
              series={derived.series}
              kind={kind}
              rangeLabel={rangeLabel}
              loading={derived.single && !derived.trend && !usage.hoursError}
              error={derived.single ? usage.hoursError : null}
              onRetry={usage.retryHours}
              colorOf={colorOf}
              nameOf={nameOf}
            />

            <Breakdown summary={summary} agent={agent} metric={metric} scope={scope} />

            <TopSessions
              summary={summary}
              agent={agent}
              metric={metric}
              scope={scope}
              nameOf={nameOf}
            />

            <Facts facts={facts} tokenFacts={tokenFacts} kind={kind} />

            {footnote}
          </View>
        )}
      </>
    )
  }

  const pickerRange = read
    ? read.choice.kind === 'custom'
      ? { from: read.choice.from, to: read.choice.to }
      : { from: read.range.from, to: addDays(read.range.to, -1) }
    : null

  return (
    <Screen readable>
      <Animated.ScrollView
        ref={scroll}
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop + space.sm,
          paddingHorizontal: space.xl,
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        }}
        refreshControl={pull}
      >
        {body()}
      </Animated.ScrollView>
      <TopBar header={header} filter={false} />
      {read && (
        <RangeSheet
          visible={picking}
          onClose={() => setPicking(false)}
          today={read.today}
          initial={pickerRange}
          used={derived?.used ?? new Set()}
          onApply={(from, to) => {
            setHour(null)
            setChoice({ kind: 'custom', from, to })
          }}
        />
      )}
    </Screen>
  )
}

function Stat(props: { value: string; label: string; note?: string }) {
  const { c } = useTokens()
  return (
    <View
      style={styles.stat}
      accessible
      accessibilityLabel={`${props.label} ${props.value}${props.note ? `，${props.note}` : ''}`}
    >
      <Text
        style={[typeScale.stat, styles.tabular, { color: c.text }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {props.value}
      </Text>
      <Text style={[typeScale.callout, { color: c.textSecondary }]}>{props.label}</Text>
      {props.note ? (
        <Text style={[typeScale.caption, { color: c.textTertiary }]} numberOfLines={1}>
          {props.note}
        </Text>
      ) : null}
    </View>
  )
}

function limitWhy(agent: AgentStatus, readable: boolean): string {
  if (agent.limitsReason) return REASONS[agent.limitsReason]
  if (agent.signIn === 'required' && agent.capabilities.reports) return '登录后才能读到额度。'
  // Huli reads Antigravity's limits only when asked: running agy by itself breaks Google's terms.
  if (agent.id === 'antigravity' && readable) return '点开后按「刷新」查询额度，只在你点的时候查。'
  return readable ? '还没有报告套餐用量。' : '不报告套餐额度。'
}

function PlanCard(props: {
  agent: AgentStatus
  width: number
  refreshing: boolean
  error: string | null
  readable: boolean
  onPress(): void
}) {
  const { c } = useTokens()
  const { agent } = props
  const limits = agent.limits.slice(0, 3)
  // Counts down while a window says when it resets.
  const counting = limits.some((l) => inlineReset(l) !== null)
  const ticked = useTicking(counting)
  const now = counting ? ticked : Date.now()
  return (
    <Card
      onPress={props.onPress}
      accessibilityLabel={`${agent.account?.label ?? agent.name} 的套餐限额`}
      containerStyle={{ width: props.width }}
      style={styles.planCard}
      padding={space.md + 2}
    >
      <View style={styles.planHead}>
        <AgentAvatar agentId={agent.id} name={agent.name} size={24} />
        {/* Two lines, so a long name such as Google Antigravity reads whole on a half-width card. */}
        <Text style={[typeScale.subhead, styles.flex, { color: c.text }]} numberOfLines={2}>
          {agent.account?.label ?? agent.name}
        </Text>
        {props.refreshing ? (
          <ActivityIndicator size="small" color={c.textTertiary} />
        ) : (
          <Icon name="chevronRight" size={12} color={c.textTertiary} weight="semibold" />
        )}
      </View>
      {limits.length > 0 ? (
        <View style={styles.planBody}>
          <ConcentricRings
            size={56}
            stroke={5}
            gap={2.5}
            rings={limits.map((l) => ({
              progress: (l.usedPercent ?? 0) / 100,
              color: limitColor(c, l),
            }))}
          />
          {/* Each window as the desktop's card has it: a dot in its ring's color, the rings from
              the outer one in, its name on the left and its share on the right, so a long name
              such as 每周 · Fable shortens itself and never the figure. Near its end, when it
              resets goes under the figure. */}
          <View style={styles.planLegend}>
            {limits.map((l) => {
              const reset = inlineReset(l, now)
              const out = reset !== null && isExhausted(l, now)
              const tone = (l.usedPercent ?? 0) >= 95 || out ? limitColor(c, l) : c.text
              return (
                <View key={l.window}>
                  <View style={styles.planLine}>
                    <View style={[styles.planDot, { backgroundColor: limitColor(c, l) }]} />
                    <Text
                      style={[typeScale.caption, styles.planLineName, { color: c.textSecondary }]}
                      numberOfLines={1}
                    >
                      {limitLabel(l)}
                    </Text>
                    <Text style={[typeScale.subhead, styles.tabular, { color: tone }]}>
                      {out
                        ? '已用完'
                        : l.usedPercent === null
                          ? '—'
                          : `${Math.round(l.usedPercent)}%`}
                    </Text>
                  </View>
                  {reset ? (
                    <Text
                      style={[
                        typeScale.caption,
                        styles.tabular,
                        styles.planReset,
                        {
                          color:
                            (l.usedPercent ?? 0) >= 90 || out ? limitColor(c, l) : c.textSecondary,
                        },
                      ]}
                      numberOfLines={1}
                    >
                      {reset}
                    </Text>
                  ) : null}
                </View>
              )
            })}
          </View>
        </View>
      ) : (
        <Text style={[typeScale.footnote, { color: c.textSecondary }]} numberOfLines={3}>
          {limitWhy(agent, props.readable)}
        </Text>
      )}
      {props.error ? (
        <Text style={[typeScale.caption, { color: c.danger }]} numberOfLines={2}>
          {props.error}
        </Text>
      ) : null}
    </Card>
  )
}

/** The summary and the figures while their first read is on its way. */
function UsageSkeleton() {
  return (
    <View style={styles.skeleton} accessibilityLabel="正在加载">
      <Skeleton width="85%" height={26} />
      <Skeleton width="60%" height={26} />
      <Skeleton height={40} radius={radius.pill} />
      <View style={styles.skeletonCards}>
        <Skeleton width="28%" height={52} />
        <Skeleton width="28%" height={52} />
        <Skeleton width="28%" height={52} />
      </View>
      <View style={styles.skeletonCards}>
        <Skeleton width={132} height={132} radius={66} />
        <View style={styles.skeletonLegend}>
          <Skeleton height={18} />
          <Skeleton width="70%" height={18} />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  summary: { gap: space.sm, paddingTop: space.md },
  sentence: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  readAt: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  planCard: { gap: space.md, minHeight: 128 },
  planHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  planBody: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  planLegend: { flex: 1, gap: 3 },
  planLine: { flexDirection: 'row', alignItems: 'baseline', gap: space.xs },
  planDot: { width: 6, height: 6, borderRadius: 3, alignSelf: 'center' },
  planLineName: { flex: 1 },
  planReset: { textAlign: 'right' },
  periodRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingTop: space.xxl },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingTop: space.md },
  stepButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLabel: { flex: 1, alignItems: 'center', gap: 2 },
  calendar: {
    width: 44,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineError: { paddingTop: space.lg },
  stats: { flexDirection: 'row', gap: space.lg, paddingTop: space.xl },
  stat: { flex: 1, gap: 2 },
  byAgent: { flexDirection: 'row', alignItems: 'center', gap: space.xl },
  legend: { flex: 1, gap: space.md },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  percent: { width: 40, textAlign: 'right', fontVariant: ['tabular-nums'] },
  skeleton: { gap: space.lg, paddingTop: space.md },
  skeletonCards: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  skeletonLegend: { flex: 1, gap: space.md, marginLeft: space.xl },
})
