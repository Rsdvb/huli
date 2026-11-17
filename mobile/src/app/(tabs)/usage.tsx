// Usage: a sentence on the period, each agent's plan limits as rings, then the period's tokens,
// requests and estimated cost, its share by agent and its spread over the hours of the day, as the
// computer counts them.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import {
  ActivityIndicator,
  Animated,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { AgentStatus, HostEvent, LimitsReason, PlanLimit } from '@shared/agent-host'
import { partsTotal, type ClockZone, type UsageStatus, type UsageSummary } from '@shared/usage'
import { TopBar, useScrollTopOnTabPress } from '../../components/shell'
import { useHost } from '../../host'
import { clockOf, errorText } from '../../sessions'
import { agentColor } from '../../ui/agent-marks'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { BottomSheet } from '../../ui/BottomSheet'
import { Card } from '../../ui/Card'
import { BarChart, ConcentricRings, Donut, Ring } from '../../ui/charts'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { Icon } from '../../ui/Icon'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { Press } from '../../ui/Press'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { SectionHeader } from '../../ui/SectionHeader'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { Skeleton } from '../../ui/Skeleton'
import {
  radius,
  space,
  TAB_BAR_CLEARANCE,
  type as typeScale,
  useTokens,
  type Palette,
} from '../../ui/tokens'

type Period = 'today' | 'week' | 'month' | 'all'

const PERIODS = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '7 天' },
  { key: 'month', label: '30 天' },
  { key: 'all', label: '全部' },
] as const

const PERIOD_WORDS: Record<Period, string> = {
  today: '今天',
  week: '最近 7 天',
  month: '最近 30 天',
  all: '至今',
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
  'harness-does-not-offer': '这个智能体不报告套餐额度。',
  'administrator-managed': '额度由管理员管理。',
  'model-provider-managed': '额度由模型服务商管理。',
  'not-yet-supported': '暂不支持读取这个智能体的额度。',
  'console-managed': '用 API 密钥登录，用量请到服务商控制台查看。',
}

function limitLabel(limit: PlanLimit): string {
  const known = WINDOWS[limit.window]
  if (known) return known
  const weekly = /^Weekly · (.+)$/.exec(limit.label)
  if (weekly) return `每周 · ${weekly[1]}`
  const fiveHour = /^5-hour · (.+)$/.exec(limit.label)
  return fiveHour ? `5 小时 · ${fiveHour[1]}` : limit.label
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function addDays(dayStart: number, days: number): number {
  const d = new Date(dayStart)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime()
}

/** The phone's UTC offsets over a range, a zone from each day its offset changes. */
function zonesBetween(from: number, to: number): ClockZone[] {
  const zones: ClockZone[] = []
  for (let day = from; day < to; day = addDays(day, 1)) {
    const offset = -new Date(day).getTimezoneOffset()
    if (zones.length === 0 || zones[zones.length - 1]!.offset !== offset) {
      zones.push({ from: day, offset })
    }
  }
  return zones.length > 0 ? zones : [{ from, offset: -new Date(from).getTimezoneOffset() }]
}

function grouped(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** A count in Chinese units: 1,573, 12.5万, 6亿. */
function compact(n: number): string {
  const trim = (v: number) => (v < 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v)))
  if (n >= 1e8) return `${trim(n / 1e8)}亿`
  if (n >= 1e4) return `${trim(n / 1e4)}万`
  return grouped(n)
}

function money(cost: number | null): string {
  if (cost === null) return '—'
  if (cost > 0 && cost < 0.01) return '< $0.01'
  return cost >= 100 ? `$${grouped(cost)}` : `$${cost.toFixed(2)}`
}

function resetText(at: number): string {
  const left = at - Date.now()
  if (left <= 0) return '已重置'
  const hours = Math.floor(left / 3_600_000)
  if (hours < 1) return `${Math.max(1, Math.round(left / 60_000))} 分钟后重置`
  if (hours < 48) return `${hours} 小时后重置`
  return `${Math.round(hours / 24)} 天后重置`
}

function hourName(hour: number): string {
  const part =
    hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour < 13 ? '中午' : hour < 18 ? '下午' : '晚上'
  const h12 = (h: number) => (h % 12 === 0 ? 12 : h % 12)
  return `${part}${h12(hour)}时至${h12(hour + 1)}时`
}

function limitColor(c: Palette, limit: PlanLimit): string {
  const used = limit.usedPercent ?? 0
  if (limit.state === 'reached' || used >= 90) return c.danger
  if (limit.state === 'warning' || used >= 75) return c.warning
  return c.tint
}

interface AgentFigures {
  agentId: string
  tokens: number
  requests: number
  cost: number | null
  cacheRead: number
}

interface Read {
  period: Period
  summary: UsageSummary
  status: UsageStatus
}

export default function Usage() {
  const { c } = useTokens()
  const { link, agents, state } = useHost()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null)
  const [period, setPeriod] = useState<Period>('today')
  const [read, setRead] = useState<Read | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pulled, setPulled] = useState(false)
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())
  const [limitErrors, setLimitErrors] = useState<Record<string, string>>({})
  const [detail, setDetail] = useState<string | null>(null)
  const [hour, setHour] = useState<number | null>(null)
  const connected = state.kind === 'connected'
  const asked = useRef(0)

  useScrollTopOnTabPress((y) => scroll.current?.scrollTo({ y, animated: true }), header)

  const load = useCallback(
    async (which: Period) => {
      if (!link) return
      const ticket = ++asked.current
      setLoading(true)
      try {
        const status = (await link.request('usage.status', undefined)) as UsageStatus
        const today = startOfDay(Date.now())
        const tomorrow = addDays(today, 1)
        let from = today
        if (which === 'week') from = addDays(today, -6)
        if (which === 'month') from = addDays(today, -29)
        if (which === 'all') {
          const firsts = [status.recordSince, ...status.logs.map((log) => log.first)].filter(
            (t): t is number => typeof t === 'number',
          )
          from = startOfDay(firsts.length > 0 ? Math.min(...firsts) : addDays(today, -365))
          if (from >= tomorrow) from = today
        }
        const summary = (await link.request('usage.summary', {
          dayStarts: [from, tomorrow],
          from,
          to: tomorrow,
          scope: status.fromComputer ? 'computer' : 'kettu',
          clock: { from, to: tomorrow, zones: zonesBetween(from, tomorrow) },
        })) as UsageSummary
        if (ticket !== asked.current) return
        setRead({ period: which, summary, status })
        setError(null)
      } catch (failure) {
        if (ticket === asked.current) setError(errorText(failure))
      } finally {
        if (ticket === asked.current) setLoading(false)
      }
    },
    [link],
  )

  useEffect(() => {
    if (connected) void load(period)
  }, [connected, load, period])

  useEffect(() => {
    if (!link) return
    return link.onHostEvent((raw: unknown) => {
      const event = raw as HostEvent
      if (event.type === 'usage.changed') void load(period)
      if (event.type === 'usage.status') {
        setRead((current) => (current ? { ...current, status: event.status } : current))
      }
    })
  }, [link, load, period])

  const refreshLimits = (agent: AgentStatus) => {
    if (!link) return
    setRefreshing((set) => new Set(set).add(agent.id))
    setLimitErrors((errors) => {
      const next = { ...errors }
      delete next[agent.id]
      return next
    })
    link
      .request('agents.refreshLimits', { agentId: agent.id, force: true })
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

  const figures = useMemo(() => {
    if (!read) return null
    const byAgent = new Map<string, AgentFigures>()
    let tokens = 0
    let requests = 0
    let cacheRead = 0
    let cost: number | null = null
    for (const row of read.summary.days) {
      const total = partsTotal(row)
      tokens += total
      requests += row.requests
      cacheRead += row.cacheRead
      if (row.cost !== null) cost = (cost ?? 0) + row.cost
      const seen = byAgent.get(row.agentId) ?? {
        agentId: row.agentId,
        tokens: 0,
        requests: 0,
        cost: null,
        cacheRead: 0,
      }
      seen.tokens += total
      seen.requests += row.requests
      seen.cacheRead += row.cacheRead
      if (row.cost !== null) seen.cost = (seen.cost ?? 0) + row.cost
      byAgent.set(row.agentId, seen)
    }
    const hours = Array.from({ length: 24 }, () => 0)
    for (const row of read.summary.clock) hours[row.hour] = (hours[row.hour] ?? 0) + partsTotal(row)
    const agentsUsed = [...byAgent.values()]
      .filter((a) => a.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
    return { tokens, requests, cacheRead, cost, agentsUsed, hours }
  }, [read])

  // Series slots follow the agent's place in the summary's own agent list, so a period with fewer
  // agents never repaints the rest.
  const colorOf = (agentId: string) => {
    const order: readonly string[] = read?.summary.agents ?? []
    const slot = Math.max(0, order.indexOf(agentId))
    return agentColor(agentId, c.series[slot % c.series.length]!)
  }
  const nameOf = (agentId: string) => agents.get(agentId)?.name ?? agentId

  const busiest = (() => {
    const hours = figures?.hours ?? []
    let best = -1
    hours.forEach((v, i) => {
      if (v > 0 && (best < 0 || v > hours[best]!)) best = i
    })
    return best
  })()

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

  const { width } = useWindowDimensions()
  const cardWidth = (width - space.xl * 2 - space.md) / 2

  const body = () => {
    if (!connected && !read) {
      return (
        <EmptyState
          icon="chart"
          title="连上电脑后才能看用量"
          message="用量由电脑上的 Huli 统计。"
        />
      )
    }
    if (!read && error) {
      return (
        <EmptyState
          tone="error"
          icon="warning"
          title="没能读到用量"
          message={error}
          action={{ label: '重试', onPress: () => void load(period) }}
        />
      )
    }
    if (!read || !figures) return <UsageSkeleton />
    const periodWord = PERIOD_WORDS[read.period]
    const top = figures.agentsUsed[0]
    return (
      <>
        <View style={styles.summary} accessibilityRole="header">
          <View style={styles.sentence}>
            {top && <AgentAvatar agentId={top.agentId} name={nameOf(top.agentId)} size={30} />}
            <Text style={[typeScale.lead, styles.flex, { color: c.text }]}>
              {figures.tokens > 0
                ? `${periodWord} ${figures.agentsUsed.length} 个 Agent 用了 ${compact(figures.tokens)} token。`
                : `${periodWord}还没有用量。`}
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

        {planAgents.length > 0 && (
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
                  onPress={() => setDetail(agent.id)}
                />
              ))}
            </View>
          </>
        )}

        <View style={styles.segmented}>
          <SegmentedControl
            segments={PERIODS}
            value={period}
            onChange={(next) => {
              setHour(null)
              setPeriod(next)
            }}
          />
        </View>

        <View style={[styles.stats, { opacity: loading && read.period !== period ? 0.5 : 1 }]}>
          <Stat
            value={compact(figures.tokens)}
            label="Token"
            note={figures.cacheRead > 0 ? `${compact(figures.cacheRead)} 来自缓存` : undefined}
          />
          <Stat value={grouped(figures.requests)} label="请求" />
          <Stat value={money(figures.cost)} label="估算费用" note="按 API 价格" />
        </View>

        {figures.agentsUsed.length > 0 && (
          <>
            <SectionHeader title="按 Agent" />
            <View style={styles.byAgent}>
              <Donut
                size={132}
                stroke={18}
                segments={figures.agentsUsed.map((a) => ({
                  key: a.agentId,
                  value: a.tokens,
                  color: colorOf(a.agentId),
                }))}
              >
                <Text style={[typeScale.headline, styles.tabular, { color: c.text }]}>
                  {compact(figures.tokens)}
                </Text>
                <Text style={[typeScale.caption, { color: c.textSecondary }]}>token</Text>
              </Donut>
              <View style={styles.legend}>
                {figures.agentsUsed.slice(0, 6).map((a) => (
                  <View key={a.agentId} style={styles.legendRow}>
                    <View style={[styles.swatch, { backgroundColor: colorOf(a.agentId) }]} />
                    <Text
                      style={[typeScale.callout, styles.flex, { color: c.text }]}
                      numberOfLines={1}
                    >
                      {nameOf(a.agentId)}
                    </Text>
                    <Text style={[typeScale.callout, styles.tabular, { color: c.text }]}>
                      {compact(a.tokens)}
                    </Text>
                    <Text style={[typeScale.footnote, styles.percent, { color: c.textSecondary }]}>
                      {Math.round((a.tokens / figures.tokens) * 100)}%
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

        {busiest >= 0 && (
          <>
            <SectionHeader
              title="按小时"
              right={
                <Text
                  style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}
                  numberOfLines={1}
                >
                  {hour !== null
                    ? `${hourName(hour)} · ${compact(figures.hours[hour] ?? 0)}`
                    : `${periodWord} · 最忙 ${hourName(busiest)}`}
                </Text>
              }
            />
            <Text
              style={[
                typeScale.caption,
                styles.tabular,
                { color: c.textTertiary, marginBottom: space.xs },
              ]}
            >
              {compact(Math.max(...figures.hours))}
            </Text>
            <BarChart
              values={figures.hours}
              height={120}
              selected={hour}
              onSelect={(next) => {
                haptic.select()
                setHour(next)
              }}
              labels={{ 0: '0时', 6: '6时', 12: '12时', 18: '18时' }}
            />
          </>
        )}

        <Text style={[typeScale.footnote, styles.note, { color: c.textTertiary }]}>
          {read.status.unavailable
            ? '电脑上的用量记录打不开，数字可能不全。'
            : read.status.fromComputer
              ? '按这台电脑上各智能体的日志统计，包括 Huli 之外的使用。'
              : '只统计在 Huli 里发生的使用。'}
          {read.status.scanning ? ' 正在读取日志…' : ''}
          {` 费用按 ${read.summary.pricesAsOf} 的价格估算。`}
        </Text>
        {error ? <Text style={[typeScale.footnote, { color: c.danger }]}>{error}</Text> : null}
      </>
    )
  }

  const shown = detail ? agents.get(detail) : undefined

  return (
    <Screen>
      <Animated.ScrollView
        ref={scroll}
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop + space.sm,
          paddingHorizontal: space.xl,
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        }}
        refreshControl={
          <RefreshControl
            refreshing={pulled}
            tintColor={c.textSecondary}
            progressViewOffset={header.height}
            onRefresh={() => {
              setPulled(true)
              void load(period).finally(() => setPulled(false))
            }}
          />
        }
      >
        {body()}
      </Animated.ScrollView>
      <TopBar header={header} filter={false} />
      <BottomSheet
        visible={!!shown}
        onClose={() => setDetail(null)}
        title={shown ? (shown.account?.label ?? shown.name) : undefined}
        message={shown?.account?.label ? shown.name : undefined}
      >
        {shown && (
          <LimitDetail
            agent={shown}
            readable={readable(shown)}
            refreshing={refreshing.has(shown.id)}
            error={limitErrors[shown.id] ?? shown.limitsError ?? null}
            onRefresh={connected ? () => refreshLimits(shown) : undefined}
          />
        )}
      </BottomSheet>
    </Screen>
  )
}

function Stat(props: { value: string; label: string; note?: string }) {
  const { c } = useTokens()
  return (
    <View style={styles.stat}>
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
        <Text style={[typeScale.headline, styles.flex, { color: c.text }]} numberOfLines={1}>
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
            size={68}
            stroke={6}
            gap={3}
            rings={limits.map((l) => ({
              progress: (l.usedPercent ?? 0) / 100,
              color: limitColor(c, l),
            }))}
          />
          <View style={styles.planLegend}>
            {limits.map((l) => (
              <Text key={l.window} numberOfLines={1} style={{ color: c.textSecondary }}>
                <Text style={[typeScale.headline, styles.tabular, { color: c.text }]}>
                  {l.usedPercent === null ? '—' : `${Math.round(l.usedPercent)}%`}
                </Text>
                <Text style={typeScale.caption}> {limitLabel(l)}</Text>
              </Text>
            ))}
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

function LimitDetail(props: {
  agent: AgentStatus
  readable: boolean
  refreshing: boolean
  error: string | null
  onRefresh: (() => void) | undefined
}) {
  const { c } = useTokens()
  const { agent } = props
  const observed = Math.max(0, ...agent.limits.map((l) => l.observedAt))
  return (
    <>
      {agent.limits.length > 0 ? (
        <View style={[styles.detail, { backgroundColor: c.fill }]}>
          {agent.limits.map((limit) => {
            const used = Math.round(limit.usedPercent ?? 0)
            const color = limitColor(c, limit)
            return (
              <View key={limit.window} style={styles.limit}>
                <View style={styles.limitHead}>
                  <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>
                    {limitLabel(limit)}
                    {limit.state === 'reached' ? ' · 已用完' : ''}
                  </Text>
                  <Text
                    style={[
                      typeScale.callout,
                      styles.tabular,
                      { color: c.text, fontWeight: '600' },
                    ]}
                  >
                    {limit.usedPercent === null ? '—' : `${used}%`}
                  </Text>
                </View>
                <View style={[styles.track, { backgroundColor: c.track }]}>
                  <View
                    style={[
                      styles.fill,
                      { backgroundColor: color, width: `${Math.min(100, Math.max(0, used))}%` },
                    ]}
                  />
                </View>
                <Text style={[typeScale.caption, styles.tabular, { color: c.textTertiary }]}>
                  {[
                    limit.resetsAt ? resetText(limit.resetsAt) : null,
                    limit.amount
                      ? `${limit.amount.used}/${limit.amount.total} ${limit.amount.unit}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || ' '}
                </Text>
              </View>
            )
          })}
        </View>
      ) : (
        <Text style={[typeScale.callout, { color: c.textSecondary }]}>
          {limitWhy(agent, props.readable)}
        </Text>
      )}
      {props.error ? (
        <Text style={[typeScale.footnote, { color: c.danger }]}>{props.error}</Text>
      ) : null}
      {props.readable && props.onRefresh && (
        <ListGroup footer={observed > 0 ? `读取于 ${clockOf(observed)}` : undefined}>
          <ListRow
            title={
              props.refreshing ? '正在读取…' : agent.limits.length > 0 ? '重新读取' : '读取额度'
            }
            icon="refresh"
            iconTint={c.tint}
            action
            disabled={props.refreshing}
            onPress={() => {
              haptic.tap()
              props.onRefresh?.()
            }}
          />
        </ListGroup>
      )}
    </>
  )
}

function UsageSkeleton() {
  return (
    <View style={styles.skeleton} accessibilityLabel="正在加载">
      <Skeleton width="85%" height={26} />
      <Skeleton width="60%" height={26} />
      <View style={styles.skeletonCards}>
        <Skeleton width="48%" height={128} radius={radius.lg} />
        <Skeleton width="48%" height={128} radius={radius.lg} />
      </View>
      <Skeleton height={40} radius={radius.pill} />
      <View style={styles.skeletonCards}>
        <Skeleton width="28%" height={52} />
        <Skeleton width="28%" height={52} />
        <Skeleton width="28%" height={52} />
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
  planLegend: { flex: 1, gap: 2 },
  segmented: { paddingTop: space.xxl },
  stats: { flexDirection: 'row', gap: space.lg, paddingTop: space.xl },
  stat: { flex: 1, gap: 2 },
  byAgent: { flexDirection: 'row', alignItems: 'center', gap: space.xl },
  legend: { flex: 1, gap: space.md },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  percent: { width: 40, textAlign: 'right', fontVariant: ['tabular-nums'] },
  note: { paddingTop: space.xxl },
  detail: { borderRadius: radius.lg, padding: space.lg, gap: space.lg },
  limit: { gap: space.sm - 2 },
  limitHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  skeleton: { gap: space.lg, paddingTop: space.md },
  skeletonCards: { flexDirection: 'row', justifyContent: 'space-between' },
})
